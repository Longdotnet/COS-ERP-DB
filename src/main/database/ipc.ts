import { z } from 'zod';
import type {
  DatabaseConnectionTestResult,
  DatabaseGrowthCapture,
  DatabaseGrowthComparisonResult,
  DatabaseGrowthCompareRequest,
  DatabaseGrowthHistoryResult,
  DatabaseGrowthDiagnosticsResult,
  DatabaseGrowthSnapshotInput,
  DatabaseObjectDetailRequest,
  DatabaseObjectDetailsResult,
  DatabaseObjectSearchRequest,
  DatabaseObjectSearchResult,
  DatabaseProfileSaveResult,
  DatabaseSettingsState,
  DatabaseTableCellUpdateRequest,
  DatabaseTableCellUpdateResult,
  DatabaseTablePageRequest,
  DatabaseTablePageResult,
  DatabaseWorkspaceContext,
  DatabaseWorkspaceContextInput
} from '../../shared/database.js';
import { logInfo } from '../logger.js';
import { secureStorageStatus } from '../secrets.js';
import {
  executeDatabaseAction,
  executeDatabaseGrowthCapture,
  executeDatabaseGrowthComparison,
  executeDatabaseTableCellUpdate
} from './service.js';
import { MAX_DATABASE_OBJECT_PAGE_SIZE, MAX_DATABASE_OBJECT_SEARCH_CHARS } from './metadata.js';
import { MAX_DATABASE_TABLE_FILTERS, MAX_DATABASE_TABLE_PAGE_SIZE } from './table-data.js';
import { setDatabaseWorkspaceContext } from './workspace-context.js';
import {
  bindLegacyDatabaseCredential,
  clearDatabasePassword,
  databasePasswordPresence,
  setDatabasePassword
} from './credentials.js';
import { readDatabaseSettings, removeDatabaseProfile, saveDatabaseProfile } from './store.js';
import {
  databaseGrowthSnapshotInputSchema,
  readDatabaseGrowthHistory,
  saveDatabaseGrowthSnapshot
} from './growth-history.js';

type RegisterHandler = <T>(channel: string, handler: (payload: unknown) => Promise<T>) => void;

const profileIdArg = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i)
}).strict();

export async function databaseSettingsState(): Promise<DatabaseSettingsState> {
  const settings = await readDatabaseSettings();
  return {
    settings,
    passwordStored: await databasePasswordPresence(settings.connections),
    secureStorage: await secureStorageStatus()
  };
}

/** Fixed, validated renderer boundary owned by COS-ERP-DB; main ipc.ts only registers it. */
export function registerDatabaseIpc(handle: RegisterHandler): void {
  handle('database:getState', async () => databaseSettingsState());

  handle<DatabaseProfileSaveResult>('database:profileSave', async payload => {
    const parsed = z.object({
      profile: z.unknown(),
      password: z.string().max(500).optional()
    }).strict().parse(payload);
    const before = await readDatabaseSettings();
    const requestedId = parsed.profile && typeof parsed.profile === 'object' && !Array.isArray(parsed.profile)
      ? (parsed.profile as Record<string, unknown>).id
      : undefined;
    const existing = typeof requestedId === 'string'
      ? before.connections.find(profile => profile.id.toLowerCase() === requestedId.toLowerCase())
      : undefined;
    // Bind V0 string credentials to the OLD endpoint before metadata can change. If the next
    // save changes server/login identity, the resolver will refuse the old password during the
    // gap before a replacement credential is committed.
    if (existing) await bindLegacyDatabaseCredential(existing);
    const saved = await saveDatabaseProfile(parsed.profile);
    const profile = saved.settings.connections.find(candidate => candidate.id === saved.profileId);
    if (!profile) throw new Error('Saved database connection could not be resolved');
    if (parsed.password !== undefined) await setDatabasePassword(profile, parsed.password);
    logInfo(`database profile saved: ${saved.profileId}`);
    return { state: await databaseSettingsState(), profileId: saved.profileId };
  });

  handle<DatabaseSettingsState>('database:profileRemove', async payload => {
    const { id } = profileIdArg.parse(payload);
    // Secret first: if secure-storage cleanup fails, keep visible metadata rather than leaving a
    // hidden credential that could resurrect when the same profile id is created again.
    await clearDatabasePassword(id);
    await removeDatabaseProfile(id);
    logInfo(`database profile removed: ${id}`);
    return databaseSettingsState();
  });

  handle<DatabaseSettingsState>('database:passwordSet', async payload => {
    const { id, value } = profileIdArg.extend({ value: z.string().max(500) }).parse(payload);
    const settings = await readDatabaseSettings();
    const profile = settings.connections.find(profile => profile.id === id);
    if (!profile) throw new Error('Database connection not found');
    await setDatabasePassword(profile, value);
    logInfo(value === '' ? `database password cleared: ${id}` : `database password stored: ${id}`);
    return databaseSettingsState();
  });

  handle<DatabaseConnectionTestResult>('database:test', async payload => {
    const { id } = profileIdArg.parse(payload);
    const result = await executeDatabaseAction({ action: 'test', connection: id });
    if (result.action !== 'test') throw new Error('Unexpected database test result');
    return { connection: result.connection, database: result.database, elapsedMs: result.elapsedMs };
  });

  handle<DatabaseGrowthDiagnosticsResult>('database:growthDiagnostics', async payload => {
    const { id } = profileIdArg.parse(payload);
    const result = await executeDatabaseAction({ action: 'growth_diagnostics', connection: id });
    if (result.action !== 'growth_diagnostics') throw new Error('Unexpected database growth diagnostics result');
    const { action: _action, connection: _connection, ...diagnostics } = result;
    return diagnostics;
  });

  handle<DatabaseGrowthCapture>('database:growthCapture', async payload => {
    const { id } = profileIdArg.parse(payload);
    return (await executeDatabaseGrowthCapture(id)).capture;
  });

  handle<DatabaseGrowthComparisonResult>('database:growthCompare', async payload => {
    const parsed = z.object({
      baselineConnection: profileIdArg.shape.id,
      currentConnection: profileIdArg.shape.id,
      baselineAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    }).strict().refine(
      value => value.baselineConnection.toLowerCase() !== value.currentConnection.toLowerCase(),
      'Baseline and current database connections must be different.'
    ).parse(payload) as DatabaseGrowthCompareRequest;
    return executeDatabaseGrowthComparison(
      parsed.baselineConnection,
      parsed.currentConnection,
      undefined,
      parsed.baselineAsOf ? { baselineAsOf: parsed.baselineAsOf } : {}
    );
  });

  handle<DatabaseGrowthHistoryResult>('database:growthHistory', async payload => {
    const { id } = profileIdArg.parse(payload);
    return readDatabaseGrowthHistory(id);
  });

  handle<DatabaseGrowthHistoryResult>('database:growthSnapshotSave', async payload => {
    const parsed = z.object({
      id: profileIdArg.shape.id,
      snapshot: databaseGrowthSnapshotInputSchema
    }).strict().parse(payload) as { id: string; snapshot: DatabaseGrowthSnapshotInput };
    return saveDatabaseGrowthSnapshot(parsed.id, parsed.snapshot);
  });

  handle<DatabaseObjectSearchResult>('database:objectsSearch', async payload => {
    const parsed = z.object({
      connection: z.string().min(1).max(64),
      search: z.string().max(MAX_DATABASE_OBJECT_SEARCH_CHARS).optional(),
      types: z.array(z.enum(['table', 'view', 'procedure', 'function', 'synonym'])).min(1).max(5).optional(),
      limit: z.number().int().min(1).max(MAX_DATABASE_OBJECT_PAGE_SIZE).optional(),
      cursor: z.string().min(1).max(1024).optional()
    }).strict().parse(payload) as DatabaseObjectSearchRequest;
    const result = await executeDatabaseAction({ action: 'search_objects', ...parsed });
    if (result.action !== 'search_objects') throw new Error('Unexpected database object search result');
    return {
      objects: result.objects,
      hasMore: result.hasMore,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      elapsedMs: result.elapsedMs
    };
  });

  handle<DatabaseTablePageResult>('database:tablePage', async payload => {
    const filterValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
    const parsed = z.object({
      connection: z.string().min(1).max(64),
      objectId: z.number().int().positive(),
      limit: z.number().int().min(1).max(MAX_DATABASE_TABLE_PAGE_SIZE).optional(),
      cursor: z.string().min(1).max(4096).optional(),
      sort: z.object({
        column: z.string().min(1).max(256),
        direction: z.enum(['asc', 'desc'])
      }).strict().optional(),
      filters: z.array(z.object({
        column: z.string().min(1).max(256),
        operator: z.enum(['eq', 'starts_with', 'contains', 'gte', 'lte', 'is_null']),
        value: filterValue.optional()
      }).strict()).max(MAX_DATABASE_TABLE_FILTERS).optional()
    }).strict().parse(payload) as DatabaseTablePageRequest;
    const result = await executeDatabaseAction({ action: 'table_page', ...parsed });
    if (result.action !== 'table_page') throw new Error('Unexpected database table page result');
    const { action: _action, connection: _connection, database: _database, ...page } = result;
    return page;
  });

  handle<DatabaseTableCellUpdateResult>('database:tableCellUpdate', async payload => {
    const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
    const parsed = z.object({
      connection: z.string().min(1).max(64),
      objectId: z.number().int().positive(),
      column: z.string().min(1).max(256),
      primaryKey: z.record(z.string().min(1).max(256), scalar).refine(row => Object.keys(row).length > 0 && Object.keys(row).length <= 16, 'Primary key must contain between 1 and 16 columns.'),
      originalValue: scalar,
      value: scalar
    }).strict().parse(payload) as DatabaseTableCellUpdateRequest;
    return executeDatabaseTableCellUpdate(parsed);
  });

  handle<DatabaseObjectDetailsResult>('database:objectDetails', async payload => {
    const parsed = z.object({
      connection: z.string().min(1).max(64),
      objectId: z.number().int().positive(),
      section: z.enum(['columns', 'keys_indexes', 'ddl', 'dependencies'])
    }).strict().parse(payload) as DatabaseObjectDetailRequest;
    const result = await executeDatabaseAction({ action: 'object_details', ...parsed });
    if (result.action !== 'object_details') throw new Error('Unexpected database object details result');
    const { action: _action, connection: _connection, database: _database, ...details } = result;
    return details;
  });

  handle<DatabaseWorkspaceContext | null>('database:workspaceContextSet', async payload => {
    const filterValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
    const schema = z.object({
      connection: z.string().min(1).max(64),
      object: z.object({
        objectId: z.number().int().positive(),
        schema: z.string().min(1).max(256),
        name: z.string().min(1).max(256),
        type: z.enum(['table', 'view', 'procedure', 'function', 'synonym'])
      }).strict().optional(),
      tab: z.enum(['data', 'columns', 'keys_indexes', 'ddl', 'dependencies']).optional(),
      filters: z.array(z.object({
        column: z.string().min(1).max(256),
        operator: z.enum(['eq', 'starts_with', 'contains', 'gte', 'lte', 'is_null']),
        value: filterValue.optional()
      }).strict()).max(MAX_DATABASE_TABLE_FILTERS).optional(),
      sort: z.object({ column: z.string().min(1).max(256), direction: z.enum(['asc', 'desc']) }).strict().optional(),
      page: z.number().int().min(1).max(1_000_000_000).optional(),
      selectedRows: z.array(z.record(z.string(), z.unknown())).max(20).optional()
    }).strict();
    const parsed = z.union([schema, z.null()]).parse(payload) as DatabaseWorkspaceContextInput | null;
    return setDatabaseWorkspaceContext(parsed);
  });
}
