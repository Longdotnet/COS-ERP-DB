import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../src/main/database/growth-diagnostics.js');
  vi.doUnmock('../src/cos-erp-db/investigation/sqlserver-investigator.js');
  vi.doUnmock('../src/main/database/sqlserver.js');
  vi.resetModules();
});

it('does not report a healthy gate when all health evidence is unavailable', async () => {
  vi.resetModules();
  const unavailable = vi.fn(async () => { throw new Error('fixture unavailable'); });
  vi.doMock('../src/main/database/growth-diagnostics.js', () => ({
    readSqlServerGrowthDiagnostics: unavailable
  }));
  vi.doMock('../src/cos-erp-db/investigation/sqlserver-investigator.js', () => ({
    readSqlServerDeadlocks: unavailable,
    readSqlServerDiagnosticHistory: unavailable,
    readSqlServerJobs: unavailable,
    readSqlServerLivePerformance: unavailable,
    readSqlServerQueryStore: unavailable
  }));

  const { readDatabaseHealthGate } = await import('../src/cos-erp-db/investigation/health-gate.js');
  const result = await readDatabaseHealthGate('customer-a', {
    server: 'fixture', database: 'ERP_A', authentication: { type: 'sql', user: 'u', password: 'p' }
  });

  expect(result.status).toBe('attention');
  expect(result.checks).toHaveLength(6);
  expect(result.checks.every(check => check.status === 'unavailable')).toBe(true);
});

it('includes database configuration in the exact deployment fingerprint', async () => {
  vi.resetModules();
  let compatibilityLevel = 160;
  const querySqlServer = vi.fn(async (_connection: unknown, sql: string) => {
    let rows: Record<string, unknown>[];
    if (sql.includes('FROM sys.databases')) {
      rows = [{
        compatibility_level: compatibilityLevel,
        collation_name: 'SQL_Latin1_General_CP1_CI_AS',
        recovery_model_desc: 'FULL',
        is_read_committed_snapshot_on: 0,
        snapshot_isolation_state_desc: 'OFF'
      }];
    } else if (sql.includes('FROM sys.sql_modules')) {
      rows = [{ schema_name: 'dbo', object_name: 'Sp_Test', object_type: 'P', definition: 'SELECT 1' }];
    } else if (sql.includes('FROM sys.objects')) {
      rows = [{ schema_name: 'dbo', object_name: 'L00TEST', object_type: 'U' }];
    } else if (sql.includes('FROM sys.columns')) {
      rows = [{ schema_name: 'dbo', table_name: 'L00TEST', column_id: 1, column_name: 'Ident00' }];
    } else if (sql.includes('FROM sys.indexes')) {
      rows = [{ schema_name: 'dbo', table_name: 'L00TEST', index_name: 'PK_L00TEST' }];
    } else {
      rows = [{ constraint_type: 'DEFAULT', schema_name: 'dbo', table_name: 'L00TEST', constraint_name: 'DF_Test' }];
    }
    return { columns: [], rows, rowCount: rows.length, elapsedMs: 1, truncated: false };
  });
  vi.doMock('../src/main/database/sqlserver.js', () => ({ querySqlServer }));

  const { readDatabaseDeploymentFingerprint } = await import('../src/cos-erp-db/investigation/deployment-fingerprint.js');
  const connection = {
    server: 'fixture', database: 'ERP_A', authentication: { type: 'sql' as const, user: 'u', password: 'p' }
  };
  const first = await readDatabaseDeploymentFingerprint('customer-a', connection);
  compatibilityLevel = 150;
  const second = await readDatabaseDeploymentFingerprint('customer-a', connection);

  expect(first.schemaHash).toBe(second.schemaHash);
  expect(first.moduleHash).toBe(second.moduleHash);
  expect(first.configurationHash).not.toBe(second.configurationHash);
  expect(first.fingerprint).not.toBe(second.fingerprint);
});
