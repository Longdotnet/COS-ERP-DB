import type { SecureStorageInfo } from './types.js';

export type DatabaseAuthenticationSettings =
  | { type: 'sql'; user: string }
  | { type: 'ntlm'; user: string; domain: string };

export type DatabaseAccessMode = 'read-only' | 'full-access';

export type DatabaseObjectType = 'table' | 'view' | 'procedure' | 'function' | 'synonym';

export interface DatabaseObjectSearchInput {
  search?: string;
  types?: DatabaseObjectType[];
  limit?: number;
  cursor?: string;
}

export interface DatabaseObjectSummary {
  schema: string;
  name: string;
  type: DatabaseObjectType;
  objectId: number;
  modifiedAt: string | null;
}

export interface DatabaseObjectSearchResult {
  objects: DatabaseObjectSummary[];
  hasMore: boolean;
  nextCursor?: string;
  elapsedMs: number;
}

export type DatabaseGrowthSeverity = 'high' | 'medium' | 'low';

export interface DatabaseGrowthFileSummary {
  name: string;
  type: 'data' | 'log';
  sizeMb: number;
  usedMb: number | null;
  freeMb: number | null;
  growth: number;
  percentGrowth: boolean;
}

export interface DatabaseGrowthTableSummary {
  objectId: number;
  schema: string;
  name: string;
  rows: number;
  reservedMb: number;
  usedMb: number;
  dataMb: number;
  indexMb: number;
}

export interface DatabaseGrowthTableFingerprint {
  schema: string;
  name: string;
  columnCount: number;
  indexCount: number;
  columnHash: string;
  indexHash: string;
}

export interface DatabaseGrowthFinding {
  id: string;
  severity: DatabaseGrowthSeverity;
  title: string;
  detail: string;
  nextAction: string;
  object?: DatabaseWorkspaceObject;
}

export interface DatabaseGrowthDiagnosticsRequest {
  connection: string;
}

export interface DatabaseGrowthDiagnosticsResult {
  database: string;
  capturedAt: string;
  summary: {
    totalMb: number;
    dataMb: number;
    logMb: number;
    dataUsedMb: number;
    logUsedMb: number;
    logUsedPercent: number;
    tableCount: number;
  };
  log: {
    available: boolean;
    stateAvailable: boolean;
    recoveryModel: string;
    reuseWait: string;
    totalMb: number;
    usedMb: number;
    freeMb: number;
    usedPercent: number;
    sinceLastBackupMb: number | null;
  };
  files: DatabaseGrowthFileSummary[];
  largestTables: DatabaseGrowthTableSummary[];
  tableStorageAvailable: boolean;
  findings: DatabaseGrowthFinding[];
  nextActions: string[];
  limitations: string[];
  historicalBaselineAvailable: false;
  elapsedMs: number;
}

export interface DatabaseGrowthCapture {
  captureVersion: 2;
  database: string;
  capturedAt: string;
  summary: DatabaseGrowthDiagnosticsResult['summary'];
  files: DatabaseGrowthFileSummary[];
  tables: DatabaseGrowthTableSummary[];
  tablesTruncated: boolean;
  tableFingerprints: DatabaseGrowthTableFingerprint[];
  schemaTruncated: boolean;
  limitations: string[];
}

export interface DatabaseGrowthSnapshotInput {
  captureVersion?: 2;
  database: string;
  capturedAt: string;
  summary: DatabaseGrowthDiagnosticsResult['summary'];
  /** Legacy V1 bounded table list retained for backward-compatible local history reads. */
  largestTables?: DatabaseGrowthTableSummary[];
  files?: DatabaseGrowthFileSummary[];
  tables?: DatabaseGrowthTableSummary[];
  tablesTruncated?: boolean;
  tableFingerprints?: DatabaseGrowthTableFingerprint[];
  schemaTruncated?: boolean;
  limitations?: string[];
}

export interface DatabaseGrowthSnapshot extends DatabaseGrowthSnapshotInput {
  id: string;
  connection: string;
  savedAt: string;
}

export interface DatabaseGrowthHistoryResult {
  connection: string;
  snapshots: DatabaseGrowthSnapshot[];
}

export type DatabaseGrowthCompareSource =
  | { type: 'live'; connection: string }
  | { type: 'snapshot'; connection: string; snapshotId: string };

export interface DatabaseGrowthCompareRequest {
  baseline: DatabaseGrowthCompareSource;
  current: DatabaseGrowthCompareSource;
  /** Optional business date of a restored backup; capture time alone cannot prove backup age. */
  baselineAsOf?: string;
}

export interface DatabaseGrowthTableDelta {
  schema: string;
  name: string;
  state: 'matched' | 'added' | 'removed';
  baselineObjectId: number | null;
  currentObjectId: number | null;
  baselineRows: number;
  currentRows: number;
  rowDelta: number;
  baselineReservedMb: number;
  currentReservedMb: number;
  reservedDeltaMb: number;
  baselineUsedMb: number;
  currentUsedMb: number;
  usedDeltaMb: number;
  baselineDataMb: number;
  currentDataMb: number;
  dataDeltaMb: number;
  baselineIndexMb: number;
  currentIndexMb: number;
  indexDeltaMb: number;
}

export interface DatabaseGrowthFileDelta {
  name: string;
  type: 'data' | 'log';
  state: 'matched' | 'added' | 'removed';
  baselineSizeMb: number;
  currentSizeMb: number;
  sizeDeltaMb: number;
  baselineUsedMb: number | null;
  currentUsedMb: number | null;
  usedDeltaMb: number | null;
}

export interface DatabaseGrowthSchemaDelta {
  schema: string;
  name: string;
  baselineObjectId: number | null;
  currentObjectId: number | null;
  columnChanged: boolean;
  indexChanged: boolean;
  baselineColumnCount: number;
  currentColumnCount: number;
  baselineIndexCount: number;
  currentIndexCount: number;
}

export interface DatabaseGrowthComparisonResult {
  baseline: {
    connection: string;
    database: string;
    capturedAt: string;
    asOf?: string;
    source: 'live' | 'snapshot';
    snapshotId?: string;
    tablesTruncated: boolean;
    schemaTruncated: boolean;
  };
  current: {
    connection: string;
    database: string;
    capturedAt: string;
    source: 'live' | 'snapshot';
    snapshotId?: string;
    tablesTruncated: boolean;
    schemaTruncated: boolean;
  };
  summary: {
    totalAllocatedDeltaMb: number;
    dataAllocatedDeltaMb: number;
    dataUsedDeltaMb: number;
    logAllocatedDeltaMb: number;
    logUsedDeltaMb: number;
    tableUsedDeltaMb: number;
    unattributedDataUsedDeltaMb: number;
    attributionPercent: number | null;
    tableCountDelta: number;
    addedTableCount: number;
    removedTableCount: number;
    schemaChangedTableCount: number;
  };
  fileDeltas: DatabaseGrowthFileDelta[];
  tableDeltas: DatabaseGrowthTableDelta[];
  totalTableDifferenceCount: number;
  returnedTableDifferenceCount: number;
  omittedTableDifferenceCount: number;
  schemaDeltas: DatabaseGrowthSchemaDelta[];
  totalSchemaDifferenceCount: number;
  returnedSchemaDifferenceCount: number;
  omittedSchemaDifferenceCount: number;
  limitations: string[];
}

export interface DatabaseObjectSearchRequest extends DatabaseObjectSearchInput {
  connection: string;
}

export type DatabaseTableFilterOperator = 'eq' | 'starts_with' | 'contains' | 'gte' | 'lte' | 'is_null';

export interface DatabaseTableFilter {
  column: string;
  operator: DatabaseTableFilterOperator;
  value?: string | number | boolean | null;
}

export interface DatabaseTableSort {
  column: string;
  direction: 'asc' | 'desc';
}

export interface DatabaseTablePageRequest {
  connection: string;
  objectId: number;
  limit?: number;
  cursor?: string;
  sort?: DatabaseTableSort;
  filters?: DatabaseTableFilter[];
}

export interface DatabaseTableColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKeyOrdinal: number | null;
  identity?: boolean;
  computed?: boolean;
}

export type DatabaseScalarValue = string | number | boolean | null;

export interface DatabaseTableCellUpdateRequest {
  connection: string;
  objectId: number;
  column: string;
  primaryKey: Record<string, DatabaseScalarValue>;
  originalValue: DatabaseScalarValue;
  value: DatabaseScalarValue;
}

export interface DatabaseTableCellUpdateResult {
  affectedRows: 1;
  elapsedMs: number;
}

export interface DatabaseTablePageResult {
  schema: string;
  table: string;
  columns: DatabaseTableColumn[];
  rows: Record<string, unknown>[];
  hasMore: boolean;
  nextCursor?: string;
  elapsedMs: number;
  pagingMode: 'keyset' | 'offset';
  warning?: string;
}

export type DatabaseObjectDetailSection = 'columns' | 'keys_indexes' | 'ddl' | 'dependencies';

export interface DatabaseObjectDetailRequest {
  connection: string;
  objectId: number;
  section: DatabaseObjectDetailSection;
}

export interface DatabaseObjectColumnDetail {
  ordinal: number;
  name: string;
  type: string;
  nullable: boolean;
  identity: boolean;
  computed: boolean;
  defaultDefinition: string | null;
  computedDefinition: string | null;
}

export interface DatabaseObjectIndexColumn {
  name: string;
  descending: boolean;
  included: boolean;
  ordinal: number;
}

export interface DatabaseObjectIndexDetail {
  name: string;
  type: string;
  unique: boolean;
  primaryKey: boolean;
  uniqueConstraint: boolean;
  disabled: boolean;
  columns: DatabaseObjectIndexColumn[];
}

export interface DatabaseObjectForeignKeyDetail {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  deleteAction: string;
  updateAction: string;
}

export interface DatabaseObjectDependencyDetail {
  schema: string | null;
  name: string;
  type: string | null;
  database: string | null;
  server: string | null;
}

export interface DatabaseObjectDetailsResult {
  schema: string;
  name: string;
  type: DatabaseObjectType;
  section: DatabaseObjectDetailSection;
  columns?: DatabaseObjectColumnDetail[];
  indexes?: DatabaseObjectIndexDetail[];
  foreignKeys?: DatabaseObjectForeignKeyDetail[];
  ddl?: {
    text: string;
    kind: 'source' | 'generated-table' | 'synonym' | 'unavailable';
    complete: boolean;
    note?: string;
    truncated?: boolean;
  };
  outboundDependencies?: DatabaseObjectDependencyDetail[];
  inboundDependencies?: DatabaseObjectDependencyDetail[];
  truncated?: boolean;
  elapsedMs: number;
}

export type DatabaseWorkspaceTab = 'data' | DatabaseObjectDetailSection;

export interface DatabaseWorkspaceObject {
  objectId: number;
  schema: string;
  name: string;
  type: DatabaseObjectType;
}

export interface DatabaseWorkspaceContextInput {
  connection: string;
  object?: DatabaseWorkspaceObject;
  tab?: DatabaseWorkspaceTab;
  filters?: DatabaseTableFilter[];
  sort?: DatabaseTableSort;
  page?: number;
  selectedRows?: Record<string, unknown>[];
}

export interface DatabaseWorkspaceContext extends DatabaseWorkspaceContextInput {
  updatedAt: number;
  selectedRowsTruncated: boolean;
}

/** Non-secret metadata for one database connection. */
export interface DatabaseConnectionProfile {
  id: string;
  name: string;
  provider: 'sqlserver';
  accessMode: DatabaseAccessMode;
  server: string;
  database: string;
  port?: number;
  instanceName?: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  authentication: DatabaseAuthenticationSettings;
}

export interface DatabaseSettings {
  connections: DatabaseConnectionProfile[];
  defaultConnectionId?: string;
}

export type DatabaseProfileDraft = Omit<DatabaseConnectionProfile, 'id' | 'provider' | 'accessMode'> & {
  id?: string;
  accessMode?: DatabaseAccessMode;
  makeDefault?: boolean;
};

export interface DatabaseSettingsState {
  settings: DatabaseSettings;
  passwordStored: Record<string, boolean>;
  secureStorage: SecureStorageInfo;
}

export interface DatabaseProfileSaveResult {
  state: DatabaseSettingsState;
  profileId: string;
}

export interface DatabaseConnectionTestResult {
  connection: string;
  database: string;
  elapsedMs: number;
}
