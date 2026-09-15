import {
  querySqlServer,
  testSqlServerConnection,
  type SqlServerConnection,
  type SqlServerQueryOptions,
  type SqlServerQueryResult
} from './sqlserver.js';
import { resolveSqlServerProfile, type ResolvedSqlServerProfile } from './profiles.js';
import { searchSqlServerObjects } from './metadata.js';
import type {
  DatabaseAccessMode,
  DatabaseGrowthDiagnosticsResult,
  DatabaseObjectDetailRequest,
  DatabaseObjectDetailsResult,
  DatabaseObjectSearchInput,
  DatabaseObjectSearchResult,
  DatabaseObjectType,
  DatabaseTablePageRequest,
  DatabaseTablePageResult,
  DatabaseTableCellUpdateRequest,
  DatabaseTableCellUpdateResult,
  DatabaseWorkspaceContext
} from '../../shared/database.js';
import { readSqlServerTablePage } from './table-data.js';
import { updateSqlServerTableCell } from './table-write.js';
import { readSqlServerObjectDetails } from './object-details.js';
import { readSqlServerGrowthDiagnostics } from './growth-diagnostics.js';
import { getDatabaseWorkspaceContext } from './workspace-context.js';
import { readDatabaseSettings } from './store.js';

export const MAX_DATABASE_SQL_CHARS = 32_000;
export const MAX_DATABASE_ROWS = 200;
export const MAX_DATABASE_RESULT_BYTES = 1_000_000;
export const MAX_DATABASE_CONCURRENT_QUERIES = 4;

export type DatabaseActionInput =
  | { action: 'test'; connection?: string }
  | { action: 'list_connections' }
  | { action: 'workspace_context' }
  | { action: 'growth_diagnostics'; connection?: string }
  | { action: 'query'; connection?: string; sql: string }
  | { action: 'search_objects'; connection?: string; search?: string; types?: DatabaseObjectType[]; limit?: number; cursor?: string }
  | ({ action: 'table_page' } & DatabaseTablePageRequest)
  | ({ action: 'object_details' } & DatabaseObjectDetailRequest);

export interface DatabaseQueryOutput {
  action: 'query';
  connection: string;
  database: string;
  columns: SqlServerQueryResult['columns'];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
  truncated: boolean;
}

export interface DatabaseTestOutput {
  action: 'test';
  connection: string;
  database: string;
  ok: true;
  elapsedMs: number;
}

export interface DatabaseObjectSearchOutput extends DatabaseObjectSearchResult {
  action: 'search_objects';
  connection: string;
  database: string;
}

export interface DatabaseTablePageOutput extends DatabaseTablePageResult {
  action: 'table_page';
  connection: string;
  database: string;
}

export interface DatabaseObjectDetailsOutput extends DatabaseObjectDetailsResult {
  action: 'object_details';
  connection: string;
  database: string;
}

export interface DatabaseGrowthDiagnosticsOutput extends DatabaseGrowthDiagnosticsResult {
  action: 'growth_diagnostics';
  connection: string;
}

export interface DatabaseWorkspaceContextOutput {
  action: 'workspace_context';
  context: DatabaseWorkspaceContext | null;
}

export interface DatabaseConnectionSummary {
  id: string;
  name: string;
  database: string;
  accessMode: DatabaseAccessMode;
  isDefault: boolean;
}

export interface DatabaseConnectionsOutput {
  action: 'list_connections';
  defaultConnectionId?: string;
  connections: DatabaseConnectionSummary[];
}

export type DatabaseActionOutput = DatabaseQueryOutput | DatabaseTestOutput | DatabaseObjectSearchOutput | DatabaseTablePageOutput | DatabaseObjectDetailsOutput | DatabaseGrowthDiagnosticsOutput | DatabaseWorkspaceContextOutput | DatabaseConnectionsOutput;

interface DatabaseRuntime {
  resolve(requestedId?: string): Promise<ResolvedSqlServerProfile>;
  listConnections(): Promise<{ defaultConnectionId?: string; connections: DatabaseConnectionSummary[] }>;
  query(connection: SqlServerConnection, sql: string, options?: SqlServerQueryOptions): Promise<SqlServerQueryResult>;
  searchObjects(connection: SqlServerConnection, input: DatabaseObjectSearchInput, options?: { signal?: AbortSignal }): Promise<DatabaseObjectSearchResult>;
  tablePage(connection: SqlServerConnection, input: Omit<DatabaseTablePageRequest, 'connection'>, options?: { signal?: AbortSignal }): Promise<DatabaseTablePageResult>;
  tableCellUpdate(connection: SqlServerConnection, input: Omit<DatabaseTableCellUpdateRequest, 'connection'>, options?: { signal?: AbortSignal }): Promise<DatabaseTableCellUpdateResult>;
  objectDetails(connection: SqlServerConnection, objectId: number, section: DatabaseObjectDetailRequest['section'], options?: { signal?: AbortSignal }): Promise<DatabaseObjectDetailsResult>;
  growthDiagnostics(connection: SqlServerConnection, options?: { signal?: AbortSignal }): Promise<DatabaseGrowthDiagnosticsResult>;
  workspaceContext(): DatabaseWorkspaceContext | null;
  test(connection: SqlServerConnection): Promise<{ elapsedMs: number }>;
}

const DEFAULT_RUNTIME: DatabaseRuntime = {
  resolve: (requestedId) => resolveSqlServerProfile(requestedId),
  listConnections: async () => {
    const settings = await readDatabaseSettings();
    return {
      ...(settings.defaultConnectionId ? { defaultConnectionId: settings.defaultConnectionId } : {}),
      connections: settings.connections.map(profile => ({
        id: profile.id,
        name: profile.name,
        database: profile.database,
        accessMode: profile.accessMode,
        isDefault: profile.id.toLowerCase() === settings.defaultConnectionId?.toLowerCase()
      }))
    };
  },
  query: (connection, sql) => querySqlServer(connection, sql),
  searchObjects: (connection, input, options) => searchSqlServerObjects(connection, input, options),
  tablePage: (connection, input, options) => readSqlServerTablePage(connection, input, options),
  tableCellUpdate: (connection, input, options) => updateSqlServerTableCell(connection, input, options),
  objectDetails: (connection, objectId, section, options) => readSqlServerObjectDetails(connection, objectId, section, options),
  growthDiagnostics: (connection, options) => readSqlServerGrowthDiagnostics(connection, options),
  workspaceContext: () => getDatabaseWorkspaceContext(),
  test: (connection) => testSqlServerConnection(connection)
};

export class DatabaseServiceError extends Error {}

interface QueryWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface QueryGate {
  active: number;
  queue: QueryWaiter[];
}

const queryGates = new Map<string, QueryGate>();

function cancelledError(): DatabaseServiceError {
  return new DatabaseServiceError('Database query was cancelled.');
}

function releaseQuerySlot(key: string, gate: QueryGate): void {
  gate.active = Math.max(0, gate.active - 1);
  while (gate.queue.length > 0 && gate.active < MAX_DATABASE_CONCURRENT_QUERIES) {
    const waiter = gate.queue.shift()!;
    waiter.signal?.removeEventListener('abort', waiter.onAbort!);
    if (waiter.signal?.aborted) {
      waiter.reject(cancelledError());
      continue;
    }
    gate.active += 1;
    waiter.resolve(() => releaseQuerySlot(key, gate));
  }
  if (gate.active === 0 && gate.queue.length === 0) queryGates.delete(key);
}

function acquireQuerySlot(key: string, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  const gate = queryGates.get(key) ?? { active: 0, queue: [] };
  queryGates.set(key, gate);
  if (gate.active < MAX_DATABASE_CONCURRENT_QUERIES) {
    gate.active += 1;
    return Promise.resolve(() => releaseQuerySlot(key, gate));
  }
  return new Promise((resolve, reject) => {
    const waiter: QueryWaiter = { resolve, reject, signal };
    if (signal) {
      waiter.onAbort = () => {
        const index = gate.queue.indexOf(waiter);
        if (index >= 0) gate.queue.splice(index, 1);
        signal.removeEventListener('abort', waiter.onAbort!);
        reject(cancelledError());
        if (gate.active === 0 && gate.queue.length === 0) queryGates.delete(key);
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    gate.queue.push(waiter);
  });
}

/**
 * Replaces quoted strings/identifiers and comments with spaces while preserving statement
 * punctuation. The read-only validator only trusts tokens that remain visible after this pass.
 */
function sqlCodeOnly(sql: string): string {
  let output = '';
  let index = 0;
  while (index < sql.length) {
    const ch = sql[index]!;
    const next = sql[index + 1];

    if (ch === "'") {
      output += ' ';
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          output += '  ';
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          output += ' ';
          index += 1;
          closed = true;
          break;
        }
        output += sql[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (!closed) throw new DatabaseServiceError('SQL could not be verified as read-only because a string literal is not closed.');
      continue;
    }

    if (ch === '[') {
      output += ' ';
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === ']' && sql[index + 1] === ']') {
          output += '  ';
          index += 2;
          continue;
        }
        if (sql[index] === ']') {
          output += ' ';
          index += 1;
          closed = true;
          break;
        }
        output += sql[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (!closed) throw new DatabaseServiceError('SQL could not be verified as read-only because a bracketed identifier is not closed.');
      continue;
    }

    if (ch === '"') {
      output += ' ';
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          output += '  ';
          index += 2;
          continue;
        }
        if (sql[index] === '"') {
          output += ' ';
          index += 1;
          closed = true;
          break;
        }
        output += sql[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (!closed) throw new DatabaseServiceError('SQL could not be verified as read-only because a quoted identifier is not closed.');
      continue;
    }

    if (ch === '-' && next === '-') {
      output += '  ';
      index += 2;
      while (index < sql.length && sql[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      output += '  ';
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          output += '  ';
          index += 2;
          depth += 1;
          continue;
        }
        if (sql[index] === '*' && sql[index + 1] === '/') {
          output += '  ';
          index += 2;
          depth -= 1;
          continue;
        }
        output += sql[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (depth !== 0) throw new DatabaseServiceError('SQL could not be verified as read-only because a block comment is not closed.');
      continue;
    }

    output += ch;
    index += 1;
  }
  return output;
}

const BLOCKED_SQL_TOKENS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'EXEC',
  'EXECUTE',
  'GRANT',
  'REVOKE',
  'DENY',
  'BACKUP',
  'RESTORE',
  'DBCC',
  'INTO',
  'WAITFOR',
  'USE',
  'DECLARE',
  'SET'
]);

/**
 * SELECT is not synonymous with side-effect free on SQL Server. These constructs can reach
 * outside the configured database or deliberately acquire locks that interfere with writers.
 * Keep this gate conservative in Read-only mode; Full access is only a stored future policy at
 * this stage and does not bypass the model-facing query tool.
 */
const BLOCKED_READ_ONLY_EXTERNAL_TOKENS = new Set([
  'OPENROWSET',
  'OPENDATASOURCE',
  'OPENQUERY'
]);

const BLOCKED_READ_ONLY_LOCK_TOKENS = new Set([
  'HOLDLOCK',
  'PAGLOCK',
  'READCOMMITTEDLOCK',
  'REPEATABLEREAD',
  'ROWLOCK',
  'SERIALIZABLE',
  'TABLOCK',
  'TABLOCKX',
  'UPDLOCK',
  'XLOCK'
]);

/** Conservative V0 gate: if the statement cannot be proven to be one SELECT/CTE query, refuse it. */
export function assertReadOnlySql(sql: string): string {
  const command = sql.trim();
  if (command === '') throw new DatabaseServiceError('SQL must not be blank.');
  if (command.length > MAX_DATABASE_SQL_CHARS) {
    throw new DatabaseServiceError(`SQL is too long. Maximum length is ${MAX_DATABASE_SQL_CHARS} characters.`);
  }

  const code = sqlCodeOnly(command);
  const semicolons = [...code.matchAll(/;/g)].map((match) => match.index ?? -1);
  if (semicolons.length > 1 || (semicolons.length === 1 && code.slice(semicolons[0]! + 1).trim() !== '')) {
    throw new DatabaseServiceError('Only one read-only SQL statement is allowed per database call.');
  }

  const statement = semicolons.length === 1 ? code.slice(0, semicolons[0]) : code;
  const tokens = [...statement.matchAll(/[A-Za-z_][A-Za-z0-9_$#@]*/g)].map((match) => match[0]!.toUpperCase());
  if (tokens.length === 0 || (tokens[0] !== 'SELECT' && tokens[0] !== 'WITH')) {
    throw new DatabaseServiceError('Only read-only SELECT queries are allowed.');
  }
  const blocked = tokens.find((token) => BLOCKED_SQL_TOKENS.has(token));
  if (blocked) {
    throw new DatabaseServiceError(
      blocked === 'INTO' ? 'SELECT INTO is not allowed.' : `SQL keyword ${blocked} is not allowed by the read-only database tool.`
    );
  }
  if (/\bNEXT\s+VALUE\s+FOR\b/i.test(statement)) {
    throw new DatabaseServiceError('NEXT VALUE FOR is not allowed in read-only mode because it advances a SQL Server sequence.');
  }
  const external = tokens.find((token) => BLOCKED_READ_ONLY_EXTERNAL_TOKENS.has(token));
  if (external) {
    throw new DatabaseServiceError(`External data access ${external} is not allowed in read-only mode.`);
  }
  const lock = tokens.find((token) => BLOCKED_READ_ONLY_LOCK_TOKENS.has(token));
  if (lock) {
    throw new DatabaseServiceError(`SQL locking hint ${lock} is not allowed in read-only mode.`);
  }
  // SQL Server's client batch separator is not part of T-SQL, but refusing it here gives a
  // deterministic single-statement answer before the driver sees a copied SSMS script.
  if (tokens.includes('GO')) throw new DatabaseServiceError('SQL batch separator GO is not allowed.');
  return command;
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

function boundedRows(rows: readonly Record<string, unknown>[]): { rows: Record<string, unknown>[]; truncated: boolean } {
  const kept: Record<string, unknown>[] = [];
  let bytes = 2; // []
  for (const row of rows) {
    if (kept.length >= MAX_DATABASE_ROWS) return { rows: kept, truncated: true };
    const safe = jsonSafe(row) as Record<string, unknown>;
    const encoded = JSON.stringify(safe);
    const cost = Buffer.byteLength(encoded, 'utf8') + (kept.length === 0 ? 0 : 1);
    if (bytes + cost > MAX_DATABASE_RESULT_BYTES) return { rows: kept, truncated: true };
    kept.push(safe);
    bytes += cost;
  }
  return { rows: kept, truncated: false };
}

function redactError(error: unknown, password: string): DatabaseServiceError {
  let message = error instanceof Error ? error.message : String(error);
  if (password) message = message.split(password).join('[redacted]');
  return new DatabaseServiceError(message);
}

export async function executeDatabaseAction(
  input: DatabaseActionInput,
  runtime: DatabaseRuntime = DEFAULT_RUNTIME,
  options: { signal?: AbortSignal } = {}
): Promise<DatabaseActionOutput> {
  // Reject unsafe SQL before profile selection or credential lookup. A malformed/mutating
  // request must never cause even a secret-store read, much less reach the provider.
  const verifiedSql = input.action === 'query' ? assertReadOnlySql(input.sql) : null;
  if (input.action === 'list_connections') {
    return { action: 'list_connections', ...(await runtime.listConnections()) };
  }
  if (input.action === 'workspace_context') {
    return { action: 'workspace_context', context: runtime.workspaceContext() };
  }
  let profile: ResolvedSqlServerProfile;
  try {
    profile = await runtime.resolve(input.connection);
  } catch (error) {
    throw new DatabaseServiceError(error instanceof Error ? error.message : String(error));
  }
  const connection = profile.connection;
  const password = connection.authentication.password;
  const database = connection.database ?? '';

  try {
    if (input.action === 'test') {
      const result = await runtime.test(connection);
      return {
        action: 'test',
        connection: profile.id,
        database,
        ok: true,
        elapsedMs: result.elapsedMs
      };
    }

    if (input.action === 'search_objects') {
      const release = await acquireQuerySlot(profile.id, options.signal);
      try {
        const result = await runtime.searchObjects(connection, input, options);
        return {
          action: 'search_objects',
          connection: profile.id,
          database,
          ...result
        };
      } finally {
        release();
      }
    }

    if (input.action === 'table_page') {
      const release = await acquireQuerySlot(profile.id, options.signal);
      try {
        const { connection: _connection, action: _action, ...request } = input;
        const result = await runtime.tablePage(connection, request, options);
        return {
          action: 'table_page',
          connection: profile.id,
          database,
          ...result
        };
      } finally {
        release();
      }
    }

    if (input.action === 'object_details') {
      const release = await acquireQuerySlot(profile.id, options.signal);
      try {
        const result = await runtime.objectDetails(connection, input.objectId, input.section, options);
        return {
          action: 'object_details',
          connection: profile.id,
          database,
          ...result
        };
      } finally {
        release();
      }
    }

    if (input.action === 'growth_diagnostics') {
      const release = await acquireQuerySlot(profile.id, options.signal);
      try {
        const result = await runtime.growthDiagnostics(connection, options);
        return {
          action: 'growth_diagnostics',
          connection: profile.id,
          ...result
        };
      } finally {
        release();
      }
    }

    const release = await acquireQuerySlot(profile.id, options.signal);
    let result: SqlServerQueryResult;
    try {
      result = await runtime.query(connection, verifiedSql!, {
        maxRows: MAX_DATABASE_ROWS,
        maxBytes: MAX_DATABASE_RESULT_BYTES,
        ...(options.signal ? { signal: options.signal } : {})
      });
    } finally {
      release();
    }
    const bounded = boundedRows(result.rows);
    return {
      action: 'query',
      connection: profile.id,
      database,
      columns: result.columns,
      rows: bounded.rows,
      rowCount: bounded.rows.length,
      elapsedMs: result.elapsedMs,
      truncated: result.truncated || bounded.truncated
    };
  } catch (error) {
    if (error instanceof DatabaseServiceError) throw error;
    throw redactError(error, password);
  }
}

/** Local renderer-only structured mutation. This is intentionally not part of DatabaseActionInput/MCP. */
export async function executeDatabaseTableCellUpdate(
  input: DatabaseTableCellUpdateRequest,
  runtime: DatabaseRuntime = DEFAULT_RUNTIME,
  options: { signal?: AbortSignal } = {}
): Promise<DatabaseTableCellUpdateResult> {
  let profile: ResolvedSqlServerProfile;
  try {
    profile = await runtime.resolve(input.connection);
  } catch (error) {
    throw new DatabaseServiceError(error instanceof Error ? error.message : String(error));
  }
  if (profile.accessMode !== 'full-access') {
    throw new DatabaseServiceError(`DATABASE_READ_ONLY: connection "${profile.id}" does not allow writes.`);
  }
  const password = profile.connection.authentication.password;
  const release = await acquireQuerySlot(profile.id, options.signal);
  try {
    const { connection: _connection, ...request } = input;
    return await runtime.tableCellUpdate(profile.connection, request, options);
  } catch (error) {
    if (error instanceof DatabaseServiceError) throw error;
    throw redactError(error, password);
  } finally {
    release();
  }
}

export type { DatabaseRuntime };
