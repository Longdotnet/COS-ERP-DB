import { describe, expect, it, vi } from 'vitest';
import { readSqlServerTablePage } from '../src/main/database/table-data.js';
import type { SqlServerConnection, SqlServerQueryOptions, SqlServerQueryResult } from '../src/main/database/sqlserver.js';

const connection: SqlServerConnection = {
  server: 'db-host',
  database: 'ERP_TEST',
  authentication: { type: 'sql', user: 'reader', password: 'secret' }
};

function result(rows: Record<string, unknown>[], elapsedMs = 1): SqlServerQueryResult {
  return { columns: [], rows, rowCount: rows.length, elapsedMs, truncated: false };
}

const metadata = [
  { schema_name: 'dbo', table_name: 'L00ZONES', column_name: 'Zone', type_name: 'varchar', column_id: 1, is_nullable: false, primary_key_ordinal: 1 },
  { schema_name: 'dbo', table_name: 'L00ZONES', column_name: 'Description', type_name: 'nvarchar', column_id: 2, is_nullable: false, primary_key_ordinal: null }
];

describe('database table data', () => {
  it('uses primary-key keyset paging and a bound cursor instead of OFFSET', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string, _options: SqlServerQueryOptions) => sql.includes('FROM sys.tables')
      ? result(metadata)
      : result([{ Zone: 'A', Description: 'One' }, { Zone: 'B', Description: 'Two' }, { Zone: 'C', Description: 'Three' }], 7));

    const first = await readSqlServerTablePage(connection, { objectId: 42, limit: 2 }, {}, query);
    expect(first.pagingMode).toBe('keyset');
    expect(first.rows).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(query.mock.calls[1]![1]).toContain('SELECT TOP (@take) * FROM [dbo].[L00ZONES]');
    expect(query.mock.calls[1]![1]).not.toContain('OFFSET');

    query.mockImplementation(async (_connection: SqlServerConnection, sql: string, _options: SqlServerQueryOptions) => sql.includes('FROM sys.tables')
      ? result(metadata)
      : result([{ Zone: 'C', Description: 'Three' }], 4));
    await readSqlServerTablePage(connection, { objectId: 42, limit: 2, cursor: first.nextCursor }, {}, query);
    expect(query.mock.calls.at(-1)![1]).toContain('[Zone] > @cursor_0');
    expect(query.mock.calls.at(-1)![2].parameters).toMatchObject({ cursor_0: 'B' });
  });

  it('parameterizes filters and validates columns before building SQL', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string, _options: SqlServerQueryOptions) => sql.includes('FROM sys.tables') ? result(metadata) : result([]));
    await readSqlServerTablePage(connection, {
      objectId: 42,
      filters: [{ column: 'Description', operator: 'starts_with', value: 'Bank%' }]
    }, {}, query);
    const [, sql, options] = query.mock.calls[1]!;
    expect(sql).toContain('[Description] LIKE @filter_0');
    expect(sql).not.toContain('Bank%');
    expect(options.parameters).toMatchObject({ filter_0: 'Bank~%%' });

    await expect(readSqlServerTablePage(connection, {
      objectId: 42,
      filters: [{ column: 'Missing', operator: 'eq', value: 1 }]
    }, {}, query)).rejects.toThrow(/Unknown table column/);
  });

  it('falls back to bounded OFFSET paging when there is no primary key', async () => {
    const noPk = metadata.map(row => ({ ...row, primary_key_ordinal: null }));
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string, _options: SqlServerQueryOptions) => sql.includes('FROM sys.tables')
      ? result(noPk)
      : result([{ Zone: 'A' }, { Zone: 'B' }]));
    const page = await readSqlServerTablePage(connection, { objectId: 42, limit: 2 }, {}, query);
    expect(page.pagingMode).toBe('offset');
    expect(page.warning).toMatch(/OFFSET/);
    expect(query.mock.calls[1]![1]).toContain('OFFSET @offset ROWS FETCH NEXT @take ROWS ONLY');
  });

  it('refuses cursors reused with different filters', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string, _options: SqlServerQueryOptions) => sql.includes('FROM sys.tables')
      ? result(metadata)
      : result([{ Zone: 'A' }, { Zone: 'B' }]));
    const first = await readSqlServerTablePage(connection, { objectId: 42, limit: 1 }, {}, query);
    await expect(readSqlServerTablePage(connection, {
      objectId: 42,
      limit: 1,
      cursor: first.nextCursor,
      filters: [{ column: 'Description', operator: 'eq', value: 'x' }]
    }, {}, query)).rejects.toThrow(/cursor does not match/i);
  });
});
