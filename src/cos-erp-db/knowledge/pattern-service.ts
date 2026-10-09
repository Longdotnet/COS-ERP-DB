import { z } from 'zod';
import type { BusinessProcessEvidenceRef } from './contracts/business-process.js';
import type {
  IncidentPattern,
  IncidentPatternGetResult,
  IncidentPatternHistoryResult,
  IncidentPatternInput,
  IncidentPatternOccurrence,
  IncidentPatternProvenanceSummary,
  IncidentPatternPutResult,
  IncidentPatternSearchHit,
  IncidentPatternSearchResult
} from './contracts/incident-pattern.js';
import { knowledgeSha256 } from './evidence.js';
import { getAcceptedIncidentOutcomeForPattern, incidentOutcomeEvidence } from './outcome-service.js';
import { mutateIncidentPatternStore, readIncidentPatternStore } from './pattern-store.js';

const MAX_REVISIONS = 25_000;
const MAX_SEARCH_RESULTS = 20;

const occurrenceInputSchema = z.object({
  outcomeKey: z.string().trim().min(1).max(160),
  note: z.string().trim().max(2_000).nullable().optional()
}).strict();

const inputSchema = z.object({
  key: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(512),
  symptom: z.string().trim().min(1).max(4_000),
  finding: z.string().trim().min(1).max(8_000),
  recommendedChecks: z.array(z.string().trim().min(1).max(1_000)).min(1).max(24),
  tags: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
  expectedRevision: z.number().int().positive().optional(),
  occurrence: occurrenceInputSchema
}).strict();

function normalizeScope(scope: string): string {
  const value = scope.trim();
  if (!value || value.length > 120 || /[\u0000-\u001f]/.test(value)) {
    throw new Error('Incident-pattern source scope must contain 1 to 120 visible characters.');
  }
  return value;
}

function normalized(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('vi-VN');
}

function normalizedKey(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
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

function patternId(key: string): string {
  return knowledgeSha256('incident-pattern:v1\u0000' + normalizedKey(key));
}

function occurrenceId(patternKey: string, scope: string, incidentKey: string): string {
  return knowledgeSha256(
    'incident-pattern-occurrence:v1\u0000' + normalizedKey(patternKey) + '\u0000' + scope + '\u0000' + normalizedKey(incidentKey)
  );
}

function rootCauseEvidenceFingerprint(evidence: readonly BusinessProcessEvidenceRef[]): string | null {
  const supportingContentHashes = [...new Set(dedupeEvidence(evidence)
    .filter(item => item.relation === 'supports')
    .map(item => item.contentHash))]
    .sort((left, right) => left.localeCompare(right));
  return supportingContentHashes.length
    ? knowledgeSha256(`incident-pattern-independence:v2\0${supportingContentHashes.join('\0')}`)
    : null;
}

async function validateOccurrence(
  sourceScope: string,
  occurrence: IncidentPatternInput['occurrence']
): Promise<{
  outcomeKey: string;
  incidentKey: string;
  processKey: string;
  expectedBehaviorKey: string;
  rootCauseCategory: string;
  rootCauseSignature: string;
  independenceFingerprint: string | null;
  evidence: BusinessProcessEvidenceRef[];
}> {
  const outcome = await getAcceptedIncidentOutcomeForPattern(sourceScope, occurrence.outcomeKey);
  const evidence = dedupeEvidence(incidentOutcomeEvidence(outcome));
  if (!evidence.some(item => item.relation === 'supports')) {
    throw new Error('Incident-pattern outcome does not contain supporting evidence.');
  }
  const independenceFingerprint = rootCauseEvidenceFingerprint(outcome.evidence);
  const rootCauseSignature = knowledgeSha256(
    `incident-pattern-root-cause:v1\0${normalized(outcome.rootCauseCategory)}\0${normalized(outcome.finding)}`
  );
  return {
    outcomeKey: outcome.key,
    incidentKey: outcome.incidentKey,
    processKey: outcome.processKey,
    expectedBehaviorKey: outcome.expectedBehaviorKey,
    rootCauseCategory: outcome.rootCauseCategory,
    rootCauseSignature,
    independenceFingerprint,
    evidence
  };
}

function definitionShape(pattern: Pick<IncidentPattern, 'title' | 'symptom' | 'finding' | 'rootCauseCategory' | 'rootCauseSignature' | 'recommendedChecks' | 'tags'>) {
  return {
    title: pattern.title,
    symptom: pattern.symptom,
    finding: pattern.finding,
    rootCauseCategory: pattern.rootCauseCategory,
    rootCauseSignature: pattern.rootCauseSignature,
    recommendedChecks: pattern.recommendedChecks,
    tags: pattern.tags
  };
}

function occurrenceShape(occurrence: IncidentPatternOccurrence): unknown {
  return {
    sourceScope: occurrence.sourceScope,
    outcomeKey: occurrence.outcomeKey ?? null,
    incidentKey: occurrence.incidentKey,
    processKey: occurrence.processKey,
    expectedBehaviorKey: occurrence.expectedBehaviorKey,
    rootCauseCategory: occurrence.rootCauseCategory,
    rootCauseSignature: occurrence.rootCauseSignature,
    independenceFingerprint: occurrence.independenceFingerprint,
    evidence: occurrence.evidence,
    note: occurrence.note
  };
}

export async function putIncidentPatternOccurrence(
  sourceScopeInput: string,
  rawInput: unknown
): Promise<IncidentPatternPutResult> {
  const sourceScope = normalizeScope(sourceScopeInput);
  const parsed = inputSchema.parse(rawInput) as IncidentPatternInput & { tags: string[] };
  const validatedOccurrence = await validateOccurrence(sourceScope, parsed.occurrence);
  const key = parsed.key.trim();
  const tags = dedupeStrings(parsed.tags);
  const recommendedChecks = dedupeStrings(parsed.recommendedChecks);
  const note = parsed.occurrence.note?.trim() || null;
  let changed = false;
  let output!: IncidentPattern;

  await mutateIncidentPatternStore(async current => {
    const existing = current.patterns.find(pattern => normalizedKey(pattern.key) === normalizedKey(key));
    if (!existing && parsed.expectedRevision !== undefined) {
      throw new Error('expectedRevision is only valid when updating an existing incident pattern.');
    }
    if (existing && parsed.expectedRevision !== undefined && parsed.expectedRevision !== existing.revision) {
      throw new Error('Incident-pattern revision changed; reload it before updating the shared definition.');
    }

    const requestedDefinition = {
      title: parsed.title.trim(),
      symptom: parsed.symptom.trim(),
      finding: parsed.finding.trim(),
      rootCauseCategory: existing?.rootCauseCategory ?? validatedOccurrence.rootCauseCategory,
      rootCauseSignature: existing?.rootCauseSignature ?? validatedOccurrence.rootCauseSignature,
      recommendedChecks,
      tags
    };
    if (existing?.rootCauseCategory && normalized(existing.rootCauseCategory) !== normalized(validatedOccurrence.rootCauseCategory)) {
      throw new Error('Incident-pattern occurrence root-cause category differs from the shared pattern definition.');
    }
    if (existing?.rootCauseSignature && existing.rootCauseSignature !== validatedOccurrence.rootCauseSignature) {
      throw new Error('Incident-pattern occurrence root-cause finding differs from the shared pattern definition.');
    }
    const comparableExistingDefinition = existing ? {
      ...definitionShape(existing),
      rootCauseCategory: existing.rootCauseCategory ?? validatedOccurrence.rootCauseCategory,
      rootCauseSignature: existing.rootCauseSignature ?? validatedOccurrence.rootCauseSignature
    } : null;
    if (existing && parsed.expectedRevision === undefined
      && JSON.stringify(comparableExistingDefinition) !== JSON.stringify(requestedDefinition)) {
      throw new Error('Existing incident-pattern definition differs; provide expectedRevision to make a reviewed definition change.');
    }

    const now = new Date().toISOString();
    const nextOccurrence: IncidentPatternOccurrence = {
      id: occurrenceId(key, sourceScope, validatedOccurrence.incidentKey),
      sourceScope,
      outcomeKey: validatedOccurrence.outcomeKey,
      incidentKey: validatedOccurrence.incidentKey,
      processKey: validatedOccurrence.processKey,
      expectedBehaviorKey: validatedOccurrence.expectedBehaviorKey,
      rootCauseCategory: validatedOccurrence.rootCauseCategory,
      rootCauseSignature: validatedOccurrence.rootCauseSignature,
      independenceFingerprint: validatedOccurrence.independenceFingerprint,
      evidence: validatedOccurrence.evidence,
      note,
      createdAt: now,
      updatedAt: now
    };
    const existingOccurrence = existing?.occurrences.find(item => item.id === nextOccurrence.id);
    if (existingOccurrence) nextOccurrence.createdAt = existingOccurrence.createdAt;
    const occurrenceChanged = !existingOccurrence
      || JSON.stringify(occurrenceShape(existingOccurrence)) !== JSON.stringify(occurrenceShape(nextOccurrence));
    const definitionChanged = !existing
      || JSON.stringify(definitionShape(existing)) !== JSON.stringify(requestedDefinition);
    if (existing && !occurrenceChanged && !definitionChanged) {
      output = existing;
      return current;
    }

    const occurrences = existingOccurrence
      ? existing!.occurrences.map(item => item.id === nextOccurrence.id ? nextOccurrence : item)
      : [...(existing?.occurrences ?? []), nextOccurrence];
    const supportingScopeCount = new Set(occurrences.map(item => item.sourceScope)).size;
    const currentOccurrenceStates = await Promise.all(occurrences.map(async occurrence => ({
      occurrence,
      ...await occurrenceState(occurrence)
    })));
    const currentSupportingScopeCount = new Set(
      currentOccurrenceStates.filter(item => item.current).map(item => item.occurrence.sourceScope)
    ).size;
    const independentSupportingCount = new Set(
      currentOccurrenceStates
        .filter(item => item.current && item.independenceFingerprint)
        .map(item => item.independenceFingerprint!)
    ).size;
    const currentlyPromotable = currentSupportingScopeCount >= 2 && independentSupportingCount >= 2;
    const candidate: IncidentPattern = {
      id: existing?.id ?? patternId(key),
      key,
      ...requestedDefinition,
      status: existing?.status === 'promoted' || currentlyPromotable ? 'promoted' : 'candidate',
      supportingScopeCount,
      independentSupportingCount,
      occurrences,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const patterns = existing
      ? current.patterns.map(pattern => pattern.id === existing.id ? candidate : pattern)
      : [...current.patterns, candidate];
    const revisions = [...current.revisions, candidate].slice(-MAX_REVISIONS);
    changed = true;
    output = candidate;
    return { version: 1, updatedAt: now, patterns, revisions };
  });
  return { changed, pattern: output };
}

async function occurrenceState(occurrence: IncidentPatternOccurrence): Promise<{
  current: boolean;
  independenceFingerprint: string | null;
}> {
  try {
    if (!occurrence.outcomeKey) return { current: false, independenceFingerprint: null };
    const outcome = await getAcceptedIncidentOutcomeForPattern(occurrence.sourceScope, occurrence.outcomeKey);
    const fingerprint = rootCauseEvidenceFingerprint(outcome.evidence);
    const rootCauseSignature = knowledgeSha256(
      `incident-pattern-root-cause:v1\0${normalized(outcome.rootCauseCategory)}\0${normalized(outcome.finding)}`
    );
    const current = normalizedKey(outcome.incidentKey) === normalizedKey(occurrence.incidentKey)
      && normalizedKey(outcome.processKey) === normalizedKey(occurrence.processKey)
      && normalizedKey(outcome.expectedBehaviorKey) === normalizedKey(occurrence.expectedBehaviorKey)
      && (occurrence.rootCauseCategory === null
        || normalized(outcome.rootCauseCategory) === normalized(occurrence.rootCauseCategory))
      && (occurrence.rootCauseSignature === null || rootCauseSignature === occurrence.rootCauseSignature)
      && JSON.stringify(dedupeEvidence(incidentOutcomeEvidence(outcome))) === JSON.stringify(dedupeEvidence(occurrence.evidence));
    return { current, independenceFingerprint: current ? fingerprint : null };
  } catch {
    return { current: false, independenceFingerprint: null };
  }
}

async function provenance(pattern: IncidentPattern, requestingScope: string): Promise<IncidentPatternProvenanceSummary> {
  const states = await Promise.all(pattern.occurrences.map(async occurrence => ({
    occurrence,
    ...await occurrenceState(occurrence)
  })));
  const currentScopes = new Set(states.filter(item => item.current).map(item => item.occurrence.sourceScope));
  const currentIndependentFingerprints = new Set(states
    .filter(item => item.current && item.independenceFingerprint)
    .map(item => item.independenceFingerprint!));
  const liveStatus = currentScopes.size >= 2 && currentIndependentFingerprints.size >= 2
    ? 'promoted' as const
    : pattern.status === 'promoted' ? 'degraded' as const : 'candidate' as const;
  return {
    liveStatus,
    currentSupportingScopeCount: currentScopes.size,
    currentIndependentSupportingCount: currentIndependentFingerprints.size,
    otherSupportingScopeCount: [...currentScopes].filter(scope => scope !== requestingScope).length,
    occurrenceCount: pattern.occurrences.length,
    staleOccurrenceCount: states.filter(item => !item.current).length
  };
}

function searchScore(pattern: IncidentPattern, query: string): number {
  const phrase = normalized(query);
  const tokens = [...new Set(phrase.match(/[\p{L}\p{N}_.$-]+/gu) ?? [])].filter(token => token.length >= 2).slice(0, 24);
  const key = normalized(pattern.key);
  const title = normalized(pattern.title);
  const symptom = normalized(pattern.symptom);
  const finding = normalized(pattern.finding);
  const checks = normalized(pattern.recommendedChecks.join(' '));
  const tags = normalized(pattern.tags.join(' '));
  let score = 0;
  if (key.includes(phrase)) score += 40;
  if (title.includes(phrase)) score += 30;
  if (symptom.includes(phrase)) score += 24;
  if (finding.includes(phrase)) score += 18;
  if (checks.includes(phrase)) score += 10;
  if (tags.includes(phrase)) score += 8;
  for (const token of tokens) {
    if (key.includes(token)) score += 8;
    if (title.includes(token)) score += 6;
    if (symptom.includes(token)) score += 5;
    if (finding.includes(token)) score += 3;
    if (checks.includes(token)) score += 2;
    if (tags.includes(token)) score += 2;
  }
  return score;
}

function withoutOccurrences(pattern: IncidentPattern): Omit<IncidentPattern, 'occurrences'> {
  const { occurrences: _occurrences, ...rest } = pattern;
  return rest;
}

export async function searchIncidentPatterns(
  requestingScopeInput: string,
  queryInput: string,
  limit = 8
): Promise<IncidentPatternSearchResult> {
  const requestingScope = normalizeScope(requestingScopeInput);
  const query = queryInput.trim();
  if (!query || query.length > 1000) throw new Error('Incident-pattern search query must contain 1 to 1000 characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
    throw new Error('Incident-pattern search limit must be between 1 and ' + MAX_SEARCH_RESULTS + '.');
  }
  const snapshot = await readIncidentPatternStore();
  const matches = snapshot.patterns
    .map(pattern => ({ pattern, score: searchScore(pattern, query) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.pattern.key.localeCompare(right.pattern.key));
  const selected = matches.slice(0, limit);
  const hits: IncidentPatternSearchHit[] = await Promise.all(selected.map(async item => ({
    pattern: withoutOccurrences(item.pattern),
    score: item.score,
    provenance: await provenance(item.pattern, requestingScope)
  })));
  return { requestingScope, query, hits, totalMatches: matches.length, truncated: matches.length > hits.length };
}

export async function getIncidentPatterns(
  requestingScopeInput: string,
  keys: readonly string[]
): Promise<IncidentPatternGetResult> {
  const requestingScope = normalizeScope(requestingScopeInput);
  if (!keys.length || keys.length > 20) throw new Error('Incident-pattern get requires 1 to 20 keys.');
  const snapshot = await readIncidentPatternStore();
  const byKey = new Map(snapshot.patterns.map(pattern => [normalizedKey(pattern.key), pattern]));
  const patterns: IncidentPatternGetResult['patterns'] = [];
  const missingKeys: string[] = [];
  for (const key of keys) {
    const pattern = byKey.get(normalizedKey(key));
    if (!pattern) {
      missingKeys.push(key);
      continue;
    }
    patterns.push({ pattern, provenance: await provenance(pattern, requestingScope) });
  }
  return { requestingScope, patterns, missingKeys };
}

export async function getIncidentPatternHistory(keyInput: string): Promise<IncidentPatternHistoryResult> {
  const key = keyInput.trim();
  if (!key) throw new Error('Incident-pattern history requires a key.');
  const id = patternId(key);
  const snapshot = await readIncidentPatternStore();
  return {
    key,
    revisions: snapshot.revisions
      .filter(pattern => pattern.id === id)
      .sort((left, right) => left.revision - right.revision)
  };
}
