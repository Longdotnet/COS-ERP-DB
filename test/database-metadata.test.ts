import { describe, expect, it, vi } from 'vitest';
import {
  MAX_DATABASE_OBJECT_PAGE_SIZE,
  searchSqlServerObjects,
  type DatabaseObjectSearchInput
} from '../src/main/database/metadata.js';
import type { SqlServerConnection, SqlServerQueryOptions } from '../src/main/database/sqlserver.js';

const connection: SqlServerConnection = {
  server: 'db-host',
  database: 'ERP',
  authentication: { type: 'sql', user: 'reader', password: 'secret' }
};

function row(schema: string, name: string, sqlType: string, objectId: number) {
  return { schema_name: schema, object_name: name, sql_type: sqlType, object_id: objectId, modify_date: '2026-09-15T00:00:00.000Z' };
}

describe('database metadata engine', () => {
  it('uses fixed parameterized SQL, bounded take and keyset cursor pagination', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string, options: SqlServerQueryOptions) => {
      expect(sql).toContain('FROM sys.objects AS o');
      expect(sql).toContain('ORDER BY s.name, o.name, o.object_id');
      expect(sql).not.toContain('Zone');
      expect(options.parameters).toMatchObject({ take: 3, prefix: 'Zone%', after_schema: '', after_name: '', after_id: 0 });
      return {
        columns: [],
        rows: [row('dbo', 'ZoneA', 'U ', 10), row('dbo', 'ZoneB', 'V ', 11), row('dbo', 'ZoneC', 'P ', 12)],
        rowCount: 3,
        elapsedMs: 7,
        truncated: false
      };
    });

    const first = await searchSqlServerObjects(connection, { search: 'Zone', types: ['table', 'view', 'procedure'], limit: 2 }, {}, query);
    expect(first.objects.map(item => item.name)).toEqual(['ZoneA', 'ZoneB']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    query.mockImplementationOnce(async (_connection, _sql, options) => {
      expect(options.parameters).toMatchObject({ after_schema: 'dbo', after_name: 'ZoneB', after_id: 11 });
      return { columns: [], rows: [row('dbo', 'ZoneC', 'P', 12)], rowCount: 1, elapsedMs: 3, truncated: false };
    });
    const second = await searchSqlServerObjects(connection, {
      search: 'Zone', types: ['procedure', 'view', 'table'], limit: 2, cursor: first.nextCursor
    }, {}, query);
    expect(second.objects.map(item => item.name)).toEqual(['ZoneC']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
  });

  it('escapes LIKE wildcard input and refuses a cursor reused with another filter', async () => {
    let seenOptions: SqlServerQueryOptions | undefined;
    const query = vi.fn(async (_connection: SqlServerConnection, _sql: string, options: SqlServerQueryOptions) => {
      seenOptions = options;
      return { columns: [], rows: [row('dbo', 'A_100%', 'U', 5), row('dbo', 'A_101%', 'U', 6)], rowCount: 2, elapsedMs: 1, truncated: false };
    });
    const page = await searchSqlServerObjects(connection, { search: 'A_100%', types: ['table'], limit: 1 }, {}, query);
    expect(seenOptions?.parameters?.prefix).toBe('A~_100~%%');
    await expect(searchSqlServerObjects(connection, { search: 'Other', types: ['table'], limit: 1, cursor: page.nextCursor }, {}, query))
      .rejects.toThrow(/does not match/i);
  });

  it.each([
    { limit: 0 },
    { limit: MAX_DATABASE_OBJECT_PAGE_SIZE + 1 },
    { search: 'x'.repeat(129) }
  ] satisfies DatabaseObjectSearchInput[])('rejects unbounded metadata input: %j', async input => {
    await expect(searchSqlServerObjects(connection, input, {}, vi.fn())).rejects.toThrow();
  });
});
