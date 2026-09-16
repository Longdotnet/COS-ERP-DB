import { describe, expect, it, vi } from 'vitest';
import { MAX_GROWTH_CAPTURE_TABLES, readSqlServerGrowthCapture } from '../src/main/database/growth-capture.js';
import type { SqlServerConnection, SqlServerQueryResult } from '../src/main/database/sqlserver.js';

const connection: SqlServerConnection = {
  server: 'localhost',
  database: 'ERP_CURRENT',
  authentication: { type: 'sql', user: 'test', password: 'secret' }
};

function result(rows: Record<string, unknown>[], truncated = false): SqlServerQueryResult {
  return { columns: [], rows, rowCount: rows.length, elapsedMs: 1, truncated };
}

describe('database growth capture', () => {
  it('keeps ordinary diagnostics bounded but captures the full table set for comparison', async () => {
    let partitionStatsCalls = 0;
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string): Promise<SqlServerQueryResult> => {
      if (sql.includes('FROM sys.database_files')) return result([
        { logical_name: 'ERP', type_desc: 'ROWS', size_mb: 5000, used_mb: 4000, growth: 12800, is_percent_growth: false },
        { logical_name: 'ERP_log', type_desc: 'LOG', size_mb: 1000, used_mb: null, growth: 12800, is_percent_growth: false }
      ]);
      if (sql.includes('FROM sys.dm_db_log_space_usage')) return result([
        { total_log_mb: 1000, used_log_mb: 100, used_log_percent: 10, since_last_backup_mb: 5 }
      ]);
      if (sql.includes('FROM sys.databases')) return result([{ recovery_model_desc: 'FULL', log_reuse_wait_desc: 'NOTHING' }]);
      if (sql.includes('COUNT_BIG')) return result([{ table_count: 3 }]);
      if (sql.includes('COS_GROWTH_SCHEMA_FINGERPRINTS')) return result([
        { schema_name: 'dbo', table_name: 'BigOne', column_count: 5, index_count: 2, column_hash: '101', index_hash: '201' },
        { schema_name: 'dbo', table_name: 'SmallOne', column_count: 3, index_count: 1, column_hash: '102', index_hash: '202' },
        { schema_name: 'erp', table_name: 'Audit', column_count: 8, index_count: 3, column_hash: '103', index_hash: '203' }
      ]);
      if (sql.includes('FROM sys.dm_db_partition_stats')) {
        partitionStatsCalls += 1;
        if (partitionStatsCalls === 1) return result([
          { object_id: 1, schema_name: 'dbo', table_name: 'BigOne', row_count: 10, reserved_mb: 100, used_mb: 90, data_mb: 80, index_mb: 10 }
        ]);
        return result([
          { object_id: 1, schema_name: 'dbo', table_name: 'BigOne', row_count: 10, reserved_mb: 100, used_mb: 90, data_mb: 80, index_mb: 10 },
          { object_id: 2, schema_name: 'dbo', table_name: 'SmallOne', row_count: 20, reserved_mb: 2, used_mb: 1.5, data_mb: 1.2, index_mb: 0.3 },
          { object_id: 3, schema_name: 'erp', table_name: 'Audit', row_count: 30, reserved_mb: 3, used_mb: 2.5, data_mb: 2, index_mb: 0.5 }
        ]);
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const capture = await readSqlServerGrowthCapture(connection, {}, query);

    expect(capture.captureVersion).toBe(2);
    expect(capture.database).toBe('ERP_CURRENT');
    expect(capture.tables.map(table => `${table.schema}.${table.name}`)).toEqual([
      'dbo.BigOne', 'dbo.SmallOne', 'erp.Audit'
    ]);
    expect(capture.tablesTruncated).toBe(false);
    expect(capture.tableFingerprints).toEqual([
      { schema: 'dbo', name: 'BigOne', columnCount: 5, indexCount: 2, columnHash: '101', indexHash: '201' },
      { schema: 'dbo', name: 'SmallOne', columnCount: 3, indexCount: 1, columnHash: '102', indexHash: '202' },
      { schema: 'erp', name: 'Audit', columnCount: 8, indexCount: 3, columnHash: '103', indexHash: '203' }
    ]);
    expect(capture.schemaTruncated).toBe(false);
    expect(partitionStatsCalls).toBe(2);
  });

  it('marks a capture as incomplete when the provider row limit is reached', async () => {
    let partitionStatsCalls = 0;
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string): Promise<SqlServerQueryResult> => {
      if (sql.includes('FROM sys.database_files')) return result([{ logical_name: 'ERP', type_desc: 'ROWS', size_mb: 100, used_mb: 80, growth: 12800, is_percent_growth: false }]);
      if (sql.includes('FROM sys.dm_db_log_space_usage')) return result([]);
      if (sql.includes('FROM sys.databases')) return result([{ recovery_model_desc: 'SIMPLE', log_reuse_wait_desc: 'NOTHING' }]);
      if (sql.includes('COUNT_BIG')) return result([{ table_count: MAX_GROWTH_CAPTURE_TABLES + 10 }]);
      if (sql.includes('COS_GROWTH_SCHEMA_FINGERPRINTS')) return result([]);
      if (sql.includes('FROM sys.dm_db_partition_stats')) {
        partitionStatsCalls += 1;
        if (partitionStatsCalls === 1) return result([]);
        return result(Array.from({ length: MAX_GROWTH_CAPTURE_TABLES + 1 }, (_, index) => ({
          object_id: index + 1,
          schema_name: 'dbo',
          table_name: `T${index}`,
          row_count: 1,
          reserved_mb: 1,
          used_mb: 1,
          data_mb: 1,
          index_mb: 0
        })), true);
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const capture = await readSqlServerGrowthCapture(connection, {}, query);
    expect(capture.tables).toHaveLength(MAX_GROWTH_CAPTURE_TABLES);
    expect(capture.tablesTruncated).toBe(true);
    expect(capture.schemaTruncated).toBe(false);
    expect(capture.limitations.join(' ')).toMatch(/limited to 5,000/i);
  });

  it('keeps storage capture usable when column/index fingerprint metadata is unavailable', async () => {
    let partitionStatsCalls = 0;
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string): Promise<SqlServerQueryResult> => {
      if (sql.includes('FROM sys.database_files')) return result([{ logical_name: 'ERP', type_desc: 'ROWS', size_mb: 100, used_mb: 80, growth: 12800, is_percent_growth: false }]);
      if (sql.includes('FROM sys.dm_db_log_space_usage')) return result([]);
      if (sql.includes('FROM sys.databases')) return result([{ recovery_model_desc: 'SIMPLE', log_reuse_wait_desc: 'NOTHING' }]);
      if (sql.includes('COUNT_BIG')) return result([{ table_count: 1 }]);
      if (sql.includes('COS_GROWTH_SCHEMA_FINGERPRINTS')) throw new Error('metadata denied');
      if (sql.includes('FROM sys.dm_db_partition_stats')) {
        partitionStatsCalls += 1;
        return result(partitionStatsCalls === 1 ? [] : [
          { object_id: 1, schema_name: 'dbo', table_name: 'History', row_count: 100, reserved_mb: 20, used_mb: 18, data_mb: 16, index_mb: 2 }
        ]);
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const capture = await readSqlServerGrowthCapture(connection, {}, query);
    expect(capture.tables).toHaveLength(1);
    expect(capture.tableFingerprints).toEqual([]);
    expect(capture.schemaTruncated).toBe(true);
    expect(capture.limitations.join(' ')).toMatch(/schema fingerprint.*unavailable/i);
  });
});
