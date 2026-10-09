import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BusinessProcessScopeSnapshot } from './contracts/business-process.js';

const STORE_VERSION = 1 as const;
const MAX_RECORDS_PER_SCOPE = 10_000;
const MAX_REVISIONS_PER_SCOPE = 50_000;
let processRoot = '';
const cache = new Map<string, BusinessProcessScopeSnapshot>();
const mutationQueues = new Map<string, Promise<void>>();

const evidenceSchema = z.object({
  evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  relation: z.enum(['supports', 'context', 'contradicts'])
}).strict();

const recordSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.string().min(1).max(120),
  key: z.string().min(1).max(160),
  kind: z.enum(['customer', 'process', 'solution', 'change_request', 'rule', 'expected_behavior']),
  title: z.string().min(1).max(512),
  statement: z.string().min(1).max(12_000),
  parentId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  parentKey: z.string().min(1).max(160).nullable(),
  status: z.enum(['draft', 'accepted', 'superseded']),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']),
  tags: z.array(z.string().min(1).max(80)).max(32),
  evidence: z.array(evidenceSchema).max(64),
  acceptanceNote: z.string().max(2_000).nullable(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

const snapshotSchema = z.object({
  version: z.literal(STORE_VERSION),
  scope: z.string().min(1).max(120),
  updatedAt: z.string().datetime(),
  records: z.array(recordSchema).max(MAX_RECORDS_PER_SCOPE),
  revisions: z.array(recordSchema).max(MAX_REVISIONS_PER_SCOPE)
}).strict();

function normalizeScope(scope: string): string {
  const value = scope.trim();
  if (!value || value.length > 120 || /[\u0000-]/.test(value)) {
    throw new Error('Business-process scope must contain 1 to 120 visible characters.');
  }
  return value;
}

function fileFor(scope: string): string {
  if (!processRoot) throw new Error('Business-process store is not initialized');
  const hash = createHash('sha256').update(normalizeScope(scope), 'utf8').digest('hex');
  return path.join(processRoot, hash + '.json');
}

export function initBusinessProcessStore(userDataDir: string): void {
  processRoot = path.join(userDataDir, 'business-process');
  cache.clear();
  mutationQueues.clear();
}

export async function readBusinessProcessScope(scopeInput: string): Promise<BusinessProcessScopeSnapshot> {
  const scope = normalizeScope(scopeInput);
  const cached = cache.get(scope);
  if (cached) return cached;
  const file = fileFor(scope);
  let snapshot: BusinessProcessScopeSnapshot;
  try {
    snapshot = snapshotSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      snapshot = {
        version: STORE_VERSION,
        scope,
        updatedAt: new Date(0).toISOString(),
        records: [],
        revisions: []
      };
    } else {
      throw new Error('Business-process scope could not be read: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (snapshot.scope !== scope) throw new Error('Business-process scope file does not match the requested scope.');
  cache.set(scope, snapshot);
  return snapshot;
}

async function writeScope(snapshot: BusinessProcessScopeSnapshot): Promise<void> {
  const parsed = snapshotSchema.parse(snapshot);
  const file = fileFor(parsed.scope);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(parsed) + '\n', 'utf8');
  await fs.rename(temp, file);
  cache.set(parsed.scope, parsed);
}

export function mutateBusinessProcessScope(
  scopeInput: string,
  mutate: (current: BusinessProcessScopeSnapshot) => Promise<BusinessProcessScopeSnapshot> | BusinessProcessScopeSnapshot
): Promise<BusinessProcessScopeSnapshot> {
  const scope = normalizeScope(scopeInput);
  const previous = mutationQueues.get(scope) ?? Promise.resolve();
  let resolveResult!: (value: BusinessProcessScopeSnapshot) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<BusinessProcessScopeSnapshot>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const run = previous.then(async () => {
    try {
      const current = await readBusinessProcessScope(scope);
      const next = snapshotSchema.parse(await mutate(current));
      if (next.scope !== scope) throw new Error('Business-process mutation changed scope identity.');
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

export function resetBusinessProcessStoreForTests(): void {
  processRoot = '';
  cache.clear();
  mutationQueues.clear();
}
