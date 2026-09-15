import { z } from 'zod';
import { executeDatabaseAction, MAX_DATABASE_SQL_CHARS, type DatabaseActionInput, type DatabaseActionOutput } from '../database/service.js';
import { MAX_DATABASE_OBJECT_PAGE_SIZE, MAX_DATABASE_OBJECT_SEARCH_CHARS } from '../database/metadata.js';
import { toolDeclaration } from './tool-declarations.js';
import { fail, guard, type SurfaceRegistrar } from './kernel.js';

type DatabaseExecutor = (input: DatabaseActionInput, options?: { signal?: AbortSignal }) => Promise<DatabaseActionOutput>;

function fallbackText(result: DatabaseActionOutput): string {
  if (result.action === 'test') {
    return `SQL Server connection ${result.connection} (${result.database}) succeeded in ${result.elapsedMs} ms.`;
  }
  return JSON.stringify(result, null, 2);
}

/** Registers the one generic, read-only database primitive on the Core surface. */
export function registerDatabaseTool(
  reg: SurfaceRegistrar,
  execute: DatabaseExecutor = (input, options) => executeDatabaseAction(input, undefined, options)
): void {
  reg.register(
    'database',
    toolDeclaration('database', () => ({
      title: 'Query SQL Server',
      description:
        'Query a configured SQL Server connection, list configured connection identities and access modes, run bounded database-growth diagnostics, search its object catalog with bounded cursor pagination, read the user\'s current Database Workspace context, or test that connection. ' +
        'Credentials stay in local secure storage and are never tool arguments. Raw SQL remains read-only; mutation and multi-statement SQL are refused.',
      inputSchema: z
        .object({
          action: z.enum(['query', 'list_connections', 'growth_diagnostics', 'search_objects', 'workspace_context', 'test']).describe('query runs read-only SQL; list_connections returns credential-free configured ids, databases, defaults and access modes; growth_diagnostics returns fixed read-only file/log/largest-table findings; search_objects searches bounded metadata; workspace_context reads the active DB UI object/tab/filter/selected rows; test checks the connection.'),
          connection: z.string().min(1).max(64).optional().describe('Configured connection id. Omit when one connection or a default is configured.'),
          sql: z.string().min(1).max(MAX_DATABASE_SQL_CHARS).optional().describe('Read-only SELECT SQL. Required for action=query.'),
          search: z.string().max(MAX_DATABASE_OBJECT_SEARCH_CHARS).optional().describe('Object/schema name prefix for search_objects.'),
          types: z.array(z.enum(['table', 'view', 'procedure', 'function', 'synonym'])).min(1).max(5).optional().describe('Object kinds to include for search_objects.'),
          limit: z.number().int().min(1).max(MAX_DATABASE_OBJECT_PAGE_SIZE).optional().describe('Objects per page for search_objects. Defaults to 50.'),
          cursor: z.string().min(1).max(1024).optional().describe('Opaque nextCursor returned by a prior search_objects page.')
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
