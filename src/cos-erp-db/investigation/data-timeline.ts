import { querySqlServer, type SqlServerConnection, type SqlServerQueryResult } from '../../main/database/sqlserver.js';
import type { DatabaseDataTimelineEvent, DatabaseDataTimelineResult } from './types.js';

const RESULT_BYTES = 256 * 1024;

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : String(value);
}

function quoteIdentifier(value: string): string {
  return '[' + value.replace(/]/g, ']]') + ']';
}

function parseSubject(subject: string): { column: string; value: string } {
  const separator = subject.indexOf('=');
  if (separator <= 0) throw new Error('Data timeline subject must use Column=Value.');
  const column = subject.slice(0, separator).trim();
  const value = subject.slice(separator + 1).trim();
  if (!column || column.length > 256 || !value || value.length > 1000) {
    throw new Error('Data timeline subject must contain a valid column and a value up to 1000 characters.');
  }
  return { column, value };
}

function timelineTime(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

async function objectCatalog(connection: SqlServerConnection, objectId: number): Promise<SqlServerQueryResult> {
  const sql = [
    'SELECT s.name AS schema_name, t.name AS table_name, c.column_id, c.name AS column_name',
    'FROM sys.tables t',
    'JOIN sys.schemas s ON s.schema_id = t.schema_id',
    'JOIN sys.columns c ON c.object_id = t.object_id',
    'WHERE t.object_id = @object_id AND t.is_ms_shipped = 0',
    'ORDER BY c.column_id;'
  ].join('\n');
  return querySqlServer(connection, sql, undefined, {
    maxRows: 1024,
    maxBytes: RESULT_BYTES,
    parameters: { object_id: objectId }
  });
}

async function helperCatalog(connection: SqlServerConnection): Promise<SqlServerQueryResult> {
  const sql = [
    'SELECT s.name AS schema_name, o.name AS object_name, o.type AS object_type',
    'FROM sys.objects o',
    'JOIN sys.schemas s ON s.schema_id = o.schema_id',
    "WHERE o.name IN (N'fn_GetDateTimeFromLog', N'fn_GetUserFromLog',",
    "  N'L00HISTORYVOUCHER', N'L00HISTORYOTHER', N'L00DMCT')",
    'ORDER BY o.name;'
  ].join('\n');
  return querySqlServer(connection, sql, undefined, { maxRows: 20, maxBytes: 32_000 });
}

function helper(result: SqlServerQueryResult, name: string): { schema: string; type: string } | null {
  const row = result.rows.find(item => stringValue(item.object_name)?.toLowerCase() === name.toLowerCase());
  const schema = row ? stringValue(row.schema_name) : null;
  const type = row ? stringValue(row.object_type) : null;
  return schema && type ? { schema, type } : null;
}

function currentSelects(
  columns: readonly string[],
  createColumn: string | null,
  modifyColumn: string | null,
  dateFn: { schema: string } | null,
  userFn: { schema: string } | null
): string[] {
  const selects = columns.map(quoteIdentifier);
  if (createColumn && dateFn) {
    selects.push(
      'CASE WHEN NULLIF(CONVERT(varchar(4000), ' + quoteIdentifier(createColumn) + "), '') IS NULL THEN NULL ELSE " +
      quoteIdentifier(dateFn.schema) + '.' + quoteIdentifier('fn_GetDateTimeFromLog') +
      '(' + quoteIdentifier(createColumn) + ') END AS __created_at'
    );
  }
  if (createColumn && userFn) {
    selects.push(
      'CASE WHEN NULLIF(CONVERT(varchar(4000), ' + quoteIdentifier(createColumn) + "), '') IS NULL THEN NULL ELSE " +
      quoteIdentifier(userFn.schema) + '.' + quoteIdentifier('fn_GetUserFromLog') +
      '(' + quoteIdentifier(createColumn) + ') END AS __created_by'
    );
  }
  if (modifyColumn && dateFn) {
    selects.push(
      'CASE WHEN NULLIF(CONVERT(varchar(4000), ' + quoteIdentifier(modifyColumn) + "), '') IS NULL THEN NULL ELSE " +
      quoteIdentifier(dateFn.schema) + '.' + quoteIdentifier('fn_GetDateTimeFromLog') +
      '(' + quoteIdentifier(modifyColumn) + ') END AS __modified_at'
    );
  }
  if (modifyColumn && userFn) {
    selects.push(
      'CASE WHEN NULLIF(CONVERT(varchar(4000), ' + quoteIdentifier(modifyColumn) + "), '') IS NULL THEN NULL ELSE " +
      quoteIdentifier(userFn.schema) + '.' + quoteIdentifier('fn_GetUserFromLog') +
      '(' + quoteIdentifier(modifyColumn) + ') END AS __modified_by'
    );
  }
  return selects;
}

async function voucherConfigured(
  connection: SqlServerConnection,
  dmct: { schema: string },
  table: string
): Promise<boolean> {
  const columnSql = [
    'SELECT c.name AS column_name',
    'FROM sys.columns c',
    'JOIN sys.tables t ON t.object_id = c.object_id',
    'JOIN sys.schemas s ON s.schema_id = t.schema_id',
    "WHERE s.name = @schema AND t.name = N'L00DMCT'",
    "  AND c.name IN (N'Table_Ph', N'Table_Ct');"
  ].join('\n');
  const columns = await querySqlServer(connection, columnSql, undefined, {
    maxRows: 2,
    maxBytes: 8_000,
    parameters: { schema: dmct.schema }
  });
  const names = new Set(
    columns.rows
      .map(item => stringValue(item.column_name)?.toLowerCase())
      .filter((value): value is string => Boolean(value))
  );
  const predicates: string[] = [];
  if (names.has('table_ph')) predicates.push(quoteIdentifier('Table_Ph') + ' = @table');
  if (names.has('table_ct')) predicates.push(quoteIdentifier('Table_Ct') + ' = @table');
  if (!predicates.length) return false;
  const sql = 'SELECT TOP (1) 1 AS configured FROM ' +
    quoteIdentifier(dmct.schema) + '.' + quoteIdentifier('L00DMCT') +
    ' WHERE ' + predicates.join(' OR ') + ';';
  const result = await querySqlServer(connection, sql, undefined, {
    maxRows: 1,
    maxBytes: 4_000,
    parameters: { table }
  });
  return result.rows.length > 0;
}

async function readVoucherHistory(
  connection: SqlServerConnection,
  schema: string,
  stt: string,
  limit: number
): Promise<DatabaseDataTimelineEvent[]> {
  const sql = [
    'SELECT TOP (@take) Ident00, Member_ID, Update_Type, Ngay_Update, Stt, Stt0,',
    '       Ma_Ct, Ngay_Ct, So_Ct, Dien_Giai, Ma_DvCs, Computer_Name',
    'FROM ' + quoteIdentifier(schema) + '.' + quoteIdentifier('L00HISTORYVOUCHER'),
    'WHERE Stt = @stt',
    'ORDER BY Ngay_Update DESC, Ident00 DESC;'
  ].join('\n');
  const history = await querySqlServer(connection, sql, undefined, {
    maxRows: limit,
    maxBytes: RESULT_BYTES,
    parameters: { take: limit, stt }
  });
  return history.rows.map(row => ({
    kind: 'voucher-history' as const,
    happenedAt: timelineTime(row.Ngay_Update),
    user: stringValue(row.Member_ID),
    updateType: stringValue(row.Update_Type),
    computer: stringValue(row.Computer_Name),
    detail: [
      stringValue(row.Ma_Ct) ? 'Ma_Ct=' + stringValue(row.Ma_Ct) : null,
      stringValue(row.So_Ct) ? 'So_Ct=' + stringValue(row.So_Ct) : null,
      stringValue(row.Stt0) ? 'Stt0=' + stringValue(row.Stt0) : null,
      stringValue(row.Dien_Giai)
    ].filter(Boolean).join(', '),
    rawLog: null
  }));
}

export async function readDatabaseDataTimeline(
  connectionId: string,
  connection: SqlServerConnection,
  objectId: number,
  subjectInput: string,
  limit = 50
): Promise<DatabaseDataTimelineResult> {
  const startedAt = Date.now();
  if (!Number.isInteger(objectId) || objectId <= 0) {
    throw new Error('Data timeline objectId must be a positive integer.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Data timeline limit must be between 1 and 100.');
  }
  const requested = parseSubject(subjectInput);
  const [catalog, helpers] = await Promise.all([objectCatalog(connection, objectId), helperCatalog(connection)]);
  if (!catalog.rows.length) throw new Error('Data timeline objectId does not identify a user table.');
  const schema = stringValue(catalog.rows[0]!.schema_name)!;
  const table = stringValue(catalog.rows[0]!.table_name)!;
  const columns = catalog.rows
    .map(row => stringValue(row.column_name))
    .filter((value): value is string => Boolean(value));
  const byLower = new Map(columns.map(column => [column.toLowerCase(), column]));
  const subjectColumn = byLower.get(requested.column.toLowerCase());
  if (!subjectColumn) throw new Error('Data timeline subject column does not exist on the selected table.');
  const createColumn = byLower.get('create_log') ?? null;
  const modifyColumn = byLower.get('lastmodify_log') ?? null;
  const sttColumn = byLower.get('stt') ?? null;
  const common = [
    subjectColumn, 'Ident00', 'Ma_Data', 'Ma_DvCs', 'Stt', 'Ma_Ct', 'Ngay_Ct', 'So_Ct',
    'Create_Log', 'LastModify_Log'
  ].map(name => byLower.get(name.toLowerCase()))
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  const dateFn = helper(helpers, 'fn_GetDateTimeFromLog');
  const userFn = helper(helpers, 'fn_GetUserFromLog');
  const selects = currentSelects(common, createColumn, modifyColumn, dateFn, userFn);
  const orderColumn = byLower.get('ident00');
  const currentSql = [
    'SELECT TOP (2) ' + selects.join(', '),
    'FROM ' + quoteIdentifier(schema) + '.' + quoteIdentifier(table),
    'WHERE ' + quoteIdentifier(subjectColumn) + ' = @subject',
    orderColumn ? 'ORDER BY ' + quoteIdentifier(orderColumn) + ' DESC;' : ';'
  ].join('\n');
  const current = await querySqlServer(connection, currentSql, undefined, {
    maxRows: 2,
    maxBytes: RESULT_BYTES,
    parameters: { subject: requested.value }
  });
  const ambiguous = current.rows.length > 1;
  const row = current.rows.length === 1 ? current.rows[0]! : null;
  const events: DatabaseDataTimelineEvent[] = [];
  const limitations: string[] = [];
  if (ambiguous) {
    limitations.push('Subject matched at least two current rows; row-specific history is not auto-linked.');
  }
  if (row && createColumn && stringValue(row[createColumn])) {
    events.push({
      kind: 'created',
      happenedAt: timelineTime(row.__created_at),
      user: stringValue(row.__created_by),
      updateType: null,
      computer: null,
      detail: 'Current row Create_Log',
      rawLog: stringValue(row[createColumn])
    });
  }
  if (row && modifyColumn && stringValue(row[modifyColumn])) {
    events.push({
      kind: 'modified',
      happenedAt: timelineTime(row.__modified_at),
      user: stringValue(row.__modified_by),
      updateType: null,
      computer: null,
      detail: 'Current row LastModify_Log',
      rawLog: stringValue(row[modifyColumn])
    });
  }

  const dmct = helper(helpers, 'L00DMCT');
  const voucherHistory = helper(helpers, 'L00HISTORYVOUCHER');
  let voucherHistoryLinked = false;
  if (row && sttColumn && dmct && voucherHistory && await voucherConfigured(connection, dmct, table)) {
    const stt = stringValue(row[sttColumn]);
    if (stt) {
      events.push(...await readVoucherHistory(connection, voucherHistory.schema, stt, limit));
      voucherHistoryLinked = true;
    }
  }
  const genericHistory = helper(helpers, 'L00HISTORYOTHER');
  if (genericHistory) {
    limitations.push('L00HISTORYOTHER exists but has no reliable source-table identity, so it is not auto-linked to arbitrary rows.');
  }
  if (!createColumn && !modifyColumn) limitations.push('Selected table has no Create_Log or LastModify_Log column.');
  if ((createColumn || modifyColumn) && !dateFn) {
    limitations.push('fn_GetDateTimeFromLog is unavailable; audit timestamps cannot be decoded.');
  }
  if ((createColumn || modifyColumn) && !userFn) {
    limitations.push('fn_GetUserFromLog is unavailable; audit users cannot be decoded.');
  }
  events.sort((left, right) => (left.happenedAt ?? '').localeCompare(right.happenedAt ?? ''));
  return {
    connection: connectionId,
    database: connection.database ?? '',
    capturedAt: new Date().toISOString(),
    object: { objectId, schema, table },
    subject: { column: subjectColumn, value: requested.value },
    matchedRows: current.rows.length,
    ambiguous,
    current: current.rows,
    events,
    sources: {
      createModifyLog: Boolean(createColumn || modifyColumn),
      voucherHistory: voucherHistoryLinked,
      genericHistoryAvailable: Boolean(genericHistory),
      genericHistoryLinked: false
    },
    limitations,
    elapsedMs: Date.now() - startedAt
  };
}
