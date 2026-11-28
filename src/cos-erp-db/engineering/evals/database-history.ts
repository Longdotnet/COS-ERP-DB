import { z } from 'zod';
import { eventTokens, foldProgress, type SessionEvent, type SessionSummary } from '../../../shared/session.js';
import { listSessionPage, readRecentEvents, getSession } from '../../../main/session/store.js';

const MAX_EVENTS = 350;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const cursorSchema = z.object({ updatedAt: z.number().int().nonnegative(), id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i) }).strict();
const runSchema = z.object({ sessionId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i), turnId: z.string().min(1).max(160) }).strict();
export const databaseHistoryBenchmarkSchema = z.object({
  scope: z.enum(['project','all-recorded']),
  limit: z.number().int().min(1).max(25).default(10),
  cursor: cursorSchema.optional(),
  compare: z.object({ baseline: runSchema, candidate: runSchema }).strict().optional()
}).strict().superRefine((input, ctx) => {
  if (input.compare && input.cursor) ctx.addIssue({ code: 'custom', path: ['cursor'], message: 'Cannot page and compare in the same call.' });
});
type Input = z.infer<typeof databaseHistoryBenchmarkSchema>;
type Store = { list: typeof listSessionPage; events: typeof readRecentEvents; get: typeof getSession };
const defaultStore: Store = { list: listSessionPage, events: readRecentEvents, get: getSession };

const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu,'').replace(/đ/gi,'d').toLowerCase();
export const DATABASE_BENCHMARK_CASES = [
  { id: 'noibo-timekeeping', pattern: /cham\s*cong|chamcong|sp_rptchamcong/, expected: 'Report/form configuration and actual permission path' },
  { id: 'bankhub', pattern: /bankhub|bank\s*code|so_tk_nhan|erp_client_id|\bbidv\b/, expected: 'Trace account mapping, configuration, voucher scope and customer database' },
  { id: 'electronic-invoice', pattern: /hoa\s*don\s*dien\s*tu|hddt|sp_printhddt|type_id_vat/, expected: 'Check stored procedure, actual schema and runtime failure evidence' },
  { id: 'crm-migration', pattern: /\bcrm\b|crm6|frmhopdong|l08hopdong|ma_loaihd|hop\s*dong/, expected: 'Compare legacy/current business metadata and physical schema' },
  { id: 'tax-lookup', pattern: /baseurl_get_mst|tra\s*cuu\s*mst|tra\s*cuu\s*ma\s*so\s*thue/, expected: 'Verify parameter and source fallback' }
] as const;

function caseIds(text: string): string[] {
  const plain = normalize(text);
  return DATABASE_BENCHMARK_CASES.filter(c => c.pattern.test(plain)).map(c => c.id);
}
const isDatabaseCall = (tool: string) => /^(?:database|runtime_debug)$/.test(tool) || /(?:^|__)database$/.test(tool);
const unique = <T>(values: T[]) => [...new Set(values)];

function turnMetrics(events: SessionEvent[], turnId: string) {
  const own = foldProgress(events.filter(e => e.turnId === turnId));
  const start = own.filter(e => e.kind === 'turn_start').sort((a,b) => a.seq-b.seq)[0];
  const end = own.filter(e => e.kind === 'turn_end').sort((a,b) => b.seq-a.seq)[0];
  if (end?.kind !== 'turn_end' || end.outcome !== 'completed' || end.continued || !start || end.seq <= start.seq || end.time < start.time) return null;
  const interval = own.filter(e => e.time >= start.time && e.time <= end.time);
  const questions = own.filter(e => e.kind === 'user_message' && e.seq < end.seq);
  const cases = unique(questions.flatMap(e => e.kind === 'user_message' ? caseIds(e.authoredText ?? e.message.text ?? '') : []));
  const calls = interval.flatMap(e => e.kind === 'tool_call' ? [e.call] : []);
  const top = calls.filter(c => !c.nested);
  const databaseCalls = calls.filter(c => isDatabaseCall(c.tool));
  if (!databaseCalls.length || !cases.length) return null;
  const observedModels = unique([...interval.flatMap(e => e.model ? [e.model] : []), ...calls.flatMap(c => c.model ? [c.model] : [])]);
  const observedEfforts = unique([...interval.flatMap(e => e.reasoningEffort ? [e.reasoningEffort] : []), ...calls.flatMap(c => c.reasoningEffort ? [c.reasoningEffort] : [])]);
  const metrics = {
    modelToolCalls: top.length,
    recordedNestedCalls: calls.length - top.length,
    databaseCalls: databaseCalls.length,
    unsuccessfulDatabaseCalls: databaseCalls.filter(c => c.outcome !== 'ok').length,
    elapsedMs: end.time - start.time,
    databaseToolDurationMs: databaseCalls.reduce((total,c) => total + Math.max(0,c.durationMs || 0),0),
    estimatedLocalTokens: interval.reduce((sum,e) => sum + eventTokens(e),0)
  };
  return { turnId, cases, startedAt: start.time, endedAt: end.time, models: observedModels, reasoningEfforts: observedEfforts, metrics };
}
type Run = NonNullable<ReturnType<typeof turnMetrics>>;

export function analyzeDatabaseHistory(summary: SessionSummary, events: SessionEvent[]) {
  const turns = unique(events.flatMap(e => e.turnId ? [e.turnId] : []));
  const runs = turns.flatMap(id => { const metrics = turnMetrics(events,id); return metrics ? [metrics] : []; });
  const candidates = unique([...caseIds(summary.title), ...events.flatMap(e => e.kind === 'user_message' ? caseIds(e.authoredText ?? e.message.text ?? '') : [])]);
  const databaseEvents = foldProgress(events).flatMap(e => e.kind === 'tool_call' && isDatabaseCall(e.call.tool) ? [e] : []);
  if (!databaseEvents.length) return null;
  // Tool-only/unattributed journals still provide operational evidence, but cannot
  // be assigned to a case or used for turn-level before/after comparisons.
  const databaseActivity = {
    observedCalls: databaseEvents.length,
    withoutTurnId: databaseEvents.filter(e => !e.turnId).length,
    unsuccessfulCalls: databaseEvents.filter(e => e.call.outcome !== 'ok').length,
    recordedToolDurationMs: databaseEvents.reduce((sum,e) => sum + Math.max(0,e.call.durationMs || 0),0)
  };
  return {
    sessionId: summary.id, updatedAt: summary.updatedAt, cases: candidates,
    sessionMetrics: { recordedToolCalls: summary.toolCalls, estimatedLocalTokens: summary.estimatedTokens, errors: summary.errors, toolRejected: summary.toolRejected },
    databaseActivity,
    runs: runs.slice(0, 12),
    coverage: { recordedEvents: summary.events, scannedEvents: events.length, boundedWindow: true, runListTruncated: runs.length > 12 }
  };
}

function compareRuns(baseline: Run, candidate: Run) {
  const sharedCases = baseline.cases.filter(id => candidate.cases.includes(id));
  const sameModel = baseline.models.length === 1 && candidate.models.length === 1 && baseline.models[0] === candidate.models[0];
  const sameEffort = baseline.reasoningEfforts.length === 1 && candidate.reasoningEfforts.length === 1 && baseline.reasoningEfforts[0] === candidate.reasoningEfforts[0];
  const metrics = Object.fromEntries(Object.entries(candidate.metrics).map(([key, value]) => {
    const previous = baseline.metrics[key as keyof Run['metrics']];
    return [key, { baseline: previous, candidate: value, delta: value - previous }];
  }));
  return { baseline, candidate, sharedCases, sameObservedModel: sameModel, sameObservedReasoning: sameEffort,
    comparability: sharedCases.length && sameModel && sameEffort ? 'same-observed-case-family-model-effort' : 'not-controlled',
    metrics, limitations: ['Historical runs may differ in input, database state, source revision or agent configuration; differences are descriptive, not causal.', 'Correctness requires a verified expected result or human-reviewed outcome; no score is inferred from tool success.'] };
}

export async function collectDatabaseHistoryBenchmark(input: Input, projectId: string | null, store: Store = defaultStore) {
  if (input.scope === 'project' && !projectId) throw new Error('Bind the current session to a project or explicitly request all-recorded scope.');
  const eventsFor = (id: string) => store.events(id, MAX_EVENTS, {
    kinds: ['user_message','assistant_message','turn_start','turn_end','tool_call'], maxBytes: MAX_EVENT_BYTES
  });
  const inScope = (summary: SessionSummary) => (input.scope === 'all-recorded' || summary.projectId === projectId) &&
    summary.origin?.kind !== 'helper' && summary.origin?.kind !== 'worker';
  if (input.compare) {
    const load = async (ref: z.infer<typeof runSchema>) => {
      const summary = await store.get(ref.sessionId);
      if (!summary || !inScope(summary)) throw new Error('Benchmark session unavailable in requested scope.');
      const run = turnMetrics(await eventsFor(summary.id), ref.turnId);
      if (!run) throw new Error('Requested turn is not a completed identifiable database case in the bounded recording window.');
      return run;
    };
    const [baseline,candidate] = await Promise.all([load(input.compare.baseline),load(input.compare.candidate)]);
    return { scope: input.scope, comparison: compareRuns(baseline,candidate) };
  }
  const page = await store.list({ limit: input.limit, cursor: input.cursor, ...(input.scope === 'project' ? { projectId: projectId! } : {}) });
  const matches = [];
  let unavailable = 0;
  for (const summary of page.sessions.filter(inScope)) {
    // Summaries are the cheap first filter. Avoid opening a journal for chats without any tool calls.
    if (!summary.toolCalls) continue;
    try {
      const analyzed = analyzeDatabaseHistory(summary, await eventsFor(summary.id));
      if (analyzed) matches.push(analyzed);
    } catch { unavailable++; }
  }
  return {
    scope: input.scope, projectId: input.scope === 'project' ? projectId : null, scannedSessions: page.sessions.length,
    unavailableSessions: unavailable, matchedSessions: matches.filter(m => m.cases.length).length,
    databaseActivitySessions: matches.length, matches, nextCursor: page.nextCursor,
    caseCatalog: DATABASE_BENCHMARK_CASES.map(({ id, expected }) => ({ id, expected })),
    limitations: ['No raw chat text or tool payloads are returned. Worker/helper sessions are excluded; worker effort is not included in primary-session metrics.',
      'Each session is sampled from its latest bounded recording window. Missing turns are not negative evidence; paginate sessions using nextCursor.',
      'Tokens are local estimates, not provider usage. Tool duration may overlap. Case labels are text matches and require review before controlled replay.',
      'Correctness, before/after causality and source revision equivalence cannot be inferred from historical metrics.']
  };
}
