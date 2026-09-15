import type {
  DatabaseTableColumn,
  DatabaseTableFilter,
  DatabaseTablePageRequest,
  DatabaseTablePageResult,
  DatabaseTableSort
} from '../../shared/database.js';
import {
  querySqlServer,
  type SqlServerConnection,
  type SqlServerQueryOptions,
  type SqlServerQueryResult
} from './sqlserver.js';

export const DEFAULT_DATABASE_TABLE_PAGE_SIZE = 100;
export const MAX_DATABASE_TABLE_PAGE_SIZE = 200;
export const MAX_DATABASE_TABLE_FILTERS = 8;
const TABLE_RESULT_BYTES = 1_000_000;
const TEXT_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext', 'sysname']);

type TableDataQuery = (
  connection: SqlServerConnection,
  sql: string,
  options: SqlServerQueryOptions
) => Promise<SqlServerQueryResult>;

export interface SqlServerTableMeta {
  schema: string;
  table: string;
  columns: Array<DatabaseTableColumn & { columnId: number; identity: boolean; computed: boolean }>;
}

interface CursorPayload {
  v: 1;
  objectId: number;
  fingerprint: string;
  mode: 'keyset' | 'offset';
  offset?: number;
  values?: Record<string, string | number | boolean | null>;
}

interface OrderColumn {
  column: DatabaseTableColumn & { columnId: number };
  direction: 'asc' | 'desc';
}

const TABLE_METADATA_SQL = `
SELECT
  s.name AS schema_name,
  t.name AS table_name,
  c.name AS column_name,
  ty.name AS type_name,
  c.column_id,
  c.is_nullable,
  c.is_identity,
  c.is_computed,
  pk.key_ordinal AS primary_key_ordinal
FROM sys.tables AS t
INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
INNER JOIN sys.columns AS c ON c.object_id = t.object_id
INNER JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
LEFT JOIN (
  SELECT ic.object_id, ic.column_id, ic.key_ordinal
  FROM sys.indexes AS i
  INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  WHERE i.is_primary_key = 1 AND ic.key_ordinal > 0
) AS pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
WHERE t.object_id = @object_id
ORDER BY c.column_id;`;

function positiveObjectId(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error('Table objectId must be a positive integer.');
  return value;
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_DATABASE_TABLE_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DATABASE_TABLE_PAGE_SIZE) {
    throw new Error(`Table page size must be an integer between 1 and ${MAX_DATABASE_TABLE_PAGE_SIZE}.`);
  }
  return limit;
}

export function quoteSqlIdentifier(value: string): string {
  return `[${value.replace(/]/g, ']]')}]`;
}

function rowString(row: Record<string, unknown>, key: string): string | null {
  return typeof row[key] === 'string' ? row[key] as string : null;
}

function rowInteger(row: Record<string, unknown>, key: string): number | null {
  return typeof row[key] === 'number' && Number.isInteger(row[key]) ? row[key] as number : null;
}

export async function loadSqlServerTableMeta(
  connection: SqlServerConnection,
  objectId: number,
  signal: AbortSignal | undefined,
  query: TableDataQuery
): Promise<SqlServerTableMeta> {
  const result = await query(connection, TABLE_METADATA_SQL, {
    maxRows: 1024,
    maxBytes: 512_000,
    ...(signal ? { signal } : {}),
    parameters: { object_id: objectId }
  });
  if (result.rows.length === 0) throw new Error('TABLE_NOT_FOUND: the selected object is not a user table.');
  let schema = '';
  let table = '';
  const columns: SqlServerTableMeta['columns'] = [];
  for (const row of result.rows) {
    const nextSchema = rowString(row, 'schema_name');
    const nextTable = rowString(row, 'table_name');
    const name = rowString(row, 'column_name');
    const type = rowString(row, 'type_name');
    const columnId = rowInteger(row, 'column_id');
    const pkOrdinal = row.primary_key_ordinal === null ? null : rowInteger(row, 'primary_key_ordinal');
    if (!nextSchema || !nextTable || !name || !type || columnId === null) throw new Error('SQL Server returned malformed table metadata.');
    schema ||= nextSchema;
    table ||= nextTable;
    columns.push({
      name,
      type,
      nullable: row.is_nullable === true,
      primaryKeyOrdinal: pkOrdinal,
      identity: row.is_identity === true,
      computed: row.is_computed === true,
      columnId
    });
  }
  return { schema, table, columns };
}

function findColumn(meta: SqlServerTableMeta, name: string): SqlServerTableMeta['columns'][number] {
  const found = meta.columns.find(column => column.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  if (!found) throw new Error(`Unknown table column "${name}".`);
  return found;
}

function normalizeFilters(meta: SqlServerTableMeta, filters: readonly DatabaseTableFilter[] | undefined): DatabaseTableFilter[] {
  if (!filters) return [];
  if (filters.length > MAX_DATABASE_TABLE_FILTERS) throw new Error(`At most ${MAX_DATABASE_TABLE_FILTERS} table filters are allowed.`);
  return filters.map(filter => {
    const column = findColumn(meta, filter.column);
    if ((filter.operator === 'starts_with' || filter.operator === 'contains') && !TEXT_TYPES.has(column.type.toLocaleLowerCase())) {
      throw new Error(`${filter.operator} is only supported for text columns.`);
    }
    if (filter.operator !== 'is_null' && filter.value === undefined) throw new Error(`Filter ${filter.operator} requires a value.`);
    return { ...filter, column: column.name };
  });
}

function normalizeSort(meta: SqlServerTableMeta, sort: DatabaseTableSort | undefined): DatabaseTableSort | undefined {
  if (!sort) return undefined;
  const column = findColumn(meta, sort.column);
  if (sort.direction !== 'asc' && sort.direction !== 'desc') throw new Error('Sort direction must be asc or desc.');
  return { column: column.name, direction: sort.direction };
}

function primaryKeyColumns(meta: SqlServerTableMeta): SqlServerTableMeta['columns'] {
  return meta.columns
    .filter(column => column.primaryKeyOrdinal !== null)
    .sort((left, right) => left.primaryKeyOrdinal! - right.primaryKeyOrdinal!);
}

function orderColumns(meta: SqlServerTableMeta, sort: DatabaseTableSort | undefined): { mode: 'keyset' | 'offset'; columns: OrderColumn[] } {
  const primaryKey = primaryKeyColumns(meta);
  if (!sort) {
    if (primaryKey.length > 0) return { mode: 'keyset', columns: primaryKey.map(column => ({ column, direction: 'asc' })) };
    return { mode: 'offset', columns: [{ column: meta.columns[0]!, direction: 'asc' }] };
  }
  const selected = findColumn(meta, sort.column);
  if (primaryKey.length === 0 || selected.nullable) return { mode: 'offset', columns: [{ column: selected, direction: sort.direction }] };
  return {
    mode: 'keyset',
    columns: [
      { column: selected, direction: sort.direction },
      ...primaryKey.filter(column => column.name !== selected.name).map(column => ({ column, direction: sort.direction }))
    ]
  };
}

function escapeLike(value: string): string {
  return value.replace(/[~%_\[]/g, match => `~${match}`);
}

function buildFilters(filters: readonly DatabaseTableFilter[]): { sql: string[]; parameters: Record<string, string | number | boolean | null> } {
  const sql: string[] = [];
  const parameters: Record<string, string | number | boolean | null> = {};
  filters.forEach((filter, index) => {
    const column = quoteSqlIdentifier(filter.column);
    const parameter = `filter_${index}`;
    if (filter.operator === 'is_null' || (filter.operator === 'eq' && filter.value === null)) {
      sql.push(`${column} IS NULL`);
      return;
    }
    const value = filter.value as string | number | boolean;
    if (filter.operator === 'starts_with' || filter.operator === 'contains') {
      if (typeof value !== 'string') throw new Error(`${filter.operator} requires a string value.`);
      parameters[parameter] = filter.operator === 'starts_with' ? `${escapeLike(value)}%` : `%${escapeLike(value)}%`;
      sql.push(`${column} LIKE @${parameter} ESCAPE N'~'`);
      return;
    }
    parameters[parameter] = value;
    sql.push(`${column} ${filter.operator === 'eq' ? '=' : filter.operator === 'gte' ? '>=' : '<='} @${parameter}`);
  });
  return { sql, parameters };
}

function fingerprint(objectId: number, sort: DatabaseTableSort | undefined, filters: readonly DatabaseTableFilter[]): string {
  return JSON.stringify({ objectId, sort: sort ?? null, filters });
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, objectId: number, expectedFingerprint: string): CursorPayload | null {
  if (!cursor) return null;
  if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Table cursor is invalid.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Table cursor is invalid.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Table cursor is invalid.');
  const row = parsed as Partial<CursorPayload>;
  if (row.v !== 1 || row.objectId !== objectId || row.fingerprint !== expectedFingerprint || (row.mode !== 'keyset' && row.mode !== 'offset')) {
    throw new Error('Table cursor does not match the current table, filters and sort.');
  }
  if (row.mode === 'offset' && (!Number.isInteger(row.offset) || (row.offset ?? -1) < 0)) throw new Error('Table cursor is invalid.');
  if (row.mode === 'keyset' && (!row.values || typeof row.values !== 'object')) throw new Error('Table cursor is invalid.');
  return row as CursorPayload;
}

function keysetPredicate(
  order: readonly OrderColumn[],
  values: Record<string, string | number | boolean | null>
): { sql: string; parameters: Record<string, string | number | boolean | null> } {
  const branches: string[] = [];
  const parameters: Record<string, string | number | boolean | null> = {};
  for (let index = 0; index < order.length; index += 1) {
    const equals: string[] = [];
    for (let prefix = 0; prefix < index; prefix += 1) {
      const item = order[prefix]!;
      const key = `cursor_${prefix}`;
      parameters[key] = values[item.column.name]!;
      equals.push(`${quoteSqlIdentifier(item.column.name)} = @${key}`);
    }
    const item = order[index]!;
    const key = `cursor_${index}`;
    const value = values[item.column.name];
    if (value === undefined || value === null) throw new Error('Table cursor contains an unsupported null sort value.');
    parameters[key] = value;
    branches.push(`(${[...equals, `${quoteSqlIdentifier(item.column.name)} ${item.direction === 'asc' ? '>' : '<'} @${key}`].join(' AND ')})`);
  }
  return { sql: `(${branches.join(' OR ')})`, parameters };
}

function cursorValues(row: Record<string, unknown>, order: readonly OrderColumn[]): Record<string, string | number | boolean | null> {
  const values: Record<string, string | number | boolean | null> = {};
  for (const item of order) {
    const value = row[item.column.name];
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values[item.column.name] = value;
    else throw new Error(`Table paging does not support cursor values from column "${item.column.name}".`);
  }
  return values;
}

export async function readSqlServerTablePage(
  connection: SqlServerConnection,
  request: Omit<DatabaseTablePageRequest, 'connection'>,
  options: { signal?: AbortSignal } = {},
  query: TableDataQuery = (resolved, sql, queryOptions) => querySqlServer(resolved, sql, undefined, queryOptions)
): Promise<DatabaseTablePageResult> {
  const objectId = positiveObjectId(request.objectId);
  const limit = normalizeLimit(request.limit);
  const meta = await loadSqlServerTableMeta(connection, objectId, options.signal, query);
  const filters = normalizeFilters(meta, request.filters);
  const sort = normalizeSort(meta, request.sort);
  const order = orderColumns(meta, sort);
  const cursorFingerprint = fingerprint(objectId, sort, filters);
  const cursor = decodeCursor(request.cursor, objectId, cursorFingerprint);
  if (cursor && cursor.mode !== order.mode) throw new Error('Table cursor paging mode no longer matches the selected sort.');

  const filter = buildFilters(filters);
  const where = [...filter.sql];
  const parameters: Record<string, string | number | boolean | null> = { ...filter.parameters, take: limit + 1 };
  let offset = 0;
  if (order.mode === 'keyset' && cursor?.values) {
    const after = keysetPredicate(order.columns, cursor.values);
    where.push(after.sql);
    Object.assign(parameters, after.parameters);
  } else if (order.mode === 'offset') {
    offset = cursor?.offset ?? 0;
    parameters.offset = offset;
  }

  const table = `${quoteSqlIdentifier(meta.schema)}.${quoteSqlIdentifier(meta.table)}`;
  const orderBy = order.columns.map(item => `${quoteSqlIdentifier(item.column.name)} ${item.direction.toUpperCase()}`).join(', ');
  const sql = order.mode === 'keyset'
    ? `SELECT TOP (@take) * FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy};`
    : `SELECT * FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy} OFFSET @offset ROWS FETCH NEXT @take ROWS ONLY;`;

  const result = await query(connection, sql, {
    maxRows: limit + 1,
    maxBytes: TABLE_RESULT_BYTES,
    ...(options.signal ? { signal: options.signal } : {}),
    parameters
  });
  const hasMore = result.rows.length > limit || result.truncated;
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  let nextCursor: string | undefined;
  if (hasMore && last) {
    nextCursor = order.mode === 'keyset'
      ? encodeCursor({ v: 1, objectId, fingerprint: cursorFingerprint, mode: 'keyset', values: cursorValues(last, order.columns) })
      : encodeCursor({ v: 1, objectId, fingerprint: cursorFingerprint, mode: 'offset', offset: offset + rows.length });
  }
  return {
    schema: meta.schema,
    table: meta.table,
    columns: meta.columns.map(({ columnId: _columnId, ...column }) => column),
    rows,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    elapsedMs: result.elapsedMs,
    pagingMode: order.mode,
    ...(order.mode === 'offset' ? { warning: 'This table/sort has no non-null primary-key tie-breaker, so paging uses OFFSET and may be slower or shift while data changes.' } : {})
  };
}
