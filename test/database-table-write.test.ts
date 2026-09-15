import { describe, expect, it, vi } from 'vitest';
import { updateSqlServerTableCell } from '../src/main/database/table-write.js';
import type { SqlServerConnection, SqlServerQueryOptions, SqlServerQueryResult } from '../src/main/database/sqlserver.js';

const connection: SqlServerConnection = {
  server: 'db-host',
  database: 'ERP_TEST',
  authentication: { type: 'sql', user: 'writer', password: 'secret' }
};

function result(rows: Record<string, unknown>[], rowCount = rows.length, elapsedMs = 1): SqlServerQueryResult {
  return { columns: [], rows, rowCount, elapsedMs, truncated: false };
}

const metadata = [
  {
    schema_name: 'dbo', table_name: 'L00ZONES', column_name: 'Zone', type_name: 'varchar',
    column_id: 1, is_nullable: false, is_identity: false, is_computed: false, primary_key_ordinal: 1
  },
  {
    schema_name: 'dbo', table_name: 'L00ZONES', column_name: 'Description', type_name: 'nvarchar',
    column_id: 2, is_nullable: true, is_identity: false, is_computed: false, primary_key_ordinal: null
  }
];

describe('database table write', () => {
  it('updates exactly one non-key cell with bound PK and original-value concurrency guards', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string, _options: SqlServerQueryOptions) =>
      sql.includes('FROM sys.tables') ? result(metadata) : result([], 1, 7));

    const output = await updateSqlServerTableCell(connection, {
      objectId: 42,
      column: 'Description',
      primaryKey: { Zone: 'ANSWERS' },
      originalValue: 'Câu trả lời',
      value: 'A'
    }, {}, query);

    expect(output).toEqual({ affectedRows: 1, elapsedMs: 7 });
    const [, sql, options] = query.mock.calls[1]!;
    expect(sql).toBe('UPDATE [dbo].[L00ZONES] SET [Description] = @next_value WHERE [Zone] = @pk_0 AND [Description] = @original_value;');
    expect(options.parameters).toEqual({ next_value: 'A', pk_0: 'ANSWERS', original_value: 'Câu trả lời' });
    expect(sql).not.toContain('ANSWERS');
    expect(sql).not.toContain('Câu trả lời');
  });

  it('fails closed when optimistic concurrency matches zero rows', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string, _options: SqlServerQueryOptions) =>
      sql.includes('FROM sys.tables') ? result(metadata) : result([], 0));

    await expect(updateSqlServerTableCell(connection, {
      objectId: 42,
      column: 'Description',
      primaryKey: { Zone: 'ANSWERS' },
      originalValue: 'Old',
      value: 'New'
    }, {}, query)).rejects.toThrow(/DATABASE_WRITE_CONFLICT/);
  });

  it('refuses primary-key edits before issuing an UPDATE', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string, _options: SqlServerQueryOptions) =>
      sql.includes('FROM sys.tables') ? result(metadata) : result([], 1));

    await expect(updateSqlServerTableCell(connection, {
      objectId: 42,
      column: 'Zone',
      primaryKey: { Zone: 'ANSWERS' },
      originalValue: 'ANSWERS',
      value: 'ANSWER'
    }, {}, query)).rejects.toThrow(/Primary-key columns cannot be edited/);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
