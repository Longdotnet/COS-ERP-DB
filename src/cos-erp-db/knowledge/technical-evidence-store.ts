import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  IncidentTechnicalEvidenceRecord,
  IncidentTechnicalEvidenceScopeSnapshot
} from './contracts/incident-technical-evidence.js';

const STORE_VERSION = 1 as const;
const MAX_RECORDS_PER_SCOPE = 20_000;
let storeRoot = '';
const cache = new Map<string, IncidentTechnicalEvidenceScopeSnapshot>();
const mutationQueues = new Map<string, Promise<void>>();

const recordSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.string().min(1).max(120),
  incidentKey: z.string().min(1).max(160),
  kind: z.enum(['runtime_diagnosis', 'health_gate', 'deployment_fingerprint', 'deployment_compare', 'query_store', 'deadlocks', 'data_timeline', 'machine_validation']),
  role: z.enum(['observation', 'hypothesis', 'causal_verification', 'verification']),
  sourceAction: z.string().min(1).max(120),
  connection: z.string().max(64).nullable(),
  capturedAt: z.string().datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.unknown(),
  createdAt: z.string().datetime()
}).strict();

const snapshotSchema = z.object({
  version: z.literal(STORE_VERSION),
  scope: z.string().min(1).max(120),
  updatedAt: z.string().datetime(),
  records: z.array(recordSchema).max(MAX_RECORDS_PER_SCOPE)
}).strict();

function normalizedScope(scopeInput: string): string {
  const scope = scopeInput.trim();
  if (!scope || scope.length > 120 || /[\u0000-\u001f]/.test(scope)) {
    throw new Error('Incident technical-evidence scope must contain 1 to 120 visible characters.');
  }
  return scope;
}

function fileFor(scope: string): string {
  if (!storeRoot) throw new Error('Incident technical-evidence store is not initialized');
  const hash = createHash('sha256').update(scope, 'utf8').digest('hex');
  return path.join(storeRoot, `${hash}.json`);
}

export function initIncidentTechnicalEvidenceStore(userDataDir: string): void {
  storeRoot = path.join(userDataDir, 'incident-technical-evidence');
  cache.clear();
  mutationQueues.clear();
}

export async function readIncidentTechnicalEvidenceScope(scopeInput: string): Promise<IncidentTechnicalEvidenceScopeSnapshot> {
  const scope = normalizedScope(scopeInput);
  const existing = cache.get(scope);
  if (existing) return existing;
  let snapshot: IncidentTechnicalEvidenceScopeSnapshot;
  try {
    snapshot = snapshotSchema.parse(JSON.parse(await fs.readFile(fileFor(scope), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      snapshot = { version: STORE_VERSION, scope, updatedAt: new Date(0).toISOString(), records: [] };
    } else {
      throw new Error(`Incident technical-evidence scope could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (snapshot.scope !== scope) throw new Error('Incident technical-evidence scope file does not match the requested scope.');
  cache.set(scope, snapshot);
  return snapshot;
}

async function writeScope(snapshot: IncidentTechnicalEvidenceScopeSnapshot): Promise<void> {
  const parsed = snapshotSchema.parse(snapshot);
  const target = fileFor(parsed.scope);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(parsed)}\n`, 'utf8');
  await fs.rename(temp, target);
  cache.set(parsed.scope, parsed);
}

export function appendIncidentTechnicalEvidenceRecord(
  scopeInput: string,
  recordInput: IncidentTechnicalEvidenceRecord
): Promise<IncidentTechnicalEvidenceRecord> {
  const scope = normalizedScope(scopeInput);
  const record = recordSchema.parse(recordInput) as IncidentTechnicalEvidenceRecord;
  if (record.scope !== scope) throw new Error('Incident technical-evidence record scope does not match append scope.');
  const previous = mutationQueues.get(scope) ?? Promise.resolve();
  let resolveResult!: (value: IncidentTechnicalEvidenceRecord) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<IncidentTechnicalEvidenceRecord>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const run = previous.then(async () => {
    try {
      const current = await readIncidentTechnicalEvidenceScope(scope);
      const existing = current.records.find(item => item.id === record.id);
      if (existing) {
        const { createdAt: _existingCreatedAt, ...existingMaterial } = existing;
        const { createdAt: _candidateCreatedAt, ...candidateMaterial } = record;
        if (JSON.stringify(existingMaterial) !== JSON.stringify(candidateMaterial)) {
          throw new Error('Incident technical-evidence immutable record differs from the stored record.');
        }
        resolveResult(existing);
        return;
      }
      const next = snapshotSchema.parse({
        ...current,
        updatedAt: record.createdAt,
        records: [...current.records, record]
      });
      await writeScope(next);
      resolveResult(record);
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

export function resetIncidentTechnicalEvidenceStoreForTests(): void {
  storeRoot = '';
  cache.clear();
  mutationQueues.clear();
}
