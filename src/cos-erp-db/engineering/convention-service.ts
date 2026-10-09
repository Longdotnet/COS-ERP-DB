import { createHash } from 'node:crypto';
import type {
  EngineeringConvention,
  EngineeringConventionInput,
  EngineeringConventionSearchHit,
  EngineeringProjectLineage
} from './contracts.js';
import { getKnowledgeEvidence, verifyKnowledgeEvidence } from '../knowledge/service.js';
import type { Root } from '../../shared/types.js';
import { engineeringKnowledgeScope } from './lineage.js';
import { mutateEngineeringScope, readEngineeringScope } from './store.js';

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cleanList(values: readonly string[] | undefined, max: number): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))].slice(0, max);
}

async function assertReviewable(lineage: EngineeringProjectLineage, input: EngineeringConventionInput, roots: readonly Root[]): Promise<void> {
  if ((input.status ?? 'draft') !== 'reviewed') return;
  if (input.provenance === 'declared_policy') {
    if (!input.decisionNote?.trim()) throw new Error('ENGINEERING_POLICY_REVIEW_REQUIRES_DECISION_NOTE');
    return;
  }
  const evidence = input.evidence ?? [];
  const supporting = evidence.filter(ref => ref.relation === 'supports');
  if (!supporting.length) throw new Error('ENGINEERING_OBSERVED_REVIEW_REQUIRES_EVIDENCE');
  if (input.classification === 'convention' && supporting.length < 2) {
    throw new Error('ENGINEERING_CONVENTION_REVIEW_REQUIRES_MULTIPLE_EXAMPLES');
  }
  const scope = engineeringKnowledgeScope(lineage);
  const verified = await verifyKnowledgeEvidence({
    scope,
    evidence: evidence.map(ref => ({ evidenceId: ref.evidenceId, contentHash: ref.contentHash }))
  }, roots);
  if (!verified.allCurrent) throw new Error('ENGINEERING_REVIEW_EVIDENCE_NOT_CURRENT');
  if (input.classification === 'convention') {
    const fetched = await getKnowledgeEvidence(scope, supporting.map(ref => ref.evidenceId));
    const independentSources = new Set(fetched.evidence.map(item => item.locator.path ?? item.sourceKey));
    if (independentSources.size < 2) throw new Error('ENGINEERING_CONVENTION_REVIEW_REQUIRES_INDEPENDENT_EXAMPLES');
    const independentSourceHashes = new Set(fetched.evidence.map(item => item.sourceHash));
    if (independentSourceHashes.size < 2) throw new Error('ENGINEERING_CONVENTION_REVIEW_REQUIRES_NON_DUPLICATE_EXAMPLES');
  }
}

export async function putEngineeringConvention(
  lineage: EngineeringProjectLineage,
  input: EngineeringConventionInput,
  roots: readonly Root[]
): Promise<EngineeringConvention> {
  const key = input.key.trim();
  const title = input.title.trim();
  const statement = input.statement.trim();
  if (!key || key.length > 160) throw new Error('Engineering convention key must contain 1 to 160 characters.');
  if (!title || title.length > 512) throw new Error('Engineering convention title must contain 1 to 512 characters.');
  if (!statement || statement.length > 12_000) throw new Error('Engineering convention statement must contain 1 to 12000 characters.');
  await assertReviewable(lineage, input, roots);
  let saved!: EngineeringConvention;
  await mutateEngineeringScope(lineage, current => {
    const previous = current.conventions.find(item => item.key === key);
    if (input.expectedRevision !== undefined && previous?.revision !== input.expectedRevision) {
      throw new Error(`ENGINEERING_REVISION_MISMATCH: expected ${input.expectedRevision}, current ${previous?.revision ?? 0}`);
    }
    const now = new Date().toISOString();
    saved = {
      id: previous?.id ?? hash(`engineering-convention\0${lineage.key}\0${key}`),
      lineageKey: lineage.key,
      key,
      title,
      statement,
      classification: input.classification,
      provenance: input.provenance,
      applicability: cleanList(input.applicability, 64),
      evidence: (input.evidence ?? []).slice(0, 128),
      status: input.status ?? 'draft',
      decisionNote: input.decisionNote?.trim() || null,
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    };
    return {
      ...current,
      lineage: { ...lineage },
      updatedAt: now,
      conventions: [...current.conventions.filter(item => item.key !== key), saved],
      conventionRevisions: [...current.conventionRevisions, saved]
    };
  });
  return saved;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('vi-VN');
}

export async function searchEngineeringConventions(
  lineage: EngineeringProjectLineage,
  queryInput: string,
  limit = 12
): Promise<EngineeringConventionSearchHit[]> {
  const query = normalized(queryInput.trim());
  if (!query || query.length > 1000) throw new Error('Engineering convention search query must contain 1 to 1000 characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Engineering convention search limit must be between 1 and 50.');
  const tokens = [...new Set(query.match(/[\p{L}\p{N}_.$-]+/gu) ?? [])].filter(token => token.length >= 2).slice(0, 24);
  const current = await readEngineeringScope(lineage);
  return current.conventions
    .map(convention => {
      const title = normalized(convention.title);
      const key = normalized(convention.key);
      const text = normalized([convention.statement, convention.classification, convention.applicability.join(' ')].join(' '));
      let score = key.includes(query) ? 40 : title.includes(query) ? 30 : text.includes(query) ? 15 : 0;
      for (const token of tokens) score += key.includes(token) ? 8 : title.includes(token) ? 6 : text.includes(token) ? 2 : 0;
      return { convention, score };
    })
    .filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.convention.key.localeCompare(b.convention.key))
    .slice(0, limit);
}

export async function getEngineeringConventions(lineage: EngineeringProjectLineage, keys: readonly string[]): Promise<EngineeringConvention[]> {
  const wanted = new Set(keys.map(key => key.trim()).filter(Boolean));
  const current = await readEngineeringScope(lineage);
  return current.conventions.filter(item => wanted.has(item.key));
}

export async function getEngineeringConventionHistory(lineage: EngineeringProjectLineage, keyInput: string): Promise<EngineeringConvention[]> {
  const key = keyInput.trim();
  const current = await readEngineeringScope(lineage);
  return current.conventionRevisions.filter(item => item.key === key).sort((a, b) => a.revision - b.revision);
}
