import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { IncidentPatternStoreSnapshot } from './contracts/incident-pattern.js';

const STORE_VERSION = 1 as const;
const MAX_PATTERNS = 5_000;
const MAX_REVISIONS = 25_000;
const MAX_OCCURRENCES_PER_PATTERN = 256;
let storeFile = '';
let cache: IncidentPatternStoreSnapshot | null = null;
let mutationQueue = Promise.resolve();

const evidenceSchema = z.object({
  evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  relation: z.enum(['supports', 'context', 'contradicts'])
}).strict();

const occurrenceSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  sourceScope: z.string().min(1).max(120),
  outcomeKey: z.string().min(1).max(160).nullable().optional(),
  incidentKey: z.string().min(1).max(160),
  processKey: z.string().min(1).max(160),
  expectedBehaviorKey: z.string().min(1).max(160),
  rootCauseCategory: z.string().min(1).max(160).nullable().default(null),
  rootCauseSignature: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  independenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  evidence: z.array(evidenceSchema).min(1).max(64),
  note: z.string().max(2_000).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

const patternSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  key: z.string().min(1).max(160),
  title: z.string().min(1).max(512),
  symptom: z.string().min(1).max(4_000),
  finding: z.string().min(1).max(8_000),
  rootCauseCategory: z.string().min(1).max(160).nullable().default(null),
  rootCauseSignature: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  recommendedChecks: z.array(z.string().min(1).max(1_000)).min(1).max(24),
  tags: z.array(z.string().min(1).max(80)).max(32),
  status: z.enum(['candidate', 'promoted']),
  supportingScopeCount: z.number().int().min(0).max(MAX_OCCURRENCES_PER_PATTERN),
  independentSupportingCount: z.number().int().min(0).max(MAX_OCCURRENCES_PER_PATTERN).default(0),
  occurrences: z.array(occurrenceSchema).max(MAX_OCCURRENCES_PER_PATTERN),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

const snapshotSchema = z.object({
  version: z.literal(STORE_VERSION),
  updatedAt: z.string().datetime(),
  patterns: z.array(patternSchema).max(MAX_PATTERNS),
  revisions: z.array(patternSchema).max(MAX_REVISIONS)
}).strict();

function emptySnapshot(): IncidentPatternStoreSnapshot {
  return { version: STORE_VERSION, updatedAt: new Date(0).toISOString(), patterns: [], revisions: [] };
}

export function initIncidentPatternStore(userDataDir: string): void {
  storeFile = path.join(userDataDir, 'incident-patterns', 'patterns.json');
  cache = null;
  mutationQueue = Promise.resolve();
}

export async function readIncidentPatternStore(): Promise<IncidentPatternStoreSnapshot> {
  if (!storeFile) throw new Error('Incident-pattern store is not initialized');
  if (cache) return cache;
  try {
    cache = snapshotSchema.parse(JSON.parse(await fs.readFile(storeFile, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') cache = emptySnapshot();
    else throw new Error('Incident-pattern store could not be read: ' + (error instanceof Error ? error.message : String(error)));
  }
  return cache;
}

async function writeStore(snapshot: IncidentPatternStoreSnapshot): Promise<void> {
  const parsed = snapshotSchema.parse(snapshot);
  await fs.mkdir(path.dirname(storeFile), { recursive: true });
  const temp = storeFile + '.tmp';
  await fs.writeFile(temp, JSON.stringify(parsed) + '\n', 'utf8');
  await fs.rename(temp, storeFile);
  cache = parsed;
}

export function mutateIncidentPatternStore(
  mutate: (current: IncidentPatternStoreSnapshot) => IncidentPatternStoreSnapshot | Promise<IncidentPatternStoreSnapshot>
): Promise<IncidentPatternStoreSnapshot> {
  let resolveResult!: (value: IncidentPatternStoreSnapshot) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<IncidentPatternStoreSnapshot>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  mutationQueue = mutationQueue.then(async () => {
    try {
      const next = snapshotSchema.parse(await mutate(await readIncidentPatternStore()));
      await writeStore(next);
      resolveResult(next);
    } catch (error) {
      rejectResult(error);
    }
  }, async () => {
    try {
      const next = snapshotSchema.parse(await mutate(await readIncidentPatternStore()));
      await writeStore(next);
      resolveResult(next);
    } catch (error) {
      rejectResult(error);
    }
  });
  return result;
}

export function resetIncidentPatternStoreForTests(): void {
  storeFile = '';
  cache = null;
  mutationQueue = Promise.resolve();
}
