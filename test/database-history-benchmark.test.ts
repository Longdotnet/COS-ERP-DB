import { expect, it, vi } from 'vitest';
import { analyzeDatabaseHistory, collectDatabaseHistoryBenchmark, databaseHistoryBenchmarkSchema } from '../src/cos-erp-db/engineering/evals/database-history.js';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';

const text = (value: string) => ({ text: value, chars: value.length, truncated: false });
function summary(id: string, projectId = 'project-a') {
  return { id, projectId, title: 'Bảng chấm công', updatedAt: 5000, events: 20, toolCalls: 4, estimatedTokens: 300, errors: 1, toolRejected: 1 } as SessionSummary;
}
function events(turnId = 'turn-a', toolCount = 2): SessionEvent[] {
  const base = { source: 'mcp', turnId, model: 'gpt-x', reasoningEffort: 'high' };
  const question = { ...base, kind: 'user_message', seq: 1, time: 999, authoredText: 'Kiểm tra CHAMCONG07', message: text('secret raw text') };
  const start = { ...base, kind: 'turn_start', seq: 2, time: 1000 };
  const calls = Array.from({ length: toolCount }, (_,i) => ({
    ...base, kind: 'tool_call', seq: i + 3, time: 1200 + i,
    call: { callId: 'call-' + i, tool: 'database', args: text('private sql'), result: text('private data'), outcome: i === 0 ? 'ok' : 'tool_rejected', durationMs: 40, summary: { title: 'db read' } }
  }));
  const end = { ...base, kind: 'turn_end', seq: toolCount + 4, time: 2000, outcome: 'completed' };
  return [question,start,...calls,...(calls.length ? [{ ...calls[0], seq: toolCount + 3 }] : []),end] as unknown as SessionEvent[];
}
it('counts unique recorded database calls and exposes no raw messages or SQL', () => {
  const result = analyzeDatabaseHistory(summary('session-a'),events())!;
  expect(result.runs[0]?.metrics).toMatchObject({ databaseCalls: 2, modelToolCalls: 2, unsuccessfulDatabaseCalls: 1, elapsedMs: 1000 });
  expect(JSON.stringify(result)).not.toMatch(/private sql|private data|secret raw text/);
});
it('retains database-only journals as operational evidence without inventing case or turn attribution', () => {
  const orphan = events().filter(e => e.kind === 'tool_call').map(e => ({ ...e, turnId: undefined }));
  const result = analyzeDatabaseHistory({ ...summary('session-x'), title: 'Unattributed' }, orphan)!;
  expect(result).toMatchObject({ cases: [], runs: [], databaseActivity: { observedCalls: 2, withoutTurnId: 2, unsuccessfulCalls: 1 } });
});
it('does not scan other projects for project scope, compares explicit runs, and returns a continuation cursor', async () => {
  const a = summary('session-a'), b = summary('session-b'), outside = summary('session-c','other');
  const store = {
    list: vi.fn(async () => ({ sessions: [a,outside], total: 3, nextCursor: { id: 'session-c', updatedAt: 5000 } })),
    events: vi.fn(async (id: string) => id === a.id ? events('turn-a',2) : events('turn-b',1)),
    get: vi.fn(async (id: string) => [a,b,outside].find(s => s.id === id) ?? null)
  };
  const page = await collectDatabaseHistoryBenchmark(databaseHistoryBenchmarkSchema.parse({ scope: 'project' }),'project-a',store);
  expect(page).toMatchObject({ matchedSessions: 1, nextCursor: { id: 'session-c' } });
  expect(store.events).toHaveBeenCalledTimes(1);
  const compare = await collectDatabaseHistoryBenchmark(databaseHistoryBenchmarkSchema.parse({
    scope: 'project', compare: { baseline: { sessionId: a.id, turnId: 'turn-a' }, candidate: { sessionId: b.id, turnId: 'turn-b' } }
  }),'project-a',store);
  expect(compare).toMatchObject({ comparison: { sameObservedModel: true, sameObservedReasoning: true, metrics: { databaseCalls: { baseline: 2, candidate: 1, delta: -1 } } } });
  await expect(collectDatabaseHistoryBenchmark(databaseHistoryBenchmarkSchema.parse({ scope: 'project' }),null,store)).rejects.toThrow('Bind');
});

// Opt-in, local acceptance only. Snapshot journal/metadata, do not open attachments
// or allow store reconciliation to write to the running app's history.
it.skipIf(!process.env.COS_HISTORY_BENCHMARK_PROFILE)('measures retained real recordings without exporting transcript content', async () => {
  const profile = process.env.COS_HISTORY_BENCHMARK_PROFILE!;
  const source = path.join(profile, 'sessions');
  const snapshot = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-history-benchmark-'));
  try {
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-z-]{8,64}$/i.test(entry.name)) continue;
      const from = path.join(source, entry.name);
      const to = path.join(snapshot, 'sessions', entry.name);
      await fs.mkdir(to, { recursive: true });
      for (const name of ['meta.json','meta.backup.json','events.jsonl','messages.json','messages']) {
        try { await fs.cp(path.join(from,name),path.join(to,name),{ recursive: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    initSessionStore(snapshot);
    const page = await collectDatabaseHistoryBenchmark(databaseHistoryBenchmarkSchema.parse({ scope: 'all-recorded', limit: 25 }),null);
    if (!('matches' in page) || !page.matches) throw new Error('Missing benchmark page');
    const matches = page.matches;
    console.log('HISTORY_BENCHMARK_AGGREGATE', JSON.stringify({
      scanned: page.scannedSessions, matched: page.matchedSessions, databaseActivitySessions: page.databaseActivitySessions, unavailable: page.unavailableSessions,
      observedDatabaseCalls: matches.reduce((n,m) => n + m.databaseActivity.observedCalls,0),
      unattributedDatabaseCalls: matches.reduce((n,m) => n + m.databaseActivity.withoutTurnId,0),
      completedRuns: matches.reduce((n,m) => n + m.runs.length,0),
      databaseCalls: matches.flatMap(m => m.runs).reduce((n,r) => n + r.metrics.databaseCalls,0),
      caseCounts: Object.fromEntries([...new Set(matches.flatMap(m => m.cases))].map(id => [id,matches.filter(m => m.cases.includes(id)).length])),
      more: !!page.nextCursor
    }));
    expect(page.scannedSessions).toBeGreaterThan(0);
  } finally {
    resetSessionStoreForTests();
    await fs.rm(snapshot,{ recursive: true, force: true });
  }
}, 120_000);
