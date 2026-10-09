import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { IncidentOutcomeScopeSnapshot } from './contracts/incident-outcome.js';

const STORE_VERSION = 1 as const;
const MAX_OUTCOMES_PER_SCOPE = 10_000;
const MAX_REVISIONS_PER_SCOPE = 50_000;
let outcomeRoot = '';
const cache = new Map<string, IncidentOutcomeScopeSnapshot>();
const mutationQueues = new Map<string, Promise<void>>();

const evidenceSchema = z.object({
  evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  relation: z.enum(['supports', 'context', 'contradicts'])
}).strict();

const technicalEvidenceSchema = z.object({
  evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

const validationSchema = z.object({
  result: z.enum(['pending', 'passed', 'failed']),
  summary: z.string().min(1).max(4_000),
  evidence: z.array(evidenceSchema).max(64)
}).strict();

const outcomeSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.string().min(1).max(120),
  key: z.string().min(1).max(160),
  incidentKey: z.string().min(1).max(160),
  title: z.string().min(1).max(512),
  symptom: z.string().min(1).max(4_000),
  processKey: z.string().min(1).max(160),
  expectedBehaviorKey: z.string().min(1).max(160),
  rootCauseCategory: z.string().min(1).max(160),
  finding: z.string().min(1).max(8_000),
  remediation: z.string().min(1).max(8_000),
  incidentClass: z.enum(['logic_correctness', 'performance', 'deployment', 'data', 'concurrency']).nullable().default(null),
  evidence: z.array(evidenceSchema).max(64),
  deploymentEvidence: z.array(evidenceSchema).max(64),
  runtimeEvidence: z.array(evidenceSchema).max(64),
  technicalEvidence: z.array(technicalEvidenceSchema).max(64).default([]),
  validation: validationSchema,
  status: z.enum(['draft', 'accepted', 'invalidated']),
  decisionNote: z.string().max(2_000).nullable(),
  tags: z.array(z.string().min(1).max(80)).max(32),
  revision: z.number().int().positive(),
  acceptedAt: z.string().datetime().nullable(),
  invalidatedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

const snapshotSchema = z.object({
  version: z.literal(STORE_VERSION),
  scope: z.string().min(1).max(120),
  updatedAt: z.string().datetime(),
  outcomes: z.array(outcomeSchema).max(MAX_OUTCOMES_PER_SCOPE),
  revisions: z.array(outcomeSchema).max(MAX_REVISIONS_PER_SCOPE)
}).strict();

function normalizeScope(scope: string): string {
  const value = scope.trim();
  if (!value || value.length > 120 || /[\u0000-\u001f]/.test(value)) {
    throw new Error('Incident-outcome scope must contain 1 to 120 visible characters.');
  }
  return value;
}

function fileFor(scope: string): string {
  if (!outcomeRoot) throw new Error('Incident-outcome store is not initialized');
  const hash = createHash('sha256').update(normalizeScope(scope), 'utf8').digest('hex');
  return path.join(outcomeRoot, hash + '.json');
}

export function initIncidentOutcomeStore(userDataDir: string): void {
  outcomeRoot = path.join(userDataDir, 'incident-outcomes');
  cache.clear();
  mutationQueues.clear();
}

export async function readIncidentOutcomeScope(scopeInput: string): Promise<IncidentOutcomeScopeSnapshot> {
  const scope = normalizeScope(scopeInput);
  const cached = cache.get(scope);
  if (cached) return cached;
  let snapshot: IncidentOutcomeScopeSnapshot;
  try {
    snapshot = snapshotSchema.parse(JSON.parse(await fs.readFile(fileFor(scope), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      snapshot = { version: STORE_VERSION, scope, updatedAt: new Date(0).toISOString(), outcomes: [], revisions: [] };
    } else {
      throw new Error('Incident-outcome scope could not be read: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (snapshot.scope !== scope) throw new Error('Incident-outcome scope file does not match the requested scope.');
  cache.set(scope, snapshot);
  return snapshot;
}

async function writeScope(snapshot: IncidentOutcomeScopeSnapshot): Promise<void> {
  const parsed = snapshotSchema.parse(snapshot);
  const file = fileFor(parsed.scope);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(parsed) + '\n', 'utf8');
  await fs.rename(temp, file);
  cache.set(parsed.scope, parsed);
}

export function mutateIncidentOutcomeScope(
  scopeInput: string,
  mutate: (current: IncidentOutcomeScopeSnapshot) => IncidentOutcomeScopeSnapshot | Promise<IncidentOutcomeScopeSnapshot>
): Promise<IncidentOutcomeScopeSnapshot> {
  const scope = normalizeScope(scopeInput);
  const previous = mutationQueues.get(scope) ?? Promise.resolve();
  let resolveResult!: (value: IncidentOutcomeScopeSnapshot) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<IncidentOutcomeScopeSnapshot>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const run = previous.then(async () => {
    try {
      const next = snapshotSchema.parse(await mutate(await readIncidentOutcomeScope(scope)));
      if (next.scope !== scope) throw new Error('Incident-outcome mutation changed scope identity.');
      await writeScope(next);
      resolveResult(next);
    } catch (error) {
      rejectResult(error);
    }
  });
  const tracked = run.then(() => undefined, () => undefined);
  mutationQueues.set(scope, tracked);
  void tracked.finally(() => {
    if (mutationQueues.get(scope) === tracked) mutationQueues.delete(scope);
  });
  return result;
}

export function resetIncidentOutcomeStoreForTests(): void {
  outcomeRoot = '';
  cache.clear();
  mutationQueues.clear();
}
