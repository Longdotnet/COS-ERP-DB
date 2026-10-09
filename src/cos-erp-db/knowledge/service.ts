import { promises as fs } from 'node:fs';
import type { Root } from '../../shared/types.js';
import type {
  KnowledgeEvidence,
  KnowledgeEvidenceKind,
  KnowledgeGetResult,
  KnowledgeIndexRequest,
  KnowledgeIndexResult,
  KnowledgeSearchHit,
  KnowledgeSearchResult,
  KnowledgeVerificationEntry,
  KnowledgeVerifyResult
} from './contracts/knowledge.js';
import { resolvePath } from '../../main/sandbox.js';
import { knowledgeSha256 } from './evidence.js';
import { currentDatabaseEvidenceSourceHash, indexKnowledgeDatabase } from './index-database.js';
import { indexKnowledgePath } from './index-source.js';
import { recordEngineeringPerformance } from '../engineering/performance.js';
import {
  MAX_KNOWLEDGE_CONTENT_BYTES_PER_SCOPE,
  MAX_KNOWLEDGE_EVIDENCE_PER_SCOPE,
  mutateKnowledgeScope,
  readKnowledgeScope
} from './store.js';

const DEFAULT_SEARCH_LIMIT = 12;
const MAX_SEARCH_LIMIT = 50;
const MAX_GET_IDS = 20;
const MAX_GET_BYTES = 64 * 1024;
const MAX_VERIFY_SOURCE_BYTES = 64 * 1024 * 1024;
const VERIFY_CONCURRENCY = 6;

interface PreparedSearchEntry {
  evidence: KnowledgeEvidence;
  title: string;
  locator: string;
  content: string;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

const preparedSearch = new Map<string, { generation: string; entries: PreparedSearchEntry[] }>();

function normalizeScope(scope: string): string {
  const value = scope.trim();
  if (!value || value.length > 120 || /[\u0000-\u001f]/.test(value)) {
    throw new Error('Knowledge scope must contain 1 to 120 visible characters.');
  }
  return value;
}

function normalizeQuery(query: string): string {
  const value = query.trim();
  if (!value || value.length > 1000) throw new Error('Knowledge search query must contain 1 to 1000 characters.');
  return value;
}

function lower(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('vi-VN');
}

function tokens(query: string): string[] {
  return [...new Set(lower(query).match(/[\p{L}\p{N}_.$-]+/gu) ?? [])].filter(token => token.length >= 2).slice(0, 24);
}

function generationFor(scope: string, evidence: readonly KnowledgeEvidence[]): string {
  const parts = evidence
    .map(item => item.id + ':' + item.contentHash + ':' + item.sourceHash)
    .sort((a, b) => a.localeCompare(b));
  return knowledgeSha256('knowledge:v1\u0000' + scope + '\u0000' + parts.join('\n'));
}

function sourceResultsLimitations(results: Array<{ limitations: string[] }>): string[] {
  return [...new Set(results.flatMap(result => result.limitations))].slice(0, 200);
}

export async function indexKnowledge(
  request: KnowledgeIndexRequest,
  roots: readonly Root[],
  options: { reuseUnchangedFiles?: boolean } = {}
): Promise<KnowledgeIndexResult> {
  const started = performance.now();
  const scope = normalizeScope(request.scope);
  if (!Array.isArray(request.sources) || request.sources.length < 1 || request.sources.length > 16) {
    throw new Error('Knowledge indexing requires 1 to 16 sources.');
  }
  const previous = options.reuseUnchangedFiles === true && (request.mode ?? 'incremental') === 'incremental'
    ? await readKnowledgeScope(scope)
    : null;
  const indexed = [];
  for (const source of request.sources) {
    if (source.kind === 'database') indexed.push(await indexKnowledgeDatabase(scope, source.connection));
    else indexed.push(await indexKnowledgePath(scope, source.kind, source.path, roots, previous?.evidence ?? []));
  }
  const bySourceKey = new Map(indexed.map(result => [result.sourceKey, result]));
  const replacements = new Set(bySourceKey.keys());
  const newEvidence = [...bySourceKey.values()].flatMap(result => result.evidence);
  if (newEvidence.length > MAX_KNOWLEDGE_EVIDENCE_PER_SCOPE) {
    throw new Error('Knowledge index exceeds the per-scope evidence limit.');
  }

  let counts = { evidence: 0, added: 0, updated: 0, removed: 0 };
  let exactNoop = false;
  const indexedAt = new Date().toISOString();
  const snapshot = await mutateKnowledgeScope(scope, current => {
    const before = new Map(current.evidence.map(item => [item.id, item]));
    const base = (request.mode ?? 'incremental') === 'refresh'
      ? []
      : current.evidence.filter(item => !replacements.has(item.sourceKey));
    const merged = new Map<string, KnowledgeEvidence>();
    for (const item of [...base, ...newEvidence]) merged.set(item.id, item);
    const evidence = [...merged.values()];
    if (evidence.length > MAX_KNOWLEDGE_EVIDENCE_PER_SCOPE) {
      throw new Error('Knowledge index exceeds the per-scope evidence limit.');
    }
    const contentBytes = evidence.reduce((sum, item) => sum + Buffer.byteLength(item.content, 'utf8'), 0);
    if (contentBytes > MAX_KNOWLEDGE_CONTENT_BYTES_PER_SCOPE) {
      throw new Error('Knowledge index exceeds the per-scope content budget.');
    }
    const after = new Map(evidence.map(item => [item.id, item]));
    let added = 0;
    let updated = 0;
    let removed = 0;
    for (const [id, item] of after) {
      const previous = before.get(id);
      if (!previous) added += 1;
      else if (previous.contentHash !== item.contentHash || previous.sourceHash !== item.sourceHash) updated += 1;
    }
    for (const id of before.keys()) if (!after.has(id)) removed += 1;
    counts = { evidence: evidence.length, added, updated, removed };
    exactNoop = (request.mode ?? 'incremental') === 'incremental'
      && evidence.length === current.evidence.length
      && evidence.every(item => before.get(item.id) === item)
      && current.evidence.every(item => after.get(item.id) === item);
    if (exactNoop) return current;
    return {
      version: 1,
      scope,
      generation: generationFor(scope, evidence),
      updatedAt: indexedAt,
      evidence
    };
  });
  if (!exactNoop) preparedSearch.delete(scope);

  const telemetry = [...bySourceKey.values()].reduce((total, item) => {
    const stats = 'telemetry' in item ? item.telemetry : null;
    if (stats) for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += stats[key];
    return total;
  }, { filesDiscovered: 0, filesProcessed: 0, filesRead: 0, filesReused: 0, sourceBytesProcessed: 0, sourceHashesComputed: 0, documentsExtracted: 0 });
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  recordEngineeringPerformance('knowledge.index', elapsedMs, {
    ...telemetry, sources: request.sources.length, evidence: counts.evidence,
    changed: counts.added + counts.updated + counts.removed
  }, request.sources.some(source => source.kind === 'database') ? 'database'
    : request.sources.some(source => source.kind === 'document') ? 'document'
    : scope.startsWith('engineering-reference-') ? 'reference'
    : scope.startsWith('engineering-') ? 'current' : 'other');
  return {
    scope,
    generation: snapshot.generation,
    indexedAt,
    counts,
    sources: [...bySourceKey.values()].map(result => ({
      kind: result.kind,
      sourceKey: result.sourceKey,
      evidenceCount: result.evidence.length,
      limitations: result.limitations
    })),
    limitations: sourceResultsLimitations([...bySourceKey.values()]),
    elapsedMs,
    telemetry
  };
}

function preparedEntries(scope: string, generation: string, evidence: readonly KnowledgeEvidence[]): PreparedSearchEntry[] {
  const cached = preparedSearch.get(scope);
  if (cached?.generation === generation) return cached.entries;
  const entries = evidence.map(item => ({
    evidence: item,
    title: lower(item.title),
    locator: lower(JSON.stringify(item.locator)),
    content: lower(item.content)
  }));
  preparedSearch.set(scope, { generation, entries });
  return entries;
}

function scoreEntry(entry: PreparedSearchEntry, phrase: string, queryTokens: readonly string[]): number {
  let score = 0;
  if (entry.title.includes(phrase)) score += 30;
  if (entry.locator.includes(phrase)) score += 24;
  if (entry.content.includes(phrase)) score += 15;
  for (const token of queryTokens) {
    if (entry.title.includes(token)) score += 8;
    if (entry.locator.includes(token)) score += 6;
    if (entry.content.includes(token)) score += 3;
  }
  return score;
}

function snippetFor(content: string, normalizedContent: string, phrase: string, queryTokens: readonly string[]): string {
  let index = normalizedContent.indexOf(phrase);
  if (index < 0) {
    for (const token of queryTokens) {
      index = normalizedContent.indexOf(token);
      if (index >= 0) break;
    }
  }
  if (index < 0) index = 0;
  const start = Math.max(0, index - 300);
  const end = Math.min(content.length, start + 1_400);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return prefix + content.slice(start, end).trim() + suffix;
}

export async function searchKnowledge(input: {
  scope: string;
  query: string;
  kinds?: KnowledgeEvidenceKind[];
  limit?: number;
}): Promise<KnowledgeSearchResult> {
  const started = performance.now();
  const scope = normalizeScope(input.scope);
  const query = normalizeQuery(input.query);
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new Error('Knowledge search limit must be between 1 and ' + MAX_SEARCH_LIMIT + '.');
  }
  const allowed = input.kinds?.length ? new Set(input.kinds) : null;
  const snapshot = await readKnowledgeScope(scope);
  const phrase = lower(query);
  const queryTokens = tokens(query);
  const matches: Array<{ entry: PreparedSearchEntry; score: number }> = [];
  for (const entry of preparedEntries(scope, snapshot.generation, snapshot.evidence)) {
    if (allowed && !allowed.has(entry.evidence.kind)) continue;
    const score = scoreEntry(entry, phrase, queryTokens);
    if (score > 0) matches.push({ entry, score });
  }
  matches.sort((left, right) =>
    right.score - left.score ||
    left.entry.evidence.title.localeCompare(right.entry.evidence.title) ||
    left.entry.evidence.id.localeCompare(right.entry.evidence.id));
  const hits: KnowledgeSearchHit[] = matches.slice(0, limit).map(({ entry, score }) => ({
    evidenceId: entry.evidence.id,
    kind: entry.evidence.kind,
    title: entry.evidence.title,
    locator: entry.evidence.locator,
    snippet: snippetFor(entry.evidence.content, entry.content, phrase, queryTokens),
    contentHash: entry.evidence.contentHash,
    sourceHash: entry.evidence.sourceHash,
    capturedAt: entry.evidence.capturedAt,
    score
  }));
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  recordEngineeringPerformance('knowledge.search', elapsedMs, { scannedEvidence: snapshot.evidence.length, totalMatches: matches.length });
  return {
    scope,
    generation: snapshot.generation,
    query,
    hits,
    totalMatches: matches.length,
    truncated: matches.length > hits.length,
    elapsedMs
  };
}

export async function getKnowledgeEvidence(scopeInput: string, ids: readonly string[]): Promise<KnowledgeGetResult> {
  const scope = normalizeScope(scopeInput);
  if (!ids.length || ids.length > MAX_GET_IDS) throw new Error('Knowledge get requires 1 to ' + MAX_GET_IDS + ' evidence ids.');
  const snapshot = await readKnowledgeScope(scope);
  const wanted = new Set(ids);
  const found = new Map(snapshot.evidence.filter(item => wanted.has(item.id)).map(item => [item.id, item]));
  const evidence: KnowledgeEvidence[] = [];
  let bytes = 0;
  let truncated = false;
  for (const id of ids) {
    const item = found.get(id);
    if (!item) continue;
    const cost = Buffer.byteLength(item.content, 'utf8');
    if (bytes + cost > MAX_GET_BYTES) {
      truncated = true;
      break;
    }
    evidence.push(item);
    bytes += cost;
  }
  const returned = new Set(evidence.map(item => item.id));
  return {
    scope,
    generation: snapshot.generation,
    evidence,
    missingIds: ids.filter(id => !found.has(id)),
    truncated: truncated || [...found.keys()].some(id => !returned.has(id))
  };
}

async function currentFileHash(evidence: KnowledgeEvidence, roots: readonly Root[]): Promise<string> {
  const requestedPath = evidence.locator.path;
  if (!requestedPath) throw new Error('Indexed file evidence has no path locator.');
  const resolved = await resolvePath(roots, requestedPath);
  const stat = await fs.stat(resolved.real);
  if (!stat.isFile()) throw new Error('Indexed source is no longer a regular file.');
  if (stat.size > MAX_VERIFY_SOURCE_BYTES) throw new Error('Indexed source is too large for bounded verification.');
  return knowledgeSha256(await fs.readFile(resolved.real));
}

export async function verifyKnowledgeEvidence(input: {
  scope: string;
  evidence: Array<{ evidenceId: string; contentHash?: string }>;
}, roots: readonly Root[]): Promise<KnowledgeVerifyResult> {
  const started = performance.now();
  const scope = normalizeScope(input.scope);
  if (!input.evidence.length || input.evidence.length > MAX_GET_IDS) {
    throw new Error('Knowledge verify requires 1 to ' + MAX_GET_IDS + ' evidence references.');
  }
  const snapshot = await readKnowledgeScope(scope);
  const indexed = new Map(snapshot.evidence.map(item => [item.id, item]));
  const results = await mapWithConcurrency(input.evidence, VERIFY_CONCURRENCY, async requested => {
    const evidence = indexed.get(requested.evidenceId);
    if (!evidence) {
      return {
        evidenceId: requested.evidenceId,
        status: 'missing',
        expectedContentHash: requested.contentHash ?? null,
        indexedContentHash: null,
        currentSourceHash: null,
        detail: 'Evidence id is not present in the current scope generation.'
      } satisfies KnowledgeVerificationEntry;
    }
    if (requested.contentHash && requested.contentHash !== evidence.contentHash) {
      return {
        evidenceId: evidence.id,
        status: 'hash-mismatch',
        expectedContentHash: requested.contentHash,
        indexedContentHash: evidence.contentHash,
        currentSourceHash: null,
        detail: 'The indexed evidence changed after the caller obtained its hash.'
      } satisfies KnowledgeVerificationEntry;
    }
    try {
      const currentSourceHash = evidence.kind === 'database'
        ? await currentDatabaseEvidenceSourceHash(evidence.locator)
        : await currentFileHash(evidence, roots);
      if (currentSourceHash === null) {
        return {
          evidenceId: evidence.id,
          status: 'stale',
          expectedContentHash: requested.contentHash ?? null,
          indexedContentHash: evidence.contentHash,
          currentSourceHash: null,
          detail: 'The indexed source no longer resolves to the same database object.'
        } satisfies KnowledgeVerificationEntry;
      }
      if (currentSourceHash === evidence.sourceHash) {
        return {
          evidenceId: evidence.id,
          status: 'current',
          expectedContentHash: requested.contentHash ?? null,
          indexedContentHash: evidence.contentHash,
          currentSourceHash,
          detail: 'Source hash still matches the indexed evidence.'
        } satisfies KnowledgeVerificationEntry;
      }
      return {
        evidenceId: evidence.id,
        status: 'stale',
        expectedContentHash: requested.contentHash ?? null,
        indexedContentHash: evidence.contentHash,
        currentSourceHash,
        detail: 'Source content changed after this evidence was indexed.'
      } satisfies KnowledgeVerificationEntry;
    } catch (error) {
      return {
        evidenceId: evidence.id,
        status: 'unavailable',
        expectedContentHash: requested.contentHash ?? null,
        indexedContentHash: evidence.contentHash,
        currentSourceHash: null,
        detail: error instanceof Error ? error.message : String(error)
      } satisfies KnowledgeVerificationEntry;
    }
  });
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  recordEngineeringPerformance('knowledge.verify', elapsedMs, {
    references: input.evidence.length,
    current: results.filter(item => item.status === 'current').length
  });
  return {
    scope,
    generation: snapshot.generation,
    verifiedAt: new Date().toISOString(),
    allCurrent: results.every(result => result.status === 'current'),
    evidence: results,
    elapsedMs
  };
}

export function resetKnowledgeSearchCacheForTests(): void {
  preparedSearch.clear();
}
