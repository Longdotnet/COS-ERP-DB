import { z } from 'zod';
import type {
  BusinessProcessEvidenceRef,
  BusinessProcessEvidenceState,
  BusinessProcessGetResult,
  BusinessProcessHistoryResult,
  BusinessProcessPutResult,
  BusinessProcessRecord,
  BusinessProcessRecordInput,
  BusinessProcessRecordKind,
  BusinessProcessSearchHit,
  BusinessProcessSearchResult
} from './contracts/business-process.js';
import { knowledgeSha256 } from './evidence.js';
import { mutateBusinessProcessScope, readBusinessProcessScope } from './process-store.js';
import { readKnowledgeScope } from './store.js';

const MAX_SEARCH_RESULTS = 50;
const MAX_REVISIONS_PER_SCOPE = 50_000;

const evidenceInputSchema = z.object({
  evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  relation: z.enum(['supports', 'context', 'contradicts']).default('supports')
}).strict();

const inputSchema = z.object({
  key: z.string().trim().min(1).max(160),
  kind: z.enum(['customer', 'process', 'solution', 'change_request', 'rule', 'expected_behavior']),
  title: z.string().trim().min(1).max(512),
  statement: z.string().trim().min(1).max(12_000),
  parentKey: z.string().trim().min(1).max(160).nullable().optional(),
  status: z.enum(['draft', 'accepted', 'superseded']).default('draft'),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']).default('unknown'),
  tags: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
  evidence: z.array(evidenceInputSchema).max(64).default([]),
  acceptanceNote: z.string().trim().max(2_000).nullable().optional()
}).strict();

const ALLOWED_PARENT: Record<BusinessProcessRecordKind, readonly BusinessProcessRecordKind[]> = {
  customer: [],
  process: ['customer'],
  solution: ['process'],
  change_request: ['process'],
  rule: ['process', 'solution', 'change_request'],
  expected_behavior: ['rule']
};

function normalizeScope(scope: string): string {
  const value = scope.trim();
  if (!value || value.length > 120 || /[\u0000-]/.test(value)) {
    throw new Error('Business-process scope must contain 1 to 120 visible characters.');
  }
  return value;
}

function normalizedKey(key: string): string {
  return key.trim().toLocaleLowerCase('en-US');
}

function recordId(scope: string, key: string): string {
  return knowledgeSha256('business-process:v1\u0000' + scope + '\u0000' + normalizedKey(key));
}

function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const value = raw.trim();
    const key = value.toLocaleLowerCase('vi-VN');
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function dedupeEvidence(evidence: readonly BusinessProcessEvidenceRef[]): BusinessProcessEvidenceRef[] {
  const seen = new Set<string>();
  const result: BusinessProcessEvidenceRef[] = [];
  for (const item of evidence) {
    const key = item.evidenceId + ':' + item.contentHash + ':' + item.relation;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

async function validateEvidence(scope: string, evidence: readonly BusinessProcessEvidenceRef[]): Promise<void> {
  if (!evidence.length) return;
  const snapshot = await readKnowledgeScope(scope);
  const indexed = new Map(snapshot.evidence.map(item => [item.id, item]));
  for (const reference of evidence) {
    const found = indexed.get(reference.evidenceId);
    if (!found) throw new Error('Business-process evidence is missing from the current knowledge scope: ' + reference.evidenceId);
    if (found.contentHash !== reference.contentHash) {
      throw new Error('Business-process evidence hash no longer matches the indexed evidence: ' + reference.evidenceId);
    }
  }
}

function materialShape(record: BusinessProcessRecord): unknown {
  return {
    kind: record.kind,
    title: record.title,
    statement: record.statement,
    parentKey: record.parentKey,
    status: record.status,
    confidence: record.confidence,
    tags: record.tags,
    evidence: record.evidence,
    acceptanceNote: record.acceptanceNote
  };
}

export async function putBusinessProcessRecord(
  scopeInput: string,
  rawInput: unknown
): Promise<BusinessProcessPutResult> {
  const scope = normalizeScope(scopeInput);
  const parsed = inputSchema.parse(rawInput) as BusinessProcessRecordInput & {
    status: BusinessProcessRecord['status'];
    confidence: BusinessProcessRecord['confidence'];
    tags: string[];
    evidence: BusinessProcessEvidenceRef[];
  };
  const key = parsed.key.trim();
  const parentKey = parsed.parentKey?.trim() || null;
  const evidence = dedupeEvidence(parsed.evidence);
  const tags = dedupeTags(parsed.tags);
  const acceptanceNote = parsed.acceptanceNote?.trim() || null;
  if (parsed.status === 'accepted' && !evidence.some(item => item.relation === 'supports') && !acceptanceNote) {
    throw new Error('Accepted business-process records require supporting evidence or an acceptanceNote.');
  }
  await validateEvidence(scope, evidence);

  let changed = false;
  let output!: BusinessProcessRecord;
  await mutateBusinessProcessScope(scope, current => {
    const byKey = new Map(current.records.map(record => [normalizedKey(record.key), record]));
    const existing = byKey.get(normalizedKey(key));
    if (existing && existing.kind !== parsed.kind) {
      throw new Error('Business-process key already exists with kind=' + existing.kind + '.');
    }
    const parent = parentKey ? byKey.get(normalizedKey(parentKey)) : undefined;
    const allowedParents = ALLOWED_PARENT[parsed.kind];
    if (allowedParents.length === 0 && parentKey) {
      throw new Error(parsed.kind + ' records cannot have a parent.');
    }
    if (allowedParents.length > 0) {
      if (!parent) throw new Error(parsed.kind + ' requires an existing parent record.');
      if (!allowedParents.includes(parent.kind)) {
        throw new Error(parsed.kind + ' parent must be one of: ' + allowedParents.join(', ') + '.');
      }
    }
    const now = new Date().toISOString();
    const candidate: BusinessProcessRecord = {
      id: existing?.id ?? recordId(scope, key),
      scope,
      key,
      kind: parsed.kind,
      title: parsed.title.trim(),
      statement: parsed.statement.trim(),
      parentId: parent?.id ?? null,
      parentKey: parent?.key ?? null,
      status: parsed.status,
      confidence: parsed.confidence,
      tags,
      evidence,
      acceptanceNote,
      revision: existing?.revision ?? 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: existing?.updatedAt ?? now
    };
    if (existing && JSON.stringify(materialShape(existing)) === JSON.stringify(materialShape(candidate))) {
      output = existing;
      return current;
    }
    changed = true;
    candidate.revision = (existing?.revision ?? 0) + 1;
    candidate.updatedAt = now;
    const records = existing
      ? current.records.map(record => record.id === existing.id ? candidate : record)
      : [...current.records, candidate];
    const revisions = [...current.revisions, candidate].slice(-MAX_REVISIONS_PER_SCOPE);
    output = candidate;
    return {
      version: 1,
      scope,
      updatedAt: now,
      records,
      revisions
    };
  });
  return { scope, changed, record: output };
}

async function evidenceState(scope: string, evidence: readonly BusinessProcessEvidenceRef[]): Promise<BusinessProcessEvidenceState[]> {
  if (!evidence.length) return [];
  const snapshot = await readKnowledgeScope(scope);
  const indexed = new Map(snapshot.evidence.map(item => [item.id, item]));
  return evidence.map(reference => {
    const found = indexed.get(reference.evidenceId);
    return {
      evidenceId: reference.evidenceId,
      status: !found ? 'missing' as const : found.contentHash === reference.contentHash ? 'indexed' as const : 'hash-mismatch' as const
    };
  });
}

function normalizedSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('vi-VN');
}

function score(record: BusinessProcessRecord, query: string): number {
  const phrase = normalizedSearch(query);
  const tokens = [...new Set(phrase.match(/[\p{L}\p{N}_.$-]+/gu) ?? [])].filter(token => token.length >= 2).slice(0, 24);
  const title = normalizedSearch(record.title);
  const key = normalizedSearch(record.key);
  const statement = normalizedSearch(record.statement);
  const tags = normalizedSearch(record.tags.join(' '));
  let result = 0;
  if (key.includes(phrase)) result += 40;
  if (title.includes(phrase)) result += 30;
  if (statement.includes(phrase)) result += 16;
  if (tags.includes(phrase)) result += 12;
  for (const token of tokens) {
    if (key.includes(token)) result += 8;
    if (title.includes(token)) result += 6;
    if (statement.includes(token)) result += 3;
    if (tags.includes(token)) result += 2;
  }
  return result;
}

export async function searchBusinessProcessRecords(
  scopeInput: string,
  queryInput: string,
  limit = 20
): Promise<BusinessProcessSearchResult> {
  const scope = normalizeScope(scopeInput);
  const query = queryInput.trim();
  if (!query || query.length > 1000) throw new Error('Business-process search query must contain 1 to 1000 characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
    throw new Error('Business-process search limit must be between 1 and ' + MAX_SEARCH_RESULTS + '.');
  }
  const snapshot = await readBusinessProcessScope(scope);
  const matches = snapshot.records
    .map(record => ({ record, score: score(record, query) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.record.key.localeCompare(right.record.key));
  const selected = matches.slice(0, limit);
  const hits: BusinessProcessSearchHit[] = await Promise.all(selected.map(async item => ({
    record: item.record,
    score: item.score,
    evidenceState: await evidenceState(scope, item.record.evidence)
  })));
  return { scope, query, hits, totalMatches: matches.length, truncated: matches.length > hits.length };
}

export async function getBusinessProcessRecords(
  scopeInput: string,
  keys: readonly string[]
): Promise<BusinessProcessGetResult> {
  const scope = normalizeScope(scopeInput);
  if (!keys.length || keys.length > 20) throw new Error('Business-process get requires 1 to 20 keys.');
  const snapshot = await readBusinessProcessScope(scope);
  const byKey = new Map(snapshot.records.map(record => [normalizedKey(record.key), record]));
  const records = [];
  const missingKeys: string[] = [];
  for (const key of keys) {
    const record = byKey.get(normalizedKey(key));
    if (!record) {
      missingKeys.push(key);
      continue;
    }
    records.push({ record, evidenceState: await evidenceState(scope, record.evidence) });
  }
  return { scope, records, missingKeys };
}

export async function getBusinessProcessHistory(
  scopeInput: string,
  keyInput: string
): Promise<BusinessProcessHistoryResult> {
  const scope = normalizeScope(scopeInput);
  const key = keyInput.trim();
  if (!key) throw new Error('Business-process history requires a key.');
  const snapshot = await readBusinessProcessScope(scope);
  const id = recordId(scope, key);
  const revisions = snapshot.revisions
    .filter(record => record.id === id)
    .sort((left, right) => left.revision - right.revision);
  return { scope, key, revisions };
}
