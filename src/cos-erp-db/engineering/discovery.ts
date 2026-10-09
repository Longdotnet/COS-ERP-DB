import type { Root } from '../../shared/types.js';
import path from 'node:path';
import { indexKnowledge, searchKnowledge, verifyKnowledgeEvidence } from '../knowledge/service.js';
import type { EngineeringConventionDiscoveryResult } from './contracts.js';
import { engineeringKnowledgeScope, type ResolvedEngineeringLineage } from './lineage.js';

const MIN_ANALOGUES = 3;
const MAX_SEARCH_HITS = 50;
const IMPLEMENTATION_EXTENSIONS = new Set([
  '.cs', '.vb', '.fs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sql', '.ps1', '.sh', '.py', '.go', '.java', '.kt', '.kts',
  '.csproj', '.fsproj', '.vbproj', '.props', '.targets'
]);

function implementationKey(candidate: { evidenceId: string; locator: unknown }): string {
  const locator = candidate.locator as { path?: unknown } | null;
  const path = typeof locator?.path === 'string' ? locator.path.trim() : '';
  return path
    ? path.replace(/\\/g, '/').toLocaleLowerCase('en-US')
    : `evidence:${candidate.evidenceId}`;
}

function isImplementationCandidate(candidate: { locator: unknown }): boolean {
  const locator = candidate.locator as { path?: unknown } | null;
  const candidatePath = typeof locator?.path === 'string' ? locator.path : '';
  return IMPLEMENTATION_EXTENSIONS.has(path.extname(candidatePath).toLocaleLowerCase('en-US'));
}

export async function discoverEngineeringAnalogues(
  resolved: ResolvedEngineeringLineage,
  queryInput: string,
  roots: readonly Root[],
  limit = 7
): Promise<EngineeringConventionDiscoveryResult> {
  return discoverEngineeringAnaloguesInScope(
    resolved,
    resolved.workspace.virtual,
    engineeringKnowledgeScope(resolved.lineage),
    queryInput,
    roots,
    limit,
    'older project binding'
  );
}

export async function discoverEngineeringAnaloguesInScope(
  resolved: ResolvedEngineeringLineage,
  workspaceVirtual: string,
  scope: string,
  queryInput: string,
  roots: readonly Root[],
  limit = 7,
  staleBindingLabel = 'older project binding'
): Promise<EngineeringConventionDiscoveryResult> {
  const query = queryInput.trim();
  if (!query || query.length > 1000) throw new Error('Engineering discovery query must contain 1 to 1000 characters.');
  if (!Number.isInteger(limit) || limit < MIN_ANALOGUES || limit > 7) throw new Error('Engineering discovery limit must be between 3 and 7.');
  const indexed = await indexKnowledge({
    scope,
    sources: [{ kind: 'source', path: workspaceVirtual }],
    mode: 'incremental'
  }, roots, { reuseUnchangedFiles: true });
  // Knowledge is chunked, so a narrow search can otherwise return several chunks from one
  // large file and make "7 candidates" look like 7 independent implementations. Search a
  // bounded wider window, then keep only the best-scoring hit from each source file. Verify
  // those file-level candidates before selection as a project may be rebound through a new
  // virtual root while older evidence remains in the same durable Engineering scope.
  const searched = await searchKnowledge({ scope, query, kinds: ['source'], limit: MAX_SEARCH_HITS });
  const byImplementation = new Map<string, (typeof searched.hits)[number]>();
  for (const hit of searched.hits) {
    if (!isImplementationCandidate(hit)) continue;
    const key = implementationKey(hit);
    if (!byImplementation.has(key)) byImplementation.set(key, hit);
  }
  const implementationCandidates = [...byImplementation.values()];
  const currentEvidenceIds = new Set<string>();
  for (let offset = 0; offset < implementationCandidates.length; offset += 20) {
    const batch = implementationCandidates.slice(offset, offset + 20);
    const verified = await verifyKnowledgeEvidence({
      scope,
      evidence: batch.map(hit => ({ evidenceId: hit.evidenceId, contentHash: hit.contentHash }))
    }, roots);
    for (const item of verified.evidence) {
      if (item.status === 'current') currentEvidenceIds.add(item.evidenceId);
    }
  }
  const distinct = new Map<string, (typeof searched.hits)[number]>();
  const seenSourceHashes = new Set<string>();
  for (const hit of implementationCandidates) {
    if (!currentEvidenceIds.has(hit.evidenceId)) continue;
    const key = implementationKey(hit);
    if (!distinct.has(key) && !seenSourceHashes.has(hit.sourceHash)) {
      distinct.set(key, hit);
      seenSourceHashes.add(hit.sourceHash);
    }
    if (distinct.size >= limit) break;
  }
  const candidates = [...distinct.values()];
  const limitations = [...new Set(indexed.limitations)];
  const ignoredStale = implementationCandidates.length - currentEvidenceIds.size;
  if (ignoredStale > 0) {
    limitations.push(`Ignored ${ignoredStale} stale or unavailable implementation source(s) from an ${staleBindingLabel}.`);
  }
  if (candidates.length < MIN_ANALOGUES) {
    limitations.push(`Only ${candidates.length} distinct implementation source(s) matched; engineering discovery targets at least ${MIN_ANALOGUES}.`);
  }
  return {
    lineage: resolved.lineage,
    knowledgeScope: scope,
    query,
    candidates: candidates.map(hit => ({
      evidenceId: hit.evidenceId,
      contentHash: hit.contentHash,
      sourceHash: hit.sourceHash,
      capturedAt: hit.capturedAt,
      title: hit.title,
      locator: hit.locator as Record<string, unknown>,
      snippet: hit.snippet,
      score: hit.score
    })),
    coverage: {
      minimum: MIN_ANALOGUES,
      requested: limit,
      distinctImplementations: candidates.length,
      targetMet: candidates.length >= MIN_ANALOGUES
    },
    limitations
  };
}
