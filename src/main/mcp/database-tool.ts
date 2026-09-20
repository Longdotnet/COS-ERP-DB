import { z } from 'zod';
import { executeDatabaseAction, MAX_DATABASE_SQL_CHARS, type DatabaseActionInput, type DatabaseActionOutput } from '../database/service.js';
import { MAX_DATABASE_OBJECT_PAGE_SIZE, MAX_DATABASE_OBJECT_SEARCH_CHARS } from '../database/metadata.js';
import { diagnoseIncident, executeServerIncidentHistory, readIncidentHistory } from '../../cos-erp-db/investigation/service.js';
import type { DatabaseIncidentHistoryResult, DatabaseIncidentSnapshot, DatabaseServerIncidentHistoryResult } from '../../cos-erp-db/investigation/types.js';
import { toolDeclaration } from './tool-declarations.js';
import { fail, guard, type SurfaceRegistrar } from './kernel.js';

type DatabaseExecutor = (input: DatabaseActionInput, options?: { signal?: AbortSignal }) => Promise<DatabaseActionOutput>;
type IncidentExecutor = {
  diagnose(connection?: string): Promise<DatabaseIncidentSnapshot>;
  history(connection: string): Promise<DatabaseIncidentHistoryResult>;
  serverHistory(connection?: string): Promise<DatabaseServerIncidentHistoryResult>;
};

const DEFAULT_INCIDENT_EXECUTOR: IncidentExecutor = {
  diagnose: (connection) => diagnoseIncident(connection),
  history: (connection) => readIncidentHistory(connection),
  serverHistory: (connection) => executeServerIncidentHistory(connection)
};

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
          description:
        'Read configured SQL Server data/schema, growth, incident diagnostics and object metadata, workspace context, or connection state. Read-only; credentials stay local.',
      inputSchema: z
        .object({
          action: z.enum(['query', 'list_connections', 'growth_diagnostics', 'incident_diagnose', 'incident_history', 'search_objects', 'workspace_context', 'test']),
          connection: z.string().min(1).max(64).optional().describe('Configured id; omit for default.'),
          sql: z.string().min(1).max(MAX_DATABASE_SQL_CHARS).optional().describe('SELECT SQL for query.'),
          search: z.string().max(MAX_DATABASE_OBJECT_SEARCH_CHARS).optional(),
          types: z.array(z.enum(['table', 'view', 'procedure', 'function', 'synonym'])).min(1).max(5).optional(),
          limit: z.number().int().min(1).max(MAX_DATABASE_OBJECT_PAGE_SIZE).optional(),
          incidentLimit: z.number().int().min(1).max(10).optional().describe('Recent local incident snapshots to return for incident_history.'),
          cursor: z.string().min(1).max(1024).optional()
        })
        .superRefine((input, ctx) => {
          if (input.action === 'query' && input.sql === undefined) {
            ctx.addIssue({ code: 'custom', path: ['sql'], message: 'sql is required for action=query' });
          }
          if (input.action !== 'query' && input.sql !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['sql'], message: 'sql is only valid for action=query' });
          }
          for (const field of ['search', 'types', 'limit', 'cursor'] as const) {
            if (input.action !== 'search_objects' && input[field] !== undefined) {
              ctx.addIssue({ code: 'custom', path: [field], message: `${field} is only valid for action=search_objects` });
            }
          }
          if (input.action !== 'incident_history' && input.incidentLimit !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['incidentLimit'], message: 'incidentLimit is only valid for action=incident_history' });
          }
          if ((input.action === 'workspace_context' || input.action === 'list_connections') && input.connection !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['connection'], message: `connection is not used for action=${input.action}` });
          }
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    })),
    async (input, call) =>
      guard('database', async () => {
        try {
          if (input.action === 'incident_diagnose') {
            const snapshot = await incident.diagnose(input.connection);
            const result = { action: 'incident_diagnose', connection: snapshot.connection, database: snapshot.database, capturedAt: snapshot.capturedAt, snapshot };
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
              structuredContent: result as unknown as Record<string, unknown>
            };
          }
          if (input.action === 'incident_history') {
            let connectionId = input.connection;
            if (!connectionId) {
              const listed = call?.signal
                ? await execute({ action: 'list_connections' }, { signal: call.signal })
                : await execute({ action: 'list_connections' });
              if (listed.action !== 'list_connections') throw new Error('Unexpected database connection-list result');
              connectionId = listed.defaultConnectionId
                ?? (listed.connections.length === 1 ? listed.connections[0]!.id : undefined);
              if (!connectionId) throw new Error('DATABASE_CONNECTION_REQUIRED: choose one configured database connection');
            }
            const [history, serverSettled] = await Promise.all([
              incident.history(connectionId),
              incident.serverHistory(connectionId).then(
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
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
              structuredContent: result as unknown as Record<string, unknown>
            };
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
