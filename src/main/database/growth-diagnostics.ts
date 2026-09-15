import type {
  DatabaseGrowthDiagnosticsResult,
  DatabaseGrowthFileSummary,
  DatabaseGrowthFinding,
  DatabaseGrowthSeverity,
  DatabaseGrowthTableSummary
} from '../../shared/database.js';
import {
  querySqlServer,
  type SqlServerConnection,
  type SqlServerQueryOptions,
  type SqlServerQueryResult
} from './sqlserver.js';

const DIAGNOSTIC_ROWS = 64;
const DIAGNOSTIC_BYTES = 512_000;

type DiagnosticQuery = (
  connection: SqlServerConnection,
  sql: string,
  options: SqlServerQueryOptions
) => Promise<SqlServerQueryResult>;

const FILES_SQL = `
SELECT
  name AS logical_name,
  type_desc,
  CAST(size * 8.0 / 1024.0 AS float) AS size_mb,
  CASE WHEN type = 0 THEN CAST(FILEPROPERTY(name, 'SpaceUsed') * 8.0 / 1024.0 AS float) END AS used_mb,
  growth,
  is_percent_growth
FROM sys.database_files
ORDER BY type, file_id;`;

const LOG_SQL = `
SELECT
  CAST(total_log_size_in_bytes / 1048576.0 AS float) AS total_log_mb,
  CAST(used_log_space_in_bytes / 1048576.0 AS float) AS used_log_mb,
  CAST(used_log_space_in_percent AS float) AS used_log_percent,
  CAST(log_space_in_bytes_since_last_backup / 1048576.0 AS float) AS since_last_backup_mb
FROM sys.dm_db_log_space_usage;`;

const STATE_SQL = `
SELECT recovery_model_desc, log_reuse_wait_desc
FROM sys.databases
WHERE database_id = DB_ID();`;

const TABLES_SQL = `
SELECT TOP (25)
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
ORDER BY SUM(ps.reserved_page_count) DESC, s.name, t.name;`;

const TABLE_COUNT_SQL = `
SELECT CAST(COUNT_BIG(*) AS float) AS table_count
FROM sys.tables
WHERE is_ms_shipped = 0;`;

function numberValue(row: Record<string, unknown> | undefined, key: string, fallback = 0): number {
  if (!row) return fallback;
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function stringValue(row: Record<string, unknown> | undefined, key: string, fallback = ''): string {
  const value = row?.[key];
  return typeof value === 'string' ? value : fallback;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function severityRank(severity: DatabaseGrowthSeverity): number {
  return severity === 'high' ? 0 : severity === 'medium' ? 1 : 2;
}

function tableObject(table: DatabaseGrowthTableSummary) {
  return { objectId: table.objectId, schema: table.schema, name: table.name, type: 'table' as const };
}

function buildFindings(
  summary: DatabaseGrowthDiagnosticsResult['summary'],
  log: DatabaseGrowthDiagnosticsResult['log'],
  files: DatabaseGrowthFileSummary[],
  tables: DatabaseGrowthTableSummary[],
  tableStorageAvailable: boolean
): DatabaseGrowthFinding[] {
  const findings: DatabaseGrowthFinding[] = [];
  const add = (finding: DatabaseGrowthFinding) => findings.push(finding);
  const logShare = summary.totalMb > 0 ? summary.logMb / summary.totalMb : 0;

  if (log.available && log.usedPercent >= 90) {
    add({
      id: 'log-nearly-full',
      severity: 'high',
      title: 'Transaction log is nearly full',
      detail: `${round(log.usedPercent)}% of the transaction log is currently used (${round(log.usedMb)} MB of ${round(log.totalMb)} MB).`,
      nextAction: 'Check log reuse wait, active transactions and the transaction-log backup schedule before looking for oversized business tables.'
    });
  } else if (log.available && log.usedPercent >= 75) {
    add({
      id: 'log-high-use',
      severity: 'medium',
      title: 'Transaction log usage is high',
      detail: `${round(log.usedPercent)}% of the transaction log is currently used.`,
      nextAction: 'Confirm that log backups and long-running transactions are healthy before the log needs to grow again.'
    });
  }

  if (log.stateAvailable && log.reuseWait === 'LOG_BACKUP') {
    add({
      id: 'log-backup-wait',
      severity: 'high',
      title: 'Log reuse is waiting for a log backup',
      detail: `Recovery model is ${log.recoveryModel}; SQL Server reports LOG_BACKUP as the current reuse wait.`,
      nextAction: 'Inspect the SQL Server Agent backup job and log-backup policy. Verify that transaction-log backups are actually succeeding.'
    });
  } else if (log.stateAvailable && log.reuseWait === 'ACTIVE_TRANSACTION') {
    add({
      id: 'active-transaction-wait',
      severity: 'high',
      title: 'An active transaction is blocking log reuse',
      detail: 'SQL Server reports ACTIVE_TRANSACTION as the current transaction-log reuse wait.',
      nextAction: 'Find the oldest open transaction and trace it back to the ERP process or integration that owns it.'
    });
  } else if (log.stateAvailable && log.reuseWait && log.reuseWait !== 'NOTHING' && log.reuseWait !== 'UNKNOWN') {
    add({
      id: 'log-reuse-wait',
      severity: 'medium',
      title: `Log reuse is waiting on ${log.reuseWait}`,
      detail: `SQL Server currently cannot reuse log space because the reuse wait is ${log.reuseWait}.`,
      nextAction: `Investigate the SQL Server ${log.reuseWait} reuse-wait condition before shrinking or resizing the log.`
    });
  }

  if (summary.logMb >= 256 && logShare >= 0.5) {
    add({
      id: 'log-dominates-size',
      severity: logShare >= 0.75 ? 'high' : 'medium',
      title: 'Transaction log dominates database size',
      detail: `${round(logShare * 100)}% of allocated database file size is transaction log, so database growth may not be caused by business rows.`,
      nextAction: 'Resolve the log-reuse cause first, then compare data-file growth separately from log-file growth.'
    });
  }

  const dataFreeMb = Math.max(0, summary.dataMb - summary.dataUsedMb);
  const dataUsedPercent = summary.dataMb > 0 ? summary.dataUsedMb / summary.dataMb * 100 : 0;
  if (summary.dataMb >= 128 && dataUsedPercent >= 90) {
    add({
      id: 'data-files-nearly-full',
      severity: dataUsedPercent >= 95 ? 'high' : 'medium',
      title: 'Data files have little free space left',
      detail: `${round(dataUsedPercent)}% of allocated data-file space is currently used (${round(summary.dataUsedMb)} MB of ${round(summary.dataMb)} MB).`,
      nextAction: 'Check which tables are consuming the used space and verify data-file autogrowth before the next ERP batch or import needs more pages.'
    });
  }

  if (summary.dataMb >= 256 && dataFreeMb / summary.dataMb >= 0.3) {
    add({
      id: 'data-free-space',
      severity: 'low',
      title: 'Data files contain significant free space',
      detail: `${round(dataFreeMb)} MB of ${round(summary.dataMb)} MB allocated to data files is currently free. File size alone can overstate active table data.`,
      nextAction: 'Compare used space and historical file growth before treating allocated MDF size as new ERP data.'
    });
  }

  if (log.available && summary.logMb >= 512 && logShare >= 0.5 && log.usedPercent <= 25) {
    add({
      id: 'log-large-mostly-free',
      severity: logShare >= 0.75 && summary.logMb >= 1024 ? 'medium' : 'low',
      title: 'Transaction log is large but mostly free',
      detail: `${round(log.usedPercent)}% of the ${round(log.totalMb)} MB log is currently used. The allocated LDF can therefore make the database look much larger than its active log workload.`,
      nextAction: 'Check historical log growth and the cause of the earlier expansion before deciding whether the current LDF size is intentional.'
    });
  }

  for (const file of files) {
    if (file.percentGrowth && file.sizeMb >= 512 && file.growth >= 10) {
      add({
        id: `percent-autogrowth:${file.name}`,
        severity: file.sizeMb >= 4096 || file.growth >= 25 ? 'medium' : 'low',
        title: `${file.name} uses percentage autogrowth`,
        detail: `${file.type === 'log' ? 'Log' : 'Data'} file ${file.name} is ${round(file.sizeMb)} MB and grows by ${round(file.growth)}%. Percentage growth becomes a larger allocation each time the file gets bigger.`,
        nextAction: 'Review the SQL Server file-growth policy and prefer a deliberate fixed growth increment sized for this workload.'
      });
      continue;
    }

    if (!file.percentGrowth && file.sizeMb >= 1024 && file.growth > 0 && file.growth < 64) {
      add({
        id: `small-autogrowth:${file.name}`,
        severity: 'low',
        title: `${file.name} has a small fixed autogrowth increment`,
        detail: `${file.type === 'log' ? 'Log' : 'Data'} file ${file.name} is ${round(file.sizeMb)} MB but grows only ${round(file.growth)} MB at a time. Frequent growth events can add latency and fragment file growth history.`,
        nextAction: 'Review autogrowth frequency and choose a fixed increment that matches normal ERP growth without causing repeated small expansions.'
      });
    }

    if (file.type === 'data' && file.usedMb !== null && file.sizeMb >= 128 && file.growth === 0 && file.usedMb / file.sizeMb >= 0.9) {
      add({
        id: `autogrowth-disabled:${file.name}`,
        severity: 'high',
        title: `${file.name} is nearly full with autogrowth disabled`,
        detail: `${round(file.usedMb / file.sizeMb * 100)}% of the data file is used and its configured growth increment is zero.`,
        nextAction: 'Confirm the file has room to grow or provision space before the next write-heavy ERP operation.'
      });
    }
  }

  const largest = tableStorageAvailable ? tables[0] : undefined;
  if (largest && largest.reservedMb >= 128 && summary.dataMb > 0) {
    const share = largest.reservedMb / summary.dataMb;
    if (share >= 0.35) {
      add({
        id: `largest-table:${largest.objectId}`,
        severity: share >= 0.6 ? 'high' : 'medium',
        title: `${largest.schema}.${largest.name} is a major storage concentration`,
        detail: `${round(largest.reservedMb)} MB reserved across ${Math.round(largest.rows).toLocaleString('en-US')} rows, about ${round(share * 100)}% of allocated data-file size.`,
        nextAction: 'Open the table, inspect its date/business-key columns, then check dependencies to identify the ERP process writing the growth.',
        object: tableObject(largest)
      });
    }
  }

  const lowRowLarge = tableStorageAvailable ? tables.find(table => table.rows <= 100_000 && table.reservedMb >= 128) : undefined;
  if (lowRowLarge) {
    add({
      id: `few-rows-large:${lowRowLarge.objectId}`,
      severity: 'medium',
      title: `${lowRowLarge.schema}.${lowRowLarge.name} is large for its row count`,
      detail: `${Math.round(lowRowLarge.rows).toLocaleString('en-US')} rows reserve ${round(lowRowLarge.reservedMb)} MB. This pattern can indicate large LOB, attachment or document columns.`,
      nextAction: 'Inspect varbinary(max), varchar(max), nvarchar(max), XML and document columns, then measure DATALENGTH before blaming row count.',
      object: tableObject(lowRowLarge)
    });
  }

  const highBytesPerRow = tableStorageAvailable
    ? tables.find(table => {
        if (table.rows <= 0 || table.rows > 100_000 || table.reservedMb < 4) return false;
        return table.reservedMb * 1024 / table.rows >= 16;
      })
    : undefined;
  if (highBytesPerRow && highBytesPerRow.objectId !== lowRowLarge?.objectId) {
    const averageKb = highBytesPerRow.reservedMb * 1024 / Math.max(1, highBytesPerRow.rows);
    add({
      id: `wide-or-lob-rows:${highBytesPerRow.objectId}`,
      severity: averageKb >= 64 || highBytesPerRow.reservedMb >= 64 ? 'medium' : 'low',
      title: `${highBytesPerRow.schema}.${highBytesPerRow.name} uses a lot of storage per row`,
      detail: `${Math.round(highBytesPerRow.rows).toLocaleString('en-US')} rows reserve ${round(highBytesPerRow.reservedMb)} MB, roughly ${round(averageKb)} KB per row on average.`,
      nextAction: 'Inspect LOB/document columns and row payload sizes with DATALENGTH; this pattern can come from attachments, XML/JSON or unusually wide ERP records.',
      object: tableObject(highBytesPerRow)
    });
  }

  const indexHeavy = tableStorageAvailable
    ? tables.find(table => table.usedMb >= 32 && table.indexMb >= 16 && table.indexMb / table.usedMb >= 0.4)
    : undefined;
  if (indexHeavy) {
    const indexShare = indexHeavy.indexMb / Math.max(indexHeavy.usedMb, 0.01);
    add({
      id: `index-heavy:${indexHeavy.objectId}`,
      severity: indexHeavy.reservedMb >= 128 && indexShare >= 0.5 ? 'medium' : 'low',
      title: `${indexHeavy.schema}.${indexHeavy.name} is index-heavy`,
      detail: `${round(indexHeavy.indexMb)} MB of ${round(indexHeavy.usedMb)} MB used by the table is index storage (${round(indexShare * 100)}%).`,
      nextAction: 'Review duplicate or unused indexes and the ERP query paths before assuming row data itself caused the storage growth.',
      object: tableObject(indexHeavy)
    });
  }

  if (tableStorageAvailable && summary.dataUsedMb >= 128 && tables.length >= 2) {
    const topThree = tables.slice(0, 3);
    const topThreeMb = topThree.reduce((sum, table) => sum + table.reservedMb, 0);
    const concentration = topThreeMb / Math.max(summary.dataUsedMb, 0.01);
    const largestShare = tables[0]!.reservedMb / Math.max(summary.dataUsedMb, 0.01);
    if (concentration >= 0.6 && largestShare < 0.5) {
      add({
        id: 'top-tables-concentrated',
        severity: concentration >= 0.8 ? 'medium' : 'low',
        title: 'A small group of tables holds most used data space',
        detail: `The top ${topThree.length} tables reserve ${round(topThreeMb)} MB, about ${round(concentration * 100)}% of currently used data-file space.`,
        nextAction: 'Drill into these tables together and compare their date columns, cleanup rules and insert paths; growth may be spread across one ERP workflow rather than one table.'
      });
    }
  }

  const highRows = tableStorageAvailable ? tables.find(table => table.rows >= 1_000_000) : undefined;
  if (highRows) {
    add({
      id: `row-volume:${highRows.objectId}`,
      severity: 'medium',
      title: `${highRows.schema}.${highRows.name} has very high row volume`,
      detail: `${Math.round(highRows.rows).toLocaleString('en-US')} rows currently reserve ${round(highRows.reservedMb)} MB.`,
      nextAction: 'Break rows down by the best date column, check duplicate business keys, and verify archive/cleanup rules and the insert path.',
      object: tableObject(highRows)
    });
  }

  if (findings.length === 0) {
    add({
      id: 'no-current-anomaly',
      severity: 'low',
      title: 'No obvious current-state storage anomaly detected',
      detail: 'Current file, log and largest-table ratios do not cross the dashboard alert thresholds.',
      nextAction: 'Capture a baseline and compare it with an older backup or future snapshot to identify which object is actually growing over time.'
    });
  }

  return findings.sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
}

function nextActions(findings: readonly DatabaseGrowthFinding[]): string[] {
  const actions: string[] = [];
  for (const finding of findings) {
    if (!actions.includes(finding.nextAction)) actions.push(finding.nextAction);
    if (actions.length >= 4) break;
  }
  actions.push('Capture a dated baseline or compare with an older backup before claiming which table caused historical growth.');
  return actions;
}

/** Fixed read-only diagnostics used by both the dashboard and the Core database tool. */
export async function readSqlServerGrowthDiagnostics(
  connection: SqlServerConnection,
  options: { signal?: AbortSignal } = {},
  query: DiagnosticQuery = (resolved, sql, queryOptions) => querySqlServer(resolved, sql, undefined, queryOptions)
): Promise<DatabaseGrowthDiagnosticsResult> {
  const startedAt = Date.now();
  const queryOptions = {
    maxRows: DIAGNOSTIC_ROWS,
    maxBytes: DIAGNOSTIC_BYTES,
    ...(options.signal ? { signal: options.signal } : {})
  };
  // Keep this deliberately gentler than an ad-hoc diagnostic script. Customer ERP databases can
  // be old or resource-constrained, and Object Explorer must stay responsive while an explicit
  // investigation is running. Lightweight pairs run together; the partition-stats scan runs alone.
  const [filesSettled, logSettled] = await Promise.allSettled([
    query(connection, FILES_SQL, queryOptions),
    query(connection, LOG_SQL, queryOptions)
  ]);
  const [stateSettled, countSettled] = await Promise.allSettled([
    query(connection, STATE_SQL, queryOptions),
    query(connection, TABLE_COUNT_SQL, queryOptions)
  ]);
  const tablesSettled = await query(connection, TABLES_SQL, queryOptions)
    .then(value => ({ status: 'fulfilled' as const, value }))
    .catch(reason => ({ status: 'rejected' as const, reason }));

  if (filesSettled.status === 'rejected') throw filesSettled.reason;
  const filesResult = filesSettled.value;
  const logResult = logSettled.status === 'fulfilled' ? logSettled.value : null;
  const stateResult = stateSettled.status === 'fulfilled' ? stateSettled.value : null;
  const tablesResult = tablesSettled.status === 'fulfilled' ? tablesSettled.value : null;
  const countResult = countSettled.status === 'fulfilled' ? countSettled.value : null;
  const limitations: string[] = [];
  if (!logResult) limitations.push('Transaction-log usage details are unavailable for this login. Grant the SQL Server metadata permission required by sys.dm_db_log_space_usage to see used percentage and backup pressure.');
  if (!stateResult) limitations.push('Recovery model and log reuse wait are unavailable for this login.');
  if (!tablesResult) limitations.push('Per-table storage details are unavailable for this login. The dashboard can still separate allocated data files from log files.');
  if (!countResult) limitations.push('User-table count is unavailable for this login.');

  const files: DatabaseGrowthFileSummary[] = filesResult.rows.map(row => {
    const type = stringValue(row, 'type_desc') === 'LOG' ? 'log' as const : 'data' as const;
    const sizeMb = numberValue(row, 'size_mb');
    const rawUsed = row.used_mb;
    const usedMb = typeof rawUsed === 'number' || typeof rawUsed === 'string' ? numberValue(row, 'used_mb') : null;
    const rawGrowth = numberValue(row, 'growth');
    const percentGrowth = row.is_percent_growth === true || row.is_percent_growth === 1;
    return {
      name: stringValue(row, 'logical_name', '(unnamed file)'),
      type,
      sizeMb: round(sizeMb),
      usedMb: usedMb === null ? null : round(usedMb),
      freeMb: usedMb === null ? null : round(Math.max(0, sizeMb - usedMb)),
      growth: round(percentGrowth ? rawGrowth : rawGrowth * 8 / 1024),
      percentGrowth
    };
  });

  const dataFiles = files.filter(file => file.type === 'data');
  const logFiles = files.filter(file => file.type === 'log');
  const dataMb = dataFiles.reduce((sum, file) => sum + file.sizeMb, 0);
  const dataUsedMb = dataFiles.reduce((sum, file) => sum + (file.usedMb ?? 0), 0);
  const allocatedLogMb = logFiles.reduce((sum, file) => sum + file.sizeMb, 0);
  const logRow = logResult?.rows[0];
  const reportedLogMb = numberValue(logRow, 'total_log_mb', allocatedLogMb);
  const logMb = reportedLogMb > 0 ? reportedLogMb : allocatedLogMb;
  const logUsedMb = numberValue(logRow, 'used_log_mb');
  const logUsedPercent = numberValue(logRow, 'used_log_percent', logMb > 0 ? logUsedMb / logMb * 100 : 0);
  const stateRow = stateResult?.rows[0];

  const largestTables: DatabaseGrowthTableSummary[] = (tablesResult?.rows ?? []).map(row => ({
    objectId: Math.round(numberValue(row, 'object_id')),
    schema: stringValue(row, 'schema_name', 'dbo'),
    name: stringValue(row, 'table_name', '(unknown table)'),
    rows: Math.max(0, numberValue(row, 'row_count')),
    reservedMb: round(numberValue(row, 'reserved_mb')),
    usedMb: round(numberValue(row, 'used_mb')),
    dataMb: round(numberValue(row, 'data_mb')),
    indexMb: round(numberValue(row, 'index_mb'))
  })).filter(table => table.objectId > 0);

  const summary = {
    totalMb: round(dataMb + logMb),
    dataMb: round(dataMb),
    logMb: round(logMb),
    dataUsedMb: round(dataUsedMb),
    logUsedMb: round(logUsedMb),
    logUsedPercent: round(logUsedPercent),
    tableCount: Math.max(0, Math.round(numberValue(countResult?.rows[0], 'table_count')))
  };
  const log = {
    available: Boolean(logResult),
    stateAvailable: Boolean(stateResult),
    recoveryModel: stringValue(stateRow, 'recovery_model_desc', 'UNKNOWN'),
    reuseWait: stringValue(stateRow, 'log_reuse_wait_desc', 'UNKNOWN'),
    totalMb: round(logMb),
    usedMb: round(logUsedMb),
    freeMb: round(Math.max(0, logMb - logUsedMb)),
    usedPercent: round(logUsedPercent),
    sinceLastBackupMb: logRow?.since_last_backup_mb === null || logRow?.since_last_backup_mb === undefined
      ? null
      : round(numberValue(logRow, 'since_last_backup_mb'))
  };
  const tableStorageAvailable = Boolean(tablesResult);
  const findings = buildFindings(summary, log, files, largestTables, tableStorageAvailable);

  return {
    database: connection.database ?? '',
    capturedAt: new Date().toISOString(),
    summary,
    log,
    files,
    largestTables,
    tableStorageAvailable,
    findings,
    nextActions: nextActions(findings),
    limitations,
    historicalBaselineAvailable: false,
    elapsedMs: Date.now() - startedAt
  };
}
