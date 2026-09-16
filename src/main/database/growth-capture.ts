import type {
  DatabaseGrowthCapture,
  DatabaseGrowthTableSummary
} from '../../shared/database.js';
import {
  querySqlServer,
  type SqlServerConnection,
  type SqlServerQueryOptions,
  type SqlServerQueryResult
} from './sqlserver.js';
import { readSqlServerGrowthDiagnostics } from './growth-diagnostics.js';

export const MAX_GROWTH_CAPTURE_TABLES = 5_000;
const CAPTURE_QUERY_ROWS = MAX_GROWTH_CAPTURE_TABLES + 1;
const CAPTURE_QUERY_BYTES = 4_000_000;

type CaptureQuery = (
  connection: SqlServerConnection,
  sql: string,
  options: SqlServerQueryOptions
) => Promise<SqlServerQueryResult>;

const ALL_TABLES_SQL = `
SELECT TOP (${CAPTURE_QUERY_ROWS})
  t.object_id,
  s.name AS schema_name,
  t.name AS table_name,
  CAST(SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.row_count ELSE 0 END) AS float) AS row_count,
  CAST(SUM(ps.reserved_page_count) * 8.0 / 1024.0 AS float) AS reserved_mb,
  CAST(SUM(ps.used_page_count) * 8.0 / 1024.0 AS float) AS used_mb,
  CAST(SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.used_page_count ELSE 0 END) * 8.0 / 1024.0 AS float) AS data_mb,
  CAST(SUM(CASE WHEN ps.index_id > 1 THEN ps.used_page_count ELSE 0 END) * 8.0 / 1024.0 AS float) AS index_mb
FROM sys.dm_db_partition_stats AS ps
INNER JOIN sys.tables AS t ON t.object_id = ps.object_id
INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
GROUP BY t.object_id, s.name, t.name
ORDER BY s.name, t.name;`;

function numberValue(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function stringValue(row: Record<string, unknown>, key: string, fallback: string): string {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function tableFromRow(row: Record<string, unknown>): DatabaseGrowthTableSummary | null {
  const objectId = Math.round(numberValue(row, 'object_id'));
  if (objectId <= 0) return null;
  return {
    objectId,
    schema: stringValue(row, 'schema_name', 'dbo'),
    name: stringValue(row, 'table_name', '(unknown table)'),
    rows: Math.max(0, numberValue(row, 'row_count')),
    reservedMb: round(numberValue(row, 'reserved_mb')),
    usedMb: round(numberValue(row, 'used_mb')),
    dataMb: round(numberValue(row, 'data_mb')),
    indexMb: round(numberValue(row, 'index_mb'))
  };
}

/**
 * Explicit V2 capture used for historical snapshots and database-to-database comparisons.
 * Ordinary Growth Investigation keeps its light top-table query; the wider scan happens only
 * when a user saves a baseline or starts a comparison.
 */
export async function readSqlServerGrowthCapture(
  connection: SqlServerConnection,
  options: { signal?: AbortSignal } = {},
  query: CaptureQuery = (resolved, sql, queryOptions) => querySqlServer(resolved, sql, undefined, queryOptions)
): Promise<DatabaseGrowthCapture> {
  const diagnostics = await readSqlServerGrowthDiagnostics(connection, options, query);
  const queryOptions: SqlServerQueryOptions = {
    maxRows: CAPTURE_QUERY_ROWS,
    maxBytes: CAPTURE_QUERY_BYTES,
    ...(options.signal ? { signal: options.signal } : {})
  };
  const limitations = diagnostics.limitations.slice();
  let tables: DatabaseGrowthTableSummary[] = [];
  let tablesTruncated = false;

  try {
    const result = await query(connection, ALL_TABLES_SQL, queryOptions);
    tablesTruncated = result.truncated || result.rows.length > MAX_GROWTH_CAPTURE_TABLES;
    tables = result.rows
      .slice(0, MAX_GROWTH_CAPTURE_TABLES)
      .map(tableFromRow)
      .filter((table): table is DatabaseGrowthTableSummary => table !== null);
    if (tablesTruncated) {
      limitations.push(`Table storage capture was limited to ${MAX_GROWTH_CAPTURE_TABLES.toLocaleString('en-US')} user tables.`);
    }
  } catch {
    limitations.push('Full per-table storage capture is unavailable for this login. Database comparison can still compare file allocation and log usage.');
  }

  return {
    captureVersion: 2,
    database: diagnostics.database,
    capturedAt: diagnostics.capturedAt,
    summary: diagnostics.summary,
    files: diagnostics.files,
    tables,
    tablesTruncated,
    limitations: [...new Set(limitations)]
  };
}
