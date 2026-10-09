import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Observation only. Never used as evidence, authorization, or a quality-gate input. */
export interface EngineeringPerformancePhase {
  name: string;
  elapsedMs: number;
  metrics: Record<string, number>;
  /** A non-secret stable work category, e.g. 'current' or 'reference', not a file path. */
  category: string | null;
}

interface EngineeringPerformanceInvocation {
  taskKey: string;
  action: string;
  revision: number | null;
  startedAt: string;
  elapsedMs: number;
  success: boolean;
  phases: EngineeringPerformancePhase[];
}

interface RunningInvocation {
  phases: EngineeringPerformancePhase[];
}

const active = new AsyncLocalStorage<RunningInvocation>();
const queues = new Map<string, Promise<void>>();
const MAX_INVOCATIONS = 150;
const MAX_PHASES_PER_INVOCATION = 80;
let performanceRoot = '';

export function initEngineeringPerformance(userDataDir: string): void {
  performanceRoot = path.join(userDataDir, 'engineering', 'performance');
  queues.clear();
}

function performanceFile(lineageKey: string): string {
  if (!performanceRoot) throw new Error('Engineering performance store is not initialized');
  if (!/^[a-f0-9]{64}$/.test(lineageKey)) throw new Error('Invalid Engineering lineage key');
  return path.join(performanceRoot, lineageKey + '.json');
}

function finiteCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

export function recordEngineeringPerformance(
  name: string,
  elapsedMs: number,
  metrics: Record<string, number> = {},
  category: string | null = null
): void {
  const invocation = active.getStore();
  if (!invocation || invocation.phases.length >= MAX_PHASES_PER_INVOCATION) return;
  const safeMetrics = Object.fromEntries(
    Object.entries(metrics).slice(0, 16).filter(([key]) => /^[a-zA-Z][a-zA-Z0-9_]{0,60}$/.test(key))
      .map(([key, value]) => [key, finiteCount(value)])
  );
  invocation.phases.push({
    name: name.slice(0, 80),
    elapsedMs: finiteCount(elapsedMs),
    metrics: safeMetrics,
    category: category?.slice(0, 80) ?? null
  });
}

export async function measureEngineeringPhase<T>(name: string, operation: () => Promise<T>, category: string | null = null): Promise<T> {
  const start = performance.now();
  try {
    return await operation();
  } finally {
    recordEngineeringPerformance(name, performance.now() - start, {}, category);
  }
}

async function appendPerformance(lineageKey: string, entry: EngineeringPerformanceInvocation): Promise<void> {
  const file = performanceFile(lineageKey);
  const prior = queues.get(lineageKey) ?? Promise.resolve();
  const write = prior.then(async () => {
    let records: EngineeringPerformanceInvocation[] = [];
    try {
      const loaded: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Array.isArray(loaded)) records = loaded as EngineeringPerformanceInvocation[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const next = [...records, entry].slice(-MAX_INVOCATIONS);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(next) + '\n', 'utf8');
    await fs.rename(temporary, file);
  });
  queues.set(lineageKey, write.catch(() => undefined));
  await write;
}

export async function observeEngineeringInvocation<T>(
  lineageKey: string,
  taskKey: string,
  action: string,
  operation: () => Promise<T>,
  extractRevision?: (value: T) => number | null
): Promise<T> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const context: RunningInvocation = { phases: [] };
  let success = false;
  let revision: number | null = null;
  try {
    return await active.run(context, async () => {
      const value = await operation();
      success = !(value && typeof value === 'object' && 'isError' in value && value.isError === true);
      try { revision = extractRevision?.(value) ?? null; } catch { /* telemetry only */ }
      return value;
    });
  } finally {
    try {
      await appendPerformance(lineageKey, {
        taskKey: taskKey.slice(0, 160),
        action: action.slice(0, 80),
        revision,
        startedAt,
        elapsedMs: finiteCount(performance.now() - start),
        success,
        phases: context.phases
      });
    } catch {
      // Telemetry must never change command verification, task state, or quality-gate results.
    }
  }
}

export async function getEngineeringPerformance(lineageKey: string, taskKey: string, limit = 30) {
  let all: EngineeringPerformanceInvocation[] = [];
  let readLimitation: string | null = null;
  try {
    const loaded: unknown = JSON.parse(await fs.readFile(performanceFile(lineageKey), 'utf8'));
    if (Array.isArray(loaded)) all = loaded as EngineeringPerformanceInvocation[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      readLimitation = 'Performance history is unreadable; telemetry is advisory and cannot affect task correctness.';
    }
  }
  const matching = all.filter(item => item && item.taskKey === taskKey && Array.isArray(item.phases))
    .slice(-Math.min(100, Math.max(1, limit)));
  const byPhase = new Map<string, { count: number; elapsedMs: number; metrics: Record<string, number> }>();
  for (const invocation of matching) {
    for (const phase of invocation.phases) {
      const old = byPhase.get(phase.name) ?? { count: 0, elapsedMs: 0, metrics: {} };
      old.count++;
      old.elapsedMs += phase.elapsedMs;
      for (const [key, value] of Object.entries(phase.metrics)) old.metrics[key] = (old.metrics[key] ?? 0) + value;
      byPhase.set(phase.name, old);
    }
  }
  return {
    lineageKey,
    taskKey,
    observedInvocationCount: matching.length,
    observedInvocationMs: matching.reduce((sum, item) => sum + item.elapsedMs, 0),
    unchangedIndexCalls: matching.flatMap(item => item.phases).filter(item =>
      item.name === 'knowledge.index' && item.metrics.changed === 0).length,
    indexedSourceBytes: matching.flatMap(item => item.phases).filter(item => item.name === 'knowledge.index')
      .reduce((sum, item) => sum + (item.metrics.sourceBytesProcessed ?? 0), 0),
    phases: [...byPhase.entries()].map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.elapsedMs - a.elapsedMs),
    invocations: matching,
    limitations: [
      ...(readLimitation ? [readLimitation] : []),
      'Only instrumented COS Engineering/Knowledge calls are measured; model thinking, browser wait, generic file reads, and unrelated worker time are not observed.',
      'Nested phase durations overlap parent phases; observedInvocationMs sums individual call durations and is not end-to-end agent wall time.',
      'unchangedIndexCalls means the indexed evidence generation was unchanged; it is not proof a freshness check was unnecessary.',
      'Index statistics report files processed and source bytes, not operating-system physical disk IO.'
    ]
  };
}
