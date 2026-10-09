import { z } from 'zod';
import type { KnowledgeEvidenceKind, KnowledgeIndexRequest } from '../knowledge/contracts/knowledge.js';
import {
  getKnowledgeEvidence,
  indexKnowledge,
  searchKnowledge,
  verifyKnowledgeEvidence
} from '../knowledge/service.js';
import {
  getBusinessProcessHistory,
  getBusinessProcessRecords,
  putBusinessProcessRecord,
  searchBusinessProcessRecords
} from '../knowledge/process-service.js';
import { expandImplementationGraph, searchImplementationGraph } from '../knowledge/graph-service.js';
import { readIncidentContext } from '../knowledge/incident-context.js';
import {
  getIncidentPatternHistory,
  getIncidentPatterns,
  putIncidentPatternOccurrence,
  searchIncidentPatterns
} from '../knowledge/pattern-service.js';
import {
  getIncidentOutcomeHistory,
  getIncidentOutcomes,
  putIncidentOutcome,
  searchIncidentOutcomes
} from '../knowledge/outcome-service.js';
import { fail, type SurfaceRegistrar, type ToolAnnotations, type ToolResult } from '../../main/mcp/kernel.js';
import { toolDeclaration } from '../../main/mcp/tool-declarations.js';

type KnowledgeSourceToken = string;

interface KnowledgeExecutor {
  index(request: KnowledgeIndexRequest, roots: SurfaceRegistrar['ctx']['roots']): Promise<unknown>;
  search(request: { scope: string; query: string; kinds?: KnowledgeEvidenceKind[]; limit?: number }): Promise<unknown>;
  get(scope: string, ids: string[]): Promise<unknown>;
  verify(
    request: { scope: string; evidence: Array<{ evidenceId: string; contentHash?: string }> },
    roots: SurfaceRegistrar['ctx']['roots']
  ): Promise<unknown>;
  processPut(scope: string, input: unknown): Promise<unknown>;
  processSearch(scope: string, query: string, limit?: number): Promise<unknown>;
  processGet(scope: string, keys: string[]): Promise<unknown>;
  processHistory(scope: string, key: string): Promise<unknown>;
  graphSearch(scope: string, query: string, limit?: number): Promise<unknown>;
  graphExpand(scope: string, nodeId: string): Promise<unknown>;
  incidentContext(
    request: { scope: string; query: string; limit?: number },
    roots: SurfaceRegistrar['ctx']['roots']
  ): Promise<unknown>;
  outcomePut(scope: string, input: unknown): Promise<unknown>;
  outcomeSearch(scope: string, query: string, limit?: number): Promise<unknown>;
  outcomeGet(scope: string, keys: string[]): Promise<unknown>;
  outcomeHistory(scope: string, key: string): Promise<unknown>;
  patternPut(scope: string, input: unknown): Promise<unknown>;
  patternSearch(scope: string, query: string, limit?: number): Promise<unknown>;
  patternGet(scope: string, keys: string[]): Promise<unknown>;
  patternHistory(key: string): Promise<unknown>;
}

const DEFAULT_EXECUTOR: KnowledgeExecutor = {
  index: (request, roots) => indexKnowledge(request, roots),
  search: request => searchKnowledge(request),
  get: (scope, ids) => getKnowledgeEvidence(scope, ids),
  verify: (request, roots) => verifyKnowledgeEvidence(request, roots),
  processPut: (scope, input) => putBusinessProcessRecord(scope, input),
  processSearch: (scope, query, limit) => searchBusinessProcessRecords(scope, query, limit),
  processGet: (scope, keys) => getBusinessProcessRecords(scope, keys),
  processHistory: (scope, key) => getBusinessProcessHistory(scope, key),
  graphSearch: (scope, query, limit) => searchImplementationGraph(scope, query, limit),
  graphExpand: (scope, nodeId) => expandImplementationGraph(scope, nodeId),
  incidentContext: (request, roots) => readIncidentContext(request.scope, request.query, roots, request.limit),
  outcomePut: (scope, input) => putIncidentOutcome(scope, input),
  outcomeSearch: (scope, query, limit) => searchIncidentOutcomes(scope, query, limit),
  outcomeGet: (scope, keys) => getIncidentOutcomes(scope, keys),
  outcomeHistory: (scope, key) => getIncidentOutcomeHistory(scope, key),
  patternPut: (scope, input) => putIncidentPatternOccurrence(scope, input),
  patternSearch: (scope, query, limit) => searchIncidentPatterns(scope, query, limit),
  patternGet: (scope, keys) => getIncidentPatterns(scope, keys),
  patternHistory: key => getIncidentPatternHistory(key)
};

function sourceToken(value: KnowledgeSourceToken): KnowledgeIndexRequest['sources'][number] {
  const separator = value.indexOf(':');
  const prefix = separator < 0 ? value : value.slice(0, separator);
  const payload = separator < 0 ? '' : value.slice(separator + 1).trim();
  if (prefix === 'database') {
    return payload ? { kind: 'database', connection: payload } : { kind: 'database' };
  }
  if (prefix === 'source' || prefix === 'document') {
    if (!payload) throw new Error(prefix + ' knowledge source requires a path.');
    return { kind: prefix, path: payload };
  }
  throw new Error('Knowledge source must start with source:, document:, or database:.');
}

function evidenceId(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Knowledge evidence id must be a 64-character lowercase SHA-256 hex string.');
  return value;
}

function evidenceReference(value: string): { evidenceId: string; contentHash?: string } {
  const match = /^([a-f0-9]{64})(?:@([a-f0-9]{64}))?$/.exec(value);
  if (!match) throw new Error('Knowledge verify items must be evidenceId or evidenceId@contentHash.');
  return {
    evidenceId: match[1]!,
    ...(match[2] ? { contentHash: match[2] } : {})
  };
}

function result(value: unknown): ToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>
  };
}

export function registerKnowledgeTool(
  reg: SurfaceRegistrar,
  executor: KnowledgeExecutor = DEFAULT_EXECUTOR
): void {
  if (!reg.exposedCaps.read) return;
  reg.register(
    'knowledge',
    toolDeclaration('knowledge', () => ({
      description: 'ERP.',
      inputSchema: z.object({
        action: z.enum([
          'index', 'search', 'get', 'verify',
          'process_put', 'process_search', 'process_get', 'process_history',
          'graph_search', 'graph_expand', 'incident_context',
          'outcome_put', 'outcome_search', 'outcome_get', 'outcome_history',
          'pattern_put', 'pattern_search', 'pattern_get', 'pattern_history'
        ]),
        scope: z.string().trim().min(1).max(120),
        items: z.array(z.string().trim().min(1).max(16_000)).min(1).max(20).optional(),
        mode: z.enum(['incremental', 'refresh']).optional(),
        query: z.string().trim().min(1).max(1000).optional(),
        kinds: z.array(z.enum(['source', 'document', 'database'])).min(1).max(3).optional(),
        limit: z.number().int().min(1).max(50).optional()
      }).strict().superRefine((input, ctx) => {
        if (input.mode !== undefined && input.action !== 'index') {
          ctx.addIssue({ code: 'custom', path: ['mode'], message: 'mode is only valid for action=index' });
        }
        if (input.query !== undefined && !['search', 'process_search', 'graph_search', 'incident_context', 'outcome_search', 'pattern_search'].includes(input.action)) {
          ctx.addIssue({ code: 'custom', path: ['query'], message: 'query is only valid for search actions' });
        }
        if (input.kinds !== undefined && input.action !== 'search') {
          ctx.addIssue({ code: 'custom', path: ['kinds'], message: 'kinds is only valid for action=search' });
        }
        if (input.limit !== undefined && !['search', 'process_search', 'graph_search', 'incident_context', 'outcome_search', 'pattern_search'].includes(input.action)) {
          ctx.addIssue({ code: 'custom', path: ['limit'], message: 'limit is only valid for search actions' });
        }
        if (['incident_context', 'outcome_search', 'pattern_search'].includes(input.action) && input.limit !== undefined && input.limit > 20) {
          ctx.addIssue({ code: 'custom', path: ['limit'], message: input.action + ' accepts at most 20 results' });
        }
        if (input.items !== undefined && ['search', 'process_search', 'graph_search', 'incident_context', 'outcome_search', 'pattern_search'].includes(input.action)) {
          ctx.addIssue({ code: 'custom', path: ['items'], message: 'items is not used for search actions' });
        }
        if (!['search', 'process_search', 'graph_search', 'incident_context', 'outcome_search', 'pattern_search'].includes(input.action) && input.items === undefined) {
          ctx.addIssue({ code: 'custom', path: ['items'], message: 'items is required for this action' });
        }
        if (input.action === 'index' && (input.items?.length ?? 0) > 16) {
          ctx.addIssue({ code: 'custom', path: ['items'], message: 'index accepts at most 16 sources' });
        }
        if (['search', 'process_search', 'graph_search', 'incident_context', 'outcome_search', 'pattern_search'].includes(input.action) && input.query === undefined) {
          ctx.addIssue({ code: 'custom', path: ['query'], message: 'query is required for search actions' });
        }
        if (['process_put', 'process_history', 'graph_expand', 'outcome_put', 'outcome_history', 'pattern_put', 'pattern_history'].includes(input.action) && input.items?.length !== 1) {
          ctx.addIssue({ code: 'custom', path: ['items'], message: input.action + ' requires exactly one item' });
        }
      }),
      // MCP annotations are optional individually. This mixed read/write surface only promises
      // the two invariants that hold for every action: calls may write local knowledge, but none
      // of them are destructive.
      annotations: { readOnlyHint: false, destructiveHint: false } as ToolAnnotations
    })),
    async input => {
      const run = async (): Promise<ToolResult> => {
      try {
        if (input.action === 'index') {
          const sources = input.items!.map(sourceToken);
          return result(await executor.index({
            scope: input.scope,
            sources,
            ...(input.mode ? { mode: input.mode } : {})
          }, reg.ctx.roots));
        }
        if (input.action === 'search') {
          return result(await executor.search({
            scope: input.scope,
            query: input.query!,
            ...(input.kinds ? { kinds: input.kinds } : {}),
            ...(input.limit ? { limit: input.limit } : {})
          }));
        }
        if (input.action === 'get') return result(await executor.get(input.scope, input.items!.map(evidenceId)));
        if (input.action === 'verify') {
          return result(await executor.verify({
            scope: input.scope,
            evidence: input.items!.map(evidenceReference)
          }, reg.ctx.roots));
        }
        if (input.action === 'process_put') {
          let parsed: unknown;
          try { parsed = JSON.parse(input.items![0]!); }
          catch { throw new Error('process_put item must be valid JSON.'); }
          return result(await executor.processPut(input.scope, parsed));
        }
        if (input.action === 'process_search') {
          return result(await executor.processSearch(input.scope, input.query!, input.limit));
        }
        if (input.action === 'process_get') {
          return result(await executor.processGet(input.scope, input.items!));
        }
        if (input.action === 'process_history') {
          return result(await executor.processHistory(input.scope, input.items![0]!));
        }
        if (input.action === 'graph_search') {
          return result(await executor.graphSearch(input.scope, input.query!, input.limit));
        }
        if (input.action === 'incident_context') {
          return result(await executor.incidentContext({
            scope: input.scope,
            query: input.query!,
            ...(input.limit ? { limit: input.limit } : {})
          }, reg.ctx.roots));
        }
        if (input.action === 'outcome_put') {
          let parsed: unknown;
          try { parsed = JSON.parse(input.items![0]!); }
          catch { throw new Error('outcome_put item must be valid JSON.'); }
          return result(await executor.outcomePut(input.scope, parsed));
        }
        if (input.action === 'outcome_search') {
          return result(await executor.outcomeSearch(input.scope, input.query!, input.limit));
        }
        if (input.action === 'outcome_get') {
          return result(await executor.outcomeGet(input.scope, input.items!));
        }
        if (input.action === 'outcome_history') {
          return result(await executor.outcomeHistory(input.scope, input.items![0]!));
        }
        if (input.action === 'pattern_put') {
          let parsed: unknown;
          try { parsed = JSON.parse(input.items![0]!); }
          catch { throw new Error('pattern_put item must be valid JSON.'); }
          return result(await executor.patternPut(input.scope, parsed));
        }
        if (input.action === 'pattern_search') {
          return result(await executor.patternSearch(input.scope, input.query!, input.limit));
        }
        if (input.action === 'pattern_get') {
          return result(await executor.patternGet(input.scope, input.items!));
        }
        if (input.action === 'pattern_history') {
          return result(await executor.patternHistory(input.items![0]!));
        }
        return result(await executor.graphExpand(input.scope, input.items![0]!));
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      };
      return input.action === 'process_put' || input.action === 'outcome_put' || input.action === 'pattern_put'
        ? reg.guarded('edit', 'knowledge', run)
        : reg.guarded('read', 'knowledge', run);
    }
  );
}
