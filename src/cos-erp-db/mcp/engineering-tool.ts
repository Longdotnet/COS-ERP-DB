import { z } from 'zod';
import type { EngineeringConventionInput, EngineeringTaskInput } from '../engineering/contracts.js';
import { getEngineeringConventionHistory, getEngineeringConventions, putEngineeringConvention, searchEngineeringConventions } from '../engineering/convention-service.js';
import { discoverEngineeringAnalogues } from '../engineering/discovery.js';
import { engineeringKnowledgeScope, resolveEngineeringLineage } from '../engineering/lineage.js';
import { engineeringProfile } from '../engineering/profiles/index.js';
import { engineeringPrepareInputSchema, prepareEngineeringTask } from '../engineering/prepare-service.js';
import { getEngineeringPerformance, observeEngineeringInvocation } from '../engineering/performance.js';
import { engineeringQualityGate } from '../engineering/quality-gate.js';
import { getEngineeringTaskHistory, getEngineeringTasks, putEngineeringTask } from '../engineering/task-service.js';
import {
  engineeringValidationRunInputSchema,
  getEngineeringVerifications,
  runEngineeringValidation
} from '../engineering/verification-service.js';
import { fail, type SurfaceRegistrar, type ToolAnnotations, type ToolResult } from '../../main/mcp/kernel.js';
import { toolDeclaration } from '../../main/mcp/tool-declarations.js';

type EngineeringAction =
  | 'context'
  | 'profile_get'
  | 'prepare'
  | 'discover'
  | 'task_put'
  | 'task_get'
  | 'task_history'
  | 'convention_put'
  | 'convention_search'
  | 'convention_get'
  | 'convention_history'
  | 'validation_run'
  | 'validation_get'
  | 'performance_get'
  | 'quality_gate';

function result(value: unknown): ToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>
  };
}

function parseJson<T>(value: string | undefined, label: string): T {
  if (!value) throw new Error(`${label} requires item JSON.`);
  try { return JSON.parse(value) as T; }
  catch { throw new Error(`${label} item must be valid JSON.`); }
}

export function registerEngineeringTool(reg: SurfaceRegistrar): void {
  if (!reg.exposedCaps.read) return;
  reg.register(
    'engineering',
    toolDeclaration('engineering', () => ({
      title: 'Project-Native Engineering',
      description: 'Project-bound preparation, evidence-backed task packets with explicit deliberation/options, convention discovery, Core-owned command/SQL verification, profiles and quality gates.',
      inputSchema: z.object({
        action: z.enum([
          'context', 'profile_get', 'prepare', 'discover',
          'task_put', 'task_get', 'task_history',
          'convention_put', 'convention_search', 'convention_get', 'convention_history',
          'validation_run', 'validation_get', 'performance_get',
          'quality_gate'
        ] satisfies EngineeringAction[]),
        profile: z.string().trim().min(1).max(80).optional(),
        runtimeFamily: z.string().trim().min(1).max(120).optional(),
        sourceRevision: z.string().trim().min(1).max(160).optional(),
        item: z.string().min(1).max(64_000).optional(),
        items: z.array(z.string().trim().min(1).max(160)).min(1).max(20).optional(),
        query: z.string().trim().min(1).max(1000).optional(),
        limit: z.number().int().min(1).max(50).optional()
      }).strict().superRefine((input, ctx) => {
        const put = input.action === 'prepare' || input.action === 'task_put' || input.action === 'convention_put' || input.action === 'validation_run';
        const search = input.action === 'discover' || input.action === 'convention_search';
        const keyed = ['task_get', 'task_history', 'convention_get', 'convention_history', 'validation_get', 'performance_get', 'quality_gate'].includes(input.action);
        if (put !== (input.item !== undefined)) {
          ctx.addIssue({ code: 'custom', path: ['item'], message: put ? 'item is required for put actions' : 'item is only valid for put actions' });
        }
        if (search !== (input.query !== undefined)) {
          ctx.addIssue({ code: 'custom', path: ['query'], message: search ? 'query is required for search/discover actions' : 'query is only valid for search/discover actions' });
        }
        if (keyed && !input.items?.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'items is required for keyed actions' });
        if (!keyed && input.items !== undefined) ctx.addIssue({ code: 'custom', path: ['items'], message: 'items is only valid for keyed actions' });
        if ((input.action === 'task_history' || input.action === 'convention_history' || input.action === 'validation_get' || input.action === 'performance_get' || input.action === 'quality_gate') && input.items?.length !== 1) {
          ctx.addIssue({ code: 'custom', path: ['items'], message: `${input.action} requires exactly one key` });
        }
        if (input.limit !== undefined && !search) ctx.addIssue({ code: 'custom', path: ['limit'], message: 'limit is only valid for search/discover actions' });
        if (input.action === 'discover' && input.limit !== undefined && (input.limit < 3 || input.limit > 7)) {
          ctx.addIssue({ code: 'custom', path: ['limit'], message: 'discover limit must be between 3 and 7' });
        }
      }),
      annotations: { readOnlyHint: false, destructiveHint: false } as ToolAnnotations
    })),
    async input => {
      const run = async (): Promise<ToolResult> => {
        try {
          if (input.action === 'profile_get') return result(engineeringProfile(input.profile));
          const resolved = await resolveEngineeringLineage({
            profile: input.profile,
            runtimeFamily: input.runtimeFamily,
            sourceRevision: input.sourceRevision
          });
          const lineage = resolved.lineage;
          if (input.action === 'context') {
            return result({ lineage, knowledgeScope: engineeringKnowledgeScope(lineage), profile: engineeringProfile(lineage.profile) });
          }
          if (input.action === 'performance_get') {
            return result(await getEngineeringPerformance(lineage.key, input.items![0]!));
          }
          const execute = async (): Promise<ToolResult> => {
          if (input.action === 'prepare') {
            const parsed = engineeringPrepareInputSchema.parse(parseJson<unknown>(input.item, 'prepare'));
            return result(await prepareEngineeringTask(resolved, parsed, reg.ctx.roots));
          }
          if (input.action === 'discover') {
            return result(await discoverEngineeringAnalogues(resolved, input.query!, reg.ctx.roots, input.limit ?? 7));
          }
          if (input.action === 'task_put') {
            return result(await putEngineeringTask(lineage, parseJson<EngineeringTaskInput>(input.item, 'task_put')));
          }
          if (input.action === 'task_get') {
            const tasks = await getEngineeringTasks(lineage, input.items!);
            return result({
              lineage,
              tasks,
              performance: await Promise.all(input.items!.map(taskKey => getEngineeringPerformance(lineage.key, taskKey, 10)))
            });
          }
          if (input.action === 'task_history') return result({ lineage, history: await getEngineeringTaskHistory(lineage, input.items![0]!) });
          if (input.action === 'convention_put') {
            return result(await putEngineeringConvention(lineage, parseJson<EngineeringConventionInput>(input.item, 'convention_put'), reg.ctx.roots));
          }
          if (input.action === 'convention_search') {
            return result({ lineage, hits: await searchEngineeringConventions(lineage, input.query!, input.limit ?? 12) });
          }
          if (input.action === 'convention_get') return result({ lineage, conventions: await getEngineeringConventions(lineage, input.items!) });
          if (input.action === 'convention_history') return result({ lineage, history: await getEngineeringConventionHistory(lineage, input.items![0]!) });
          if (input.action === 'validation_run') {
            const parsed = engineeringValidationRunInputSchema.parse(parseJson<unknown>(input.item, 'validation_run'));
            return result(await runEngineeringValidation(resolved, parsed, reg.ctx.roots));
          }
          if (input.action === 'validation_get') {
            const all = await getEngineeringVerifications(lineage, input.items![0]!);
            const verifications = all.slice(-50);
            return result({ lineage, verifications, total: all.length, truncated: all.length > verifications.length });
          }
          return result(await engineeringQualityGate(lineage, input.items![0]!, reg.ctx.roots, resolved.workspace));
          };
          let taskKey = input.items?.[0] ?? '__unattributed__';
          if (input.action === 'prepare' || input.action === 'task_put' || input.action === 'validation_run') {
            try {
              const parsed = JSON.parse(input.item ?? '{}') as { taskKey?: unknown; key?: unknown };
              const selected = parsed.taskKey ?? parsed.key;
              if (typeof selected === 'string' && selected.trim()) taskKey = selected.trim();
            } catch { /* Original input validation remains authoritative. */ }
          }
          if (input.action === 'discover' || input.action === 'convention_search') taskKey = '__unattributed__';
          return observeEngineeringInvocation(lineage.key, taskKey, input.action, execute, value => {
            const body = value.structuredContent as { revision?: number; task?: { revision?: number } } | undefined;
            return body?.task?.revision ?? body?.revision ?? null;
          });
        } catch (error) {
          return fail(`engineering failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      if (input.action === 'prepare' || input.action === 'task_put' || input.action === 'convention_put') return reg.guarded('edit', 'engineering', run);
      if (input.action === 'validation_run') {
        let kind: unknown;
        try { kind = (JSON.parse(input.item ?? '{}') as { kind?: unknown }).kind; } catch { kind = null; }
        return kind === 'sql_scale'
          ? reg.guarded('read', 'engineering', run)
          : reg.guarded('command', 'engineering', run);
      }
      return reg.guarded('read', 'engineering', run);
    }
  );
}
