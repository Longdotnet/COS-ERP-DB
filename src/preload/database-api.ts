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
  DatabaseProfileDraft,
  DatabaseProfileSaveResult,
  DatabaseSettingsState,
  DatabaseTableCellUpdateRequest,
  DatabaseTableCellUpdateResult,
  DatabaseTablePageRequest,
  DatabaseTablePageResult,
  DatabaseWorkspaceContext,
  DatabaseWorkspaceContextInput
} from '../shared/database.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
type Call = <T>(channel: string, payload?: unknown) => Promise<Reply<T>>;

/** Fork-owned preload surface. The upstream preload keeps only one spread hook. */
export function createDatabaseApi(call: Call) {
  return {
    getDatabaseState: () => call<DatabaseSettingsState>('database:getState'),
    saveDatabaseProfile: (profile: DatabaseProfileDraft, password?: string) => call<DatabaseProfileSaveResult>(
      'database:profileSave',
      { profile, ...(password === undefined ? {} : { password }) }
    ),
    removeDatabaseProfile: (id: string) => call<DatabaseSettingsState>('database:profileRemove', { id }),
    setDatabasePassword: (id: string, value: string) => call<DatabaseSettingsState>('database:passwordSet', { id, value }),
    testDatabaseConnection: (id: string) => call<DatabaseConnectionTestResult>('database:test', { id }),
    readDatabaseGrowthDiagnostics: (id: string) => call<DatabaseGrowthDiagnosticsResult>('database:growthDiagnostics', { id }),
    readDatabaseGrowthCapture: (id: string) => call<DatabaseGrowthCapture>('database:growthCapture', { id }),
    compareDatabaseGrowth: (request: DatabaseGrowthCompareRequest) => call<DatabaseGrowthComparisonResult>('database:growthCompare', request),
    readDatabaseGrowthHistory: (id: string) => call<DatabaseGrowthHistoryResult>('database:growthHistory', { id }),
    saveDatabaseGrowthSnapshot: (id: string, snapshot: DatabaseGrowthSnapshotInput) => call<DatabaseGrowthHistoryResult>('database:growthSnapshotSave', { id, snapshot }),
    searchDatabaseObjects: (request: DatabaseObjectSearchRequest) => call<DatabaseObjectSearchResult>('database:objectsSearch', request),
    readDatabaseTablePage: (request: DatabaseTablePageRequest) => call<DatabaseTablePageResult>('database:tablePage', request),
    updateDatabaseTableCell: (request: DatabaseTableCellUpdateRequest) => call<DatabaseTableCellUpdateResult>('database:tableCellUpdate', request),
    readDatabaseObjectDetails: (request: DatabaseObjectDetailRequest) => call<DatabaseObjectDetailsResult>('database:objectDetails', request),
    setDatabaseWorkspaceContext: (context: DatabaseWorkspaceContextInput | null) => call<DatabaseWorkspaceContext | null>('database:workspaceContextSet', context)
  };
}

export type DatabaseApi = ReturnType<typeof createDatabaseApi>;
