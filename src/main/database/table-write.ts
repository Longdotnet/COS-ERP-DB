import type {
  DatabaseScalarValue,
  DatabaseTableCellUpdateRequest,
  DatabaseTableCellUpdateResult
} from '../../shared/database.js';
import {
  querySqlServer,
  type SqlServerConnection,
  type SqlServerQueryOptions,
  type SqlServerQueryResult
} from './sqlserver.js';
import { loadSqlServerTableMeta, quoteSqlIdentifier } from './table-data.js';

type WriteQuery = (
  connection: SqlServerConnection,
  sql: string,
  options: SqlServerQueryOptions
) => Promise<SqlServerQueryResult>;

function scalar(value: unknown, field: string): DatabaseScalarValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  throw new Error(`${field} must be a string, number, boolean or null.`);
}

function sameName(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

/**
 * Structured single-cell mutation used only by the local Database UI.
 * The target table/column/PK are re-resolved from SQL Server metadata and identifiers are quoted;
 * user values are driver parameters. The old value participates in WHERE so stale UI state cannot
 * silently overwrite a concurrent change.
 */
export async function updateSqlServerTableCell(
  connection: SqlServerConnection,
  request: Omit<DatabaseTableCellUpdateRequest, 'connection'>,
  options: { signal?: AbortSignal } = {},
  query: WriteQuery = (resolved, sql, queryOptions) => querySqlServer(resolved, sql, undefined, queryOptions)
): Promise<DatabaseTableCellUpdateResult> {
  if (!Number.isInteger(request.objectId) || request.objectId <= 0) throw new Error('Table objectId must be a positive integer.');
  const meta = await loadSqlServerTableMeta(connection, request.objectId, options.signal, query);
  const column = meta.columns.find(candidate => sameName(candidate.name, request.column));
  if (!column) throw new Error(`Unknown table column "${request.column}".`);
  if (column.primaryKeyOrdinal !== null) throw new Error('Primary-key columns cannot be edited inline.');
  if (column.identity) throw new Error('Identity columns cannot be edited inline.');
  if (column.computed) throw new Error('Computed columns cannot be edited inline.');

  const primaryKey = meta.columns
    .filter(candidate => candidate.primaryKeyOrdinal !== null)
    .sort((left, right) => left.primaryKeyOrdinal! - right.primaryKeyOrdinal!);
  if (primaryKey.length === 0) throw new Error('INLINE_EDIT_REQUIRES_PRIMARY_KEY: this table has no primary key.');
  if (Object.keys(request.primaryKey).length !== primaryKey.length) throw new Error('Primary-key values do not match the selected table.');

  const parameters: Record<string, DatabaseScalarValue> = {
    next_value: scalar(request.value, 'value')
  };
  const where: string[] = [];
  primaryKey.forEach((keyColumn, index) => {
    const entry = Object.entries(request.primaryKey).find(([name]) => sameName(name, keyColumn.name));
    if (!entry) throw new Error(`Missing primary-key value for "${keyColumn.name}".`);
    const value = scalar(entry[1], `primaryKey.${keyColumn.name}`);
    if (value === null) throw new Error(`Primary-key value for "${keyColumn.name}" cannot be null.`);
    const parameter = `pk_${index}`;
    parameters[parameter] = value;
    where.push(`${quoteSqlIdentifier(keyColumn.name)} = @${parameter}`);
  });

  const original = scalar(request.originalValue, 'originalValue');
  if (original === null) {
    where.push(`${quoteSqlIdentifier(column.name)} IS NULL`);
  } else {
    parameters.original_value = original;
    where.push(`${quoteSqlIdentifier(column.name)} = @original_value`);
  }

  const sql = `UPDATE ${quoteSqlIdentifier(meta.schema)}.${quoteSqlIdentifier(meta.table)} ` +
    `SET ${quoteSqlIdentifier(column.name)} = @next_value WHERE ${where.join(' AND ')};`;
  const result = await query(connection, sql, {
    maxRows: 1,
    maxBytes: 8_192,
    ...(options.signal ? { signal: options.signal } : {}),
    parameters
  });
  if (result.rowCount === 0) throw new Error('DATABASE_WRITE_CONFLICT: the row no longer matches the value you edited. Refresh and try again.');
  if (result.rowCount !== 1) throw new Error(`DATABASE_WRITE_UNSAFE_AFFECTED_ROWS: expected 1 row, SQL Server reported ${result.rowCount}.`);
  return { affectedRows: 1, elapsedMs: result.elapsedMs };
}
