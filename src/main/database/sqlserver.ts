import { ConnectionPool, type config as MsSqlConfig, type IColumnMetadata } from 'mssql';
import { createHash } from 'node:crypto';

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 120_000;
export const SQL_SERVER_POOL_IDLE_MS = 60_000;

export type SqlServerAuthentication =
  | { type: 'sql'; user: string; password: string }
  | { type: 'ntlm'; user: string; password: string; domain: string };

export interface SqlServerConnection {
  server: string;
  database?: string;
  port?: number;
  instanceName?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  authentication: SqlServerAuthentication;
}

export interface SqlServerColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface SqlServerQueryResult {
  columns: SqlServerColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
  truncated: boolean;
}

export interface SqlServerQueryOptions {
  maxRows?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Named driver parameters. Keys exclude the leading @ and are never interpolated into SQL. */
  parameters?: Readonly<Record<string, string | number | boolean | null>>;
  /** Test/internal seam. Production defaults to shared pools only for the native factory. */
  reusePool?: boolean;
}

interface DriverRecordset extends Array<Record<string, unknown>> {
  columns?: IColumnMetadata;
}

interface DriverResult {
  recordset?: DriverRecordset;
  rowsAffected?: number[];
}

interface DriverRequest {
  stream: boolean;
  input(name: string, value: unknown): this;
  query(sql: string): Promise<DriverResult>;
  cancel(): void;
  on(event: 'recordset', listener: (columns: IColumnMetadata) => void): this;
  on(event: 'row', listener: (row: Record<string, unknown>) => void): this;
  on(event: 'error', listener: (error: Error & { code?: string }) => void): this;
  on(event: 'done', listener: (result: { rowsAffected?: number[] }) => void): this;
}

interface DriverPool {
  connect(): Promise<unknown>;
  request(): DriverRequest;
  close(): Promise<void>;
}

export type SqlServerPoolFactory = (config: MsSqlConfig) => DriverPool;

const defaultPoolFactory: SqlServerPoolFactory = (config) => new ConnectionPool(config);

interface SharedPoolEntry {
  pool: DriverPool;
  connect: Promise<void>;
  connected: boolean;
  active: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: Promise<void> | null;
}

const sharedPools = new Map<string, SharedPoolEntry>();
const poolFactoryIds = new WeakMap<SqlServerPoolFactory, number>();
let nextPoolFactoryId = 1;
let sqlServerPoolsClosing = false;

function poolFactoryId(factory: SqlServerPoolFactory): number {
  const existing = poolFactoryIds.get(factory);
  if (existing !== undefined) return existing;
  const id = nextPoolFactoryId++;
  poolFactoryIds.set(factory, id);
  return id;
}

/** Hash the full driver config so credential/endpoint/TLS changes can never reuse a stale pool. */
function poolKey(factory: SqlServerPoolFactory, config: MsSqlConfig): string {
  const fingerprint = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  return `${poolFactoryId(factory)}:${fingerprint}`;
}

async function closeSharedPool(key: string, entry: SharedPoolEntry): Promise<void> {
  if (entry.closing) return entry.closing;
  if (sharedPools.get(key) === entry) sharedPools.delete(key);
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  entry.closing = (async () => {
    try {
      await entry.connect;
    } catch {
      return;
    }
    if (entry.connected) await entry.pool.close();
  })();
  return entry.closing;
}

function scheduleSharedPoolClose(key: string, entry: SharedPoolEntry): void {
  if (sqlServerPoolsClosing || entry.active !== 0 || entry.closing || sharedPools.get(key) !== entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null;
    void closeSharedPool(key, entry).catch(() => undefined);
  }, SQL_SERVER_POOL_IDLE_MS);
  entry.idleTimer.unref?.();
}

async function acquireSharedPool(
  factory: SqlServerPoolFactory,
  config: MsSqlConfig
): Promise<{ pool: DriverPool; release: () => void }> {
  if (sqlServerPoolsClosing) throw new Error('SQL Server pools are shutting down');
  const key = poolKey(factory, config);
  let entry = sharedPools.get(key);
  if (!entry) {
    const pool = factory(config);
    const created: SharedPoolEntry = {
      pool,
      connect: Promise.resolve(),
      connected: false,
      active: 0,
      idleTimer: null,
      closing: null
    };
    created.connect = pool.connect().then(() => {
      created.connected = true;
    }).catch((error) => {
      if (sharedPools.get(key) === created) sharedPools.delete(key);
      throw error;
    });
    sharedPools.set(key, created);
    entry = created;
  }
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  entry.active += 1;
  try {
    await entry.connect;
    if (sqlServerPoolsClosing) throw new Error('SQL Server pools are shutting down');
  } catch (error) {
    entry.active = Math.max(0, entry.active - 1);
    throw error;
  }
  let released = false;
  return {
    pool: entry.pool,
    release: () => {
      if (released) return;
      released = true;
      entry!.active = Math.max(0, entry!.active - 1);
      scheduleSharedPoolClose(key, entry!);
    }
  };
}

/** Final app-shutdown owner for all cached native SQL Server pools. */
export async function closeSqlServerPools(): Promise<void> {
  sqlServerPoolsClosing = true;
  const entries = [...sharedPools.entries()];
  const results = await Promise.allSettled(entries.map(([key, entry]) => closeSharedPool(key, entry)));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}

/** Test process continues after simulated shutdown; a real Electron process exits instead. */
export function resetSqlServerPoolsForTests(): void {
  sharedPools.clear();
  sqlServerPoolsClosing = false;
}

function nonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === '') throw new Error(`${field} must not be blank`);
  return normalized;
}

function boundedTimeout(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < MIN_TIMEOUT_MS || resolved > MAX_TIMEOUT_MS) {
    throw new Error(`${field} must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms`);
  }
  return resolved;
}

function sqlTypeName(type: IColumnMetadata[string]['type']): string {
  const direct = type as unknown as { declaration?: string; name?: string; type?: unknown };
  const candidate = typeof type === 'function' ? type : direct.type ?? direct;
  const described = candidate as { declaration?: string; name?: string };
  return described.declaration?.trim() || described.name?.trim() || 'unknown';
}

function columnsFrom(metadata: IColumnMetadata | undefined): SqlServerColumn[] {
  if (!metadata) return [];
  return Object.values(metadata)
    .sort((left, right) => left.index - right.index)
    .map((column) => ({
      name: column.name,
      type: sqlTypeName(column.type),
      nullable: column.nullable
    }));
}

function affectedRowCount(rowsAffected: readonly number[] | undefined): number {
  return (rowsAffected ?? []).reduce((total, value) => total + Math.max(0, value), 0);
}

function positiveLimit(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function bindParameters(request: DriverRequest, parameters: SqlServerQueryOptions['parameters']): void {
  if (!parameters) return;
  for (const [name, value] of Object.entries(parameters)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid SQL parameter name: ${name}`);
    request.input(name, value);
  }
}

function jsonSafe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value ?? null;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (depth >= 8) return String(value);
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) result[key] = jsonSafe(entry, depth + 1);
    return result;
  }
  return String(value);
}

function abortError(): Error {
  const error = new Error('SQL Server query was cancelled.');
  error.name = 'AbortError';
  return error;
}

function streamQuery(
  request: DriverRequest,
  command: string,
  options: SqlServerQueryOptions,
  startedAt: number
): Promise<SqlServerQueryResult> {
  const maxRows = positiveLimit(options.maxRows, 'maxRows');
  const maxBytes = positiveLimit(options.maxBytes, 'maxBytes');

  return new Promise((resolve, reject) => {
    const rows: Record<string, unknown>[] = [];
    let columns: SqlServerColumn[] = [];
    let bytes = 2; // []
    let rowsAffected: number[] | undefined;
    let truncated = false;
    let stoppingForLimit = false;
    let stoppingForAbort = false;
    let settled = false;

    const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stoppingForAbort) {
        reject(abortError());
        return;
      }
      resolve({
        columns,
        rows,
        rowCount: columns.length > 0 ? rows.length : affectedRowCount(rowsAffected),
        elapsedMs: Date.now() - startedAt,
        truncated
      });
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = (reason: 'limit' | 'abort') => {
      if (settled || stoppingForLimit || stoppingForAbort) return;
      if (reason === 'limit') {
        truncated = true;
        stoppingForLimit = true;
      } else {
        stoppingForAbort = true;
      }
      try {
        request.cancel();
      } catch (error) {
        fail(error);
      }
    };
    const onAbort = () => cancel('abort');

    request.stream = true;
    request.on('recordset', (metadata) => {
      if (columns.length === 0) columns = columnsFrom(metadata);
    });
    request.on('row', (row) => {
      if (stoppingForLimit || stoppingForAbort || settled) return;
      const safe = jsonSafe(row) as Record<string, unknown>;
      const encoded = JSON.stringify(safe);
      const cost = Buffer.byteLength(encoded, 'utf8') + (rows.length === 0 ? 0 : 1);
      if ((maxRows !== undefined && rows.length >= maxRows) || (maxBytes !== undefined && bytes + cost > maxBytes)) {
        cancel('limit');
        return;
      }
      rows.push(safe);
      bytes += cost;
    });
    request.on('error', (error) => {
      // `mssql` reports ECANCEL for our own bounded/caller cancellation. The done/error
      // boundary means the request has stopped and the pool can now be closed safely.
      if ((stoppingForLimit || stoppingForAbort) && error.code === 'ECANCEL') {
        finish();
        return;
      }
      fail(error);
    });
    request.on('done', (result) => {
      rowsAffected = result.rowsAffected;
      finish();
    });

    if (options.signal?.aborted) {
      stoppingForAbort = true;
      fail(abortError());
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    void request.query(command).catch((error) => {
      if (stoppingForLimit || stoppingForAbort) {
        if (!settled) finish();
        return;
      }
      fail(error);
    });
  });
}

/**
 * Builds the native Node/TDS driver config. This module never shells out to sqlcmd,
 * PowerShell or exec_command; `mssql`/`tedious` owns the TCP/TDS connection directly.
 */
export function sqlServerDriverConfig(connection: SqlServerConnection): MsSqlConfig {
  const server = nonBlank(connection.server, 'server');
  const database = connection.database?.trim();
  const instanceName = connection.instanceName?.trim();
  if (connection.port !== undefined && instanceName) {
    throw new Error('port and instanceName cannot be used together');
  }
  if (connection.port !== undefined && (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65_535)) {
    throw new Error('port must be an integer between 1 and 65535');
  }

  const auth = connection.authentication;
  const config: MsSqlConfig = {
    server,
    ...(database ? { database } : {}),
    ...(connection.port === undefined ? {} : { port: connection.port }),
    connectionTimeout: boundedTimeout(connection.connectionTimeoutMs, DEFAULT_CONNECTION_TIMEOUT_MS, 'connectionTimeoutMs'),
    requestTimeout: boundedTimeout(connection.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs'),
    options: {
      encrypt: connection.encrypt ?? false,
      trustServerCertificate: connection.trustServerCertificate ?? true,
      ...(instanceName ? { instanceName } : {}),
      appName: 'COS-ERP-DB'
    }
  };

  if (auth.type === 'sql') {
    config.user = nonBlank(auth.user, 'authentication.user');
    config.password = auth.password;
  } else {
    config.user = nonBlank(auth.user, 'authentication.user');
    config.password = auth.password;
    config.domain = nonBlank(auth.domain, 'authentication.domain');
  }
  return config;
}

/** One connection + one query + guaranteed close: deliberately minimal for the first vertical slice. */
export async function querySqlServer(
  connection: SqlServerConnection,
  sql: string,
  poolFactory: SqlServerPoolFactory = defaultPoolFactory,
  options: SqlServerQueryOptions = {}
): Promise<SqlServerQueryResult> {
  const command = nonBlank(sql, 'sql');
  positiveLimit(options.maxRows, 'maxRows');
  positiveLimit(options.maxBytes, 'maxBytes');
  const config = sqlServerDriverConfig(connection);
  const startedAt = Date.now();
  const reusePool = options.reusePool ?? poolFactory === defaultPoolFactory;
  const shared = reusePool ? await acquireSharedPool(poolFactory, config) : null;
  const pool = shared?.pool ?? poolFactory(config);
  let connected = false;
  let primaryError: unknown;
  try {
    if (!shared) {
      await pool.connect();
      connected = true;
    }
    if (options.signal?.aborted) throw abortError();
    const request = pool.request();
    bindParameters(request, options.parameters);
    return await streamQuery(request, command, options, startedAt);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (shared) {
      shared.release();
    } else if (connected) {
      // Cleanup must not replace the SQL error the caller actually needs to diagnose.
      try {
        await pool.close();
      } catch (error) {
        if (primaryError === undefined) throw error;
      }
    }
  }
}

/** Cheap real-connection probe used later by setup/UI without needing a separate code path. */
export async function testSqlServerConnection(
  connection: SqlServerConnection,
  poolFactory: SqlServerPoolFactory = defaultPoolFactory
): Promise<{ elapsedMs: number }> {
  const result = await querySqlServer(connection, 'SELECT 1 AS ok', poolFactory, { maxRows: 1, maxBytes: 4_096 });
  return { elapsedMs: result.elapsedMs };
}
