import type {
  EngineeringLearningRef,
  EngineeringLearningRefInput,
  EngineeringLearningRole
} from './contracts.js';
import { getIncidentOutcomes, incidentOutcomeTechnicalBasisHash } from '../knowledge/outcome-service.js';
import { getIncidentPatterns } from '../knowledge/pattern-service.js';
import { knowledgeSha256 } from '../knowledge/evidence.js';

export type EngineeringLearningVerificationStatus = 'current' | 'stale' | 'missing';

export interface EngineeringLearningVerification {
  ref: EngineeringLearningRef;
  status: EngineeringLearningVerificationStatus;
  detail: string;
}

function normalizedKey(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function learningIdentity(kind: EngineeringLearningRef['kind'], key: string): string {
  return `${kind}:${normalizedKey(key)}`;
}

function patternSemanticHash(pattern: Awaited<ReturnType<typeof getIncidentPatterns>>['patterns'][number]['pattern']): string {
  return knowledgeSha256('engineering-pattern-learning:v1\0' + JSON.stringify({
    key: pattern.key,
    title: pattern.title,
    symptom: pattern.symptom,
    finding: pattern.finding,
    rootCauseCategory: pattern.rootCauseCategory,
    rootCauseSignature: pattern.rootCauseSignature,
    recommendedChecks: pattern.recommendedChecks,
    tags: pattern.tags
  }));
}

async function captureLearningRef(scope: string, input: EngineeringLearningRefInput): Promise<EngineeringLearningRef> {
  const key = input.key.trim();
  const boundAt = new Date().toISOString();
  if (input.kind === 'incident_outcome') {
    const result = await getIncidentOutcomes(scope, [key]);
    const found = result.outcomes[0];
    if (!found || found.provenance.liveStatus !== 'accepted') {
      throw new Error(`ENGINEERING_LEARNING_OUTCOME_NOT_CURRENT: ${key}`);
    }
    if (input.role === 'relied_upon' && !found.provenance.machineBacked) {
      throw new Error(`ENGINEERING_LEARNING_RELIED_OUTCOME_NOT_MACHINE_BACKED: ${key}`);
    }
    return {
      kind: input.kind,
      key: found.outcome.key,
      role: input.role,
      scope,
      semanticHash: incidentOutcomeTechnicalBasisHash(found.outcome),
      capturedRevision: found.outcome.revision,
      boundLiveStatus: 'accepted',
      boundAt
    };
  }

  const result = await getIncidentPatterns(scope, [key]);
  const found = result.patterns[0];
  if (!found || found.provenance.liveStatus !== 'promoted') {
    throw new Error(`ENGINEERING_LEARNING_PATTERN_NOT_PROMOTED: ${key}`);
  }
  return {
    kind: input.kind,
    key: found.pattern.key,
    role: input.role,
    scope,
    semanticHash: patternSemanticHash(found.pattern),
    capturedRevision: found.pattern.revision,
    boundLiveStatus: 'promoted',
    boundAt
  };
}

export async function bindEngineeringLearningRefs(
  scope: string,
  inputs: readonly EngineeringLearningRefInput[],
  previous: readonly EngineeringLearningRef[] = []
): Promise<EngineeringLearningRef[]> {
  if (inputs.length > 32) throw new Error('Engineering learning refs are limited to 32 per task.');
  const previousByIdentity = new Map(previous.map(ref => [learningIdentity(ref.kind, ref.key), ref]));
  const seen = new Set<string>();
  const output: EngineeringLearningRef[] = [];
  for (const input of inputs) {
    if (input.kind !== 'incident_outcome' && input.kind !== 'incident_pattern') {
      throw new Error(`ENGINEERING_LEARNING_INVALID_KIND: ${String(input.kind)}`);
    }
    if (input.role !== 'context' && input.role !== 'advisory' && input.role !== 'relied_upon') {
      throw new Error(`ENGINEERING_LEARNING_INVALID_ROLE: ${String(input.role)}`);
    }
    if (input.refreshBinding !== undefined && typeof input.refreshBinding !== 'boolean') {
      throw new Error('ENGINEERING_LEARNING_INVALID_REFRESH_BINDING');
    }
    const key = input.key.trim();
    if (!key || key.length > 160) throw new Error('Engineering learning key must contain 1 to 160 characters.');
    const identity = learningIdentity(input.kind, key);
    if (seen.has(identity)) throw new Error(`ENGINEERING_LEARNING_DUPLICATE_REF: ${input.kind}:${key}`);
    seen.add(identity);
    const existing = previousByIdentity.get(identity);
    if (existing && !input.refreshBinding) {
      output.push({ ...existing, role: input.role });
      continue;
    }
    output.push(await captureLearningRef(scope, { ...input, key }));
  }
  return output;
}

export async function mergeDiscoveredEngineeringLearningRefs(
  scope: string,
  previous: readonly EngineeringLearningRef[],
  discovered: readonly EngineeringLearningRefInput[]
): Promise<EngineeringLearningRef[]> {
  const existing = new Set(previous.map(ref => learningIdentity(ref.kind, ref.key)));
  const missing = discovered.filter(ref => !existing.has(learningIdentity(ref.kind, ref.key)));
  if (!missing.length) return [...previous];
  const captured = await bindEngineeringLearningRefs(scope, missing, []);
  return [...previous, ...captured].slice(0, 32);
}

export async function verifyEngineeringLearningRef(ref: EngineeringLearningRef): Promise<EngineeringLearningVerification> {
  if (ref.kind === 'incident_outcome') {
    const result = await getIncidentOutcomes(ref.scope, [ref.key]);
    const found = result.outcomes[0];
    if (!found) return { ref, status: 'missing', detail: 'Incident outcome no longer exists.' };
    if (found.provenance.liveStatus !== 'accepted') {
      return { ref, status: 'stale', detail: `Incident outcome is ${found.provenance.liveStatus}.` };
    }
    if (ref.role === 'relied_upon' && !found.provenance.machineBacked) {
      return { ref, status: 'stale', detail: 'Relied-upon incident outcome is not machine-backed.' };
    }
    if (incidentOutcomeTechnicalBasisHash(found.outcome) !== ref.semanticHash) {
      return { ref, status: 'stale', detail: 'Incident outcome semantic basis changed.' };
    }
    return { ref, status: 'current', detail: 'Incident outcome binding is current.' };
  }

  const result = await getIncidentPatterns(ref.scope, [ref.key]);
  const found = result.patterns[0];
  if (!found) return { ref, status: 'missing', detail: 'Incident pattern no longer exists.' };
  if (found.provenance.liveStatus !== 'promoted') {
    return { ref, status: 'stale', detail: `Incident pattern is ${found.provenance.liveStatus}.` };
  }
  if (patternSemanticHash(found.pattern) !== ref.semanticHash) {
    return { ref, status: 'stale', detail: 'Incident pattern definition changed.' };
  }
  return { ref, status: 'current', detail: 'Incident pattern binding is current.' };
}

export function reliedUponLearningBasis(refs: readonly EngineeringLearningRef[]): Array<{
  kind: EngineeringLearningRef['kind'];
  key: string;
  semanticHash: string;
}> {
  return refs
    .filter(ref => ref.role === 'relied_upon')
    .map(ref => ({ kind: ref.kind, key: ref.key, semanticHash: ref.semanticHash }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key));
}

export function learningRoleRank(role: EngineeringLearningRole): number {
  return role === 'relied_upon' ? 2 : role === 'advisory' ? 1 : 0;
}
