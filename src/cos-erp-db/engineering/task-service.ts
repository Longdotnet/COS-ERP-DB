import { createHash } from 'node:crypto';
import type {
  EngineeringAuthorizedReference,
  EngineeringImpactAssessment,
  EngineeringImpactReviewStatus,
  EngineeringLearningRefInput,
  EngineeringProjectLineage,
  EngineeringTask,
  EngineeringTaskInput
} from './contracts.js';
import { readKnowledgeScope } from '../knowledge/store.js';
import { engineeringKnowledgeScope } from './lineage.js';
import { mutateEngineeringScope, readEngineeringScope } from './store.js';
import { inferEngineeringValidationPurpose } from './validation-purpose.js';
import {
  bindEngineeringLearningRefs,
  mergeDiscoveredEngineeringLearningRefs,
  reliedUponLearningBasis
} from './learning-service.js';

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cleanList(values: readonly string[] | undefined, max: number): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))].slice(0, max);
}

export function engineeringSolutionReviewBasisHash(task: Pick<
  EngineeringTask,
  | 'goal'
  | 'requirements'
  | 'decisions'
  | 'openQuestions'
  | 'evidence'
  | 'analogueEvidence'
  | 'referenceAnalogueEvidence'
  | 'analogueAssessments'
  | 'authorizedReferences'
  | 'requirementComparisons'
  | 'solutionFindings'
  | 'deliberationStatus'
  | 'deliberationQuestion'
  | 'deliberationTriggers'
  | 'deliberationSummary'
  | 'deliberationAuthority'
  | 'solutionOptions'
  | 'selectedOptionKey'
  | 'deliberationDecisionNote'
  | 'learningRefs'
  | 'conventionKeys'
  | 'largeDataRisk'
>): string {
  return hash(JSON.stringify({
    goal: task.goal,
    requirements: task.requirements,
    decisions: task.decisions,
    openQuestions: task.openQuestions,
    evidence: task.evidence,
    analogueEvidence: task.analogueEvidence,
    referenceAnalogueEvidence: task.referenceAnalogueEvidence,
    analogueAssessments: task.analogueAssessments,
    authorizedReferences: task.authorizedReferences,
    requirementComparisons: task.requirementComparisons,
    solutionFindings: task.solutionFindings,
    deliberationStatus: task.deliberationStatus,
    deliberationQuestion: task.deliberationQuestion,
    deliberationTriggers: task.deliberationTriggers,
    deliberationSummary: task.deliberationSummary,
    deliberationAuthority: task.deliberationAuthority,
    solutionOptions: task.solutionOptions,
    selectedOptionKey: task.selectedOptionKey,
    deliberationDecisionNote: task.deliberationDecisionNote,
    learningRefs: reliedUponLearningBasis(task.learningRefs),
    conventionKeys: task.conventionKeys,
    largeDataRisk: task.largeDataRisk
  }));
}

export function engineeringImplementationBindingHash(task: Pick<
  EngineeringTask,
  | 'deliberationBasisHash'
  | 'solutionReviewBasisHash'
  | 'selectedOptionKey'
  | 'implementedOptionKey'
  | 'changedFiles'
  | 'implementedFindingKeys'
>): string {
  return hash(JSON.stringify({
    deliberationBasisHash: task.deliberationBasisHash,
    solutionReviewBasisHash: task.solutionReviewBasisHash,
    selectedOptionKey: task.selectedOptionKey,
    implementedOptionKey: task.implementedOptionKey,
    changedFiles: [...task.changedFiles].sort((a, b) => a.localeCompare(b)),
    implementedFindingKeys: [...task.implementedFindingKeys].sort((a, b) => a.localeCompare(b))
  }));
}

export function engineeringDeliberationBasisHash(task: Pick<
  EngineeringTask,
  | 'goal'
  | 'requirements'
  | 'decisions'
  | 'openQuestions'
  | 'evidence'
  | 'analogueEvidence'
  | 'referenceAnalogueEvidence'
  | 'analogueAssessments'
  | 'authorizedReferences'
  | 'requirementComparisons'
  | 'solutionFindings'
  | 'deliberationStatus'
  | 'deliberationQuestion'
  | 'deliberationTriggers'
  | 'deliberationSummary'
  | 'deliberationAuthority'
  | 'solutionOptions'
  | 'selectedOptionKey'
  | 'deliberationDecisionNote'
  | 'learningRefs'
  | 'conventionKeys'
  | 'largeDataRisk'
>): string {
  return hash(JSON.stringify({
    goal: task.goal,
    requirements: task.requirements,
    decisions: task.decisions,
    openQuestions: task.openQuestions,
    evidence: task.evidence,
    analogueEvidence: task.analogueEvidence,
    referenceAnalogueEvidence: task.referenceAnalogueEvidence,
    analogueAssessments: task.analogueAssessments,
    authorizedReferences: task.authorizedReferences,
    requirementComparisons: task.requirementComparisons,
    solutionFindings: task.solutionFindings,
    deliberationStatus: task.deliberationStatus,
    deliberationQuestion: task.deliberationQuestion,
    deliberationTriggers: task.deliberationTriggers,
    deliberationSummary: task.deliberationSummary,
    deliberationAuthority: task.deliberationAuthority,
    solutionOptions: task.solutionOptions,
    selectedOptionKey: task.selectedOptionKey,
    deliberationDecisionNote: task.deliberationDecisionNote,
    learningRefs: reliedUponLearningBasis(task.learningRefs),
    conventionKeys: task.conventionKeys,
    largeDataRisk: task.largeDataRisk
  }));
}

export async function putEngineeringTask(
  lineage: EngineeringProjectLineage,
  input: EngineeringTaskInput,
  options: {
    prepared?: boolean;
    authorizedReferences?: EngineeringAuthorizedReference[];
    solutionReviewRequired?: boolean;
    impactReviewRequired?: boolean;
    discoveredLearningRefs?: EngineeringLearningRefInput[];
    impactReview?: {
      status: EngineeringImpactReviewStatus;
      assessments: EngineeringImpactAssessment[];
      basisHash: string | null;
      reviewedAt: string | null;
    };
  } = {}
): Promise<EngineeringTask> {
  const key = input.key.trim();
  if (!key || key.length > 160) throw new Error('Engineering task key must contain 1 to 160 characters.');
  const learningScope = engineeringKnowledgeScope(lineage);
  const knowledgeGeneration = (await readKnowledgeScope(learningScope)).generation;
  let saved!: EngineeringTask;
  await mutateEngineeringScope(lineage, async current => {
    const previous = current.tasks.find(task => task.key === key);
    if (input.expectedRevision !== undefined && previous?.revision !== input.expectedRevision) {
      throw new Error(`ENGINEERING_REVISION_MISMATCH: expected ${input.expectedRevision}, current ${previous?.revision ?? 0}`);
    }
    const goal = input.goal?.trim() ?? previous?.goal ?? '';
    if (!goal || goal.length > 12_000) {
      throw new Error('Engineering task goal must contain 1 to 12000 characters when creating a task.');
    }
    const now = new Date().toISOString();
    const impactReviewRequired = options.impactReviewRequired ?? previous?.impactReviewRequired ?? false;
    const changedFiles = input.changedFiles === undefined ? previous?.changedFiles ?? [] : cleanList(input.changedFiles, 256);
    const changedFilesChanged = previous
      ? JSON.stringify([...previous.changedFiles].sort()) !== JSON.stringify([...changedFiles].sort())
      : false;
    const previousLearningRefs = previous?.learningRefs ?? [];
    const learningRefs = input.learningRefs !== undefined
      ? await bindEngineeringLearningRefs(learningScope, input.learningRefs, previousLearningRefs)
      : options.discoveredLearningRefs?.length
        ? await mergeDiscoveredEngineeringLearningRefs(learningScope, previousLearningRefs, options.discoveredLearningRefs)
        : previousLearningRefs;
    saved = {
      id: previous?.id ?? hash(`engineering-task\0${lineage.key}\0${key}`),
      lineageKey: lineage.key,
      prepared: options.prepared ?? previous?.prepared ?? false,
      solutionReviewRequired: options.solutionReviewRequired ?? previous?.solutionReviewRequired ?? false,
      solutionReviewBasisHash: previous?.solutionReviewBasisHash ?? null,
      solutionReviewedAt: previous?.solutionReviewedAt ?? null,
      deliberationBasisHash: previous?.deliberationBasisHash ?? null,
      deliberatedAt: previous?.deliberatedAt ?? null,
      implementationBindingHash: previous?.implementationBindingHash ?? null,
      implementationBoundAt: previous?.implementationBoundAt ?? null,
      impactReviewRequired,
      impactReviewStatus: options.impactReview?.status
        ?? previous?.impactReviewStatus
        ?? (impactReviewRequired ? 'pending' : 'not_required'),
      impactAssessments: options.impactReview?.assessments ?? previous?.impactAssessments ?? [],
      impactReviewBasisHash: options.impactReview?.basisHash ?? previous?.impactReviewBasisHash ?? null,
      impactReviewedAt: options.impactReview?.reviewedAt ?? previous?.impactReviewedAt ?? null,
      learningRefs,
      knowledgeGeneration,
      key,
      goal,
      authorizedReferences: options.authorizedReferences ?? previous?.authorizedReferences ?? [],
      requirements: input.requirements === undefined ? previous?.requirements ?? [] : cleanList(input.requirements, 200),
      decisions: input.decisions === undefined ? previous?.decisions ?? [] : cleanList(input.decisions, 200),
      openQuestions: input.openQuestions === undefined ? previous?.openQuestions ?? [] : cleanList(input.openQuestions, 100),
      evidence: input.evidence === undefined ? previous?.evidence ?? [] : input.evidence.slice(0, 128),
      analogueEvidence: input.analogueEvidence === undefined ? previous?.analogueEvidence ?? [] : input.analogueEvidence.slice(0, 7),
      referenceAnalogueEvidence: input.referenceAnalogueEvidence === undefined
        ? previous?.referenceAnalogueEvidence ?? []
        : input.referenceAnalogueEvidence.slice(0, 7),
      analogueAssessments: input.analogueAssessments === undefined
        ? previous?.analogueAssessments ?? []
        : input.analogueAssessments.slice(0, 14).map(assessment => ({ ...assessment, note: assessment.note.trim() })),
      solutionReviewStatus: input.solutionReviewStatus ?? previous?.solutionReviewStatus ?? 'not_required',
      solutionReviewSummary: input.solutionReviewSummary === undefined
        ? previous?.solutionReviewSummary ?? ''
        : input.solutionReviewSummary.trim(),
      requirementComparisons: input.requirementComparisons === undefined
        ? previous?.requirementComparisons ?? []
        : input.requirementComparisons.slice(0, 200).map(comparison => ({
            ...comparison,
            requirement: comparison.requirement.trim(),
            currentEvidence: comparison.currentEvidence.slice(0, 32),
            referenceEvidence: comparison.referenceEvidence.slice(0, 32),
            findingKeys: cleanList(comparison.findingKeys, 64),
            note: comparison.note.trim()
          })),
      solutionFindings: input.solutionFindings === undefined
        ? previous?.solutionFindings ?? []
        : input.solutionFindings.slice(0, 100).map(finding => ({
            ...finding,
            key: finding.key.trim(),
            title: finding.title.trim(),
            statement: finding.statement.trim(),
            impact: finding.impact.trim(),
            affectedRequirements: cleanList(finding.affectedRequirements, 64),
            processKeys: cleanList(finding.processKeys, 64),
            evidence: finding.evidence.slice(0, 64),
            recommendation: finding.recommendation.trim(),
            decisionNote: finding.decisionNote.trim()
          })),
      implementedFindingKeys: input.implementedFindingKeys === undefined
        ? previous?.implementedFindingKeys ?? []
        : cleanList(input.implementedFindingKeys, 100),
      deliberationStatus: input.deliberationStatus ?? previous?.deliberationStatus ?? 'not_required',
      deliberationQuestion: input.deliberationQuestion === undefined
        ? previous?.deliberationQuestion ?? ''
        : input.deliberationQuestion.trim(),
      deliberationTriggers: input.deliberationTriggers === undefined
        ? previous?.deliberationTriggers ?? []
        : [...new Set(input.deliberationTriggers)].slice(0, 9),
      deliberationSummary: input.deliberationSummary === undefined
        ? previous?.deliberationSummary ?? 'Direct task did not require explicit deliberation.'
        : input.deliberationSummary.trim(),
      deliberationAuthority: input.deliberationAuthority ?? previous?.deliberationAuthority ?? 'agent',
      solutionOptions: input.solutionOptions === undefined
        ? previous?.solutionOptions ?? []
        : input.solutionOptions.slice(0, 3).map(option => ({
            ...option,
            key: option.key.trim(),
            title: option.title.trim(),
            approach: option.approach.trim(),
            benefits: cleanList(option.benefits, 32),
            tradeoffs: cleanList(option.tradeoffs, 32),
            risks: cleanList(option.risks, 32),
            evidence: option.evidence.slice(0, 64),
            rejectedReason: option.rejectedReason.trim()
          })),
      selectedOptionKey: input.selectedOptionKey === undefined
        ? previous?.selectedOptionKey ?? null
        : input.selectedOptionKey?.trim() || null,
      deliberationDecisionNote: input.deliberationDecisionNote === undefined
        ? previous?.deliberationDecisionNote ?? 'Direct task did not require explicit deliberation.'
        : input.deliberationDecisionNote.trim(),
      implementedOptionKey: input.implementedOptionKey === undefined
        ? previous?.implementedOptionKey ?? null
        : input.implementedOptionKey?.trim() || null,
      conventionKeys: input.conventionKeys === undefined ? previous?.conventionKeys ?? [] : cleanList(input.conventionKeys, 128),
      changedFiles,
      validations: input.validations === undefined ? previous?.validations ?? [] : input.validations.slice(0, 128).map(validation => ({
        ...validation,
        purpose: validation.purpose ?? inferEngineeringValidationPurpose(validation.name),
        evidence: (validation.evidence ?? []).slice(0, 32)
      })),
      largeDataRisk: input.largeDataRisk ?? previous?.largeDataRisk ?? false,
      scaleStatus: input.scaleStatus ?? previous?.scaleStatus ?? 'not_assessed',
      scaleEvidence: input.scaleEvidence === undefined ? previous?.scaleEvidence ?? [] : input.scaleEvidence.slice(0, 32),
      remainingRisks: input.remainingRisks === undefined ? previous?.remainingRisks ?? [] : cleanList(input.remainingRisks, 100),
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    };
    if (!saved.impactReviewRequired) {
      saved.impactReviewStatus = 'not_required';
      saved.impactAssessments = [];
      saved.impactReviewBasisHash = null;
      saved.impactReviewedAt = null;
    } else if (previous?.impactReviewRequired !== true && options.impactReview === undefined) {
      saved.impactReviewStatus = 'pending';
      saved.impactAssessments = [];
      saved.impactReviewBasisHash = null;
      saved.impactReviewedAt = null;
    } else if (changedFilesChanged && options.impactReview === undefined) {
      saved.impactReviewStatus = 'pending';
      saved.impactAssessments = [];
      saved.impactReviewBasisHash = null;
      saved.impactReviewedAt = null;
    }
    if (input.solutionReviewStatus !== undefined) {
      if (saved.solutionReviewStatus === 'reviewed') {
        saved.solutionReviewBasisHash = engineeringSolutionReviewBasisHash(saved);
        saved.solutionReviewedAt = now;
      } else {
        saved.solutionReviewBasisHash = null;
        saved.solutionReviewedAt = null;
      }
    }
    if (input.deliberationStatus !== undefined) {
      if (saved.deliberationStatus === 'pending') {
        saved.deliberationBasisHash = null;
        saved.deliberatedAt = null;
      } else {
        saved.deliberationBasisHash = engineeringDeliberationBasisHash(saved);
        saved.deliberatedAt = now;
      }
    }
    if (input.implementedOptionKey !== undefined) {
      if (!saved.implementedOptionKey) {
        saved.implementationBindingHash = null;
        saved.implementationBoundAt = null;
      } else {
        saved.implementationBindingHash = engineeringImplementationBindingHash(saved);
        saved.implementationBoundAt = now;
      }
    }
    return {
      ...current,
      lineage: { ...lineage },
      updatedAt: now,
      tasks: [...current.tasks.filter(task => task.key !== key), saved],
      taskRevisions: [...current.taskRevisions, saved]
    };
  });
  return saved;
}

export async function getEngineeringTasks(lineage: EngineeringProjectLineage, keys: readonly string[]): Promise<EngineeringTask[]> {
  const wanted = new Set(keys.map(key => key.trim()).filter(Boolean));
  const current = await readEngineeringScope(lineage);
  return current.tasks.filter(task => wanted.has(task.key));
}

export async function getEngineeringTaskHistory(lineage: EngineeringProjectLineage, keyInput: string): Promise<EngineeringTask[]> {
  const key = keyInput.trim();
  const current = await readEngineeringScope(lineage);
  return current.taskRevisions.filter(task => task.key === key).sort((a, b) => a.revision - b.revision);
}
