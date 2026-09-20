import type {
  DatabaseAgentJobSummary,
  DatabaseColumnMatch,
  DatabaseColumnProfileResult,
  DatabaseColumnSearchResult,
  DatabaseDeadlockEvent,
  DatabaseDeadlockHistoryResult,
  DatabaseDeadlockProcess,
  DatabaseFieldConsumer,
  DatabaseFieldConsumersResult,
  DatabaseIncidentReason,
  DatabaseIncidentThresholds,
  DatabaseLivePerformanceResult,
  DatabaseLiveRequest,
  DatabaseQueryStoreEntry,
  DatabaseQueryStoreRequest,
  DatabaseQueryStoreResult,
  DatabaseQueryHotspot,
  DatabaseServerIncidentCapture,
  DatabaseServerIncidentHistoryResult,
  DatabaseServerIncidentSession,
  DatabaseSchemaCompareResult,
  DatabaseSchemaDifference
} from './types.js';
import {
  querySqlServer,
  type SqlServerConnection,
  type SqlServerQueryOptions,
  type SqlServerQueryResult
} from '../../main/database/sqlserver.js';

const MAX_COLUMN_MATCHES = 200;
const PROFILE_SAMPLE_ROWS = 10_000;
const MAX_CONSUMERS = 200;
const MAX_LIVE_REQUESTS = 40;
const MAX_ACTIVE_REQUEST_SCAN = 200;
const MAX_SESSION_STATE_SCAN = 300;
const MAX_INCIDENT_SESSIONS = 80;
const MAX_HOTSPOTS = 20;
const MAX_JOBS = 200;
const MAX_SCHEMA_ROWS = 20_000;
const MAX_SCHEMA_DIFFERENCES = 500;
const MAX_PROGRAMMABLE_OBJECTS = 5_000;
const MAX_MODULE_TEXT_CHARS = 12_000;
const MAX_QUERY_STORE_ROWS = 50;
const MAX_DEADLOCK_EVENTS = 30;
const MAX_SQL_TEXT_CHARS = 8_000;
const MAX_SERVER_INCIDENT_CAPTURES = 20;
const MAX_SERVER_INCIDENT_SESSIONS = 200;

export const DEFAULT_INCIDENT_THRESHOLDS: DatabaseIncidentThresholds = {
  blockingThresholdMs: 10_000,
  longRequestThresholdMs: 60_000,
  openTransactionThresholdSeconds: 60
};

type Query = (
  connection: SqlServerConnection,
  sql: string,
  options?: SqlServerQueryOptions
) => Promise<SqlServerQueryResult>;

const defaultQuery: Query = (connection, sql, options = {}) => querySqlServer(connection, sql, undefined, options);

function num(row: Record<string, unknown> | undefined, key: string, fallback = 0): number {
  const value = row?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function str(row: Record<string, unknown> | undefined, key: string, fallback = ''): string {
  const value = row?.[key];
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return fallback;
}

function bool(row: Record<string, unknown> | undefined, key: string): boolean {
  return row?.[key] === true || row?.[key] === 1;
}

function nullableStr(row: Record<string, unknown> | undefined, key: string): string | null {
  const value = row?.[key];
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function nullableDateTime(row: Record<string, unknown> | undefined, key: string): string | null {
  const value = row?.[key];
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function boundedText(row: Record<string, unknown> | undefined, key: string): string | null {
  const value = nullableStr(row, key);
  return value === null ? null : value.slice(0, MAX_SQL_TEXT_CHARS);
}

function quoteIdentifier(value: string): string {
  return `[${value.replace(/]/g, ']]')}]`;
}

function typeDeclaration(row: Record<string, unknown>): string {
  const type = str(row, 'type_name', 'unknown');
  const maxLength = num(row, 'max_length', 0);
  const precision = num(row, 'precision', 0);
  const scale = num(row, 'scale', 0);
  if (['varchar', 'char', 'varbinary', 'binary'].includes(type)) return `${type}(${maxLength === -1 ? 'max' : maxLength})`;
  if (['nvarchar', 'nchar'].includes(type)) return `${type}(${maxLength === -1 ? 'max' : Math.floor(maxLength / 2)})`;
  if (['decimal', 'numeric'].includes(type)) return `${type}(${precision},${scale})`;
  if (['datetime2', 'datetimeoffset', 'time'].includes(type)) return `${type}(${scale})`;
  return type;
}

const COLUMN_SEARCH_SQL = `
SELECT TOP (@take)
  t.object_id,
  s.name AS schema_name,
  t.name AS table_name,
  c.column_id,
  c.name AS column_name,
  ty.name AS type_name,
  c.max_length,
  c.precision,
  c.scale,
  c.is_nullable,
  c.is_identity,
  c.is_computed,
  CASE WHEN pk.column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS is_primary_key,
  CASE WHEN ix.column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS is_indexed
FROM sys.columns AS c
INNER JOIN sys.tables AS t ON t.object_id = c.object_id AND t.is_ms_shipped = 0
INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
INNER JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
OUTER APPLY (
  SELECT TOP (1) ic.column_id
  FROM sys.indexes AS i
  INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id
) AS pk
OUTER APPLY (
  SELECT TOP (1) ic.column_id
  FROM sys.indexes AS i
  INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  WHERE i.object_id = c.object_id AND i.index_id > 0 AND i.is_hypothetical = 0 AND ic.column_id = c.column_id
) AS ix
WHERE c.name LIKE @pattern ESCAPE N'~'
ORDER BY CASE WHEN c.name = @exact THEN 0 ELSE 1 END, s.name, t.name, c.column_id;`;

function escapeLike(value: string): string {
  return value.replace(/~/g, '~~').replace(/%/g, '~%').replace(/_/g, '~_').replace(/\[/g, '~[');
}

function columnFromRow(row: Record<string, unknown>): DatabaseColumnMatch {
  return {
    objectId: Math.round(num(row, 'object_id')),
    schema: str(row, 'schema_name', 'dbo'),
    table: str(row, 'table_name', '(unknown table)'),
    columnId: Math.round(num(row, 'column_id')),
    column: str(row, 'column_name', '(unknown column)'),
    type: typeDeclaration(row),
    nullable: bool(row, 'is_nullable'),
    identity: bool(row, 'is_identity'),
    computed: bool(row, 'is_computed'),
    primaryKey: bool(row, 'is_primary_key'),
    indexed: bool(row, 'is_indexed')
  };
}

export async function searchSqlServerColumns(
  connectionId: string,
  connection: SqlServerConnection,
  search: string,
  query: Query = defaultQuery
): Promise<DatabaseColumnSearchResult> {
  const startedAt = Date.now();
  const term = search.trim();
  if (!term || term.length > 256) throw new Error('Column search must contain 1 to 256 characters.');
  const result = await query(connection, COLUMN_SEARCH_SQL, {
    maxRows: MAX_COLUMN_MATCHES + 1,
    maxBytes: 1_000_000,
    parameters: { take: MAX_COLUMN_MATCHES + 1, pattern: `%${escapeLike(term)}%`, exact: term }
  });
  return {
    connection: connectionId,
    database: connection.database ?? '',
    search: term,
    matches: result.rows.slice(0, MAX_COLUMN_MATCHES).map(columnFromRow),
    truncated: result.truncated || result.rows.length > MAX_COLUMN_MATCHES,
    elapsedMs: Date.now() - startedAt
  };
}

const COLUMN_BY_ID_SQL = `
SELECT TOP (1)
  t.object_id,
  s.name AS schema_name,
  t.name AS table_name,
  c.column_id,
  c.name AS column_name,
  ty.name AS type_name,
  c.max_length,
  c.precision,
  c.scale,
  c.is_nullable,
  c.is_identity,
  c.is_computed,
  CASE WHEN pk.column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS is_primary_key,
  CASE WHEN ix.column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS is_indexed
FROM sys.columns AS c
INNER JOIN sys.tables AS t ON t.object_id = c.object_id AND t.is_ms_shipped = 0
INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
INNER JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
OUTER APPLY (
  SELECT TOP (1) ic.column_id FROM sys.indexes AS i
  INNER JOIN sys.index_columns AS ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
  WHERE i.object_id=c.object_id AND i.is_primary_key=1 AND ic.column_id=c.column_id
) AS pk
OUTER APPLY (
  SELECT TOP (1) ic.column_id FROM sys.indexes AS i
  INNER JOIN sys.index_columns AS ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
  WHERE i.object_id=c.object_id AND i.index_id>0 AND i.is_hypothetical=0 AND ic.column_id=c.column_id
) AS ix
WHERE t.object_id=@object_id AND c.name=@column_name;`;

export async function profileSqlServerColumn(
  connectionId: string,
  connection: SqlServerConnection,
  objectId: number,
  columnName: string,
  query: Query = defaultQuery
): Promise<DatabaseColumnProfileResult> {
  const startedAt = Date.now();
  const header = await query(connection, COLUMN_BY_ID_SQL, {
    maxRows: 2,
    maxBytes: 32_000,
    parameters: { object_id: objectId, column_name: columnName }
  });
  const row = header.rows[0];
  if (!row) throw new Error('The selected column no longer exists.');
  const column = columnFromRow(row);
  const schema = column.schema;
  const table = column.table;
  const quotedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const quotedColumn = quoteIdentifier(column.column);
  const baseType = str(row, 'type_name').toLowerCase();
  const limitations: string[] = [
    `Profile statistics use at most ${PROFILE_SAMPLE_ROWS.toLocaleString('en-US')} rows to avoid a full customer-table scan.`
  ];
  const unsupported = ['image', 'text', 'ntext', 'xml', 'geography', 'geometry', 'hierarchyid'].includes(baseType);
  if (unsupported) limitations.push(`Value profiling is limited for SQL Server type ${baseType}; NULL counts remain available.`);

  const normalized = unsupported ? 'CAST(NULL AS nvarchar(4000))' : `TRY_CONVERT(nvarchar(4000), ${quotedColumn})`;
  const statsSql = `
WITH sample AS (
  SELECT TOP (${PROFILE_SAMPLE_ROWS}) ${quotedColumn} AS value
  FROM ${quotedTable} WITH (READUNCOMMITTED)
)
SELECT
  COUNT_BIG(*) AS sampled_rows,
  SUM(CASE WHEN value IS NULL THEN CAST(1 AS bigint) ELSE CAST(0 AS bigint) END) AS null_rows,
  ${unsupported ? 'CAST(NULL AS bigint)' : `SUM(CASE WHEN value IS NOT NULL AND ${normalized} = N'' THEN CAST(1 AS bigint) ELSE CAST(0 AS bigint) END)`} AS blank_rows,
  ${unsupported ? 'CAST(NULL AS bigint)' : `COUNT_BIG(DISTINCT ${normalized})`} AS distinct_values,
  ${unsupported ? 'CAST(NULL AS nvarchar(4000))' : `MIN(${normalized})`} AS min_value,
  ${unsupported ? 'CAST(NULL AS nvarchar(4000))' : `MAX(${normalized})`} AS max_value,
  MAX(CASE WHEN value IS NULL THEN NULL ELSE DATALENGTH(value) END) AS max_data_length_bytes
FROM sample;`;
  const examplesSql = unsupported ? null : `
WITH sample AS (
  SELECT TOP (${PROFILE_SAMPLE_ROWS}) ${quotedColumn} AS value
  FROM ${quotedTable} WITH (READUNCOMMITTED)
)
SELECT TOP (12) ${normalized} AS value, COUNT_BIG(*) AS value_count
FROM sample
GROUP BY ${normalized}
ORDER BY COUNT_BIG(*) DESC, ${normalized};`;
  const [stats, examples] = await Promise.all([
    query(connection, statsSql, { maxRows: 2, maxBytes: 64_000 }),
    examplesSql ? query(connection, examplesSql, { maxRows: 12, maxBytes: 128_000 }) : Promise.resolve(null)
  ]);
  const statsRow = stats.rows[0] ?? {};
  return {
    connection: connectionId,
    database: connection.database ?? '',
    object: { objectId: column.objectId, schema, table },
    column,
    sampleLimit: PROFILE_SAMPLE_ROWS,
    sampledRows: num(statsRow, 'sampled_rows'),
    nullRows: num(statsRow, 'null_rows'),
    blankRows: statsRow.blank_rows === null || statsRow.blank_rows === undefined ? null : num(statsRow, 'blank_rows'),
    distinctValues: statsRow.distinct_values === null || statsRow.distinct_values === undefined ? null : num(statsRow, 'distinct_values'),
    minValue: nullableStr(statsRow, 'min_value'),
    maxValue: nullableStr(statsRow, 'max_value'),
    maxDataLengthBytes: statsRow.max_data_length_bytes === null || statsRow.max_data_length_bytes === undefined ? null : num(statsRow, 'max_data_length_bytes'),
    examples: (examples?.rows ?? []).map(example => ({ value: nullableStr(example, 'value'), count: num(example, 'value_count') })),
    limitations,
    elapsedMs: Date.now() - startedAt
  };
}

const FIELD_CONSUMERS_SQL = `
SELECT TOP (@take)
  o.object_id,
  s.name AS schema_name,
  o.name AS object_name,
  o.type_desc,
  CASE WHEN EXISTS (
    SELECT 1 FROM sys.sql_expression_dependencies AS d
    WHERE d.referencing_id=o.object_id AND d.referenced_id=@object_id
  ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS references_table,
  CASE WHEN m.definition LIKE @column_pattern ESCAPE N'~' THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS mentions_column
FROM sys.objects AS o
INNER JOIN sys.schemas AS s ON s.schema_id=o.schema_id
INNER JOIN sys.sql_modules AS m ON m.object_id=o.object_id
WHERE o.is_ms_shipped=0
  AND (
    EXISTS (SELECT 1 FROM sys.sql_expression_dependencies AS d WHERE d.referencing_id=o.object_id AND d.referenced_id=@object_id)
    OR m.definition LIKE @column_pattern ESCAPE N'~'
  )
ORDER BY references_table DESC, mentions_column DESC, s.name, o.name;`;

export async function readSqlServerFieldConsumers(
  connectionId: string,
  connection: SqlServerConnection,
  objectId: number,
  columnName: string,
  query: Query = defaultQuery
): Promise<DatabaseFieldConsumersResult> {
  const startedAt = Date.now();
  const header = await query(connection, COLUMN_BY_ID_SQL, {
    maxRows: 2,
    maxBytes: 32_000,
    parameters: { object_id: objectId, column_name: columnName }
  });
  const sourceRow = header.rows[0];
  if (!sourceRow) throw new Error('The selected column no longer exists.');
  const source = columnFromRow(sourceRow);
  const result = await query(connection, FIELD_CONSUMERS_SQL, {
    maxRows: MAX_CONSUMERS + 1,
    maxBytes: 1_000_000,
    parameters: {
      take: MAX_CONSUMERS + 1,
      object_id: objectId,
      column_pattern: `%${escapeLike(columnName)}%`
    }
  });
  const consumers: DatabaseFieldConsumer[] = result.rows.slice(0, MAX_CONSUMERS).map(row => {
    const referencesTable = bool(row, 'references_table');
    const mentionsColumn = bool(row, 'mentions_column');
    const confidence = referencesTable && mentionsColumn ? 'high' : mentionsColumn ? 'medium' : 'low';
    return {
      objectId: Math.round(num(row, 'object_id')),
      schema: str(row, 'schema_name', 'dbo'),
      name: str(row, 'object_name', '(unknown object)'),
      type: str(row, 'type_desc', 'UNKNOWN'),
      dependencyDirection: referencesTable ? 'references-table' : 'text-match',
      confidence,
      reason: referencesTable && mentionsColumn
        ? 'SQL Server records a dependency on the table and the module text mentions this column.'
        : mentionsColumn
          ? 'The module text mentions this column, but SQL Server does not prove a direct dependency on this table.'
          : 'SQL Server records a dependency on the table; column-level usage is not proven.'
    };
  });
  return {
    connection: connectionId,
    database: connection.database ?? '',
    source: { objectId, schema: source.schema, table: source.table, column: source.column },
    consumers,
    limitations: [
      'Dependency metadata is strongest for static SQL. Dynamic SQL, application code and encrypted modules can be missing.',
      ...(result.truncated || result.rows.length > MAX_CONSUMERS ? [`Only the first ${MAX_CONSUMERS} consumers are shown.`] : [])
    ],
    elapsedMs: Date.now() - startedAt
  };
}

const LIVE_REQUESTS_SQL = `
SELECT TOP (${MAX_ACTIVE_REQUEST_SCAN + 1})
  r.session_id,
  r.status,
  s.status AS session_status,
  r.command,
  DB_NAME(r.database_id) AS database_name,
  s.login_name,
  s.host_name,
  s.program_name,
  r.total_elapsed_time,
  r.cpu_time,
  r.logical_reads,
  r.writes,
  r.wait_type,
  r.last_wait_type,
  r.wait_time,
  r.wait_resource,
  r.blocking_session_id,
  s.open_transaction_count,
  CONVERT(varchar(18), r.query_hash, 1) AS query_hash,
  CONVERT(varchar(18), r.query_plan_hash, 1) AS query_plan_hash,
  LEFT(
    CASE
      WHEN st.text IS NULL THEN NULL
      WHEN r.statement_start_offset IS NULL THEN st.text
      ELSE SUBSTRING(
        st.text,
        (r.statement_start_offset / 2) + 1,
        ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(st.text) ELSE r.statement_end_offset END - r.statement_start_offset) / 2) + 1
      )
    END,
    ${MAX_SQL_TEXT_CHARS}
  ) AS sql_text
FROM sys.dm_exec_requests AS r
INNER JOIN sys.dm_exec_sessions AS s ON s.session_id=r.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) AS st
WHERE r.session_id<>@@SPID AND s.is_user_process=1
ORDER BY CASE WHEN r.blocking_session_id<>0 THEN 0 ELSE 1 END, r.total_elapsed_time DESC, r.session_id;`;

const SESSION_STATE_SQL = `
WITH transaction_state AS (
  SELECT st.session_id, MIN(at.transaction_begin_time) AS transaction_begin_time
  FROM sys.dm_tran_session_transactions AS st
  INNER JOIN sys.dm_tran_active_transactions AS at ON at.transaction_id=st.transaction_id
  GROUP BY st.session_id
)
SELECT TOP (${MAX_SESSION_STATE_SCAN + 1})
  s.session_id,
  s.status AS session_status,
  s.login_name,
  s.host_name,
  s.program_name,
  s.open_transaction_count,
  tx.transaction_begin_time,
  DB_NAME(txt.dbid) AS database_name,
  LEFT(txt.text, ${MAX_SQL_TEXT_CHARS}) AS sql_text
FROM sys.dm_exec_sessions AS s
LEFT JOIN transaction_state AS tx ON tx.session_id=s.session_id
OUTER APPLY (
  SELECT TOP (1) c.most_recent_sql_handle
  FROM sys.dm_exec_connections AS c
  WHERE c.session_id=s.session_id
  ORDER BY c.connect_time DESC
) AS conn
OUTER APPLY sys.dm_exec_sql_text(conn.most_recent_sql_handle) AS txt
WHERE s.is_user_process=1 AND s.session_id<>@@SPID
ORDER BY CASE WHEN s.open_transaction_count>0 THEN 0 ELSE 1 END, s.session_id;`;

const HOTSPOTS_SQL = `
SELECT TOP (${MAX_HOTSPOTS})
  qs.execution_count,
  qs.total_elapsed_time / 1000.0 AS total_elapsed_ms,
  (qs.total_elapsed_time / NULLIF(qs.execution_count,0)) / 1000.0 AS avg_elapsed_ms,
  qs.total_worker_time / 1000.0 AS total_cpu_ms,
  qs.total_logical_reads,
  qs.last_execution_time,
  LEFT(st.text, 8000) AS sql_text
FROM sys.dm_exec_query_stats AS qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) AS st
WHERE st.dbid=DB_ID() OR st.dbid IS NULL
ORDER BY qs.total_elapsed_time DESC;`;

interface SessionStateEvidence {
  sessionId: number;
  status: string;
  database: string | null;
  login: string | null;
  host: string | null;
  program: string | null;
  openTransactionCount: number;
  transactionBeginTime: string | null;
  sql: string | null;
}

function normalizeIncidentThresholds(value: Partial<DatabaseIncidentThresholds>): DatabaseIncidentThresholds {
  const thresholds = { ...DEFAULT_INCIDENT_THRESHOLDS, ...value };
  for (const [name, threshold] of Object.entries(thresholds)) {
    if (!Number.isFinite(threshold) || threshold < 0) throw new Error(`${name} must be a non-negative number.`);
  }
  return thresholds;
}

function transactionAgeSeconds(begin: string | null, capturedAtMs: number): number | null {
  if (!begin) return null;
  const startedAt = new Date(begin).getTime();
  if (!Number.isFinite(startedAt)) return null;
  return Math.max(0, Math.floor((capturedAtMs - startedAt) / 1000));
}

function sessionStateFromRow(row: Record<string, unknown>): SessionStateEvidence {
  return {
    sessionId: Math.round(num(row, 'session_id')),
    status: str(row, 'session_status', 'unknown'),
    database: nullableStr(row, 'database_name'),
    login: nullableStr(row, 'login_name'),
    host: nullableStr(row, 'host_name'),
    program: nullableStr(row, 'program_name'),
    openTransactionCount: Math.max(0, Math.round(num(row, 'open_transaction_count'))),
    transactionBeginTime: nullableDateTime(row, 'transaction_begin_time'),
    sql: boundedText(row, 'sql_text')
  };
}

function baseRequestFromRow(row: Record<string, unknown>): DatabaseLiveRequest {
  return {
    sessionId: Math.round(num(row, 'session_id')),
    status: str(row, 'status', 'unknown'),
    command: str(row, 'command', 'unknown'),
    database: nullableStr(row, 'database_name'),
    login: nullableStr(row, 'login_name'),
    host: nullableStr(row, 'host_name'),
    program: nullableStr(row, 'program_name'),
    elapsedMs: Math.max(0, num(row, 'total_elapsed_time')),
    cpuMs: Math.max(0, num(row, 'cpu_time')),
    logicalReads: Math.max(0, num(row, 'logical_reads')),
    writes: Math.max(0, num(row, 'writes')),
    waitType: nullableStr(row, 'wait_type'),
    lastWaitType: nullableStr(row, 'last_wait_type'),
    waitMs: Math.max(0, num(row, 'wait_time')),
    waitResource: nullableStr(row, 'wait_resource'),
    blockingSessionId: Math.round(num(row, 'blocking_session_id')),
    openTransactionCount: Math.max(0, Math.round(num(row, 'open_transaction_count'))),
    transactionBeginTime: null,
    transactionAgeSeconds: null,
    queryHash: nullableStr(row, 'query_hash'),
    queryPlanHash: nullableStr(row, 'query_plan_hash'),
    isBlocked: false,
    isBlocker: false,
    isRootBlocker: false,
    isSleepingTransaction: false,
    reasonMask: 0,
    sql: boundedText(row, 'sql_text')
  };
}

function blockingChainSessionIds(active: readonly DatabaseLiveRequest[], blockingThresholdMs: number): Set<number> {
  const bySession = new Map(active.map(request => [request.sessionId, request]));
  const chain = new Set<number>();
  for (const seed of active) {
    if (seed.blockingSessionId <= 0 || seed.waitMs < blockingThresholdMs) continue;
    let current: DatabaseLiveRequest | undefined = seed;
    const visited = new Set<number>();
    while (current && !visited.has(current.sessionId)) {
      visited.add(current.sessionId);
      chain.add(current.sessionId);
      if (current.blockingSessionId <= 0) break;
      chain.add(current.blockingSessionId);
      current = bySession.get(current.blockingSessionId);
    }
  }
  return chain;
}

function incidentReasonMask(
  request: DatabaseLiveRequest,
  state: SessionStateEvidence | undefined,
  chain: ReadonlySet<number>,
  thresholds: DatabaseIncidentThresholds,
  capturedAtMs: number
): number {
  let mask = 0;
  if (request.blockingSessionId !== 0 && request.waitMs >= thresholds.blockingThresholdMs) mask |= 1;
  if (request.elapsedMs >= thresholds.longRequestThresholdMs) mask |= 2;
  const age = transactionAgeSeconds(state?.transactionBeginTime ?? request.transactionBeginTime, capturedAtMs);
  if (age !== null && age >= thresholds.openTransactionThresholdSeconds) mask |= 4;
  if (chain.has(request.sessionId)) mask |= 8;
  return mask;
}

function enrichRequest(
  request: DatabaseLiveRequest,
  state: SessionStateEvidence | undefined,
  blockerIds: ReadonlySet<number>,
  chain: ReadonlySet<number>,
  activeBySession: ReadonlyMap<number, DatabaseLiveRequest>,
  thresholds: DatabaseIncidentThresholds,
  capturedAtMs: number
): DatabaseLiveRequest {
  const blockingSessionId = request.blockingSessionId;
  const begin = state?.transactionBeginTime ?? request.transactionBeginTime;
  const age = transactionAgeSeconds(begin, capturedAtMs);
  const isBlocker = blockerIds.has(request.sessionId);
  const active = activeBySession.get(request.sessionId);
  const isRootBlocker = isBlocker && (!active || active.blockingSessionId === 0);
  const openTransactionCount = state?.openTransactionCount ?? request.openTransactionCount;
  const sessionStatus = state?.status ?? request.status;
  const enriched: DatabaseLiveRequest = {
    ...request,
    database: request.database ?? state?.database ?? null,
    login: request.login ?? state?.login ?? null,
    host: request.host ?? state?.host ?? null,
    program: request.program ?? state?.program ?? null,
    openTransactionCount,
    transactionBeginTime: begin,
    transactionAgeSeconds: age,
    isBlocked: blockingSessionId !== 0,
    isBlocker,
    isRootBlocker,
    isSleepingTransaction: sessionStatus.toLowerCase() === 'sleeping' && openTransactionCount > 0 && begin !== null,
    sql: request.sql ?? state?.sql ?? null
  };
  enriched.reasonMask = incidentReasonMask(enriched, state, chain, thresholds, capturedAtMs);
  return enriched;
}

function idleSessionRequest(state: SessionStateEvidence): DatabaseLiveRequest {
  return {
    sessionId: state.sessionId,
    status: state.status,
    command: 'idle',
    database: state.database,
    login: state.login,
    host: state.host,
    program: state.program,
    elapsedMs: 0,
    cpuMs: 0,
    logicalReads: 0,
    writes: 0,
    waitType: null,
    lastWaitType: null,
    waitMs: 0,
    waitResource: null,
    blockingSessionId: 0,
    openTransactionCount: state.openTransactionCount,
    transactionBeginTime: state.transactionBeginTime,
    transactionAgeSeconds: null,
    queryHash: null,
    queryPlanHash: null,
    isBlocked: false,
    isBlocker: false,
    isRootBlocker: false,
    isSleepingTransaction: false,
    reasonMask: 0,
    sql: state.sql
  };
}

export async function readSqlServerLivePerformance(
  connectionId: string,
  connection: SqlServerConnection,
  query: Query = defaultQuery,
  thresholdOverrides: Partial<DatabaseIncidentThresholds> = {}
): Promise<DatabaseLivePerformanceResult> {
  const startedAt = Date.now();
  const capturedAt = new Date();
  const capturedAtMs = capturedAt.getTime();
  const thresholds = normalizeIncidentThresholds(thresholdOverrides);
  const limitations: string[] = [];
  const [requestsSettled, sessionsSettled, hotspotsSettled] = await Promise.allSettled([
    query(connection, LIVE_REQUESTS_SQL, { maxRows: MAX_ACTIVE_REQUEST_SCAN + 1, maxBytes: 3_000_000 }),
    query(connection, SESSION_STATE_SQL, { maxRows: MAX_SESSION_STATE_SCAN + 1, maxBytes: 3_000_000 }),
    query(connection, HOTSPOTS_SQL, { maxRows: MAX_HOTSPOTS, maxBytes: 1_000_000 })
  ]);
  if (requestsSettled.status === 'rejected') limitations.push('Live requests are unavailable. The SQL login may need VIEW SERVER STATE (or VIEW SERVER PERFORMANCE STATE on newer SQL Server versions).');
  if (sessionsSettled.status === 'rejected') limitations.push('Session and transaction state is unavailable. Sleeping blockers and long open transactions may be missing.');
  if (hotspotsSettled.status === 'rejected') limitations.push('Cached query hotspots are unavailable for this login or SQL Server configuration.');
  const rawActive = requestsSettled.status === 'fulfilled'
    ? requestsSettled.value.rows.slice(0, MAX_ACTIVE_REQUEST_SCAN).map(baseRequestFromRow)
    : [];
  if (requestsSettled.status === 'fulfilled' && (requestsSettled.value.truncated || requestsSettled.value.rows.length > MAX_ACTIVE_REQUEST_SCAN)) {
    limitations.push(`Only the first ${MAX_ACTIVE_REQUEST_SCAN} active requests were inspected; a very large blocking chain may be incomplete.`);
  }
  const sessionStates = sessionsSettled.status === 'fulfilled'
    ? sessionsSettled.value.rows.slice(0, MAX_SESSION_STATE_SCAN).map(sessionStateFromRow)
    : [];
  if (sessionsSettled.status === 'fulfilled' && (sessionsSettled.value.truncated || sessionsSettled.value.rows.length > MAX_SESSION_STATE_SCAN)) {
    limitations.push(`Only the first ${MAX_SESSION_STATE_SCAN} user sessions were inspected for sleeping blockers and open transactions.`);
  }
  const stateBySession = new Map(sessionStates.map(state => [state.sessionId, state]));
  const activeBySession = new Map(rawActive.map(request => [request.sessionId, request]));
  const blockerIds = new Set(rawActive.map(request => request.blockingSessionId).filter(id => id > 0));
  const chain = blockingChainSessionIds(rawActive, thresholds.blockingThresholdMs);
  const activeEvidence = rawActive.map(request => enrichRequest(
    request,
    stateBySession.get(request.sessionId),
    blockerIds,
    chain,
    activeBySession,
    thresholds,
    capturedAtMs
  ));
  const incidentBySession = new Map<number, DatabaseLiveRequest>();
  for (const request of activeEvidence) {
    if (request.reasonMask !== 0) incidentBySession.set(request.sessionId, request);
  }
  for (const state of sessionStates) {
    if (activeBySession.has(state.sessionId)) continue;
    const request = idleSessionRequest(state);
    const enriched = enrichRequest(request, state, blockerIds, chain, activeBySession, thresholds, capturedAtMs);
    if (enriched.reasonMask !== 0) incidentBySession.set(enriched.sessionId, enriched);
  }
  const incidentSessions = [...incidentBySession.values()]
    .sort((left, right) => Number(right.isRootBlocker) - Number(left.isRootBlocker)
      || Number(right.isBlocked) - Number(left.isBlocked)
      || right.reasonMask - left.reasonMask
      || left.sessionId - right.sessionId)
    .slice(0, MAX_INCIDENT_SESSIONS);
  if (incidentBySession.size > MAX_INCIDENT_SESSIONS) {
    limitations.push(`Incident evidence is limited to ${MAX_INCIDENT_SESSIONS} sessions.`);
  }
  const hotspots: DatabaseQueryHotspot[] = hotspotsSettled.status === 'fulfilled' ? hotspotsSettled.value.rows.map(row => ({
    executionCount: num(row, 'execution_count'),
    totalElapsedMs: num(row, 'total_elapsed_ms'),
    avgElapsedMs: num(row, 'avg_elapsed_ms'),
    totalCpuMs: num(row, 'total_cpu_ms'),
    totalLogicalReads: num(row, 'total_logical_reads'),
    lastExecutionAt: nullableStr(row, 'last_execution_time'),
    sql: boundedText(row, 'sql_text')
  })) : [];
  const rootBlockers = [...blockerIds].filter(sessionId => {
    const blocker = activeBySession.get(sessionId);
    return !blocker || blocker.blockingSessionId === 0;
  });
  return {
    connection: connectionId,
    database: connection.database ?? '',
    capturedAt: capturedAt.toISOString(),
    requests: activeEvidence.slice(0, MAX_LIVE_REQUESTS),
    incidentSessions,
    hotspots,
    activeRequestCount: rawActive.length,
    blockedRequestCount: activeEvidence.filter(request => request.isBlocked).length,
    rootBlockerSessionIds: rootBlockers,
    thresholds,
    limitations,
    elapsedMs: Date.now() - startedAt
  };
}

export function decodeIncidentReasonMask(mask: number): DatabaseIncidentReason[] {
  const reasons: DatabaseIncidentReason[] = [];
  if ((mask & 1) !== 0) reasons.push('blocked');
  if ((mask & 2) !== 0) reasons.push('long-request');
  if ((mask & 4) !== 0) reasons.push('long-transaction');
  if ((mask & 8) !== 0) reasons.push('blocking-chain');
  return reasons;
}

const SERVER_INCIDENT_HISTORY_SQL = `
WITH recent_capture AS (
  SELECT TOP (${MAX_SERVER_INCIDENT_CAPTURES})
    CaptureId, CapturedAt, ServerName, InstanceName, BlockingCount, LongRequestCount, OpenTransactionCount
  FROM [LinkQDiagnostics].[diag].[Capture]
  ORDER BY CapturedAt DESC, CaptureId DESC
)
SELECT TOP (${MAX_SERVER_INCIDENT_SESSIONS + 1})
  c.CaptureId AS capture_id,
  c.CapturedAt AS captured_at,
  c.ServerName AS server_name,
  c.InstanceName AS instance_name,
  c.BlockingCount AS blocking_count,
  c.LongRequestCount AS long_request_count,
  c.OpenTransactionCount AS capture_open_transaction_count,
  s.SessionId AS session_id,
  s.BlockingSessionId AS blocking_session_id,
  s.DatabaseName AS database_name,
  s.LoginName AS login_name,
  s.HostName AS host_name,
  s.ProgramName AS program_name,
  s.SessionStatus AS session_status,
  s.RequestStatus AS request_status,
  s.Command AS command,
  s.WaitType AS wait_type,
  s.LastWaitType AS last_wait_type,
  s.WaitTimeMs AS wait_time_ms,
  s.WaitResource AS wait_resource,
  s.CpuTimeMs AS cpu_time_ms,
  s.TotalElapsedTimeMs AS total_elapsed_time_ms,
  s.LogicalReads AS logical_reads,
  s.Writes AS writes,
  s.OpenTransactionCount AS open_transaction_count,
  s.TransactionBeginTime AS transaction_begin_time,
  s.IsBlocked AS is_blocked,
  s.IsBlocker AS is_blocker,
  s.IsRootBlocker AS is_root_blocker,
  s.IsSleepingTransaction AS is_sleeping_transaction,
  s.ReasonMask AS reason_mask,
  LEFT(s.SqlText, ${MAX_SQL_TEXT_CHARS}) AS sql_text,
  LEFT(s.RunningStatement, ${MAX_SQL_TEXT_CHARS}) AS running_statement,
  CONVERT(varchar(18), s.QueryHash, 1) AS query_hash,
  CONVERT(varchar(18), s.QueryPlanHash, 1) AS query_plan_hash
FROM recent_capture AS c
LEFT JOIN [LinkQDiagnostics].[diag].[SessionSnapshot] AS s ON s.CaptureId=c.CaptureId
ORDER BY c.CapturedAt DESC, c.CaptureId DESC, s.IsRootBlocker DESC, s.IsBlocked DESC, s.SessionId;`;

export async function readSqlServerDiagnosticHistory(
  connectionId: string,
  connection: SqlServerConnection,
  query: Query = defaultQuery
): Promise<DatabaseServerIncidentHistoryResult> {
  const startedAt = Date.now();
  const capturedAt = new Date().toISOString();
  try {
    const result = await query(connection, SERVER_INCIDENT_HISTORY_SQL, {
      maxRows: MAX_SERVER_INCIDENT_SESSIONS + 1,
      maxBytes: 5_000_000
    });
    const captureMap = new Map<number, DatabaseServerIncidentCapture>();
    for (const row of result.rows.slice(0, MAX_SERVER_INCIDENT_SESSIONS)) {
      const captureId = Math.round(num(row, 'capture_id'));
      const captureTime = nullableDateTime(row, 'captured_at');
      if (!captureId || !captureTime) continue;
      let capture = captureMap.get(captureId);
      if (!capture) {
        capture = {
          captureId,
          capturedAt: captureTime,
          serverName: nullableStr(row, 'server_name'),
          instanceName: nullableStr(row, 'instance_name'),
          blockingCount: Math.max(0, Math.round(num(row, 'blocking_count'))),
          longRequestCount: Math.max(0, Math.round(num(row, 'long_request_count'))),
          openTransactionCount: Math.max(0, Math.round(num(row, 'capture_open_transaction_count'))),
          sessions: []
        };
        captureMap.set(captureId, capture);
      }
      if (row.session_id === null || row.session_id === undefined) continue;
      const transactionBeginTime = nullableDateTime(row, 'transaction_begin_time');
      const reasonMask = Math.max(0, Math.round(num(row, 'reason_mask')));
      const session: DatabaseServerIncidentSession = {
        captureId,
        sessionId: Math.round(num(row, 'session_id')),
        status: str(row, 'request_status') || str(row, 'session_status', 'unknown'),
        command: str(row, 'command', 'idle'),
        database: nullableStr(row, 'database_name'),
        login: nullableStr(row, 'login_name'),
        host: nullableStr(row, 'host_name'),
        program: nullableStr(row, 'program_name'),
        elapsedMs: Math.max(0, num(row, 'total_elapsed_time_ms')),
        cpuMs: Math.max(0, num(row, 'cpu_time_ms')),
        logicalReads: Math.max(0, num(row, 'logical_reads')),
        writes: Math.max(0, num(row, 'writes')),
        waitType: nullableStr(row, 'wait_type'),
        lastWaitType: nullableStr(row, 'last_wait_type'),
        waitMs: Math.max(0, num(row, 'wait_time_ms')),
        waitResource: nullableStr(row, 'wait_resource'),
        blockingSessionId: Math.round(num(row, 'blocking_session_id')),
        openTransactionCount: Math.max(0, Math.round(num(row, 'open_transaction_count'))),
        transactionBeginTime,
        transactionAgeSeconds: transactionAgeSeconds(transactionBeginTime, new Date(captureTime).getTime()),
        queryHash: nullableStr(row, 'query_hash'),
        queryPlanHash: nullableStr(row, 'query_plan_hash'),
        isBlocked: bool(row, 'is_blocked'),
        isBlocker: bool(row, 'is_blocker'),
        isRootBlocker: bool(row, 'is_root_blocker'),
        isSleepingTransaction: bool(row, 'is_sleeping_transaction'),
        reasonMask,
        reasons: decodeIncidentReasonMask(reasonMask),
        sql: boundedText(row, 'sql_text'),
        runningStatement: boundedText(row, 'running_statement')
      };
      capture.sessions.push(session);
    }
    const limitations: string[] = [];
    if (result.truncated || result.rows.length > MAX_SERVER_INCIDENT_SESSIONS) {
      limitations.push(`Only the first ${MAX_SERVER_INCIDENT_SESSIONS} diagnostic session rows are shown.`);
    }
    return {
      connection: connectionId,
      database: connection.database ?? '',
      capturedAt,
      available: true,
      captures: [...captureMap.values()],
      limitations,
      elapsedMs: Date.now() - startedAt
    };
  } catch {
    return {
      connection: connectionId,
      database: connection.database ?? '',
      capturedAt,
      available: false,
      captures: [],
      limitations: ['Server incident history is unavailable. LinkQDiagnostics may not be installed on this SQL Server, or this login cannot read its diag history.'],
      elapsedMs: Date.now() - startedAt
    };
  }
}

const QUERY_STORE_OPTIONS_SQL = `
SELECT TOP (1)
  actual_state_desc,
  desired_state_desc,
  readonly_reason,
  current_storage_size_mb,
  max_storage_size_mb
FROM sys.database_query_store_options;`;

function queryStoreOrder(sort: DatabaseQueryStoreRequest['sort']): string {
  if (sort === 'cpu') return 'avg_cpu_ms DESC';
  if (sort === 'reads') return 'avg_logical_reads DESC';
  if (sort === 'executions') return 'execution_count DESC';
  return 'avg_duration_ms DESC';
}

export async function readSqlServerQueryStore(
  connectionId: string,
  connection: SqlServerConnection,
  request: Omit<DatabaseQueryStoreRequest, 'connection'> = {},
  query: Query = defaultQuery
): Promise<DatabaseQueryStoreResult> {
  const startedAt = Date.now();
  const hours = request.hours ?? 24;
  const sort = request.sort ?? 'duration';
  const limitations: string[] = [];
  let options: SqlServerQueryResult;
  try {
    options = await query(connection, QUERY_STORE_OPTIONS_SQL, { maxRows: 1, maxBytes: 32_000 });
  } catch {
    return {
      connection: connectionId,
      database: connection.database ?? '',
      capturedAt: new Date().toISOString(),
      available: false,
      actualState: null,
      desiredState: null,
      readonlyReason: null,
      currentStorageMb: null,
      maxStorageMb: null,
      hours,
      sort,
      queries: [],
      limitations: ['Query Store is unavailable. The database may be on an older SQL Server version, or this login cannot read Query Store metadata.'],
      elapsedMs: Date.now() - startedAt
    };
  }
  const option = options.rows[0] ?? {};
  const actualState = nullableStr(option, 'actual_state_desc');
  const desiredState = nullableStr(option, 'desired_state_desc');
  const readonlyReason = option.readonly_reason === null || option.readonly_reason === undefined ? null : num(option, 'readonly_reason');
  const currentStorageMb = option.current_storage_size_mb === null || option.current_storage_size_mb === undefined ? null : num(option, 'current_storage_size_mb');
  const maxStorageMb = option.max_storage_size_mb === null || option.max_storage_size_mb === undefined ? null : num(option, 'max_storage_size_mb');
  if (!actualState || actualState.toUpperCase() === 'OFF') {
    return {
      connection: connectionId,
      database: connection.database ?? '',
      capturedAt: new Date().toISOString(),
      available: false,
      actualState,
      desiredState,
      readonlyReason,
      currentStorageMb,
      maxStorageMb,
      hours,
      sort,
      queries: [],
      limitations: ['Query Store is OFF for this database, so historical query runtime evidence is not being collected here.'],
      elapsedMs: Date.now() - startedAt
    };
  }
  if (actualState.toUpperCase() === 'READ_ONLY') {
    limitations.push('Query Store is READ_ONLY. Existing history can be read, but SQL Server is not currently recording new Query Store runtime data.');
  }
  const statsSql = `
WITH weighted AS (
  SELECT
    q.query_id,
    p.plan_id,
    LEFT(qt.query_sql_text, 8000) AS sql_text,
    SUM(CONVERT(bigint, rs.count_executions)) AS execution_count,
    SUM(CONVERT(float, rs.avg_duration) * rs.count_executions) / NULLIF(SUM(CONVERT(float, rs.count_executions)), 0) / 1000.0 AS avg_duration_ms,
    SUM(CONVERT(float, rs.avg_cpu_time) * rs.count_executions) / NULLIF(SUM(CONVERT(float, rs.count_executions)), 0) / 1000.0 AS avg_cpu_ms,
    SUM(CONVERT(float, rs.avg_logical_io_reads) * rs.count_executions) / NULLIF(SUM(CONVERT(float, rs.count_executions)), 0) AS avg_logical_reads,
    MAX(rs.last_execution_time) AS last_execution_time
  FROM sys.query_store_query_text AS qt
  INNER JOIN sys.query_store_query AS q ON q.query_text_id=qt.query_text_id
  INNER JOIN sys.query_store_plan AS p ON p.query_id=q.query_id
  INNER JOIN sys.query_store_runtime_stats AS rs ON rs.plan_id=p.plan_id
  INNER JOIN sys.query_store_runtime_stats_interval AS rsi ON rsi.runtime_stats_interval_id=rs.runtime_stats_interval_id
  WHERE rsi.end_time >= DATEADD(hour, -@hours, SYSUTCDATETIME())
  GROUP BY q.query_id,p.plan_id,qt.query_sql_text
), plan_counts AS (
  SELECT query_id, COUNT_BIG(*) AS plan_count
  FROM sys.query_store_plan
  GROUP BY query_id
)
SELECT TOP (${MAX_QUERY_STORE_ROWS})
  w.query_id,w.plan_id,w.execution_count,w.avg_duration_ms,w.avg_cpu_ms,w.avg_logical_reads,w.last_execution_time,w.sql_text,
  pc.plan_count
FROM weighted AS w
INNER JOIN plan_counts AS pc ON pc.query_id=w.query_id
ORDER BY ${queryStoreOrder(sort)}, w.query_id, w.plan_id;`;
  let rows: Record<string, unknown>[] = [];
  try {
    const result = await query(connection, statsSql, {
      maxRows: MAX_QUERY_STORE_ROWS,
      maxBytes: 1_500_000,
      parameters: { hours }
    });
    rows = result.rows;
    if (result.truncated) limitations.push(`Only the first ${MAX_QUERY_STORE_ROWS} Query Store rows are shown.`);
  } catch {
    limitations.push('Query Store is enabled, but runtime statistics could not be read with this login. VIEW DATABASE STATE may be required.');
  }
  const queries: DatabaseQueryStoreEntry[] = rows.map(row => ({
    queryId: Math.round(num(row, 'query_id')),
    planId: Math.round(num(row, 'plan_id')),
    executionCount: num(row, 'execution_count'),
    avgDurationMs: num(row, 'avg_duration_ms'),
    avgCpuMs: num(row, 'avg_cpu_ms'),
    avgLogicalReads: num(row, 'avg_logical_reads'),
    lastExecutionAt: nullableStr(row, 'last_execution_time'),
    planCount: Math.round(num(row, 'plan_count')),
    sql: nullableStr(row, 'sql_text')
  }));
  return {
    connection: connectionId,
    database: connection.database ?? '',
    capturedAt: new Date().toISOString(),
    available: true,
    actualState,
    desiredState,
    readonlyReason,
    currentStorageMb,
    maxStorageMb,
    hours,
    sort,
    queries,
    limitations,
    elapsedMs: Date.now() - startedAt
  };
}

const DEADLOCK_RING_BUFFER_SQL = `
;WITH health AS (
  SELECT CAST(t.target_data AS xml) AS target_data
  FROM sys.dm_xe_session_targets AS t
  INNER JOIN sys.dm_xe_sessions AS s ON s.address=t.event_session_address
  WHERE s.name=N'system_health' AND t.target_name=N'ring_buffer'
)
SELECT TOP (${MAX_DEADLOCK_EVENTS})
  e.node.value('(@timestamp)[1]', 'datetime2') AS event_time,
  CONVERT(nvarchar(max), e.node.query('(data/value/deadlock)[1]')) AS deadlock_xml
FROM health
CROSS APPLY health.target_data.nodes('/RingBufferTarget/event[@name="xml_deadlock_report"]') AS e(node)
ORDER BY event_time DESC;`;

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function xmlAttribute(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return match ? decodeXml(match[1] ?? '') : null;
}

function parseDeadlockXml(xml: string, happenedAt: string | null): DatabaseDeadlockEvent {
  const victimProcessId = xml.match(/<victimProcess\s+id="([^"]+)"/i)?.[1] ?? null;
  const processes: DatabaseDeadlockProcess[] = [];
  // Require whitespace (or the closing bracket) after the element name. A plain
  // `\b` also matches `<process-list>` because `-` is a non-word character, which
  // made the first parsed row inherit the list wrapper instead of victim attributes.
  const processPattern = /<process(?:\s+([^>]*))?>([\s\S]*?)<\/process>/gi;
  for (const match of xml.matchAll(processPattern)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const processId = xmlAttribute(attributes, 'id');
    const input = body.match(/<inputbuf>([\s\S]*?)<\/inputbuf>/i)?.[1] ?? null;
    const spid = xmlAttribute(attributes, 'spid');
    processes.push({
      processId,
      sessionId: spid && /^\d+$/.test(spid) ? Number(spid) : null,
      victim: processId !== null && processId === victimProcessId,
      login: xmlAttribute(attributes, 'loginname'),
      host: xmlAttribute(attributes, 'hostname'),
      application: xmlAttribute(attributes, 'clientapp'),
      database: xmlAttribute(attributes, 'currentdbname'),
      waitResource: xmlAttribute(attributes, 'waitresource'),
      lockMode: xmlAttribute(attributes, 'lockMode'),
      statement: input ? decodeXml(input.replace(/\s+/g, ' ').trim()).slice(0, 4000) : null
    });
  }
  const objects = [...new Set([...xml.matchAll(/\bobjectname="([^"]+)"/gi)].map(match => decodeXml(match[1] ?? '')).filter(Boolean))].slice(0, 20);
  return { happenedAt, victimProcessId, processes, objects };
}

export async function readSqlServerDeadlocks(
  connectionId: string,
  connection: SqlServerConnection,
  query: Query = defaultQuery
): Promise<DatabaseDeadlockHistoryResult> {
  const startedAt = Date.now();
  try {
    const result = await query(connection, DEADLOCK_RING_BUFFER_SQL, { maxRows: MAX_DEADLOCK_EVENTS, maxBytes: 4_000_000 });
    return {
      connection: connectionId,
      database: connection.database ?? '',
      capturedAt: new Date().toISOString(),
      available: true,
      events: result.rows.map(row => parseDeadlockXml(nullableStr(row, 'deadlock_xml') ?? '', nullableStr(row, 'event_time'))),
      limitations: [
        'This view reads deadlocks still retained in the system_health ring buffer. Older events can roll out of the ring buffer.',
        ...(result.truncated ? [`Only the newest ${MAX_DEADLOCK_EVENTS} deadlocks are shown.`] : [])
      ],
      elapsedMs: Date.now() - startedAt
    };
  } catch {
    return {
      connection: connectionId,
      database: connection.database ?? '',
      capturedAt: new Date().toISOString(),
      available: false,
      events: [],
      limitations: ['Deadlock history is unavailable. Reading the system_health Extended Events session commonly requires VIEW SERVER STATE (or VIEW SERVER PERFORMANCE STATE on newer SQL Server versions).'],
      elapsedMs: Date.now() - startedAt
    };
  }
}

const JOBS_SQL = `
SELECT TOP (${MAX_JOBS})
  j.name AS job_name,
  j.enabled,
  h.run_status,
  h.message,
  CASE WHEN h.run_date>0 THEN msdb.dbo.agent_datetime(h.run_date,h.run_time) END AS last_run_at,
  CASE WHEN h.run_duration IS NULL THEN NULL ELSE
    ((h.run_duration / 10000) * 3600) + (((h.run_duration % 10000) / 100) * 60) + (h.run_duration % 100)
  END AS duration_seconds,
  CASE WHEN sch.next_run_date>0 THEN msdb.dbo.agent_datetime(sch.next_run_date,sch.next_run_time) END AS next_run_at
FROM msdb.dbo.sysjobs AS j
OUTER APPLY (
  SELECT TOP (1) run_status,message,run_date,run_time,run_duration
  FROM msdb.dbo.sysjobhistory AS h
  WHERE h.job_id=j.job_id AND h.step_id=0
  ORDER BY h.instance_id DESC
) AS h
OUTER APPLY (
  SELECT TOP (1) next_run_date,next_run_time
  FROM msdb.dbo.sysjobschedules AS js
  WHERE js.job_id=j.job_id AND js.next_run_date>0
  ORDER BY js.next_run_date,js.next_run_time
) AS sch
ORDER BY j.name;`;

function jobOutcome(value: number | null): DatabaseAgentJobSummary['lastOutcome'] {
  if (value === null) return 'unknown';
  if (value === 0) return 'failed';
  if (value === 1) return 'succeeded';
  if (value === 2) return 'retry';
  if (value === 3) return 'canceled';
  if (value === 4) return 'in-progress';
  return 'unknown';
}

export async function readSqlServerJobs(
  connectionId: string,
  connection: SqlServerConnection,
  query: Query = defaultQuery
): Promise<{ connection: string; database: string; available: boolean; capturedAt: string; jobs: DatabaseAgentJobSummary[]; failedJobCount: number; disabledJobCount: number; limitations: string[]; elapsedMs: number }> {
  const startedAt = Date.now();
  try {
    const result = await query(connection, JOBS_SQL, { maxRows: MAX_JOBS, maxBytes: 1_000_000 });
    const jobs = result.rows.map(row => {
      const rawOutcome = row.run_status === null || row.run_status === undefined ? null : Math.round(num(row, 'run_status'));
      return {
        name: str(row, 'job_name', '(unnamed job)'),
        enabled: bool(row, 'enabled'),
        lastRunAt: nullableStr(row, 'last_run_at'),
        lastOutcome: jobOutcome(rawOutcome),
        lastMessage: nullableStr(row, 'message'),
        lastDurationSeconds: row.duration_seconds === null || row.duration_seconds === undefined ? null : num(row, 'duration_seconds'),
        nextRunAt: nullableStr(row, 'next_run_at')
      } satisfies DatabaseAgentJobSummary;
    });
    return {
      connection: connectionId,
      database: connection.database ?? '',
      available: true,
      capturedAt: new Date().toISOString(),
      jobs,
      failedJobCount: jobs.filter(job => job.lastOutcome === 'failed').length,
      disabledJobCount: jobs.filter(job => !job.enabled).length,
      limitations: result.truncated ? [`Only the first ${MAX_JOBS} SQL Agent jobs are shown.`] : [],
      elapsedMs: Date.now() - startedAt
    };
  } catch {
    return {
      connection: connectionId,
      database: connection.database ?? '',
      available: false,
      capturedAt: new Date().toISOString(),
      jobs: [],
      failedJobCount: 0,
      disabledJobCount: 0,
      limitations: ['SQL Agent job history is unavailable. SQL Server Agent may not be installed/running, or this login cannot read msdb job metadata.'],
      elapsedMs: Date.now() - startedAt
    };
  }
}

type SchemaColumn = {
  tableKey: string;
  columnKey: string;
  table: string;
  column: string;
  descriptor: string;
};
type SchemaIndex = { key: string; object: string; descriptor: string };
type SchemaModule = { key: string; object: string; kind: 'procedure' | 'view'; definition: string | null; canonical: string | null };

const SCHEMA_COLUMNS_SQL = `
SELECT TOP (${MAX_SCHEMA_ROWS})
  s.name AS schema_name,
  t.name AS table_name,
  c.name AS column_name,
  c.column_id,
  ty.name AS type_name,
  c.max_length,c.precision,c.scale,c.is_nullable,c.is_identity,c.is_computed,c.collation_name,
  dc.definition AS default_definition,
  cc.definition AS computed_definition
FROM sys.tables AS t
INNER JOIN sys.schemas AS s ON s.schema_id=t.schema_id
INNER JOIN sys.columns AS c ON c.object_id=t.object_id
INNER JOIN sys.types AS ty ON ty.user_type_id=c.user_type_id
LEFT JOIN sys.default_constraints AS dc ON dc.object_id=c.default_object_id
LEFT JOIN sys.computed_columns AS cc ON cc.object_id=c.object_id AND cc.column_id=c.column_id
WHERE t.is_ms_shipped=0
ORDER BY s.name,t.name,c.column_id;`;

const SCHEMA_INDEXES_SQL = `
SELECT TOP (${MAX_SCHEMA_ROWS})
  s.name AS schema_name,
  t.name AS table_name,
  i.name AS index_name,
  i.type_desc,
  i.is_unique,i.is_primary_key,i.is_unique_constraint,i.is_disabled,i.has_filter,i.filter_definition,
  ic.index_column_id,ic.key_ordinal,ic.is_descending_key,ic.is_included_column,
  c.name AS column_name
FROM sys.tables AS t
INNER JOIN sys.schemas AS s ON s.schema_id=t.schema_id
INNER JOIN sys.indexes AS i ON i.object_id=t.object_id AND i.index_id>0 AND i.is_hypothetical=0
INNER JOIN sys.index_columns AS ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
INNER JOIN sys.columns AS c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
WHERE t.is_ms_shipped=0
ORDER BY s.name,t.name,i.index_id,ic.index_column_id;`;

const SCHEMA_MODULES_SQL = `
SELECT TOP (${MAX_PROGRAMMABLE_OBJECTS + 1})
  s.name AS schema_name,
  o.name AS object_name,
  o.type,
  m.definition
FROM sys.objects AS o
INNER JOIN sys.schemas AS s ON s.schema_id=o.schema_id
LEFT JOIN sys.sql_modules AS m ON m.object_id=o.object_id
WHERE o.is_ms_shipped=0 AND o.type IN ('P','V')
ORDER BY s.name,o.name;`;

function canonicalModuleDefinition(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*(CREATE|ALTER)(\s+OR\s+ALTER)?\b/i, 'CREATE')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

function moduleSnippet(value: string | null, other: string | null): string | null {
  if (value === null) return null;
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  const otherLines = (other ?? '').replace(/\r\n?/g, '\n').split('\n');
  let first = 0;
  while (first < lines.length && first < otherLines.length && lines[first] === otherLines[first]) first += 1;
  const start = Math.max(0, first - 2);
  const snippet = lines.slice(start, start + 8).join('\n');
  return snippet.length <= MAX_MODULE_TEXT_CHARS ? snippet : `${snippet.slice(0, MAX_MODULE_TEXT_CHARS - 1)}…`;
}

async function schemaSnapshot(connection: SqlServerConnection, query: Query): Promise<{ columns: SchemaColumn[]; indexes: SchemaIndex[]; modules: SchemaModule[]; truncated: boolean }> {
  const [columnResult, indexResult, moduleResult] = await Promise.all([
    query(connection, SCHEMA_COLUMNS_SQL, { maxRows: MAX_SCHEMA_ROWS + 1, maxBytes: 8_000_000 }),
    query(connection, SCHEMA_INDEXES_SQL, { maxRows: MAX_SCHEMA_ROWS + 1, maxBytes: 8_000_000 }),
    query(connection, SCHEMA_MODULES_SQL, { maxRows: MAX_PROGRAMMABLE_OBJECTS + 1, maxBytes: 12_000_000 })
  ]);
  const columns = columnResult.rows.slice(0, MAX_SCHEMA_ROWS).map(row => {
    const table = `${str(row, 'schema_name', 'dbo')}.${str(row, 'table_name')}`;
    const column = str(row, 'column_name');
    const descriptor = [
      typeDeclaration(row),
      bool(row, 'is_nullable') ? 'NULL' : 'NOT NULL',
      bool(row, 'is_identity') ? 'IDENTITY' : '',
      bool(row, 'is_computed') ? `COMPUTED ${nullableStr(row, 'computed_definition') ?? ''}` : '',
      nullableStr(row, 'default_definition') ? `DEFAULT ${nullableStr(row, 'default_definition')}` : '',
      nullableStr(row, 'collation_name') ? `COLLATE ${nullableStr(row, 'collation_name')}` : ''
    ].filter(Boolean).join(' ');
    return { tableKey: table.toLowerCase(), columnKey: `${table}.${column}`.toLowerCase(), table, column, descriptor };
  });
  const groups = new Map<string, { object: string; header: string; columns: string[] }>();
  for (const row of indexResult.rows.slice(0, MAX_SCHEMA_ROWS)) {
    const object = `${str(row, 'schema_name', 'dbo')}.${str(row, 'table_name')}.${str(row, 'index_name', '(unnamed index)')}`;
    const key = object.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = {
        object,
        header: [
          str(row, 'type_desc', 'INDEX'),
          bool(row, 'is_unique') ? 'UNIQUE' : '',
          bool(row, 'is_primary_key') ? 'PRIMARY KEY' : '',
          bool(row, 'is_unique_constraint') ? 'UNIQUE CONSTRAINT' : '',
          bool(row, 'is_disabled') ? 'DISABLED' : '',
          bool(row, 'has_filter') ? `FILTER ${nullableStr(row, 'filter_definition') ?? ''}` : ''
        ].filter(Boolean).join(' '),
        columns: []
      };
      groups.set(key, group);
    }
    group.columns.push(`${str(row, 'column_name')}:${num(row, 'key_ordinal')}:${bool(row, 'is_descending_key') ? 'DESC' : 'ASC'}:${bool(row, 'is_included_column') ? 'INCLUDE' : 'KEY'}`);
  }
  const indexes = [...groups.entries()].map(([key, group]) => ({ key, object: group.object, descriptor: `${group.header} [${group.columns.join(', ')}]` }));
  const modules = moduleResult.rows.slice(0, MAX_PROGRAMMABLE_OBJECTS).map(row => {
    const kind = str(row, 'type') === 'V' ? 'view' as const : 'procedure' as const;
    const object = `${str(row, 'schema_name', 'dbo')}.${str(row, 'object_name')}`;
    const definition = nullableStr(row, 'definition');
    return { key: `${kind}:${object}`.toLowerCase(), object, kind, definition, canonical: canonicalModuleDefinition(definition) };
  });
  return {
    columns,
    indexes,
    modules,
    truncated: columnResult.truncated || indexResult.truncated || moduleResult.truncated || columnResult.rows.length > MAX_SCHEMA_ROWS || indexResult.rows.length > MAX_SCHEMA_ROWS || moduleResult.rows.length > MAX_PROGRAMMABLE_OBJECTS
  };
}

export async function compareSqlServerSchemas(
  baselineConnectionId: string,
  baselineConnection: SqlServerConnection,
  currentConnectionId: string,
  currentConnection: SqlServerConnection,
  query: Query = defaultQuery
): Promise<DatabaseSchemaCompareResult> {
  const startedAt = Date.now();
  const capturedAt = new Date().toISOString();
  const [before, after] = await Promise.all([schemaSnapshot(baselineConnection, query), schemaSnapshot(currentConnection, query)]);
  const differences: DatabaseSchemaDifference[] = [];
  const counts = {
    tablesAdded: 0, tablesRemoved: 0,
    columnsAdded: 0, columnsRemoved: 0, columnsChanged: 0,
    indexesAdded: 0, indexesRemoved: 0, indexesChanged: 0,
    proceduresAdded: 0, proceduresRemoved: 0, proceduresChanged: 0,
    viewsAdded: 0, viewsRemoved: 0, viewsChanged: 0
  };
  const beforeTables = new Set(before.columns.map(column => column.tableKey));
  const afterTables = new Set(after.columns.map(column => column.tableKey));
  const tableDisplay = new Map([...before.columns, ...after.columns].map(column => [column.tableKey, column.table]));
  for (const key of afterTables) if (!beforeTables.has(key)) {
    counts.tablesAdded++;
    differences.push({ kind: 'table-added', object: tableDisplay.get(key) ?? key, detail: 'Table exists only in Current.', baseline: null, current: 'present', confidence: before.truncated ? 'low' : 'high' });
  }
  for (const key of beforeTables) if (!afterTables.has(key)) {
    counts.tablesRemoved++;
    differences.push({ kind: 'table-removed', object: tableDisplay.get(key) ?? key, detail: 'Table exists only in Baseline.', baseline: 'present', current: null, confidence: after.truncated ? 'low' : 'high' });
  }
  const beforeColumns = new Map(before.columns.map(column => [column.columnKey, column]));
  const afterColumns = new Map(after.columns.map(column => [column.columnKey, column]));
  for (const [key, current] of afterColumns) {
    const baseline = beforeColumns.get(key);
    if (!baseline) {
      if (beforeTables.has(current.tableKey)) {
        counts.columnsAdded++;
        differences.push({ kind: 'column-added', object: `${current.table}.${current.column}`, detail: 'Column exists only in Current.', baseline: null, current: current.descriptor, confidence: before.truncated ? 'low' : 'high' });
      }
      continue;
    }
    if (baseline.descriptor !== current.descriptor) {
      counts.columnsChanged++;
      differences.push({ kind: 'column-changed', object: `${current.table}.${current.column}`, detail: 'Column definition changed.', baseline: baseline.descriptor, current: current.descriptor, confidence: 'high' });
    }
  }
  for (const [key, baseline] of beforeColumns) {
    if (!afterColumns.has(key) && afterTables.has(baseline.tableKey)) {
      counts.columnsRemoved++;
      differences.push({ kind: 'column-removed', object: `${baseline.table}.${baseline.column}`, detail: 'Column exists only in Baseline.', baseline: baseline.descriptor, current: null, confidence: after.truncated ? 'low' : 'high' });
    }
  }
  const beforeIndexes = new Map(before.indexes.map(index => [index.key, index]));
  const afterIndexes = new Map(after.indexes.map(index => [index.key, index]));
  for (const [key, current] of afterIndexes) {
    const baseline = beforeIndexes.get(key);
    if (!baseline) {
      counts.indexesAdded++;
      differences.push({ kind: 'index-added', object: current.object, detail: 'Index exists only in Current.', baseline: null, current: current.descriptor, confidence: before.truncated ? 'low' : 'high' });
    } else if (baseline.descriptor !== current.descriptor) {
      counts.indexesChanged++;
      differences.push({ kind: 'index-changed', object: current.object, detail: 'Index definition changed.', baseline: baseline.descriptor, current: current.descriptor, confidence: 'high' });
    }
  }
  for (const [key, baseline] of beforeIndexes) if (!afterIndexes.has(key)) {
    counts.indexesRemoved++;
    differences.push({ kind: 'index-removed', object: baseline.object, detail: 'Index exists only in Baseline.', baseline: baseline.descriptor, current: null, confidence: after.truncated ? 'low' : 'high' });
  }
  const beforeModules = new Map(before.modules.map(module => [module.key, module]));
  const afterModules = new Map(after.modules.map(module => [module.key, module]));
  for (const [key, current] of afterModules) {
    const baseline = beforeModules.get(key);
    const prefix = current.kind === 'view' ? 'view' : 'procedure';
    if (!baseline) {
      if (current.kind === 'view') counts.viewsAdded++; else counts.proceduresAdded++;
      differences.push({
        kind: `${prefix}-added`, object: current.object, detail: `${current.kind === 'view' ? 'View' : 'Stored procedure'} exists only in Current.`,
        baseline: null, current: moduleSnippet(current.definition, null), confidence: before.truncated ? 'low' : current.definition === null ? 'unknown' : 'high'
      } as DatabaseSchemaDifference);
      continue;
    }
    if (baseline.canonical !== current.canonical) {
      if (current.kind === 'view') counts.viewsChanged++; else counts.proceduresChanged++;
      const encrypted = baseline.definition === null || current.definition === null;
      differences.push({
        kind: `${prefix}-changed`, object: current.object,
        detail: encrypted ? 'Definition could not be compared completely because at least one side is encrypted/unavailable.' : 'SQL module definition changed.',
        baseline: moduleSnippet(baseline.definition, current.definition),
        current: moduleSnippet(current.definition, baseline.definition),
        confidence: encrypted ? 'unknown' : 'high'
      } as DatabaseSchemaDifference);
    }
  }
  for (const [key, baseline] of beforeModules) if (!afterModules.has(key)) {
    const prefix = baseline.kind === 'view' ? 'view' : 'procedure';
    if (baseline.kind === 'view') counts.viewsRemoved++; else counts.proceduresRemoved++;
    differences.push({
      kind: `${prefix}-removed`, object: baseline.object, detail: `${baseline.kind === 'view' ? 'View' : 'Stored procedure'} exists only in Baseline.`,
      baseline: moduleSnippet(baseline.definition, null), current: null, confidence: after.truncated ? 'low' : baseline.definition === null ? 'unknown' : 'high'
    } as DatabaseSchemaDifference);
  }
  const totalDifferenceCount = differences.length;
  return {
    baseline: { connection: baselineConnectionId, database: baselineConnection.database ?? '', capturedAt },
    current: { connection: currentConnectionId, database: currentConnection.database ?? '', capturedAt },
    summary: counts,
    differences: differences.slice(0, MAX_SCHEMA_DIFFERENCES),
    totalDifferenceCount,
    truncated: before.truncated || after.truncated || totalDifferenceCount > MAX_SCHEMA_DIFFERENCES,
    limitations: [
      'V2 compares live table/column/index metadata plus stored procedure and view definitions. CREATE versus ALTER and line-ending/trailing-space differences are normalized before comparing code.',
      'Encrypted SQL modules cannot be compared by body. Triggers, functions, permissions and partition/filegroup options are not yet included.',
      ...(before.truncated || after.truncated ? ['At least one metadata capture hit its safety limit; missing-only differences have reduced confidence.'] : []),
      ...(totalDifferenceCount > MAX_SCHEMA_DIFFERENCES ? [`Only the first ${MAX_SCHEMA_DIFFERENCES} differences are returned.`] : [])
    ],
    elapsedMs: Date.now() - startedAt
  };
}
