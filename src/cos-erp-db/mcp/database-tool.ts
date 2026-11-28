import { z } from 'zod';
import { executeDatabaseAction, MAX_DATABASE_SQL_CHARS, type DatabaseActionInput, type DatabaseActionOutput } from '../../main/database/service.js';
import { MAX_DATABASE_OBJECT_PAGE_SIZE, MAX_DATABASE_OBJECT_SEARCH_CHARS } from '../../main/database/metadata.js';
import { investigateBusinessObject } from '../investigation/business-trace.js';
import { compareBusinessObject } from '../investigation/business-compare.js';
import { compareQueryResults, resultCompareSchema, verifyDeployedObject, objectVerificationSchema } from '../investigation/result-verification.js';
import { auditMigrationScript } from '../investigation/migration-audit.js';
import { migrationPreflight, migrationPreflightSchema } from '../investigation/migration-preflight.js';
import {
  diagnoseIncident,
  executeColumnProfile,
  executeColumnSearch,
  executeDataTimeline,
  executeDeadlocks,
  executeDeploymentCompare,
  executeDeploymentFingerprint,
  executeFieldConsumers,
  executeHealthGate,
  executeIncidentCauseTrace,
  executeJobs,
  executeLivePerformance,
  executeQueryStore,
  executeSchemaCompare,
  executeServerIncidentHistory,
  executeSourceTrace,
  executeTableScaleProfile,
  readIncidentHistory
} from '../investigation/service.js';
import type {
  DatabaseColumnProfileRequest,
  DatabaseColumnProfileResult,
  DatabaseColumnSearchResult,
  DatabaseDataTimelineRequest,
  DatabaseDataTimelineResult,
  DatabaseDeadlockHistoryResult,
  DatabaseDeploymentCompareResult,
  DatabaseDeploymentFingerprint,
  DatabaseFieldConsumerRequest,
  DatabaseFieldConsumersResult,
  DatabaseIncidentCauseTraceRequest,
  DatabaseIncidentCauseTraceResult,
  DatabaseIncidentHistoryResult,
  DatabaseIncidentSnapshot,
  DatabaseHealthGateResult,
  DatabaseJobsResult,
  DatabaseLivePerformanceResult,
  DatabaseQueryStoreRequest,
  DatabaseQueryStoreResult,
  DatabaseSchemaCompareRequest,
  DatabaseSchemaCompareResult,
  DatabaseServerIncidentHistoryResult,
  DatabaseSourceTraceRequest,
  DatabaseSourceTraceResult,
  DatabaseTableScaleProfileRequest,
  DatabaseTableScaleProfileResult
} from '../investigation/types.js';
import {
  readIncidentWorkspace,
  type IncidentWorkspaceRequest,
  type IncidentWorkspaceResult
} from '../knowledge/incident-workspace.js';
import { toolDeclaration } from '../../main/mcp/tool-declarations.js';
import { fail, guard, type SurfaceRegistrar, type ToolResult } from '../../main/mcp/kernel.js';

type DatabaseExecutor = (input: DatabaseActionInput, options?: { signal?: AbortSignal }) => Promise<DatabaseActionOutput>;
type IncidentExecutor = {
  workspace?(request: IncidentWorkspaceRequest, roots: SurfaceRegistrar['ctx']['roots']): Promise<IncidentWorkspaceResult>;
  diagnose(connection?: string): Promise<DatabaseIncidentSnapshot>;
  history(connection: string): Promise<DatabaseIncidentHistoryResult>;
  serverHistory(connection?: string): Promise<DatabaseServerIncidentHistoryResult>;
  columnSearch?(connection: string, search: string): Promise<DatabaseColumnSearchResult>;
  columnProfile?(request: DatabaseColumnProfileRequest): Promise<DatabaseColumnProfileResult>;
  tableScaleProfile?(request: DatabaseTableScaleProfileRequest): Promise<DatabaseTableScaleProfileResult>;
  fieldConsumers?(request: DatabaseFieldConsumerRequest): Promise<DatabaseFieldConsumersResult>;
  livePerformance?(connection: string): Promise<DatabaseLivePerformanceResult>;
  queryStore?(request: DatabaseQueryStoreRequest): Promise<DatabaseQueryStoreResult>;
  deadlocks?(connection: string): Promise<DatabaseDeadlockHistoryResult>;
  sourceTrace?(request: DatabaseSourceTraceRequest): Promise<DatabaseSourceTraceResult>;
  incidentCauseTrace?(request: DatabaseIncidentCauseTraceRequest): Promise<DatabaseIncidentCauseTraceResult>;
  jobs?(connection: string): Promise<DatabaseJobsResult>;
  schemaCompare?(request: DatabaseSchemaCompareRequest): Promise<DatabaseSchemaCompareResult>;
  healthGate?(connection: string): Promise<DatabaseHealthGateResult>;
  deploymentFingerprint?(connection: string): Promise<DatabaseDeploymentFingerprint>;
  deploymentCompare?(request: DatabaseSchemaCompareRequest): Promise<DatabaseDeploymentCompareResult>;
  dataTimeline?(request: DatabaseDataTimelineRequest): Promise<DatabaseDataTimelineResult>;
};

const DEFAULT_INCIDENT_EXECUTOR: IncidentExecutor = {
  workspace: (request, roots) => readIncidentWorkspace(request, roots),
  diagnose: (connection) => diagnoseIncident(connection),
  history: (connection) => readIncidentHistory(connection),
  serverHistory: (connection) => executeServerIncidentHistory(connection),
  columnSearch: (connection, search) => executeColumnSearch(connection, search),
  columnProfile: (request) => executeColumnProfile(request),
  tableScaleProfile: (request) => executeTableScaleProfile(request),
  fieldConsumers: (request) => executeFieldConsumers(request),
  livePerformance: (connection) => executeLivePerformance(connection),
  queryStore: (request) => executeQueryStore(request),
  deadlocks: (connection) => executeDeadlocks(connection),
  sourceTrace: (request) => executeSourceTrace(request),
  incidentCauseTrace: (request) => executeIncidentCauseTrace(request),
  jobs: (connection) => executeJobs(connection),
  schemaCompare: (request) => executeSchemaCompare(request),
  healthGate: (connection) => executeHealthGate(connection),
  deploymentFingerprint: (connection) => executeDeploymentFingerprint(connection),
  deploymentCompare: (request) => executeDeploymentCompare(request),
  dataTimeline: (request) => executeDataTimeline(request)
};

function structured(result: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
}

function fallbackText(result: DatabaseActionOutput): string {
  if (result.action === 'test') {
    return `SQL Server connection ${result.connection} (${result.database}) succeeded in ${result.elapsedMs} ms.`;
  }
  return JSON.stringify(result, null, 2);
}

/** Registers the one generic, read-only database primitive on the Core surface. */
export function registerDatabaseTool(
  reg: SurfaceRegistrar,
  execute: DatabaseExecutor = (input, options) => executeDatabaseAction(input, undefined, options),
  incident: IncidentExecutor = DEFAULT_INCIDENT_EXECUTOR
): void {
  reg.register(
    'database',
    toolDeclaration('database', () => ({
      title: 'SQL Server',
      description: 'Read SQL Server data/schema and incident evidence. Start with business_trace or business_graph for ERP identifiers, business_compare for scoped cross-database differences, object_details for columns/DDL/indexes/dependencies. result_compare compares bounded read-only SELECT results; object_verify fingerprints a deployed definition; migration_preflight compares selected source/target table mappings; migration_audit inspects a local SQL payload without running it. Read-only; credentials stay local.',
      inputSchema: z
        .object({
          action: z.enum([
            'query',
            'list_connections',
            'growth_diagnostics',
            'incident_workspace',
            'incident_diagnose',
            'incident_history',
            'search_objects',
            'business_trace',
            'business_graph',
            'business_compare',
            'result_compare',
            'object_verify',
            'migration_audit',
            'migration_preflight',
            'object_details',
            'workspace_context',
            'column_search',
            'column_profile',
            'table_scale_profile',
            'field_consumers',
            'live_performance',
            'query_store',
            'deadlocks',
            'source_trace',
            'incident_cause_trace',
            'jobs',
            'schema_compare',
            'health_gate',
            'deployment_fingerprint',
            'deployment_compare',
            'data_timeline',
            'test'
          ]),
          connection: z.string().min(1).max(64).optional().describe('Configured id; omit for default.'),
          comparison: resultCompareSchema.optional().describe('result_compare only: two explicit connections and read-only SELECT queries with identical projections.'),
          verification: objectVerificationSchema.optional().describe('object_verify only: explicit connection, schema.object and optional expected definition SHA256.'),
          scriptPath: z.string().trim().min(1).max(4096).optional().describe('migration_audit only: approved local SQL payload file; inspect without executing.'),
          migration: migrationPreflightSchema.optional().describe('migration_preflight only: explicit source/target connections and up to 12 schema-qualified table pairs.'),
          scope: z.string().trim().max(120).optional(),
          symptom: z.string().trim().max(1000).optional(),
          sql: z.string().min(1).max(MAX_DATABASE_SQL_CHARS).optional().describe('SELECT SQL for query, or captured SQL for incident_cause_trace.'),
          search: z.string().max(MAX_DATABASE_OBJECT_SEARCH_CHARS).optional().describe('search_objects: object name; column_search: column name; business_trace/business_graph/business_compare: exact ERP identifier or SQL object name.'),
          depth: z.number().int().min(1).max(4).optional().describe('business_graph only: bounded expansion depth (default 3).'),
          types: z.array(z.enum(['table', 'view', 'procedure', 'function', 'synonym'])).min(1).max(5).optional(),
          limit: z.number().int().min(1).max(MAX_DATABASE_OBJECT_PAGE_SIZE).optional().describe('Only search_objects or data_timeline.'),
          incidentLimit: z.number().int().min(1).max(10).optional().describe('Recent local incident snapshots to return for incident_history.'),
          cursor: z.string().min(1).max(1024).optional(),
          objectId: z.number().int().positive().optional().describe('SQL Server object_id for object_details or field investigation actions.'),
          section: z.enum(['columns', 'keys_indexes', 'ddl', 'dependencies']).optional().describe('Required only for object_details.'),
          column: z.string().min(1).max(256).optional().describe('Column name for field investigation actions.'),
          subject: z.string().trim().min(3).max(1300).optional().describe('data_timeline only: Column=Value.'),
          sourceRoot: z.string().trim().min(1).max(4096).optional().describe('Required for source_trace and incident_cause_trace; optional for business_trace and business_graph.'),
          hours: z.union([z.literal(1), z.literal(6), z.literal(24), z.literal(168)]).optional().describe('Query Store lookback window.'),
          sort: z.enum(['duration', 'cpu', 'reads', 'executions']).optional().describe('Query Store ordering.'),
          baselineConnection: z.string().min(1).max(64).optional().describe('Baseline connection for schema_compare, deployment_compare or business_compare.'),
          currentConnection: z.string().min(1).max(64).optional().describe('Current connection for schema_compare, deployment_compare or business_compare.')
        })
        .superRefine((input, ctx) => {
          if ((input.scriptPath !== undefined) !== (input.action === 'migration_audit')) {
            ctx.addIssue({ code: 'custom', path: ['scriptPath'], message: 'scriptPath is required only for migration_audit' });
          }
          for (const [field, action] of [['comparison','result_compare'],['verification','object_verify'],['migration','migration_preflight']] as const) {
            if ((input[field] !== undefined) !== (input.action === action)) {
              ctx.addIssue({ code: 'custom', path: [field], message: field + ' is required only for ' + action });
            }
          }
          if (['result_compare','object_verify','migration_audit','migration_preflight'].includes(input.action) && input.connection !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['connection'], message: 'Specify connection inside the action-specific request.' });
          }
          if (input.action === 'incident_workspace') {
            if (!input.scope) ctx.addIssue({ code: 'custom', path: ['scope'], message: 'scope is required for action=incident_workspace' });
            if (!input.symptom) ctx.addIssue({ code: 'custom', path: ['symptom'], message: 'symptom is required for action=incident_workspace' });
          } else {
            if (input.scope !== undefined) ctx.addIssue({ code: 'custom', path: ['scope'], message: 'scope is only valid for action=incident_workspace' });
            if (input.symptom !== undefined) ctx.addIssue({ code: 'custom', path: ['symptom'], message: 'symptom is only valid for action=incident_workspace' });
          }
          const sqlActions = new Set(['query', 'incident_cause_trace']);
          if (sqlActions.has(input.action) && input.sql === undefined) {
            ctx.addIssue({ code: 'custom', path: ['sql'], message: `sql is required for action=${input.action}` });
          }
          if (!sqlActions.has(input.action) && input.sql !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['sql'], message: 'sql is only valid for query or incident_cause_trace' });
          }
          if (['column_search', 'business_trace', 'business_graph', 'business_compare'].includes(input.action) && !input.search?.trim()) {
            ctx.addIssue({ code: 'custom', path: ['search'], message: `search is required for action=${input.action}` });
          }
          if (!['search_objects', 'column_search', 'business_trace', 'business_graph', 'business_compare'].includes(input.action) && input.search !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['search'], message: 'search is only valid for search_objects, column_search, business_trace, business_graph or business_compare' });
          }
          if (input.action !== 'business_graph' && input.depth !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['depth'], message: 'depth is only valid for business_graph' });
          }
          if (['business_trace', 'business_graph', 'object_details'].includes(input.action) && !input.connection?.trim()) {
            ctx.addIssue({ code: 'custom', path: ['connection'], message: 'Choose an explicit configured connection for this action.' });
          }
          if (input.action === 'object_details' ? input.section === undefined : input.section !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['section'], message: 'section is required only for action=object_details' });
          }
          for (const field of ['types', 'cursor'] as const) {
            if (input.action !== 'search_objects' && input[field] !== undefined) {
              ctx.addIssue({ code: 'custom', path: [field], message: `${field} is only valid for action=search_objects` });
            }
          }
          if (input.limit !== undefined && !['search_objects', 'data_timeline'].includes(input.action)) {
            ctx.addIssue({ code: 'custom', path: ['limit'], message: 'limit is only valid for search_objects or data_timeline' });
          }
          if (input.action !== 'incident_history' && input.incidentLimit !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['incidentLimit'], message: 'incidentLimit is only valid for action=incident_history' });
          }
          const objectActions = ['column_profile', 'table_scale_profile', 'field_consumers', 'source_trace', 'data_timeline', 'object_details'];
          if (objectActions.includes(input.action)) {
            if (input.objectId === undefined) ctx.addIssue({ code: 'custom', path: ['objectId'], message: `objectId is required for action=${input.action}` });
          } else if (input.objectId !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['objectId'], message: 'objectId is only valid for object investigation actions' });
          }
          const fieldActions = ['column_profile', 'field_consumers', 'source_trace'];
          if (fieldActions.includes(input.action)) {
            if (input.column === undefined) ctx.addIssue({ code: 'custom', path: ['column'], message: `column is required for action=${input.action}` });
          } else if (input.column !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['column'], message: 'column is only valid for field investigation actions' });
          }
          if (input.action === 'data_timeline' && input.subject === undefined) {
            ctx.addIssue({ code: 'custom', path: ['subject'], message: 'subject is required for action=data_timeline' });
          }
          if (input.action !== 'data_timeline' && input.subject !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['subject'], message: 'subject is only valid for action=data_timeline' });
          }
          const sourceActions = ['source_trace', 'incident_cause_trace'];
          if (sourceActions.includes(input.action) && input.sourceRoot === undefined) {
            ctx.addIssue({ code: 'custom', path: ['sourceRoot'], message: `sourceRoot is required for action=${input.action}` });
          }
          if (!sourceActions.includes(input.action) && !['business_trace', 'business_graph'].includes(input.action) && input.sourceRoot !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['sourceRoot'], message: 'sourceRoot is only valid for source_trace, incident_cause_trace, business_trace or business_graph' });
          }
          for (const field of ['hours', 'sort'] as const) {
            if (input.action !== 'query_store' && input[field] !== undefined) {
              ctx.addIssue({ code: 'custom', path: [field], message: `${field} is only valid for action=query_store` });
            }
          }
          const compareActions = ['schema_compare', 'deployment_compare', 'business_compare'];
          if (compareActions.includes(input.action)) {
            if (input.baselineConnection === undefined) ctx.addIssue({ code: 'custom', path: ['baselineConnection'], message: 'baselineConnection is required for compare actions' });
            if (input.currentConnection === undefined) ctx.addIssue({ code: 'custom', path: ['currentConnection'], message: 'currentConnection is required for compare actions' });
          } else {
            if (input.baselineConnection !== undefined) ctx.addIssue({ code: 'custom', path: ['baselineConnection'], message: 'baselineConnection is only valid for compare actions' });
            if (input.currentConnection !== undefined) ctx.addIssue({ code: 'custom', path: ['currentConnection'], message: 'currentConnection is only valid for compare actions' });
          }
          if (['workspace_context', 'list_connections', ...compareActions].includes(input.action) && input.connection !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['connection'], message: `connection is not used for action=${input.action}` });
          }
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    })),
    async (input, call) =>
      guard('database', async () => {
        try {
          const connectionId = async (): Promise<string> => {
            if (input.connection) return input.connection;
            const listed = call?.signal
              ? await execute({ action: 'list_connections' }, { signal: call.signal })
              : await execute({ action: 'list_connections' });
            if (listed.action !== 'list_connections') throw new Error('Unexpected database connection-list result');
            const selected = listed.defaultConnectionId
              ?? (listed.connections.length === 1 ? listed.connections[0]!.id : undefined);
            if (!selected) throw new Error('DATABASE_CONNECTION_REQUIRED: choose one configured database connection');
            return selected;
          };
          if (input.action === 'incident_workspace') {
            if (!incident.workspace) throw new Error('INCIDENT_WORKSPACE_UNAVAILABLE');
            const result = await incident.workspace({
              scope: input.scope!,
              symptom: input.symptom!,
              ...(input.connection ? { connection: input.connection } : {})
            }, reg.ctx.roots);
            return structured({ action: 'incident_workspace', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'incident_diagnose') {
            const snapshot = await incident.diagnose(input.connection);
            const result = { action: 'incident_diagnose', connection: snapshot.connection, database: snapshot.database, capturedAt: snapshot.capturedAt, snapshot };
            return structured(result as unknown as Record<string, unknown>);
          }
          if (input.action === 'incident_history') {
            const selected = await connectionId();
            const [history, serverSettled] = await Promise.all([
              incident.history(selected),
              incident.serverHistory(selected).then(
                value => ({ ok: true as const, value }),
                error => ({ ok: false as const, error })
              )
            ]);
            const result = {
              action: 'incident_history',
              connection: history.connection,
              snapshots: history.snapshots.slice(0, input.incidentLimit ?? 5),
              serverHistory: serverSettled.ok ? serverSettled.value : null,
              ...(serverSettled.ok ? {} : { serverHistoryError: serverSettled.error instanceof Error ? serverSettled.error.message : String(serverSettled.error) })
            };
            return structured(result as unknown as Record<string, unknown>);
          }
          if (input.action === 'column_search') {
            if (!incident.columnSearch) throw new Error('COLUMN_SEARCH_UNAVAILABLE');
            const result = await incident.columnSearch(await connectionId(), input.search!);
            return structured({ action: 'column_search', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'business_trace' || input.action === 'business_graph') {
            if (input.sourceRoot && !reg.ctx.caps.read) throw new Error('Source tracing requires file read permission.');
            const result = await investigateBusinessObject({
              connection: input.connection!, search: input.search!, sourceRoot: input.sourceRoot,
              ...(input.action === 'business_graph' ? { graphDepth: input.depth ?? 3 } : {})
            }, execute, call?.signal);
            return structured({ action: input.action, ...result });
          }
          if (input.action === 'migration_preflight') {
            return structured({ action: input.action, ...await migrationPreflight(input.migration!, execute, call?.signal) });
          }
          if (input.action === 'migration_audit') {
            if (!reg.ctx.caps.read) throw new Error('Migration audit requires file read permission.');
            return structured({ action: input.action, ...await auditMigrationScript(input.scriptPath!, reg.ctx.roots, call?.signal) });
          }
          if (input.action === 'result_compare') {
            return structured({ action: input.action, ...await compareQueryResults(input.comparison!, execute, call?.signal) });
          }
          if (input.action === 'object_verify') {
            return structured({ action: input.action, ...await verifyDeployedObject(input.verification!, execute, call?.signal) });
          }
          if (input.action === 'business_compare') {
            const result = await compareBusinessObject({
              baselineConnection: input.baselineConnection!, connection: input.currentConnection!, search: input.search!
            }, execute, call?.signal);
            return structured({ action: 'business_compare', ...result });
          }
          if (input.action === 'column_profile') {
            if (!incident.columnProfile) throw new Error('COLUMN_PROFILE_UNAVAILABLE');
            const result = await incident.columnProfile({ connection: await connectionId(), objectId: input.objectId!, column: input.column! });
            return structured({ action: 'column_profile', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'table_scale_profile') {
            if (!incident.tableScaleProfile) throw new Error('TABLE_SCALE_PROFILE_UNAVAILABLE');
            const result = await incident.tableScaleProfile({ connection: await connectionId(), objectId: input.objectId! });
            return structured({ action: 'table_scale_profile', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'field_consumers') {
            if (!incident.fieldConsumers) throw new Error('FIELD_CONSUMERS_UNAVAILABLE');
            const result = await incident.fieldConsumers({ connection: await connectionId(), objectId: input.objectId!, column: input.column! });
            return structured({ action: 'field_consumers', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'live_performance') {
            if (!incident.livePerformance) throw new Error('LIVE_PERFORMANCE_UNAVAILABLE');
            const result = await incident.livePerformance(await connectionId());
            return structured({ action: 'live_performance', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'query_store') {
            if (!incident.queryStore) throw new Error('QUERY_STORE_UNAVAILABLE');
            const result = await incident.queryStore({ connection: await connectionId(), hours: input.hours, sort: input.sort });
            return structured({ action: 'query_store', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'deadlocks') {
            if (!incident.deadlocks) throw new Error('DEADLOCKS_UNAVAILABLE');
            const result = await incident.deadlocks(await connectionId());
            return structured({ action: 'deadlocks', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'source_trace') {
            if (!incident.sourceTrace) throw new Error('SOURCE_TRACE_UNAVAILABLE');
            const result = await incident.sourceTrace({
              connection: await connectionId(),
              objectId: input.objectId!,
              column: input.column!,
              sourceRoot: input.sourceRoot!
            });
            return structured({ action: 'source_trace', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'incident_cause_trace') {
            if (!incident.incidentCauseTrace) throw new Error('INCIDENT_CAUSE_TRACE_UNAVAILABLE');
            const result = await incident.incidentCauseTrace({
              connection: await connectionId(),
              sql: input.sql!,
              sourceRoot: input.sourceRoot!
            });
            return structured({ action: 'incident_cause_trace', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'jobs') {
            if (!incident.jobs) throw new Error('JOBS_UNAVAILABLE');
            const result = await incident.jobs(await connectionId());
            return structured({ action: 'jobs', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'schema_compare') {
            if (!incident.schemaCompare) throw new Error('SCHEMA_COMPARE_UNAVAILABLE');
            const result = await incident.schemaCompare({
              baselineConnection: input.baselineConnection!,
              currentConnection: input.currentConnection!
            });
            return structured({ action: 'schema_compare', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'health_gate') {
            if (!incident.healthGate) throw new Error('HEALTH_GATE_UNAVAILABLE');
            const result = await incident.healthGate(await connectionId());
            return structured({ action: 'health_gate', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'deployment_fingerprint') {
            if (!incident.deploymentFingerprint) throw new Error('DEPLOYMENT_FINGERPRINT_UNAVAILABLE');
            const result = await incident.deploymentFingerprint(await connectionId());
            return structured({ action: 'deployment_fingerprint', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'deployment_compare') {
            if (!incident.deploymentCompare) throw new Error('DEPLOYMENT_COMPARE_UNAVAILABLE');
            const result = await incident.deploymentCompare({
              baselineConnection: input.baselineConnection!,
              currentConnection: input.currentConnection!
            });
            return structured({ action: 'deployment_compare', ...result } as unknown as Record<string, unknown>);
          }
          if (input.action === 'data_timeline') {
            if (!incident.dataTimeline) throw new Error('DATA_TIMELINE_UNAVAILABLE');
            const result = await incident.dataTimeline({
              connection: await connectionId(),
              objectId: input.objectId!,
              subject: input.subject!,
              limit: input.limit
            });
            return structured({ action: 'data_timeline', ...result } as unknown as Record<string, unknown>);
          }
          const result = call?.signal
            ? await execute(input as DatabaseActionInput, { signal: call.signal })
            : await execute(input as DatabaseActionInput);
          return {
            content: [{ type: 'text' as const, text: fallbackText(result) }],
            structuredContent: result as unknown as Record<string, unknown>
          };
        } catch (error) {
          return fail(`database failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
  );
}
