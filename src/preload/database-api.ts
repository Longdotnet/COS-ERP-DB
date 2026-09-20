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
import type {
  DatabaseColumnProfileRequest,
  DatabaseColumnProfileResult,
  DatabaseColumnSearchResult,
  DatabaseDeadlockHistoryResult,
  DatabaseFieldConsumerRequest,
  DatabaseFieldConsumersResult,
  DatabaseIncidentHistoryResult,
  DatabaseIncidentCauseTraceRequest,
  DatabaseIncidentCauseTraceResult,
  DatabaseIncidentWatchStatus,
  DatabaseJobsResult,
  DatabaseLivePerformanceResult,
  DatabaseQueryStoreRequest,
  DatabaseQueryStoreResult,
  DatabaseSchemaCompareRequest,
  DatabaseSchemaCompareResult,
  DatabaseServerIncidentHistoryResult,
  DatabaseSourceTraceRequest,
  DatabaseSourceTraceResult
} from '../cos-erp-db/investigation/types.js';

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
    searchDatabaseColumns: (id: string, search: string) => call<DatabaseColumnSearchResult>('database:investigator:columns', { id, search }),
    profileDatabaseColumn: (request: DatabaseColumnProfileRequest) => call<DatabaseColumnProfileResult>('database:investigator:columnProfile', request),
    readDatabaseFieldConsumers: (request: DatabaseFieldConsumerRequest) => call<DatabaseFieldConsumersResult>('database:investigator:fieldConsumers', request),
    traceDatabaseSource: (request: DatabaseSourceTraceRequest) => call<DatabaseSourceTraceResult>('database:investigator:sourceTrace', request),
    traceDatabaseIncidentCause: (request: DatabaseIncidentCauseTraceRequest) => call<DatabaseIncidentCauseTraceResult>('database:investigator:incidentCauseTrace', request),
    readDatabaseLivePerformance: (id: string) => call<DatabaseLivePerformanceResult>('database:investigator:performance', { id }),
    readDatabaseQueryStore: (request: DatabaseQueryStoreRequest) => call<DatabaseQueryStoreResult>('database:investigator:queryStore', request),
    readDatabaseDeadlocks: (id: string) => call<DatabaseDeadlockHistoryResult>('database:investigator:deadlocks', { id }),
    readDatabaseJobs: (id: string) => call<DatabaseJobsResult>('database:investigator:jobs', { id }),
    compareDatabaseSchemas: (request: DatabaseSchemaCompareRequest) => call<DatabaseSchemaCompareResult>('database:investigator:schemaCompare', request),
    captureDatabaseIncident: (id: string) => call<DatabaseIncidentHistoryResult>('database:investigator:incidentCapture', { id }),
    readDatabaseIncidentHistory: (id: string) => call<DatabaseIncidentHistoryResult>('database:investigator:incidentHistory', { id }),
    readDatabaseServerIncidentHistory: (id: string) => call<DatabaseServerIncidentHistoryResult>('database:investigator:serverIncidentHistory', { id }),
    deleteDatabaseIncident: (id: string, snapshotId: string) => call<DatabaseIncidentHistoryResult>('database:investigator:incidentDelete', { id, snapshotId }),
    clearDatabaseIncidentHistory: (id: string) => call<DatabaseIncidentHistoryResult>('database:investigator:incidentClear', { id }),
    readDatabaseIncidentWatchStatus: (id: string) => call<DatabaseIncidentWatchStatus>('database:investigator:incidentWatchStatus', { id }),
    startDatabaseIncidentWatch: (id: string) => call<DatabaseIncidentWatchStatus>('database:investigator:incidentWatchStart', { id }),
    stopDatabaseIncidentWatch: (id: string) => call<DatabaseIncidentWatchStatus>('database:investigator:incidentWatchStop', { id }),
    readDatabaseGrowthDiagnostics: (id: string) => call<DatabaseGrowthDiagnosticsResult>('database:growthDiagnostics', { id }),
    readDatabaseGrowthCapture: (id: string) => call<DatabaseGrowthCapture>('database:growthCapture', { id }),
    compareDatabaseGrowth: (request: DatabaseGrowthCompareRequest) => call<DatabaseGrowthComparisonResult>('database:growthCompare', request),
    readDatabaseGrowthHistory: (id: string) => call<DatabaseGrowthHistoryResult>('database:growthHistory', { id }),
    saveDatabaseGrowthSnapshot: (id: string, snapshot: DatabaseGrowthSnapshotInput) => call<DatabaseGrowthHistoryResult>('database:growthSnapshotSave', { id, snapshot }),
    deleteDatabaseGrowthSnapshot: (id: string, snapshotId: string) => call<DatabaseGrowthHistoryResult>('database:growthSnapshotDelete', { id, snapshotId }),
    clearDatabaseGrowthHistory: (id: string) => call<DatabaseGrowthHistoryResult>('database:growthHistoryClear', { id }),
    searchDatabaseObjects: (request: DatabaseObjectSearchRequest) => call<DatabaseObjectSearchResult>('database:objectsSearch', request),
    readDatabaseTablePage: (request: DatabaseTablePageRequest) => call<DatabaseTablePageResult>('database:tablePage', request),
    updateDatabaseTableCell: (request: DatabaseTableCellUpdateRequest) => call<DatabaseTableCellUpdateResult>('database:tableCellUpdate', request),
    readDatabaseObjectDetails: (request: DatabaseObjectDetailRequest) => call<DatabaseObjectDetailsResult>('database:objectDetails', request),
    setDatabaseWorkspaceContext: (context: DatabaseWorkspaceContextInput | null) => call<DatabaseWorkspaceContext | null>('database:workspaceContextSet', context)
  };
}

export type DatabaseApi = ReturnType<typeof createDatabaseApi>;
