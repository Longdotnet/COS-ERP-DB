import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { KnowledgeScopeSnapshot } from './contracts/knowledge.js';

const STORE_VERSION = 1 as const;
export const MAX_KNOWLEDGE_EVIDENCE_PER_SCOPE = 30_000;
export const MAX_KNOWLEDGE_CONTENT_BYTES_PER_SCOPE = 96 * 1024 * 1024;
const MAX_EVIDENCE_CONTENT_CHARS = 12_000;
let knowledgeRoot = '';
const cache = new Map<string, KnowledgeScopeSnapshot>();
const mutationQueues = new Map<string, Promise<void>>();

const locatorSchema = z.object({
  path: z.string().min(1).max(4096).optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  part: z.string().min(1).max(512).optional(),
  connection: z.string().min(1).max(64).optional(),
  database: z.string().max(256).optional(),
  databaseOrigin: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  objectId: z.number().int().positive().optional(),
  objectType: z.string().min(1).max(64).optional(),
  schema: z.string().min(1).max(256).optional(),
  name: z.string().min(1).max(256).optional()
}).strict();

const evidenceSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.string().min(1).max(120),
  kind: z.enum(['source', 'document', 'database']),
  sourceKey: z.string().min(1).max(5000),
  title: z.string().min(1).max(512),
  content: z.string().max(MAX_EVIDENCE_CONTENT_CHARS),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: z.string().datetime(),
    locator: locatorSchema,
    sourceSize: z.number().int().nonnegative().nullable(),
    sourceMtimeMs: z.number().finite().nonnegative().nullable(),
    sourceCtimeMs: z.number().finite().nonnegative().nullable().optional()
}).strict();

const snapshotSchema = z.object({
  version: z.literal(STORE_VERSION),
  scope: z.string().min(1).max(120),
  generation: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string().datetime(),
  evidence: z.array(evidenceSchema).max(MAX_KNOWLEDGE_EVIDENCE_PER_SCOPE)
}).strict();

function normalizedScope(scope: string): string {
  const value = scope.trim();
  if (!value || value.length > 120 || /[\u0000-\u001f]/.test(value)) {
    throw new Error('Knowledge scope must contain 1 to 120 visible characters.');
  }
  return value;
}

function assertInitialized(): string {
  if (!knowledgeRoot) throw new Error('Knowledge store is not initialized');
  return knowledgeRoot;
}

function scopeFile(scope: string): string {
  const root = assertInitialized();
  const key = createHash('sha256').update(normalizedScope(scope), 'utf8').digest('hex');
  return path.join(root, `${key}.json`);
}

function emptyGeneration(scope: string): string {
  return createHash('sha256').update(`knowledge:v1:\0${scope}\0`, 'utf8').digest('hex');
}

export function initKnowledgeStore(userDataDir: string): void {
  knowledgeRoot = path.join(userDataDir, 'knowledge');
  cache.clear();
  mutationQueues.clear();
}

export async function readKnowledgeScope(scope: string): Promise<KnowledgeScopeSnapshot> {
  const canonical = normalizedScope(scope);
  const cached = cache.get(canonical);
  if (cached) return cached;
  const file = scopeFile(canonical);
  let snapshot: KnowledgeScopeSnapshot;
  try {
    snapshot = snapshotSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      snapshot = {
        version: STORE_VERSION,
        scope: canonical,
        generation: emptyGeneration(canonical),
        updatedAt: new Date(0).toISOString(),
        evidence: []
      };
    } else {
      throw new Error(`Knowledge scope "${canonical}" could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (snapshot.scope !== canonical) throw new Error('Knowledge scope file does not match the requested scope.');
  cache.set(canonical, snapshot);
  return snapshot;
}

async function writeKnowledgeScope(snapshot: KnowledgeScopeSnapshot): Promise<void> {
  const parsed = snapshotSchema.parse(snapshot);
  const file = scopeFile(parsed.scope);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(parsed)}\n`, 'utf8');
  await fs.rename(temp, file);
  cache.set(parsed.scope, parsed);
}

export function mutateKnowledgeScope(
  scope: string,
  mutation: (current: KnowledgeScopeSnapshot) => Promise<KnowledgeScopeSnapshot> | KnowledgeScopeSnapshot
): Promise<KnowledgeScopeSnapshot> {
  const canonical = normalizedScope(scope);
  const previous = mutationQueues.get(canonical) ?? Promise.resolve();
  let resolveResult!: (value: KnowledgeScopeSnapshot) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<KnowledgeScopeSnapshot>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const run = previous.then(async () => {
    try {
      const current = await readKnowledgeScope(canonical);
      const proposed = await mutation(current);
      if (proposed === current) {
        resolveResult(current);
        return;
      }
      const next = snapshotSchema.parse(proposed);
      if (next.scope !== canonical) throw new Error('Knowledge mutation changed scope identity.');
      await writeKnowledgeScope(next);
      resolveResult(next);
    } catch (error) {
      rejectResult(error);
    }
  });
  const tracked = run.then(() => undefined, () => undefined);
  mutationQueues.set(canonical, tracked);
  void tracked.finally(() => {
    if (mutationQueues.get(canonical) === tracked) mutationQueues.delete(canonical);
  });
  return result;
}

export function resetKnowledgeStoreForTests(): void {
  knowledgeRoot = '';
  cache.clear();
  mutationQueues.clear();
}
