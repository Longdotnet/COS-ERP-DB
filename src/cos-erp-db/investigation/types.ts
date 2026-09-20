export type DatabaseInvestigationConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface DatabaseColumnMatch {
  objectId: number;
  schema: string;
  table: string;
  columnId: number;
  column: string;
  type: string;
  nullable: boolean;
  identity: boolean;
  computed: boolean;
  primaryKey: boolean;
  indexed: boolean;
}

export interface DatabaseColumnSearchResult {
  connection: string;
  database: string;
  search: string;
  matches: DatabaseColumnMatch[];
  truncated: boolean;
  elapsedMs: number;
}

export interface DatabaseColumnProfileRequest {
  connection: string;
  objectId: number;
  column: string;
}

export interface DatabaseColumnProfileResult {
  connection: string;
  database: string;
  object: { objectId: number; schema: string; table: string };
  column: DatabaseColumnMatch;
  sampleLimit: number;
  sampledRows: number;
  nullRows: number;
  blankRows: number | null;
  distinctValues: number | null;
  minValue: string | null;
  maxValue: string | null;
  maxDataLengthBytes: number | null;
  examples: Array<{ value: string | null; count: number }>;
  limitations: string[];
  elapsedMs: number;
}

export interface DatabaseFieldConsumerRequest {
  connection: string;
  objectId: number;
  column: string;
}

export interface DatabaseFieldConsumer {
  objectId: number;
  schema: string;
  name: string;
  type: string;
  dependencyDirection: 'references-table' | 'text-match';
  confidence: DatabaseInvestigationConfidence;
  reason: string;
}

export interface DatabaseFieldConsumersResult {
  connection: string;
  database: string;
  source: { objectId: number; schema: string; table: string; column: string };
  consumers: DatabaseFieldConsumer[];
  limitations: string[];
  elapsedMs: number;
}

export interface DatabaseLiveRequest {
  sessionId: number;
  status: string;
  command: string;
  database: string | null;
  login: string | null;
  host: string | null;
  program: string | null;
  elapsedMs: number;
  cpuMs: number;
  logicalReads: number;
  writes: number;
  waitType: string | null;
  lastWaitType: string | null;
  waitMs: number;
  waitResource: string | null;
  blockingSessionId: number;
  openTransactionCount: number;
  transactionBeginTime: string | null;
  transactionAgeSeconds: number | null;
  queryHash: string | null;
  queryPlanHash: string | null;
  isBlocked: boolean;
  isBlocker: boolean;
  isRootBlocker: boolean;
  isSleepingTransaction: boolean;
  reasonMask: number;
  sql: string | null;
}

export interface DatabaseIncidentThresholds {
  blockingThresholdMs: number;
  longRequestThresholdMs: number;
  openTransactionThresholdSeconds: number;
}

export interface DatabaseQueryHotspot {
  executionCount: number;
  totalElapsedMs: number;
  avgElapsedMs: number;
  totalCpuMs: number;
  totalLogicalReads: number;
  lastExecutionAt: string | null;
  sql: string | null;
}

export interface DatabaseLivePerformanceResult {
  connection: string;
  database: string;
  capturedAt: string;
  requests: DatabaseLiveRequest[];
  incidentSessions: DatabaseLiveRequest[];
  hotspots: DatabaseQueryHotspot[];
  activeRequestCount: number;
  blockedRequestCount: number;
  rootBlockerSessionIds: number[];
  thresholds: DatabaseIncidentThresholds;
  limitations: string[];
  elapsedMs: number;
}

export type DatabaseIncidentReason = 'blocked' | 'long-request' | 'long-transaction' | 'blocking-chain';

export interface DatabaseServerIncidentSession extends DatabaseLiveRequest {
  captureId: number;
  runningStatement: string | null;
  reasons: DatabaseIncidentReason[];
}

export interface DatabaseServerIncidentCapture {
  captureId: number;
  capturedAt: string;
  serverName: string | null;
  instanceName: string | null;
  blockingCount: number;
  longRequestCount: number;
  openTransactionCount: number;
  sessions: DatabaseServerIncidentSession[];
}

export interface DatabaseServerIncidentHistoryResult {
  connection: string;
  database: string;
  capturedAt: string;
  available: boolean;
  captures: DatabaseServerIncidentCapture[];
  limitations: string[];
  elapsedMs: number;
}

export interface DatabaseAgentJobSummary {
  name: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastOutcome: 'succeeded' | 'failed' | 'retry' | 'canceled' | 'in-progress' | 'unknown';
  lastMessage: string | null;
  lastDurationSeconds: number | null;
  nextRunAt: string | null;
}

export interface DatabaseJobsResult {
  connection: string;
  database: string;
  available: boolean;
  capturedAt: string;
  jobs: DatabaseAgentJobSummary[];
  failedJobCount: number;
  disabledJobCount: number;
  limitations: string[];
  elapsedMs: number;
}

export interface DatabaseSchemaCompareRequest {
  baselineConnection: string;
  currentConnection: string;
}

export interface DatabaseSchemaDifference {
  kind:
    | 'table-added' | 'table-removed'
    | 'column-added' | 'column-removed' | 'column-changed'
    | 'index-added' | 'index-removed' | 'index-changed'
    | 'procedure-added' | 'procedure-removed' | 'procedure-changed'
    | 'view-added' | 'view-removed' | 'view-changed';
  object: string;
  detail: string;
  baseline: string | null;
  current: string | null;
  confidence: DatabaseInvestigationConfidence;
}

export interface DatabaseSchemaCompareResult {
  baseline: { connection: string; database: string; capturedAt: string };
  current: { connection: string; database: string; capturedAt: string };
  summary: {
    tablesAdded: number;
    tablesRemoved: number;
    columnsAdded: number;
    columnsRemoved: number;
    columnsChanged: number;
    indexesAdded: number;
    indexesRemoved: number;
    indexesChanged: number;
    proceduresAdded: number;
    proceduresRemoved: number;
    proceduresChanged: number;
    viewsAdded: number;
    viewsRemoved: number;
    viewsChanged: number;
  };
  differences: DatabaseSchemaDifference[];
  totalDifferenceCount: number;
  truncated: boolean;
  limitations: string[];
  elapsedMs: number;
}

export type DatabaseSourceTraceKind = 'field-reference' | 'table-reference' | 'sql-call' | 'winforms-binding';

export interface DatabaseSourceTraceMatch {
  path: string;
  line: number;
  kind: DatabaseSourceTraceKind;
  matchedTerm: string;
  preview: string;
  confidence: DatabaseInvestigationConfidence;
}

export interface DatabaseSourceTraceRequest {
  connection: string;
  objectId: number;
  column: string;
  sourceRoot: string;
}

export interface DatabaseSourceTraceResult {
  connection: string;
  database: string;
  source: { objectId: number; schema: string; table: string; column: string };
  sourceRoot: string;
  searchedFiles: number;
  skippedFiles: number;
  matches: DatabaseSourceTraceMatch[];
  truncated: boolean;
  limitations: string[];
  elapsedMs: number;
}

export interface DatabaseQueryStoreRequest {
  connection: string;
  hours?: 1 | 6 | 24 | 168;
  sort?: 'duration' | 'cpu' | 'reads' | 'executions';
}

export interface DatabaseQueryStoreEntry {
  queryId: number;
  planId: number;
  executionCount: number;
  avgDurationMs: number;
  avgCpuMs: number;
  avgLogicalReads: number;
  lastExecutionAt: string | null;
  planCount: number;
  sql: string | null;
}

export interface DatabaseQueryStoreResult {
  connection: string;
  database: string;
  capturedAt: string;
  available: boolean;
  actualState: string | null;
  desiredState: string | null;
  readonlyReason: number | null;
  currentStorageMb: number | null;
  maxStorageMb: number | null;
  hours: number;
  sort: 'duration' | 'cpu' | 'reads' | 'executions';
  queries: DatabaseQueryStoreEntry[];
  limitations: string[];
  elapsedMs: number;
}

export interface DatabaseDeadlockProcess {
  processId: string | null;
  sessionId: number | null;
  victim: boolean;
  login: string | null;
  host: string | null;
  application: string | null;
  database: string | null;
  waitResource: string | null;
  lockMode: string | null;
  statement: string | null;
}

export interface DatabaseDeadlockEvent {
  happenedAt: string | null;
  victimProcessId: string | null;
  processes: DatabaseDeadlockProcess[];
  objects: string[];
}

export interface DatabaseDeadlockHistoryResult {
  connection: string;
  database: string;
  capturedAt: string;
  available: boolean;
  events: DatabaseDeadlockEvent[];
  limitations: string[];
  elapsedMs: number;
}

export interface DatabaseIncidentSnapshot {
  id: string;
  connection: string;
  database: string;
  capturedAt: string;
  savedAt: string | null;
  summary: {
    totalMb: number | null;
    dataUsedMb: number | null;
    logUsedPercent: number | null;
    activeRequestCount: number;
    blockedRequestCount: number;
    failedJobCount: number | null;
  };
  requests: DatabaseLiveRequest[];
  jobs: DatabaseAgentJobSummary[];
  findings: Array<{ severity: string; title: string; detail: string }>;
  limitations: string[];
}

export interface DatabaseIncidentHistoryResult {
  connection: string;
  snapshots: DatabaseIncidentSnapshot[];
}

export interface DatabaseIncidentWatchStatus {
  connection: string;
  watching: boolean;
  intervalMs: number;
  startedAt: string | null;
  lastCheckedAt: string | null;
  lastCapturedAt: string | null;
  capturedCount: number;
  incidentActive: boolean;
  lastError: string | null;
}

export interface DatabaseIncidentCauseCandidate {
  kind: 'procedure' | 'table' | 'column';
  schema: string | null;
  table: string | null;
  name: string;
  confidence: DatabaseInvestigationConfidence;
  evidence: string;
}

export interface DatabaseIncidentCauseTraceRequest {
  connection: string;
  sql: string;
  sourceRoot: string;
}

export interface DatabaseIncidentSourceEvidence {
  sourceRoot: string;
  searchedFiles: number;
  skippedFiles: number;
  matches: DatabaseSourceTraceMatch[];
  truncated: boolean;
  limitations: string[];
  elapsedMs: number;
}

export interface DatabaseIncidentCauseTraceResult {
  connection: string;
  database: string;
  candidates: DatabaseIncidentCauseCandidate[];
  confirmedField: DatabaseColumnMatch | null;
  consumers: DatabaseFieldConsumer[];
  source: DatabaseIncidentSourceEvidence | null;
  limitations: string[];
  elapsedMs: number;
}
