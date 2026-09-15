import { afterEach, describe, expect, it, vi } from 'vitest';
import type { config as MsSqlConfig, IColumnMetadata } from 'mssql';
import { EventEmitter } from 'node:events';
import {
  querySqlServer,
  closeSqlServerPools,
  resetSqlServerPoolsForTests,
  SQL_SERVER_POOL_IDLE_MS,
  sqlServerDriverConfig,
  testSqlServerConnection,
  type SqlServerConnection,
  type SqlServerPoolFactory
} from '../src/main/database/sqlserver.js';

afterEach(async () => {
  await closeSqlServerPools().catch(() => undefined);
  resetSqlServerPoolsForTests();
  vi.useRealTimers();
});

function sqlConnection(overrides: Partial<SqlServerConnection> = {}): SqlServerConnection {
  return {
    server: 'db-host',
    database: 'ERP_TEST',
    authentication: { type: 'sql', user: 'erp_reader', password: 'secret' },
    ...overrides
  };
}

function fakeColumns(): IColumnMetadata {
  return {
    Ma_Zone: {
      index: 0,
      name: 'Ma_Zone',
      length: 20,
      type: { declaration: '', name: 'VarChar' },
      nullable: false,
      caseSensitive: false,
      identity: false,
      readOnly: true,
      primary: false
    },
    Ten_Zone: {
      index: 1,
      name: 'Ten_Zone',
      length: 100,
      type: { declaration: '', name: 'NVarChar' },
      nullable: true,
      caseSensitive: false,
      identity: false,
      readOnly: true,
      primary: false
    }
  } as unknown as IColumnMetadata;
}

function streamingRequest(rows: Record<string, unknown>[], columns = fakeColumns()) {
  type StreamingRequest = EventEmitter & {
    stream: boolean;
    input: ReturnType<typeof vi.fn<(name: string, value: unknown) => StreamingRequest>>;
    query: typeof query;
    cancel: typeof cancel;
  };
  const query = vi.fn<(sql: string) => Promise<any>>(async (_sql: string) => {
    queueMicrotask(() => {
      emitter.emit('recordset', columns);
      for (const row of rows) {
        if (emitter.cancel.mock.calls.length > 0) break;
        emitter.emit('row', row);
      }
      if (emitter.cancel.mock.calls.length === 0) emitter.emit('done', { rowsAffected: [rows.length] });
    });
    return { rowsAffected: [rows.length] };
  });
  const cancel = vi.fn<() => void>(() => {
    const error = Object.assign(new Error('Cancelled.'), { code: 'ECANCEL' });
    queueMicrotask(() => emitter.emit('error', error));
  });
  const emitter = new EventEmitter() as StreamingRequest;
  emitter.stream = false;
  emitter.input = vi.fn<(name: string, value: unknown) => StreamingRequest>(() => emitter);
  emitter.query = query;
  emitter.cancel = cancel;
  return emitter;
}

function streamingRangeRequest(count: number) {
  const request = streamingRequest([]);
  request.query = vi.fn<(sql: string) => Promise<any>>(async (_sql: string) => {
    queueMicrotask(() => {
      request.emit('recordset', fakeColumns());
      for (let id = 0; id < count; id += 1) {
        if (request.cancel.mock.calls.length > 0) break;
        request.emit('row', { id });
      }
      if (request.cancel.mock.calls.length === 0) request.emit('done', { rowsAffected: [count] });
    });
    return { rowsAffected: [count] };
  });
  return request;
}

describe('SQL Server provider', () => {
  it('maps SQL login and direct-driver connection options', () => {
    const config = sqlServerDriverConfig(sqlConnection({
      port: 1433,
      encrypt: true,
      trustServerCertificate: false,
      connectionTimeoutMs: 5_000,
      requestTimeoutMs: 7_000
    }));

    expect(config).toMatchObject({
      server: 'db-host',
      database: 'ERP_TEST',
      port: 1433,
      user: 'erp_reader',
      password: 'secret',
      connectionTimeout: 5_000,
      requestTimeout: 7_000,
      options: {
        encrypt: true,
        trustServerCertificate: false,
        appName: 'COS-ERP-DB'
      }
    });
  });

  it('maps NTLM credentials without a native sqlcmd/PowerShell hop', () => {
    const config = sqlServerDriverConfig(sqlConnection({
      authentication: { type: 'ntlm', domain: 'LINKQ', user: 'longvtt', password: 'secret' }
    }));
    expect(config).toMatchObject({ user: 'longvtt', password: 'secret', domain: 'LINKQ' });
  });

  it('connects, queries, returns structured rows/columns and closes the pool', async () => {
    const connect = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const request = streamingRequest([{ Ma_Zone: 'Z01', Ten_Zone: 'HCM' }, { Ma_Zone: 'Z02', Ten_Zone: 'HN' }]);
    const seen: MsSqlConfig[] = [];
    const factory: SqlServerPoolFactory = (config) => {
      seen.push(config);
      return { connect, close, request: () => request };
    };

    const result = await querySqlServer(sqlConnection(), 'SELECT TOP 2 * FROM L00ZONES', factory);

    expect(seen).toHaveLength(1);
    expect(connect).toHaveBeenCalledOnce();
    expect(request.query).toHaveBeenCalledWith('SELECT TOP 2 * FROM L00ZONES');
    expect(request.stream).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(result.columns).toEqual([
      { name: 'Ma_Zone', type: 'VarChar', nullable: false },
      { name: 'Ten_Zone', type: 'NVarChar', nullable: true }
    ]);
    expect(result.rows).toEqual([{ Ma_Zone: 'Z01', Ten_Zone: 'HCM' }, { Ma_Zone: 'Z02', Ten_Zone: 'HN' }]);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('uses rowsAffected when a command has no recordset', async () => {
    const request = streamingRequest([], {} as IColumnMetadata);
    request.query = vi.fn<(sql: string) => Promise<any>>(async (_sql: string) => {
      queueMicrotask(() => request.emit('done', { rowsAffected: [2, 3] }));
      return { rowsAffected: [2, 3] };
    });
    const factory: SqlServerPoolFactory = () => ({
      connect: async () => undefined,
      close: async () => undefined,
      request: () => request
    });
    const result = await querySqlServer(sqlConnection(), 'UPDATE Something SET Flag = 1', factory);
    expect(result).toMatchObject({ columns: [], rows: [], rowCount: 5, truncated: false });
  });

  it('closes an established pool when the query fails', async () => {
    const close = vi.fn(async () => undefined);
    const request = streamingRequest([]);
    request.query = vi.fn<(sql: string) => Promise<any>>(async (_sql: string) => {
      queueMicrotask(() => request.emit('error', new Error('boom')));
      return {};
    });
    const factory: SqlServerPoolFactory = () => ({
      connect: async () => undefined,
      close,
      request: () => request
    });
    await expect(querySqlServer(sqlConnection(), 'SELECT broken', factory)).rejects.toThrow('boom');
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects malformed connection/query input before opening a pool', async () => {
    const factory = vi.fn<SqlServerPoolFactory>(() => {
      throw new Error('must not be created');
    });
    await expect(querySqlServer(sqlConnection(), '   ', factory)).rejects.toThrow(/sql must not be blank/);
    expect(factory).not.toHaveBeenCalled();
    expect(() => sqlServerDriverConfig(sqlConnection({ port: 1433, instanceName: 'SQLEXPRESS' }))).toThrow(/cannot be used together/);
  });

  it('reuses the same direct query path for connection testing', async () => {
    const request = streamingRequest([{ ok: 1 }], {
      ok: { ...Object.values(fakeColumns())[0]!, name: 'ok', index: 0 }
    } as unknown as IColumnMetadata);
    const factory: SqlServerPoolFactory = () => ({
      connect: async () => undefined,
      close: async () => undefined,
      request: () => request
    });
    await expect(testSqlServerConnection(sqlConnection(), factory)).resolves.toEqual({ elapsedMs: expect.any(Number) });
    expect(request.query).toHaveBeenCalledWith('SELECT 1 AS ok');
  });

  it('stops the driver after the first row beyond the hard row limit instead of materializing a million-row result', async () => {
    let emitted = 0;
    const request = streamingRangeRequest(1_000_000);
    request.on('row', () => { emitted += 1; });
    const close = vi.fn(async () => undefined);
    const factory: SqlServerPoolFactory = () => ({ connect: async () => undefined, close, request: () => request });

    const result = await querySqlServer(sqlConnection(), 'SELECT id FROM HugeTable', factory, { maxRows: 3, maxBytes: 100_000 });

    expect(result.rows).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);
    expect(result.truncated).toBe(true);
    expect(emitted).toBeLessThanOrEqual(4);
    expect(request.cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('stops the driver when the byte budget is exceeded', async () => {
    const request = streamingRequest([{ value: 'a'.repeat(32) }, { value: 'b'.repeat(32) }]);
    const factory: SqlServerPoolFactory = () => ({ connect: async () => undefined, close: async () => undefined, request: () => request });

    const result = await querySqlServer(sqlConnection(), 'SELECT value FROM HugeTable', factory, { maxRows: 50, maxBytes: 60 });

    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(request.cancel).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight streaming request when the caller aborts', async () => {
    const request = streamingRequest([]);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    request.query = vi.fn<(sql: string) => Promise<any>>(async (_sql: string) => {
      markStarted();
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const factory: SqlServerPoolFactory = () => ({ connect: async () => undefined, close: async () => undefined, request: () => request });

    const running = querySqlServer(sqlConnection(), 'SELECT id FROM SlowTable', factory, { signal: controller.signal });
    await started;
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(request.cancel).toHaveBeenCalledOnce();
  });

  it('binds named parameters through the driver instead of interpolating values into SQL', async () => {
    const request = streamingRequest([{ object_id: 1 }]);
    const factory: SqlServerPoolFactory = () => ({ connect: async () => undefined, close: async () => undefined, request: () => request });

    await querySqlServer(sqlConnection(), 'SELECT @needle AS object_id', factory, {
      parameters: { needle: "L00ZONES'; DROP TABLE X;--" }
    });

    expect(request.input).toHaveBeenCalledWith('needle', "L00ZONES'; DROP TABLE X;--");
    expect(request.query).toHaveBeenCalledWith('SELECT @needle AS object_id');
  });

  it('reuses one connected pool for the same fingerprint and closes it at final shutdown', async () => {
    const connect = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const factory = vi.fn<SqlServerPoolFactory>(() => ({
      connect,
      close,
      request: () => streamingRequest([{ ok: 1 }])
    }));

    await querySqlServer(sqlConnection(), 'SELECT 1', factory, { reusePool: true });
    await querySqlServer(sqlConnection(), 'SELECT 2', factory, { reusePool: true });

    expect(factory).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();

    await closeSqlServerPools();
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not reuse a pool after connection credentials or endpoint settings change', async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const factory = vi.fn<SqlServerPoolFactory>(() => {
      const close = vi.fn(async () => undefined);
      closes.push(close);
      return { connect: async () => undefined, close, request: () => streamingRequest([{ ok: 1 }]) };
    });

    await querySqlServer(sqlConnection(), 'SELECT 1', factory, { reusePool: true });
    await querySqlServer(sqlConnection({ database: 'ERP_OTHER' }), 'SELECT 1', factory, { reusePool: true });
    await querySqlServer(sqlConnection({ authentication: { type: 'sql', user: 'erp_reader', password: 'new-secret' } }), 'SELECT 1', factory, { reusePool: true });

    expect(factory).toHaveBeenCalledTimes(3);
    await closeSqlServerPools();
    expect(closes.every(close => close.mock.calls.length === 1)).toBe(true);
  });

  it('retires an idle shared pool without keeping the app alive', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const factory: SqlServerPoolFactory = () => ({
      connect: async () => undefined,
      close,
      request: () => streamingRequest([{ ok: 1 }])
    });

    await querySqlServer(sqlConnection(), 'SELECT 1', factory, { reusePool: true });
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SQL_SERVER_POOL_IDLE_MS + 1);
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves the primary query failure when ephemeral pool cleanup also fails', async () => {
    const request = streamingRequest([]);
    request.query = vi.fn<(sql: string) => Promise<any>>(async () => {
      queueMicrotask(() => request.emit('error', new Error('query failed')));
      return {};
    });
    const factory: SqlServerPoolFactory = () => ({
      connect: async () => undefined,
      close: async () => { throw new Error('close failed'); },
      request: () => request
    });

    await expect(querySqlServer(sqlConnection(), 'SELECT broken', factory)).rejects.toThrow('query failed');
  });
});
