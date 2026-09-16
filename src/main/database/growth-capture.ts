import type {
  DatabaseGrowthCapture,
  DatabaseGrowthTableFingerprint,
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

const SCHEMA_FINGERPRINTS_SQL = `
-- COS_GROWTH_SCHEMA_FINGERPRINTS
SELECT TOP (${CAPTURE_QUERY_ROWS})
  s.name AS schema_name,
  t.name AS table_name,
  CAST((
    SELECT COUNT(*)
    FROM sys.columns AS c
    WHERE c.object_id = t.object_id
  ) AS int) AS column_count,
  CONVERT(varchar(32), COALESCE((
    SELECT CHECKSUM_AGG(BINARY_CHECKSUM(
      c.column_id,
      c.name,
      c.system_type_id,
      c.user_type_id,
      c.max_length,
      c.precision,
      c.scale,
      c.collation_name,
      c.is_nullable,
      c.is_identity,
      c.is_computed,
      dc.definition,
      cc.definition
    ))
    FROM sys.columns AS c
    LEFT JOIN sys.default_constraints AS dc ON dc.object_id = c.default_object_id
    LEFT JOIN sys.computed_columns AS cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
    WHERE c.object_id = t.object_id
  ), 0)) AS column_hash,
  CAST((
    SELECT COUNT(*)
    FROM sys.indexes AS i
    WHERE i.object_id = t.object_id
      AND i.index_id > 0
      AND i.is_hypothetical = 0
  ) AS int) AS index_count,
  CONVERT(varchar(32), COALESCE((
    SELECT CHECKSUM_AGG(BINARY_CHECKSUM(
      i.index_id,
      i.name,
      i.type,
      i.is_unique,
      i.is_primary_key,
      i.is_unique_constraint,
      i.is_disabled,
      i.has_filter,
      i.filter_definition,
      ic.index_column_id,
      ic.column_id,
      ic.key_ordinal,
      ic.partition_ordinal,
      ic.is_descending_key,
      ic.is_included_column
    ))
    FROM sys.indexes AS i
    LEFT JOIN sys.index_columns AS ic
      ON ic.object_id = i.object_id
      AND ic.index_id = i.index_id
    WHERE i.object_id = t.object_id
      AND i.index_id > 0
      AND i.is_hypothetical = 0
  ), 0)) AS index_hash
FROM sys.tables AS t
INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
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

function fingerprintFromRow(row: Record<string, unknown>): DatabaseGrowthTableFingerprint | null {
  const schema = stringValue(row, 'schema_name', '');
  const name = stringValue(row, 'table_name', '');
  if (!schema || !name) return null;
  return {
    schema,
    name,
    columnCount: Math.max(0, Math.round(numberValue(row, 'column_count'))),
    indexCount: Math.max(0, Math.round(numberValue(row, 'index_count'))),
    columnHash: stringValue(row, 'column_hash', '0'),
    indexHash: stringValue(row, 'index_hash', '0')
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
  let tableFingerprints: DatabaseGrowthTableFingerprint[] = [];
  let schemaTruncated = false;

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

  try {
    const result = await query(connection, SCHEMA_FINGERPRINTS_SQL, queryOptions);
    schemaTruncated = result.truncated || result.rows.length > MAX_GROWTH_CAPTURE_TABLES;
    tableFingerprints = result.rows
      .slice(0, MAX_GROWTH_CAPTURE_TABLES)
      .map(fingerprintFromRow)
      .filter((fingerprint): fingerprint is DatabaseGrowthTableFingerprint => fingerprint !== null);
    if (schemaTruncated) {
      limitations.push(`Column/index schema capture was limited to ${MAX_GROWTH_CAPTURE_TABLES.toLocaleString('en-US')} user tables.`);
    }
  } catch {
    schemaTruncated = true;
    limitations.push('Column/index schema fingerprint capture is unavailable for this login. Storage comparison remains available, but schema drift cannot be proven for this capture.');
  }

  return {
    captureVersion: 2,
    database: diagnostics.database,
    capturedAt: diagnostics.capturedAt,
    summary: diagnostics.summary,
    files: diagnostics.files,
    tables,
    tablesTruncated,
    tableFingerprints,
    schemaTruncated,
    limitations: [...new Set(limitations)]
  };
}
