import { z } from 'zod';
import type { BusinessProcessEvidenceRef, BusinessProcessRecord } from './contracts/business-process.js';
import type {
  IncidentOutcome,
  IncidentOutcomeGetResult,
  IncidentOutcomeHistoryResult,
  IncidentOutcomeInput,
  IncidentOutcomeProvenance,
  IncidentOutcomePutResult,
  IncidentOutcomeSearchResult
} from './contracts/incident-outcome.js';
import { knowledgeSha256 } from './evidence.js';
import { mutateIncidentOutcomeScope, readIncidentOutcomeScope } from './outcome-store.js';
import { readBusinessProcessScope } from './process-store.js';
import { readKnowledgeScope } from './store.js';

const MAX_SEARCH_RESULTS = 20;
const MAX_REVISIONS_PER_SCOPE = 50_000;

const evidenceInputSchema = z.object({
  evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  relation: z.enum(['supports', 'context', 'contradicts']).default('supports')
}).strict();

const inputSchema = z.object({
  key: z.string().trim().min(1).max(160),
  incidentKey: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(512),
  symptom: z.string().trim().min(1).max(4_000),
  processKey: z.string().trim().min(1).max(160),
  expectedBehaviorKey: z.string().trim().min(1).max(160),
  rootCauseCategory: z.string().trim().min(1).max(160),
  finding: z.string().trim().min(1).max(8_000),
  remediation: z.string().trim().min(1).max(8_000),
  evidence: z.array(evidenceInputSchema).max(64).default([]),
  deploymentEvidence: z.array(evidenceInputSchema).max(64).default([]),
  runtimeEvidence: z.array(evidenceInputSchema).max(64).default([]),
  validation: z.object({
    result: z.enum(['pending', 'passed', 'failed']),
    summary: z.string().trim().min(1).max(4_000),
    evidence: z.array(evidenceInputSchema).max(64).default([])
  }).strict(),
  status: z.enum(['draft', 'accepted', 'invalidated']).default('draft'),
  decisionNote: z.string().trim().max(2_000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
  expectedRevision: z.number().int().positive().optional()
}).strict();

function normalizeScope(scope: string): string {
  const value = scope.trim();
  if (!value || value.length > 120 || /[\u0000-\u001f]/.test(value)) {
    throw new Error('Incident-outcome scope must contain 1 to 120 visible characters.');
  }
  return value;
}

function normalized(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('vi-VN');
}

function normalizedKey(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function outcomeId(scope: string, key: string): string {
  return knowledgeSha256('incident-outcome:v1\u0000' + scope + '\u0000' + normalizedKey(key));
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = normalized(value);
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function dedupeEvidence(values: readonly BusinessProcessEvidenceRef[]): BusinessProcessEvidenceRef[] {
  const seen = new Set<string>();
  const result: BusinessProcessEvidenceRef[] = [];
  for (const item of values) {
    const key = item.evidenceId + ':' + item.contentHash + ':' + item.relation;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function byKey(records: readonly BusinessProcessRecord[]): Map<string, BusinessProcessRecord> {
  return new Map(records.map(record => [normalizedKey(record.key), record]));
}

function expectedBelongsToProcess(expected: BusinessProcessRecord, process: BusinessProcessRecord, records: ReadonlyMap<string, BusinessProcessRecord>): boolean {
  let current: BusinessProcessRecord | undefined = expected;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.id === process.id) return true;
    seen.add(current.id);
    current = current.parentKey ? records.get(normalizedKey(current.parentKey)) : undefined;
  }
  return false;
}

export function incidentOutcomeEvidence(outcome: IncidentOutcome): BusinessProcessEvidenceRef[] {
  return dedupeEvidence([
    ...outcome.evidence,
    ...outcome.deploymentEvidence,
    ...outcome.runtimeEvidence,
    ...outcome.validation.evidence
  ]);
}

async function validateReferences(scope: string, processKey: string, expectedBehaviorKey: string, evidence: readonly BusinessProcessEvidenceRef[]) {
  const [processSnapshot, knowledgeSnapshot] = await Promise.all([
    readBusinessProcessScope(scope),
    readKnowledgeScope(scope)
  ]);
  const records = byKey(processSnapshot.records);
  const process = records.get(normalizedKey(processKey));
  const expected = records.get(normalizedKey(expectedBehaviorKey));
  if (!process || process.kind !== 'process') throw new Error('Incident outcome requires an existing process record in its scope.');
  if (!expected || expected.kind !== 'expected_behavior' || expected.status !== 'accepted') {
    throw new Error('Incident outcome requires an accepted expected_behavior record in its scope.');
  }
  if (!expectedBelongsToProcess(expected, process, records)) {
    throw new Error('Incident outcome expected behavior must belong to the referenced process hierarchy.');
  }
  const indexed = new Map(knowledgeSnapshot.evidence.map(item => [item.id, item]));
  for (const reference of evidence) {
    const found = indexed.get(reference.evidenceId);
    if (!found) throw new Error('Incident outcome evidence is missing from the current scope: ' + reference.evidenceId);
    if (found.contentHash !== reference.contentHash) {
      throw new Error('Incident outcome evidence hash no longer matches the current scope: ' + reference.evidenceId);
    }
  }
  return { process, expected };
}

function materialShape(outcome: IncidentOutcome): unknown {
  return {
    incidentKey: outcome.incidentKey,
    title: outcome.title,
    symptom: outcome.symptom,
    processKey: outcome.processKey,
    expectedBehaviorKey: outcome.expectedBehaviorKey,
    rootCauseCategory: outcome.rootCauseCategory,
    finding: outcome.finding,
    remediation: outcome.remediation,
    evidence: outcome.evidence,
    deploymentEvidence: outcome.deploymentEvidence,
    runtimeEvidence: outcome.runtimeEvidence,
    validation: outcome.validation,
    status: outcome.status,
    decisionNote: outcome.decisionNote,
    tags: outcome.tags
  };
}

export async function evaluateIncidentOutcome(outcome: IncidentOutcome): Promise<IncidentOutcomeProvenance> {
  if (outcome.status === 'draft') {
    return { liveStatus: 'draft', current: false, staleEvidenceCount: 0, evidenceCount: incidentOutcomeEvidence(outcome).length, processCurrent: false, expectedBehaviorCurrent: false };
  }
  if (outcome.status === 'invalidated') {
    return { liveStatus: 'invalidated', current: false, staleEvidenceCount: 0, evidenceCount: incidentOutcomeEvidence(outcome).length, processCurrent: false, expectedBehaviorCurrent: false };
  }
  try {
    const [processSnapshot, knowledgeSnapshot] = await Promise.all([
      readBusinessProcessScope(outcome.scope),
      readKnowledgeScope(outcome.scope)
    ]);
    const records = byKey(processSnapshot.records);
    const process = records.get(normalizedKey(outcome.processKey));
    const expected = records.get(normalizedKey(outcome.expectedBehaviorKey));
    const processCurrent = Boolean(process && process.kind === 'process');
    const expectedBehaviorCurrent = Boolean(
      expected && expected.kind === 'expected_behavior' && expected.status === 'accepted' && process && expectedBelongsToProcess(expected, process, records)
    );
    const indexed = new Map(knowledgeSnapshot.evidence.map(item => [item.id, item]));
    const evidence = incidentOutcomeEvidence(outcome);
    const staleEvidenceCount = evidence.filter(reference => indexed.get(reference.evidenceId)?.contentHash !== reference.contentHash).length;
    const current = processCurrent && expectedBehaviorCurrent && outcome.validation.result === 'passed'
      && outcome.evidence.some(item => item.relation === 'supports')
      && outcome.validation.evidence.some(item => item.relation === 'supports')
      && staleEvidenceCount === 0;
    return {
      liveStatus: current ? 'accepted' : 'stale',
      current,
      staleEvidenceCount,
      evidenceCount: evidence.length,
      processCurrent,
      expectedBehaviorCurrent
    };
  } catch {
    return {
      liveStatus: 'stale', current: false, staleEvidenceCount: incidentOutcomeEvidence(outcome).length,
      evidenceCount: incidentOutcomeEvidence(outcome).length, processCurrent: false, expectedBehaviorCurrent: false
    };
  }
}

export async function putIncidentOutcome(scopeInput: string, rawInput: unknown): Promise<IncidentOutcomePutResult> {
  const scope = normalizeScope(scopeInput);
  const parsed = inputSchema.parse(rawInput) as IncidentOutcomeInput & {
    evidence: BusinessProcessEvidenceRef[];
    deploymentEvidence: BusinessProcessEvidenceRef[];
    runtimeEvidence: BusinessProcessEvidenceRef[];
    validation: IncidentOutcomeInput['validation'] & { evidence: BusinessProcessEvidenceRef[] };
    status: IncidentOutcome['status'];
    tags: string[];
  };
  const evidence = dedupeEvidence(parsed.evidence);
  const deploymentEvidence = dedupeEvidence(parsed.deploymentEvidence);
  const runtimeEvidence = dedupeEvidence(parsed.runtimeEvidence);
  const validationEvidence = dedupeEvidence(parsed.validation.evidence ?? []);
  const allEvidence = dedupeEvidence([...evidence, ...deploymentEvidence, ...runtimeEvidence, ...validationEvidence]);
  await validateReferences(scope, parsed.processKey, parsed.expectedBehaviorKey, allEvidence);
  const decisionNote = parsed.decisionNote?.trim() || null;
  if (parsed.status === 'accepted') {
    if (!evidence.some(item => item.relation === 'supports')) {
      throw new Error('Accepted incident outcomes require supporting root-cause evidence.');
    }
    if (parsed.validation.result !== 'passed' || !validationEvidence.some(item => item.relation === 'supports')) {
      throw new Error('Accepted incident outcomes require passed validation with supporting evidence.');
    }
    if (!decisionNote) throw new Error('Accepted incident outcomes require an explicit decisionNote.');
  }
  if (parsed.status === 'invalidated' && !decisionNote) {
    throw new Error('Invalidated incident outcomes require a decisionNote.');
  }

  const key = parsed.key.trim();
  let changed = false;
  let output!: IncidentOutcome;
  await mutateIncidentOutcomeScope(scope, current => {
    const existing = current.outcomes.find(item => normalizedKey(item.key) === normalizedKey(key));
    if (!existing && parsed.expectedRevision !== undefined) {
      throw new Error('expectedRevision is only valid when updating an existing incident outcome.');
    }
    if (existing && parsed.expectedRevision !== undefined && existing.revision !== parsed.expectedRevision) {
      throw new Error('Incident-outcome revision changed; reload it before updating.');
    }
    const now = new Date().toISOString();
    const candidate: IncidentOutcome = {
      id: existing?.id ?? outcomeId(scope, key),
      scope,
      key,
      incidentKey: parsed.incidentKey.trim(),
      title: parsed.title.trim(),
      symptom: parsed.symptom.trim(),
      processKey: parsed.processKey.trim(),
      expectedBehaviorKey: parsed.expectedBehaviorKey.trim(),
      rootCauseCategory: parsed.rootCauseCategory.trim(),
      finding: parsed.finding.trim(),
      remediation: parsed.remediation.trim(),
      evidence,
      deploymentEvidence,
      runtimeEvidence,
      validation: { result: parsed.validation.result, summary: parsed.validation.summary.trim(), evidence: validationEvidence },
      status: parsed.status,
      decisionNote,
      tags: dedupeStrings(parsed.tags),
      revision: (existing?.revision ?? 0) + 1,
      acceptedAt: parsed.status === 'accepted' ? (existing?.status === 'accepted' ? existing.acceptedAt : now) : null,
      invalidatedAt: parsed.status === 'invalidated' ? (existing?.status === 'invalidated' ? existing.invalidatedAt : now) : null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    if (existing && JSON.stringify(materialShape(existing)) === JSON.stringify(materialShape(candidate))) {
      output = existing;
      return current;
    }
    if (existing?.status === 'accepted' && parsed.expectedRevision === undefined) {
      throw new Error('Existing accepted incident outcome requires expectedRevision for reviewed changes.');
    }
    changed = true;
    output = candidate;
    const outcomes = existing
      ? current.outcomes.map(item => item.id === existing.id ? candidate : item)
      : [...current.outcomes, candidate];
    const revisions = [...current.revisions, candidate].slice(-MAX_REVISIONS_PER_SCOPE);
    return { version: 1, scope, updatedAt: now, outcomes, revisions };
  });
  return { scope, changed, outcome: output, provenance: await evaluateIncidentOutcome(output) };
}

function searchScore(outcome: IncidentOutcome, query: string): number {
  const phrase = normalized(query);
  const tokens = [...new Set(phrase.match(/[\p{L}\p{N}_.$-]+/gu) ?? [])].filter(token => token.length >= 2).slice(0, 24);
  const values = {
    key: normalized(outcome.key), title: normalized(outcome.title), symptom: normalized(outcome.symptom),
    finding: normalized(outcome.finding), category: normalized(outcome.rootCauseCategory), remediation: normalized(outcome.remediation),
    tags: normalized(outcome.tags.join(' '))
  };
  let score = 0;
  if (values.key.includes(phrase)) score += 40;
  if (values.title.includes(phrase)) score += 30;
  if (values.symptom.includes(phrase)) score += 24;
  if (values.finding.includes(phrase)) score += 18;
  if (values.category.includes(phrase)) score += 12;
  if (values.remediation.includes(phrase)) score += 10;
  if (values.tags.includes(phrase)) score += 8;
  for (const token of tokens) {
    if (values.key.includes(token)) score += 8;
    if (values.title.includes(token)) score += 6;
    if (values.symptom.includes(token)) score += 5;
    if (values.finding.includes(token)) score += 3;
    if (values.category.includes(token)) score += 2;
    if (values.remediation.includes(token)) score += 2;
    if (values.tags.includes(token)) score += 2;
  }
  return score;
}

export async function searchIncidentOutcomes(scopeInput: string, queryInput: string, limit = 8): Promise<IncidentOutcomeSearchResult> {
  const scope = normalizeScope(scopeInput);
  const query = queryInput.trim();
  if (!query || query.length > 1000) throw new Error('Incident-outcome search query must contain 1 to 1000 characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) throw new Error('Incident-outcome search limit must be between 1 and ' + MAX_SEARCH_RESULTS + '.');
  const snapshot = await readIncidentOutcomeScope(scope);
  const matches = snapshot.outcomes
    .map(outcome => ({ outcome, score: searchScore(outcome, query) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.outcome.key.localeCompare(right.outcome.key));
  const selected = matches.slice(0, limit);
  return {
    scope, query, totalMatches: matches.length, truncated: matches.length > selected.length,
    hits: await Promise.all(selected.map(async item => ({ ...item, provenance: await evaluateIncidentOutcome(item.outcome) })))
  };
}

export async function getIncidentOutcomes(scopeInput: string, keys: readonly string[]): Promise<IncidentOutcomeGetResult> {
  const scope = normalizeScope(scopeInput);
  if (!keys.length || keys.length > 20) throw new Error('Incident-outcome get requires 1 to 20 keys.');
  const snapshot = await readIncidentOutcomeScope(scope);
  const index = new Map(snapshot.outcomes.map(outcome => [normalizedKey(outcome.key), outcome]));
  const outcomes: IncidentOutcomeGetResult['outcomes'] = [];
  const missingKeys: string[] = [];
  for (const key of keys) {
    const outcome = index.get(normalizedKey(key));
    if (!outcome) missingKeys.push(key);
    else outcomes.push({ outcome, provenance: await evaluateIncidentOutcome(outcome) });
  }
  return { scope, outcomes, missingKeys };
}

export async function getIncidentOutcomeHistory(scopeInput: string, keyInput: string): Promise<IncidentOutcomeHistoryResult> {
  const scope = normalizeScope(scopeInput);
  const key = keyInput.trim();
  if (!key) throw new Error('Incident-outcome history requires a key.');
  const id = outcomeId(scope, key);
  const snapshot = await readIncidentOutcomeScope(scope);
  return { scope, key, revisions: snapshot.revisions.filter(item => item.id === id).sort((a, b) => a.revision - b.revision) };
}

export async function getAcceptedIncidentOutcomeForPattern(scopeInput: string, keyInput: string): Promise<IncidentOutcome> {
  const scope = normalizeScope(scopeInput);
  const snapshot = await readIncidentOutcomeScope(scope);
  const outcome = snapshot.outcomes.find(item => normalizedKey(item.key) === normalizedKey(keyInput));
  if (!outcome) throw new Error('Incident pattern requires an existing incident outcome in its source scope.');
  if (outcome.status !== 'accepted') throw new Error('Incident pattern requires an accepted incident outcome.');
  const provenance = await evaluateIncidentOutcome(outcome);
  if (!provenance.current) throw new Error('Incident pattern requires a current accepted outcome with current validation evidence.');
  return outcome;
}
