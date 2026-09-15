import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  }
}));

import {
  assertReadOnlySql,
  executeDatabaseAction,
  executeDatabaseTableCellUpdate,
  MAX_DATABASE_CONCURRENT_QUERIES,
  MAX_DATABASE_ROWS,
  type DatabaseRuntime
} from '../src/main/database/service.js';
import type { ResolvedSqlServerProfile } from '../src/main/database/profiles.js';

const profile: ResolvedSqlServerProfile = {
  id: 'linkq-test',
  name: 'LinkQ Test',
  accessMode: 'read-only',
  connection: {
    server: 'linkqwin.linkq.vn',
    database: 'L80LINKQ.TEST',
    port: 2027,
    encrypt: false,
    trustServerCertificate: true,
    authentication: { type: 'sql', user: 'long', password: 'super-secret' }
  }
};

function runtime(overrides: Partial<DatabaseRuntime> = {}): DatabaseRuntime {
  return {
    resolve: vi.fn(async () => profile),
    listConnections: vi.fn(async () => ({
      defaultConnectionId: 'linkq-test',
      connections: [{ id: 'linkq-test', name: 'LinkQ Test', database: 'L80LINKQ.TEST', accessMode: 'read-only' as const, isDefault: true }]
    })),
    query: vi.fn(async () => ({
      columns: [{ name: 'Ma_Zone', type: 'varchar', nullable: false }],
      rows: [{ Ma_Zone: 'Z01' }],
      rowCount: 1,
      elapsedMs: 18,
      truncated: false
    })),
    searchObjects: vi.fn(async () => ({ objects: [], hasMore: false, elapsedMs: 2 })),
    tablePage: vi.fn(async () => ({
      schema: 'dbo',
      table: 'L00ZONES',
      columns: [{ name: 'Zone', type: 'varchar', nullable: false, primaryKeyOrdinal: 1 }],
      rows: [{ Zone: 'A' }],
      hasMore: false,
      elapsedMs: 3,
      pagingMode: 'keyset' as const
    })),
    tableCellUpdate: vi.fn(async () => ({ affectedRows: 1 as const, elapsedMs: 4 })),
    objectDetails: vi.fn(async (_connection, objectId, section) => ({
      schema: 'dbo',
      name: objectId === 42 ? 'L00ZONES' : 'Object',
      type: 'table' as const,
      section,
      ...(section === 'columns' ? { columns: [] } : {}),
      elapsedMs: 2
    })),
    growthDiagnostics: vi.fn(async () => ({
      database: 'L80LINKQ.TEST',
      capturedAt: '2026-09-15T17:00:00.000Z',
      summary: { totalMb: 2000, dataMb: 200, logMb: 1800, dataUsedMb: 150, logUsedMb: 1700, logUsedPercent: 94.4, tableCount: 100 },
      log: { available: true, stateAvailable: true, recoveryModel: 'FULL', reuseWait: 'LOG_BACKUP', totalMb: 1800, usedMb: 1700, freeMb: 100, usedPercent: 94.4, sinceLastBackupMb: 1600 },
      files: [],
      largestTables: [],
      tableStorageAvailable: true,
      findings: [],
      nextActions: [],
      limitations: [],
      historicalBaselineAvailable: false as const,
      elapsedMs: 5
    })),
    workspaceContext: vi.fn(() => null),
    test: vi.fn(async () => ({ elapsedMs: 7 })),
    ...overrides
  };
}

describe('database service', () => {
  it('refuses renderer cell writes for a read-only profile before the writer is called', async () => {
    const deps = runtime();
    await expect(executeDatabaseTableCellUpdate({
      connection: 'linkq-test',
      objectId: 42,
      column: 'Description',
      primaryKey: { Zone: 'A' },
      originalValue: 'Old',
      value: 'New'
    }, deps)).rejects.toThrow(/DATABASE_READ_ONLY/);
    expect(deps.tableCellUpdate).not.toHaveBeenCalled();
  });

  it('allows only the structured renderer writer when the resolved profile is Full access', async () => {
    const fullAccessProfile: ResolvedSqlServerProfile = { ...profile, accessMode: 'full-access' };
    const deps = runtime({ resolve: vi.fn(async () => fullAccessProfile) });
    const input = {
      connection: 'linkq-test',
      objectId: 42,
      column: 'Description',
      primaryKey: { Zone: 'A' },
      originalValue: 'Old',
      value: 'New'
    } as const;

    await expect(executeDatabaseTableCellUpdate(input, deps)).resolves.toEqual({ affectedRows: 1, elapsedMs: 4 });
    expect(deps.tableCellUpdate).toHaveBeenCalledWith(
      fullAccessProfile.connection,
      expect.objectContaining({ objectId: 42, column: 'Description', primaryKey: { Zone: 'A' }, originalValue: 'Old', value: 'New' }),
      {}
    );
  });

  it('lists only credential-free connection identity and policy without resolving a password', async () => {
    const deps = runtime();

    const result = await executeDatabaseAction({ action: 'list_connections' }, deps);

    expect(result).toEqual({
      action: 'list_connections',
      defaultConnectionId: 'linkq-test',
      connections: [{ id: 'linkq-test', name: 'LinkQ Test', database: 'L80LINKQ.TEST', accessMode: 'read-only', isDefault: true }]
    });
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/password|server|user|domain/i);
  });

  it('returns workspace context without resolving a database profile or credentials', async () => {
    const context = {
      connection: 'linkq-test',
      object: { objectId: 42, schema: 'dbo', name: 'L00ZONES', type: 'table' as const },
      tab: 'data' as const,
      selectedRowsTruncated: false,
      updatedAt: 1
    };
    const deps = runtime({ workspaceContext: vi.fn(() => context) });

    const result = await executeDatabaseAction({ action: 'workspace_context' }, deps);

    expect(result).toEqual({ action: 'workspace_context', context });
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it('resolves a local profile and runs a read-only query through the native provider', async () => {
    const deps = runtime();
    const result = await executeDatabaseAction(
      { action: 'query', connection: 'linkq-test', sql: 'SELECT TOP 10 * FROM dbo.L00ZONES' },
      deps
    );

    expect(deps.resolve).toHaveBeenCalledWith('linkq-test');
    expect(deps.query).toHaveBeenCalledWith(profile.connection, 'SELECT TOP 10 * FROM dbo.L00ZONES', {
      maxRows: MAX_DATABASE_ROWS,
      maxBytes: 1_000_000
    });
    expect(deps.test).not.toHaveBeenCalled();
    expect(result).toEqual({
      action: 'query',
      connection: 'linkq-test',
      database: 'L80LINKQ.TEST',
      columns: [{ name: 'Ma_Zone', type: 'varchar', nullable: false }],
      rows: [{ Ma_Zone: 'Z01' }],
      rowCount: 1,
      elapsedMs: 18,
      truncated: false
    });
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  it('uses the same resolved profile for connection tests without running arbitrary SQL', async () => {
    const deps = runtime();
    const result = await executeDatabaseAction({ action: 'test' }, deps);

    expect(deps.resolve).toHaveBeenCalledWith(undefined);
    expect(deps.test).toHaveBeenCalledWith(profile.connection);
    expect(deps.query).not.toHaveBeenCalled();
    expect(result).toEqual({
      action: 'test', connection: 'linkq-test', database: 'L80LINKQ.TEST', ok: true, elapsedMs: 7
    });
  });

  it('routes bounded object search through the metadata engine instead of model-authored sys catalog SQL', async () => {
    const deps = runtime({
      searchObjects: vi.fn(async () => ({
        objects: [{ schema: 'dbo', name: 'L00ZONES', type: 'table' as const, objectId: 42, modifiedAt: null }],
        hasMore: true,
        nextCursor: 'next-page',
        elapsedMs: 5
      }))
    });
    const input = { action: 'search_objects' as const, connection: 'linkq-test', search: 'L00', types: ['table' as const], limit: 25 };
    const result = await executeDatabaseAction(input, deps);

    expect(deps.searchObjects).toHaveBeenCalledWith(profile.connection, input, {});
    expect(deps.query).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: 'search_objects', connection: 'linkq-test', database: 'L80LINKQ.TEST', hasMore: true, nextCursor: 'next-page'
    });
  });

  it('routes fixed growth diagnostics through the structured diagnostics engine', async () => {
    const deps = runtime();

    const result = await executeDatabaseAction({ action: 'growth_diagnostics', connection: 'linkq-test' }, deps);

    expect(deps.growthDiagnostics).toHaveBeenCalledWith(profile.connection, {});
    expect(deps.query).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: 'growth_diagnostics',
      connection: 'linkq-test',
      database: 'L80LINKQ.TEST',
      summary: { totalMb: 2000, logMb: 1800 }
    });
  });

  it.each([
    'DELETE FROM dbo.L00ZONES',
    'SELECT * INTO #copy FROM dbo.L00ZONES',
    'SELECT TOP 1 * FROM dbo.L00ZONES; DELETE FROM dbo.L00ZONES',
    'WITH x AS (SELECT TOP 1 * FROM dbo.L00ZONES) UPDATE x SET Ma_Zone = Ma_Zone',
    'EXEC dbo.Sp_Test',
    'SELECT NEXT VALUE FOR dbo.InvoiceSequence AS next_id',
    'SELECT * FROM dbo.L00ZONES WITH (TABLOCKX)',
    'SELECT * FROM dbo.L00ZONES WITH (UPDLOCK, HOLDLOCK)',
    "SELECT * FROM OPENROWSET('MSOLEDBSQL', 'Server=remote', 'SELECT 1')",
    "SELECT * FROM OPENQUERY(RemoteServer, 'SELECT 1')",
    "SELECT * FROM OPENDATASOURCE('MSOLEDBSQL', 'Data Source=remote').master.sys.tables"
  ])('refuses unsafe SQL before the provider is called: %s', async (sql) => {
    const deps = runtime();
    await expect(executeDatabaseAction({ action: 'query', sql }, deps)).rejects.toThrow(/read-only|SELECT INTO|one read-only/i);
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.query).not.toHaveBeenCalled();
  });

  it('ignores mutation-looking words inside strings, comments and quoted identifiers', () => {
    expect(() => assertReadOnlySql("SELECT 'DELETE', [UPDATE] FROM dbo.Logs -- DROP TABLE x")).not.toThrow();
    expect(() => assertReadOnlySql('WITH x AS (SELECT 1 AS n /* DELETE */) SELECT n FROM x;')).not.toThrow();
    expect(() => assertReadOnlySql("SELECT 'NEXT VALUE FOR dbo.Seq', 'TABLOCKX', 'OPENROWSET' AS note")).not.toThrow();
    expect(() => assertReadOnlySql('SELECT [UPDLOCK], [OPENQUERY] FROM dbo.SafeNames /* TABLOCKX */')).not.toThrow();
  });

  it('keeps ordinary read hints and read-only SQL available', () => {
    expect(() => assertReadOnlySql('SELECT TOP 10 * FROM dbo.L00ZONES WITH (NOLOCK) ORDER BY Zone')).not.toThrow();
    expect(() => assertReadOnlySql('WITH x AS (SELECT TOP 5 Zone FROM dbo.L00ZONES) SELECT * FROM x')).not.toThrow();
  });

  it('bounds rows returned to the model and marks truncation', async () => {
    const rows = Array.from({ length: MAX_DATABASE_ROWS + 5 }, (_, index) => ({ id: index }));
    const deps = runtime({
      query: vi.fn(async () => ({ columns: [], rows, rowCount: rows.length, elapsedMs: 4, truncated: true }))
    });
    const result = await executeDatabaseAction({ action: 'query', sql: 'SELECT TOP 205 id FROM dbo.L00ZONES' }, deps);
    if (result.action !== 'query') throw new Error('expected query result');
    expect(result.rows).toHaveLength(MAX_DATABASE_ROWS);
    expect(result.rowCount).toBe(MAX_DATABASE_ROWS);
    expect(result.truncated).toBe(true);
  });

  it('redacts the stored password if a driver error happens to echo it', async () => {
    const deps = runtime({
      query: vi.fn(async () => { throw new Error('login failed for password super-secret'); })
    });
    await expect(executeDatabaseAction({ action: 'query', sql: 'SELECT 1' }, deps)).rejects.toThrow(
      'login failed for password [redacted]'
    );
  });

  it('surfaces profile selection errors without invoking a provider', async () => {
    const deps = runtime({
      resolve: vi.fn(async () => { throw new Error('DATABASE_CONNECTION_NOT_FOUND: no configured database connection named "missing"'); })
    });
    await expect(executeDatabaseAction({ action: 'query', connection: 'missing', sql: 'SELECT 1' }, deps)).rejects.toThrow(
      /DATABASE_CONNECTION_NOT_FOUND/
    );
    expect(deps.query).not.toHaveBeenCalled();
    expect(deps.test).not.toHaveBeenCalled();
  });

  it('limits concurrent queries per connection and releases the next waiter when a slot finishes', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const query = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active -= 1;
      return { columns: [], rows: [], rowCount: 0, elapsedMs: 1, truncated: false };
    });
    const deps = runtime({ query });
    const calls = Array.from({ length: MAX_DATABASE_CONCURRENT_QUERIES + 1 }, () =>
      executeDatabaseAction({ action: 'query', sql: 'SELECT 1' }, deps)
    );

    while (query.mock.calls.length < MAX_DATABASE_CONCURRENT_QUERIES) await Promise.resolve();
    expect(query).toHaveBeenCalledTimes(MAX_DATABASE_CONCURRENT_QUERIES);
    expect(peak).toBe(MAX_DATABASE_CONCURRENT_QUERIES);

    releases.shift()!();
    while (query.mock.calls.length < MAX_DATABASE_CONCURRENT_QUERIES + 1) await Promise.resolve();
    expect(query).toHaveBeenCalledTimes(MAX_DATABASE_CONCURRENT_QUERIES + 1);
    expect(peak).toBe(MAX_DATABASE_CONCURRENT_QUERIES);

    for (const release of releases.splice(0)) release();
    while (releases.length === 0 && active > 0) await Promise.resolve();
    for (const release of releases.splice(0)) release();
    await Promise.all(calls);
  });
});
