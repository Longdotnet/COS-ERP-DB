import type { BusinessProcessRecord } from './contracts/business-process.js';
import type { Root } from '../../shared/types.js';
import { expandImplementationGraph, searchImplementationGraph } from './graph-service.js';
import { readBusinessProcessScope } from './process-store.js';
import { searchBusinessProcessRecords } from './process-service.js';
import { searchIncidentOutcomes } from './outcome-service.js';
import { searchIncidentPatterns } from './pattern-service.js';
import { searchKnowledge, verifyKnowledgeEvidence } from './service.js';

const DEFAULT_CONTEXT_LIMIT = 8;
const MAX_CONTEXT_LIMIT = 20;
const MAX_CONTEXT_RECORDS = 64;
const MAX_VERIFY_EVIDENCE = 20;

function normalized(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('vi-VN');
}

function selectProcessContext(
  records: readonly BusinessProcessRecord[],
  seedKeys: readonly string[]
): BusinessProcessRecord[] {
  const byKey = new Map(records.map(record => [normalized(record.key), record]));
  const children = new Map<string, BusinessProcessRecord[]>();
  for (const record of records) {
    if (!record.parentKey) continue;
    const key = normalized(record.parentKey);
    const list = children.get(key) ?? [];
    list.push(record);
    children.set(key, list);
  }

  const selected = new Set<string>();
  for (const seedKey of seedKeys) {
    let current = byKey.get(normalized(seedKey));
    while (current && selected.size < MAX_CONTEXT_RECORDS) {
      selected.add(normalized(current.key));
      current = current.parentKey ? byKey.get(normalized(current.parentKey)) : undefined;
    }
  }

  const queue = [...selected];
  while (queue.length && selected.size < MAX_CONTEXT_RECORDS) {
    const parent = queue.shift()!;
    for (const child of children.get(parent) ?? []) {
      const childKey = normalized(child.key);
      if (selected.has(childKey)) continue;
      selected.add(childKey);
      queue.push(childKey);
      if (selected.size >= MAX_CONTEXT_RECORDS) break;
    }
  }

  return records.filter(record => selected.has(normalized(record.key))).slice(0, MAX_CONTEXT_RECORDS);
}

export async function readIncidentContext(
  scopeInput: string,
  queryInput: string,
  roots: readonly Root[],
  limit = DEFAULT_CONTEXT_LIMIT
) {
  const startedAt = performance.now();
  const scope = scopeInput.trim();
  const query = queryInput.trim();
  if (!scope || scope.length > 120) throw new Error('Incident context scope must contain 1 to 120 characters.');
  if (!query || query.length > 1000) throw new Error('Incident context query must contain 1 to 1000 characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTEXT_LIMIT) {
    throw new Error('Incident context limit must be between 1 and ' + MAX_CONTEXT_LIMIT + '.');
  }

  const [process, evidence, implementation, snapshot, outcomeSearchState, patternSearchState] = await Promise.all([
    searchBusinessProcessRecords(scope, query, limit),
    searchKnowledge({ scope, query, limit }),
    searchImplementationGraph(scope, query, limit),
    readBusinessProcessScope(scope),
    searchIncidentOutcomes(scope, query, Math.min(4, limit))
      .then(result => ({ result, error: null as string | null }))
      .catch(error => ({
        result: null,
        error: error instanceof Error ? error.message : String(error)
      })),
    searchIncidentPatterns(scope, query, Math.min(4, limit))
      .then(result => ({ result, error: null as string | null }))
      .catch(error => ({
        result: null,
        error: error instanceof Error ? error.message : String(error)
      }))
  ]);

  const seedKeys = new Set<string>();
  for (const hit of process.hits) seedKeys.add(hit.record.key);
  for (const hit of implementation.hits) {
    if (hit.node.recordKey) seedKeys.add(hit.node.recordKey);
    for (const neighbor of hit.neighbors) if (neighbor.recordKey) seedKeys.add(neighbor.recordKey);
  }
  const contextRecords = selectProcessContext(snapshot.records, [...seedKeys]);

  const verificationRequests = new Map<string, string>();
  for (const record of contextRecords) {
    for (const reference of record.evidence) {
      if (verificationRequests.size >= MAX_VERIFY_EVIDENCE) break;
      verificationRequests.set(reference.evidenceId, reference.contentHash);
    }
    if (verificationRequests.size >= MAX_VERIFY_EVIDENCE) break;
  }
  for (const hit of evidence.hits) {
    if (verificationRequests.size >= MAX_VERIFY_EVIDENCE) break;
    if (!verificationRequests.has(hit.evidenceId)) verificationRequests.set(hit.evidenceId, hit.contentHash);
  }
  const verification = verificationRequests.size
    ? await verifyKnowledgeEvidence({
      scope,
      evidence: [...verificationRequests].map(([evidenceId, contentHash]) => ({ evidenceId, contentHash }))
    }, roots)
    : null;

  const implementationLinks = await Promise.all(
    [...verificationRequests.keys()].slice(0, 4).map(evidenceId =>
      expandImplementationGraph(scope, 'evidence:' + evidenceId)
    )
  );

  const acceptedExpectedBehavior = contextRecords.some(
    record => record.kind === 'expected_behavior' && record.status === 'accepted'
  );
  const implementationKinds = new Set([
    'source_file', 'source_method', 'form', 'control', 'database_object', 'database_column'
  ]);
  const hasImplementationEvidence = implementation.hits.some(hit =>
    implementationKinds.has(hit.node.kind) || hit.neighbors.some(node => implementationKinds.has(node.kind))
  ) || implementationLinks.some(link => link.nodes.some(node => implementationKinds.has(node.kind)));
  const staleEvidence = verification?.evidence.filter(item => item.status !== 'current') ?? [];
  const gaps: string[] = [];
  if (!contextRecords.length) gaps.push('No curated customer/process context matched this incident query.');
  if (contextRecords.length && !acceptedExpectedBehavior) {
    gaps.push('No accepted expected behavior is linked to the matched process context.');
  }
  if (!hasImplementationEvidence) {
    gaps.push('No source/form/database implementation evidence is linked to the matched context.');
  }
  if (staleEvidence.length) {
    gaps.push(staleEvidence.length + ' referenced evidence item(s) are stale, missing, mismatched, or unavailable.');
  }
  if (!verificationRequests.size) gaps.push('The matched context has no indexed evidence to verify.');

  const hasAnyContext = contextRecords.length > 0 || evidence.hits.length > 0 || implementation.hits.length > 0;
  const evidenceCurrent = verification === null || verification.allCurrent;
  const readiness = contextRecords.length && acceptedExpectedBehavior && hasImplementationEvidence && evidenceCurrent
    ? 'grounded' as const
    : hasAnyContext ? 'partial' as const : 'empty' as const;
  const crossCustomerSuggestions = (patternSearchState.result?.hits ?? [])
    .filter(hit => hit.provenance.liveStatus === 'promoted' && hit.provenance.otherSupportingScopeCount > 0)
    .map(hit => ({
      pattern: hit.pattern,
      score: hit.score,
      provenance: hit.provenance,
      guidance: 'Cross-customer pattern only: verify this customer\'s process, deployment and runtime evidence before treating it as a local cause.'
    }));
  const crossCustomerLimitations = patternSearchState.error
    ? ['Cross-customer pattern lookup was unavailable: ' + patternSearchState.error]
    : [];
  const priorConfirmedOutcomes = (outcomeSearchState.result?.hits ?? [])
    .filter(hit => hit.provenance.liveStatus === 'accepted')
    .map(hit => ({ outcome: hit.outcome, score: hit.score, provenance: hit.provenance }));
  const priorOutcomeLimitations = outcomeSearchState.error
    ? ['Local incident-outcome lookup was unavailable: ' + outcomeSearchState.error]
    : [];

  return {
    scope,
    query,
    readiness,
    process,
    contextRecords,
    evidence,
    implementation,
    implementationLinks,
    priorConfirmedOutcomes,
    priorOutcomeLimitations,
    crossCustomerSuggestions,
    crossCustomerLimitations,
    verification,
    gaps,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt))
  };
}
