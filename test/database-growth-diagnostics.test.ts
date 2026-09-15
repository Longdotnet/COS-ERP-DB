import { describe, expect, it, vi } from 'vitest';
import { readSqlServerGrowthDiagnostics } from '../src/main/database/growth-diagnostics.js';
import type { SqlServerConnection, SqlServerQueryResult } from '../src/main/database/sqlserver.js';

const connection: SqlServerConnection = {
  server: 'localhost',
  database: 'L80LINKQ.TEST',
  authentication: { type: 'sql', user: 'test', password: 'secret' }
};

function result(rows: Record<string, unknown>[]): SqlServerQueryResult {
  return { columns: [], rows, rowCount: rows.length, elapsedMs: 1, truncated: false };
}

describe('database growth diagnostics', () => {
  it('separates data from log growth and ranks the actionable SQL Server causes first', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string): Promise<SqlServerQueryResult> => {
      if (sql.includes('FROM sys.database_files')) return result([
        { logical_name: 'ERP', type_desc: 'ROWS', size_mb: 238.75, used_mb: 173.13, growth: 8192, is_percent_growth: false },
        { logical_name: 'ERP_log', type_desc: 'LOG', size_mb: 1800, used_mb: null, growth: 8192, is_percent_growth: false }
      ]);
      if (sql.includes('FROM sys.dm_db_log_space_usage')) return result([
        { total_log_mb: 1800, used_log_mb: 1783.98, used_log_percent: 99.11, since_last_backup_mb: 1783 }
      ]);
      if (sql.includes('FROM sys.databases')) return result([
        { recovery_model_desc: 'FULL', log_reuse_wait_desc: 'LOG_BACKUP' }
      ]);
      if (sql.includes('FROM sys.dm_db_partition_stats')) return result([
        { object_id: 42, schema_name: 'dbo', table_name: 'L00DMFILE', row_count: 755, reserved_mb: 150, used_mb: 145, data_mb: 140, index_mb: 5 },
        { object_id: 43, schema_name: 'dbo', table_name: 'SystemLog', row_count: 791, reserved_mb: 6, used_mb: 5.9, data_mb: 5, index_mb: .9 }
      ]);
      if (sql.includes('COUNT_BIG')) return result([{ table_count: 250 }]);
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const diagnostics = await readSqlServerGrowthDiagnostics(connection, {}, query);

    expect(query).toHaveBeenCalledTimes(5);
    expect(diagnostics.summary).toMatchObject({
      totalMb: 2038.75,
      dataMb: 238.75,
      logMb: 1800,
      dataUsedMb: 173.13,
      logUsedMb: 1783.98,
      logUsedPercent: 99.11,
      tableCount: 250
    });
    expect(diagnostics.log).toMatchObject({ recoveryModel: 'FULL', reuseWait: 'LOG_BACKUP' });
    expect(diagnostics.log.available).toBe(true);
    expect(diagnostics.log.stateAvailable).toBe(true);
    expect(diagnostics.tableStorageAvailable).toBe(true);
    expect(diagnostics.limitations).toEqual([]);
    expect(diagnostics.findings.map(finding => finding.id)).toEqual(expect.arrayContaining([
      'log-nearly-full',
      'log-backup-wait',
      'log-dominates-size',
      'largest-table:42'
    ]));
    expect(diagnostics.findings[0]!.severity).toBe('high');
    expect(diagnostics.findings.find(finding => finding.id === 'largest-table:42')?.object).toEqual({
      objectId: 42,
      schema: 'dbo',
      name: 'L00DMFILE',
      type: 'table'
    });
    expect(diagnostics.historicalBaselineAvailable).toBe(false);
    expect(diagnostics.nextActions.at(-1)).toMatch(/baseline|older backup/i);
  });

  it('keeps file allocation useful when a least-privilege login cannot read diagnostic DMVs', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string): Promise<SqlServerQueryResult> => {
      if (sql.includes('FROM sys.database_files')) return result([
        { logical_name: 'ERP', type_desc: 'ROWS', size_mb: 900, used_mb: 600, growth: 8192, is_percent_growth: false },
        { logical_name: 'ERP_log', type_desc: 'LOG', size_mb: 1100, used_mb: null, growth: 8192, is_percent_growth: false }
      ]);
      if (sql.includes('COUNT_BIG')) return result([{ table_count: 40 }]);
      throw new Error('VIEW DATABASE STATE denied');
    });

    const diagnostics = await readSqlServerGrowthDiagnostics(connection, {}, query);

    expect(diagnostics.summary).toMatchObject({ totalMb: 2000, dataMb: 900, logMb: 1100, tableCount: 40 });
    expect(diagnostics.log.available).toBe(false);
    expect(diagnostics.log.stateAvailable).toBe(false);
    expect(diagnostics.tableStorageAvailable).toBe(false);
    expect(diagnostics.limitations.join(' ')).toMatch(/unavailable|permission/i);
    expect(diagnostics.findings.some(finding => finding.id === 'log-nearly-full')).toBe(false);
    expect(diagnostics.findings.some(finding => finding.id === 'log-dominates-size')).toBe(true);
  });

  it('detects data pressure, risky file growth, wide rows and index-heavy tables without database-specific names', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string): Promise<SqlServerQueryResult> => {
      if (sql.includes('FROM sys.database_files')) return result([
        { logical_name: 'ERP_DATA', type_desc: 'ROWS', size_mb: 1000, used_mb: 960, growth: 20, is_percent_growth: true },
        { logical_name: 'ERP_LOG', type_desc: 'LOG', size_mb: 200, used_mb: null, growth: 12800, is_percent_growth: false }
      ]);
      if (sql.includes('FROM sys.dm_db_log_space_usage')) return result([
        { total_log_mb: 200, used_log_mb: 40, used_log_percent: 20, since_last_backup_mb: 8 }
      ]);
      if (sql.includes('FROM sys.databases')) return result([
        { recovery_model_desc: 'FULL', log_reuse_wait_desc: 'NOTHING' }
      ]);
      if (sql.includes('FROM sys.dm_db_partition_stats')) return result([
        { object_id: 101, schema_name: 'erp', table_name: 'DocumentStore', row_count: 100, reserved_mb: 40, used_mb: 39, data_mb: 38, index_mb: 1 },
        { object_id: 102, schema_name: 'erp', table_name: 'SalesLedger', row_count: 100000, reserved_mb: 100, used_mb: 80, data_mb: 40, index_mb: 40 }
      ]);
      if (sql.includes('COUNT_BIG')) return result([{ table_count: 42 }]);
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const diagnostics = await readSqlServerGrowthDiagnostics(connection, {}, query);
    const ids = diagnostics.findings.map(finding => finding.id);

    expect(ids).toEqual(expect.arrayContaining([
      'data-files-nearly-full',
      'percent-autogrowth:ERP_DATA',
      'wide-or-lob-rows:101',
      'index-heavy:102'
    ]));
    expect(diagnostics.findings.find(finding => finding.id === 'wide-or-lob-rows:101')?.object?.name).toBe('DocumentStore');
    expect(diagnostics.findings.find(finding => finding.id === 'index-heavy:102')?.object?.name).toBe('SalesLedger');
  });

  it('distinguishes a large mostly-free log from an actively full log', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string): Promise<SqlServerQueryResult> => {
      if (sql.includes('FROM sys.database_files')) return result([
        { logical_name: 'ERP_DATA', type_desc: 'ROWS', size_mb: 500, used_mb: 400, growth: 12800, is_percent_growth: false },
        { logical_name: 'ERP_LOG', type_desc: 'LOG', size_mb: 1500, used_mb: null, growth: 12800, is_percent_growth: false }
      ]);
      if (sql.includes('FROM sys.dm_db_log_space_usage')) return result([
        { total_log_mb: 1500, used_log_mb: 120, used_log_percent: 8, since_last_backup_mb: 20 }
      ]);
      if (sql.includes('FROM sys.databases')) return result([
        { recovery_model_desc: 'FULL', log_reuse_wait_desc: 'NOTHING' }
      ]);
      if (sql.includes('FROM sys.dm_db_partition_stats')) return result([]);
      if (sql.includes('COUNT_BIG')) return result([{ table_count: 12 }]);
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const diagnostics = await readSqlServerGrowthDiagnostics(connection, {}, query);
    const ids = diagnostics.findings.map(finding => finding.id);

    expect(ids).toContain('log-large-mostly-free');
    expect(ids).toContain('log-dominates-size');
    expect(ids).not.toContain('log-nearly-full');
    expect(ids).not.toContain('log-high-use');
  });
});
