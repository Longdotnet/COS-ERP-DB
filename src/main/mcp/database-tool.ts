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
      title: 'SQL Server',
      description:
        'Read configured SQL Server data/schema, growth and object metadata, workspace context, or connection state. Read-only; credentials stay local.',
      inputSchema: z
        .object({
          action: z.enum(['query', 'list_connections', 'growth_diagnostics', 'search_objects', 'workspace_context', 'test']),
          connection: z.string().min(1).max(64).optional().describe('Configured id; omit for default.'),
          sql: z.string().min(1).max(MAX_DATABASE_SQL_CHARS).optional().describe('SELECT SQL for query.'),
          search: z.string().max(MAX_DATABASE_OBJECT_SEARCH_CHARS).optional(),
          types: z.array(z.enum(['table', 'view', 'procedure', 'function', 'synonym'])).min(1).max(5).optional(),
          limit: z.number().int().min(1).max(MAX_DATABASE_OBJECT_PAGE_SIZE).optional(),
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
