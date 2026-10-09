import type { Root } from '../../shared/types.js';
import { indexKnowledge, verifyKnowledgeEvidence } from '../knowledge/service.js';
import { readKnowledgeScope } from '../knowledge/store.js';
import type {
  EngineeringEvidenceRef,
  EngineeringProjectLineage,
  EngineeringQualityGateResult,
  EngineeringReviewEvidenceRef,
  EngineeringTask
} from './contracts.js';
import { getEngineeringConventions } from './convention-service.js';
import { engineeringKnowledgeScope, type ResolvedEngineeringLineage } from './lineage.js';
import {
  engineeringReferenceKnowledgeScope,
  verifyEngineeringAuthorizedReference
} from './reference-service.js';
import {
  engineeringDeliberationBasisHash,
  engineeringImplementationBindingHash,
  engineeringSolutionReviewBasisHash,
  getEngineeringTasks
} from './task-service.js';
import { measureEngineeringPhase } from './performance.js';
import { analyzeEngineeringImpact } from './impact-service.js';
import { verifyEngineeringLearningRef } from './learning-service.js';
import { buildEngineeringLearningProposal } from './learning-proposal.js';
import {
  captureEngineeringTaskFiles,
  getEngineeringVerifications,
  sameEngineeringTaskFileSnapshots,
  verifyEngineeringVerification
} from './verification-service.js';
import { inferEngineeringValidationPurpose } from './validation-purpose.js';

const VERIFY_BATCH = 20;

async function verifyRefs(
  lineage: EngineeringProjectLineage,
  refs: readonly EngineeringEvidenceRef[],
  roots: readonly Root[]
): Promise<boolean> {
  if (!refs.length) return true;
  for (let offset = 0; offset < refs.length; offset += VERIFY_BATCH) {
    const batch = refs.slice(offset, offset + VERIFY_BATCH);
    const verified = await verifyKnowledgeEvidence({
      scope: engineeringKnowledgeScope(lineage),
      evidence: batch.map(ref => ({ evidenceId: ref.evidenceId, contentHash: ref.contentHash }))
    }, roots);
    if (!verified.allCurrent) return false;
  }
  return true;
}

async function verifyReviewRefs(
  lineage: EngineeringProjectLineage,
  task: EngineeringTask,
  refs: readonly EngineeringReviewEvidenceRef[],
  roots: readonly Root[],
  currentReferences: ReadonlySet<string>
): Promise<boolean> {
  if (!refs.length) return true;
  const grouped = new Map<string, EngineeringReviewEvidenceRef[]>();
  for (const ref of refs) {
    let scope: string;
    if (ref.origin === 'current_project') {
      if (ref.referenceRootIdentity !== null) return false;
      scope = engineeringKnowledgeScope(lineage);
    } else {
      const rootIdentity = ref.referenceRootIdentity;
      if (!rootIdentity || !currentReferences.has(rootIdentity)
        || !task.authorizedReferences.some(reference => reference.rootIdentity === rootIdentity)) return false;
      scope = engineeringReferenceKnowledgeScope(rootIdentity);
    }
    const list = grouped.get(scope) ?? [];
    list.push(ref);
    grouped.set(scope, list);
  }
  for (const [scope, scopedRefs] of grouped) {
    for (let offset = 0; offset < scopedRefs.length; offset += VERIFY_BATCH) {
      const batch = scopedRefs.slice(offset, offset + VERIFY_BATCH);
      const verified = await verifyKnowledgeEvidence({
        scope,
        evidence: batch.map(ref => ({ evidenceId: ref.evidenceId, contentHash: ref.contentHash }))
      }, roots);
      if (!verified.allCurrent) return false;
    }
  }
  return true;
}

export async function engineeringQualityGate(
  lineage: EngineeringProjectLineage,
  taskKey: string,
  roots: readonly Root[],
  workspace?: ResolvedEngineeringLineage['workspace']
): Promise<EngineeringQualityGateResult> {
  const task = (await getEngineeringTasks(lineage, [taskKey]))[0];
  if (!task) throw new Error(`ENGINEERING_TASK_NOT_FOUND: ${taskKey}`);
  const blockers: string[] = [];
  const attention: string[] = [];
  let evidenceFreshnessVerified = true;
  let referenceBindingsVerified = true;
  let solutionReviewVerified = true;
  let deliberationVerified = true;
  let impactReviewVerified = true;
  const learningRefAssurance = {
    current: 0,
    staleContext: 0,
    staleAdvisory: 0,
    staleReliedUpon: 0
  };
  const currentKnowledge = await measureEngineeringPhase('gate.current_index', async () => workspace
    ? await indexKnowledge({
        scope: engineeringKnowledgeScope(lineage),
        sources: [{ kind: 'source', path: workspace.virtual }],
        mode: 'incremental'
      }, roots)
    : await readKnowledgeScope(engineeringKnowledgeScope(lineage)));
  const currentReferenceRoots = new Set<string>();
  const referenceRefreshes = await Promise.all(task.authorizedReferences.map(async reference => {
    const current = await verifyEngineeringAuthorizedReference(reference, roots);
    if (!current.current) return { reference, current, error: null as string | null };
    try {
      await measureEngineeringPhase('gate.reference_index', () => indexKnowledge({
        scope: engineeringReferenceKnowledgeScope(reference.rootIdentity),
        sources: [{ kind: 'source', path: current.virtual }],
        mode: 'incremental'
      }, roots));
      return { reference, current, error: null as string | null };
    } catch (error) {
      return {
        reference,
        current,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }));
  for (const { reference, current, error } of referenceRefreshes) {
    if (!current.current) {
      referenceBindingsVerified = false;
      evidenceFreshnessVerified = false;
      blockers.push(`Authorized reference is stale or unavailable (${reference.virtualPath}): ${current.reason}.`);
      continue;
    }
    if (error) {
      referenceBindingsVerified = false;
      evidenceFreshnessVerified = false;
      blockers.push(
        `Authorized reference could not be refreshed (${reference.virtualPath}): ${error}.`
      );
      continue;
    }
    currentReferenceRoots.add(reference.rootIdentity);
  }

  if (task.openQuestions.length) blockers.push(`${task.openQuestions.length} unresolved engineering question(s).`);
  const passed = task.validations.filter(validation => validation.status === 'passed');
  const reportedPassed = passed.filter(validation => !(validation.evidence ?? []).some(ref => ref.relation === 'supports'));
  const evidenceBackedPassed = passed.filter(validation => (validation.evidence ?? []).some(ref => ref.relation === 'supports'));
  for (const validation of evidenceBackedPassed) {
    if (!await verifyRefs(lineage, validation.evidence ?? [], roots)) {
      evidenceFreshnessVerified = false;
      blockers.push(`Validation evidence is stale, missing or mismatched: ${validation.name}.`);
    }
  }

  const verificationRecords = await getEngineeringVerifications(lineage, task.key);
  const resolved = workspace ? { lineage, workspace } : null;
  const sharedVerificationChecks = task.validations.filter(validation => {
    const purpose = validation.purpose ?? inferEngineeringValidationPurpose(validation.name);
    return verificationRecords.some(candidate =>
      candidate.kind === 'command'
      && candidate.name === validation.name
      && candidate.command?.purpose === purpose);
  }).length + (task.largeDataRisk && verificationRecords.some(candidate => candidate.kind === 'sql_scale') ? 1 : 0);
  const currentTaskFiles = resolved && sharedVerificationChecks > 1
    ? await measureEngineeringPhase('gate.changed_files', () => captureEngineeringTaskFiles(task, resolved, roots))
        .catch(() => undefined)
    : undefined;
  const commandVerifications: EngineeringQualityGateResult['assurance']['commandVerifications'] = [];
  for (const validation of task.validations) {
    const purpose = validation.purpose ?? inferEngineeringValidationPurpose(validation.name);
    const record = [...verificationRecords]
      .reverse()
      .find(candidate => candidate.kind === 'command' && candidate.name === validation.name && candidate.command?.purpose === purpose);
    if (!record) {
      commandVerifications.push({ name: validation.name, purpose, status: 'missing', verificationId: null });
      if (validation.status === 'failed') blockers.push(`Task-reported validation failed and has no machine verification: ${validation.name}.`);
      else if (validation.status === 'pending') attention.push(`Validation is pending machine verification: ${validation.name}.`);
      else attention.push(`Task reports validation passed, but no Core-owned validation_run record exists: ${validation.name}.`);
      continue;
    }
    if (!resolved) {
      commandVerifications.push({ name: validation.name, purpose, status: 'stale', verificationId: record.id });
      blockers.push(`Machine verification cannot be checked without the current project workspace: ${validation.name}.`);
      continue;
    }
    const current = await verifyEngineeringVerification(
      record,
      task,
      resolved,
      roots,
      currentKnowledge.generation,
      currentTaskFiles
    );
    if (!current.current) {
      commandVerifications.push({ name: validation.name, purpose, status: 'stale', verificationId: record.id });
      blockers.push(`Machine verification is stale for ${validation.name}: ${current.reason}.`);
      continue;
    }
    if (!record.success) {
      commandVerifications.push({ name: validation.name, purpose, status: 'current-fail', verificationId: record.id });
      blockers.push(`Machine validation failed: ${validation.name}.`);
      continue;
    }
    commandVerifications.push({ name: validation.name, purpose, status: 'current-pass', verificationId: record.id });
  }

  if (task.evidence.length) {
    if (!await verifyRefs(lineage, task.evidence, roots)) {
      evidenceFreshnessVerified = false;
      blockers.push('One or more task evidence references are stale, missing or mismatched.');
    }
  }

  if (task.prepared) {
    if (task.analogueEvidence.length && !await verifyRefs(lineage, task.analogueEvidence, roots)) {
      evidenceFreshnessVerified = false;
      blockers.push('One or more prepared analogue evidence references are stale, missing or mismatched.');
    }
    if (task.referenceAnalogueEvidence.some(ref => ref.origin !== 'authorized_reference')) {
      referenceBindingsVerified = false;
      blockers.push('Prepared reference analogue evidence contains an invalid non-reference origin.');
    } else if (task.referenceAnalogueEvidence.length && !await verifyReviewRefs(
      lineage,
      task,
      task.referenceAnalogueEvidence,
      roots,
      currentReferenceRoots
    )) {
      evidenceFreshnessVerified = false;
      referenceBindingsVerified = false;
      blockers.push('One or more prepared reference analogue evidence items are stale, unauthorized or mismatched.');
    }
    const preparedAnalogueCount = task.analogueEvidence.length + task.referenceAnalogueEvidence.length;
    if (preparedAnalogueCount < 3) {
      blockers.push(`Prepared workflow has only ${preparedAnalogueCount} independent analogue(s) from the current project or authorized references; at least 3 are required before project-native implementation is considered grounded.`);
    }
    if (preparedAnalogueCount > 7) {
      blockers.push(`Prepared workflow has ${preparedAnalogueCount} analogue(s); the bounded task packet allows at most 7.`);
    }
    const expected = new Set([
      ...task.analogueEvidence.map(ref => `${ref.evidenceId}:${ref.contentHash}`),
      ...task.referenceAnalogueEvidence.map(ref => `${ref.evidenceId}:${ref.contentHash}`)
    ]);
    const assessed = new Set(
      task.analogueAssessments
        .filter(item => expected.has(`${item.evidenceId}:${item.contentHash}`))
        .map(item => `${item.evidenceId}:${item.contentHash}`)
    );
    const missingAssessments = [...expected].filter(key => !assessed.has(key));
    if (missingAssessments.length) {
      blockers.push(
        `${missingAssessments.length} prepared analogue(s) still require task-scoped classification as convention, business_rule, legacy_debt or engineering_improvement.`
      );
    }
    const foreignAssessments = task.analogueAssessments.filter(item => !expected.has(`${item.evidenceId}:${item.contentHash}`));
    if (foreignAssessments.length) blockers.push(`${foreignAssessments.length} analogue assessment(s) do not belong to this task's prepared analogue evidence.`);

    if (task.deliberationStatus === 'pending') {
      deliberationVerified = false;
      blockers.push('Deliberation is still pending: classify the task as not_required with a concrete rationale or compare 2-3 solution options before implementation completion.');
    } else if (task.deliberationStatus === 'not_required') {
      const expectedDeliberationBasis = engineeringDeliberationBasisHash(task);
      if (!task.deliberationBasisHash || task.deliberationBasisHash !== expectedDeliberationBasis) {
        deliberationVerified = false;
        blockers.push('Deliberation is stale: task requirements, evidence, review findings or deliberation rationale changed after it was classified.');
      }
      if (!task.deliberationSummary.trim()) {
        deliberationVerified = false;
        blockers.push('Deliberation marked not_required requires a concrete evidence-based rationale.');
      }
      if (task.deliberationQuestion.trim() || task.deliberationTriggers.length
        || task.solutionOptions.length || task.selectedOptionKey || task.implementedOptionKey) {
        deliberationVerified = false;
        blockers.push('Deliberation marked not_required cannot carry a decision question, triggers, solution-option selection or implementation mapping.');
      }
    } else {
      const expectedDeliberationBasis = engineeringDeliberationBasisHash(task);
      if (!task.deliberationBasisHash || task.deliberationBasisHash !== expectedDeliberationBasis) {
        deliberationVerified = false;
        blockers.push('Deliberation is stale: task requirements, evidence, review findings or solution options changed after the decision.');
      }
      if (task.solutionOptions.length < 2 || task.solutionOptions.length > 3) {
        deliberationVerified = false;
        blockers.push(`Deliberation requires 2-3 concrete solution options; found ${task.solutionOptions.length}.`);
      }
      if (!task.deliberationQuestion.trim()) {
        deliberationVerified = false;
        blockers.push('Deliberation requires an explicit decision question.');
      }
      if (!task.deliberationTriggers.length) {
        deliberationVerified = false;
        blockers.push('Deliberation requires at least one trigger category explaining why multiple options are material.');
      }
      const optionKeys = task.solutionOptions.map(option => option.key);
      if (new Set(optionKeys).size !== optionKeys.length) {
        deliberationVerified = false;
        blockers.push('Deliberation contains duplicate solution-option keys.');
      }
      if (!task.deliberationSummary.trim()) {
        deliberationVerified = false;
        blockers.push('Deliberation requires a summary of the decision context and trade-offs.');
      }
      if (!task.deliberationDecisionNote.trim()) {
        deliberationVerified = false;
        blockers.push('Deliberation requires a decision note explaining why the selected option won.');
      }
      const selected = task.selectedOptionKey
        ? task.solutionOptions.find(option => option.key === task.selectedOptionKey)
        : undefined;
      if (!selected) {
        deliberationVerified = false;
        blockers.push('Deliberation must select exactly one current solution option.');
      }
      for (const option of task.solutionOptions) {
        if (!option.tradeoffs.length) {
          deliberationVerified = false;
          blockers.push(`Solution option ${option.key} must record at least one trade-off.`);
        }
        if (!await verifyReviewRefs(lineage, task, option.evidence, roots, currentReferenceRoots)) {
          evidenceFreshnessVerified = false;
          solutionReviewVerified = false;
          deliberationVerified = false;
          blockers.push(`Solution option evidence is stale, unauthorized or mismatched: ${option.key}.`);
        }
        if (selected && option.key !== selected.key && !option.rejectedReason.trim()) {
          deliberationVerified = false;
          blockers.push(`Rejected solution option ${option.key} requires a rejection reason.`);
        }
      }
      if (task.changedFiles.length && task.implementedOptionKey !== task.selectedOptionKey) {
        deliberationVerified = false;
        blockers.push('Implementation is not mapped to the selected deliberation option.');
      }
      if (task.changedFiles.length && task.implementedOptionKey === task.selectedOptionKey) {
        const expectedImplementationBinding = engineeringImplementationBindingHash(task);
        if (!task.implementationBindingHash || task.implementationBindingHash !== expectedImplementationBinding) {
          deliberationVerified = false;
          blockers.push('Implementation binding is stale: selected option, reviewed basis, changed files or implemented findings changed after the implementation was mapped.');
        }
      }
      if (task.deliberationAuthority === 'user' && task.deliberationDecisionNote.trim().length < 3) {
        deliberationVerified = false;
        blockers.push('A user-authority deliberation decision requires a recorded decision note.');
      }
    }
  }

  if (task.solutionReviewRequired) {
    if (task.solutionReviewStatus !== 'reviewed') {
      solutionReviewVerified = false;
      blockers.push('Solution review is required before implementation completion.');
    }
    if (!task.solutionReviewSummary.trim()) {
      solutionReviewVerified = false;
      blockers.push('Solution review requires a summary that separates requested behavior, evidence-required changes and proposals.');
    }
    const expectedBasis = engineeringSolutionReviewBasisHash(task);
    if (!task.solutionReviewBasisHash || task.solutionReviewBasisHash !== expectedBasis) {
      solutionReviewVerified = false;
      blockers.push('Solution review is stale: requirements, evidence, references or review findings changed after the last reviewed basis.');
    }

    const expectedRequirements = new Set(task.requirements);
    const comparisonsByRequirement = new Map(task.requirementComparisons.map(item => [item.requirement, item]));
    const missingComparisons = task.requirements.filter(requirement => !comparisonsByRequirement.has(requirement));
    const foreignComparisons = task.requirementComparisons.filter(item => !expectedRequirements.has(item.requirement));
    if (missingComparisons.length) {
      solutionReviewVerified = false;
      blockers.push(`${missingComparisons.length} requirement(s) still lack solution comparison review.`);
    }
    if (foreignComparisons.length) {
      solutionReviewVerified = false;
      blockers.push(`${foreignComparisons.length} solution comparison item(s) no longer belong to current task requirements.`);
    }

    const findingKeys = task.solutionFindings.map(finding => finding.key);
    const uniqueFindingKeys = new Set(findingKeys);
    if (uniqueFindingKeys.size !== findingKeys.length) {
      solutionReviewVerified = false;
      blockers.push('Solution review contains duplicate finding keys.');
    }
    const findingByKey = new Map(task.solutionFindings.map(finding => [finding.key, finding]));
    const implemented = new Set(task.implementedFindingKeys);
    const unknownImplemented = task.implementedFindingKeys.filter(key => !findingByKey.has(key));
    if (unknownImplemented.length) {
      solutionReviewVerified = false;
      blockers.push(`${unknownImplemented.length} implemented finding key(s) do not belong to the current solution review.`);
    }

    for (const comparison of task.requirementComparisons) {
      if (comparison.status === 'investigate' || comparison.proposedDisposition === 'investigate') {
        solutionReviewVerified = false;
        blockers.push(`Requirement comparison remains unresolved: ${comparison.requirement}`);
      }
      if (comparison.currentEvidence.some(ref => ref.origin !== 'current_project' || ref.referenceRootIdentity !== null)) {
        solutionReviewVerified = false;
        blockers.push(`Requirement comparison current evidence has invalid provenance: ${comparison.requirement}`);
      } else if (!await verifyReviewRefs(lineage, task, comparison.currentEvidence, roots, currentReferenceRoots)) {
        evidenceFreshnessVerified = false;
        solutionReviewVerified = false;
        blockers.push(`Requirement comparison current evidence is stale or mismatched: ${comparison.requirement}`);
      }
      if (comparison.referenceEvidence.some(ref => ref.origin !== 'authorized_reference')) {
        referenceBindingsVerified = false;
        solutionReviewVerified = false;
        blockers.push(`Requirement comparison reference evidence has invalid provenance: ${comparison.requirement}`);
      } else if (!await verifyReviewRefs(lineage, task, comparison.referenceEvidence, roots, currentReferenceRoots)) {
        evidenceFreshnessVerified = false;
        referenceBindingsVerified = false;
        solutionReviewVerified = false;
        blockers.push(`Requirement comparison reference evidence is stale, unauthorized or mismatched: ${comparison.requirement}`);
      }
      const unknownFindingKeys = comparison.findingKeys.filter(key => !findingByKey.has(key));
      if (unknownFindingKeys.length) {
        solutionReviewVerified = false;
        blockers.push(`Requirement comparison references unknown solution finding(s): ${comparison.requirement}`);
      }
    }

    for (const finding of task.solutionFindings) {
      const unknownRequirements = finding.affectedRequirements.filter(requirement => !expectedRequirements.has(requirement));
      if (unknownRequirements.length) {
        solutionReviewVerified = false;
        blockers.push(`Solution finding ${finding.key} references requirement(s) outside the current task.`);
      }
      if (!await verifyReviewRefs(lineage, task, finding.evidence, roots, currentReferenceRoots)) {
        evidenceFreshnessVerified = false;
        solutionReviewVerified = false;
        blockers.push(`Solution finding evidence is stale, unauthorized or mismatched: ${finding.key}.`);
      }
      if ((finding.disposition === 'decision_required' || finding.disposition === 'investigate')
        && finding.decision === 'pending') {
        solutionReviewVerified = false;
        blockers.push(`Solution finding still requires a decision: ${finding.key}.`);
      }
      if (finding.disposition === 'must_address') {
        if (finding.decision === 'pending' || finding.decision === 'rejected') {
          solutionReviewVerified = false;
          blockers.push(`Evidence-required solution finding is not accepted/resolved: ${finding.key}.`);
        }
        if (!implemented.has(finding.key)) {
          solutionReviewVerified = false;
          blockers.push(`Evidence-required solution finding is not mapped to the implementation: ${finding.key}.`);
        }
      }
      if (finding.decision !== 'pending' && finding.decision !== 'not_required' && !finding.decisionNote.trim()) {
        solutionReviewVerified = false;
        blockers.push(`Recorded solution decision requires a decision note: ${finding.key}.`);
      }
      if (implemented.has(finding.key)
        && ['contradiction', 'process_risk', 'proposed_improvement', 'investigate'].includes(finding.type)
        && finding.decision !== 'accepted') {
        solutionReviewVerified = false;
        blockers.push(`Solution finding was implemented without an accepted business/process decision: ${finding.key}.`);
      }
    }
  }

  if (task.impactReviewRequired && task.changedFiles.length) {
    if (!resolved) {
      impactReviewVerified = false;
      blockers.push('Changed-file impact review cannot be verified without the current project workspace.');
    } else {
      try {
        const impact = await measureEngineeringPhase(
          'gate.impact_review',
          () => analyzeEngineeringImpact(resolved, task, roots, { refreshKnowledge: false })
        );
        if (!impact.coverageComplete) {
          impactReviewVerified = false;
          blockers.push('Changed-file impact review coverage is incomplete: one or more changed source files are absent from the current Implementation Graph or graph expansion was truncated.');
        } else if (task.impactReviewStatus === 'reviewed' && task.impactReviewBasisHash) {
          if (task.impactReviewBasisHash !== impact.basisHash) {
            impactReviewVerified = false;
            blockers.push('Changed-file impact review is stale: changed file content or high-confidence implementation-graph impacts changed after review.');
          } else {
            const assessmentById = new Map(task.impactAssessments.map(assessment => [assessment.nodeId, assessment]));
            const missing = impact.required.filter(target => !assessmentById.has(target.nodeId));
            if (missing.length) {
              impactReviewVerified = false;
              blockers.push(`${missing.length} high-confidence changed-file impact(s) still require assessment.`);
            }
            for (const target of impact.required) {
              const assessment = assessmentById.get(target.nodeId);
              if (!assessment || assessment.decision !== 'changed'
                || !['process', 'rule', 'expected_behavior'].includes(target.kind)) continue;
              const acceptedFinding = task.solutionFindings.find(finding =>
                target.recordKey !== null
                && finding.processKeys.includes(target.recordKey)
                && finding.decision === 'accepted'
                && task.implementedFindingKeys.includes(finding.key));
              if (task.deliberationStatus !== 'decided'
                || task.deliberationAuthority !== 'user'
                || !acceptedFinding) {
                impactReviewVerified = false;
                blockers.push(
                  `Changed accepted business impact ${target.label} requires a user-authority deliberation and an accepted implemented solution finding bound to ${target.recordKey ?? target.nodeId}.`
                );
              }
            }
          }
        } else if (!impact.required.length) {
          impactReviewVerified = true;
        } else {
          impactReviewVerified = false;
          blockers.push('Changed-file impact review is required: run impact_get, assess every high-confidence accepted Process / Rule / Expected Behavior and database contract impact, then record impact_put.');
        }
      } catch (error) {
        impactReviewVerified = false;
        blockers.push(`Changed-file impact review could not be verified: ${error instanceof Error ? error.message : String(error)}.`);
      }
    }
  }

  if (task.learningRefs.length) {
    const learning = await Promise.all(task.learningRefs.map(ref => verifyEngineeringLearningRef(ref)));
    for (const item of learning) {
      if (item.status === 'current') {
        learningRefAssurance.current += 1;
        continue;
      }
      if (item.ref.role === 'relied_upon') {
        learningRefAssurance.staleReliedUpon += 1;
        blockers.push(`Relied-upon learning is ${item.status}: ${item.ref.kind}:${item.ref.key}. ${item.detail}`);
      } else if (item.ref.role === 'advisory') {
        learningRefAssurance.staleAdvisory += 1;
      } else {
        learningRefAssurance.staleContext += 1;
      }
    }
  }

  if (task.conventionKeys.length) {
    const conventions = await getEngineeringConventions(lineage, task.conventionKeys);
    const found = new Set(conventions.map(item => item.key));
    const missing = task.conventionKeys.filter(key => !found.has(key));
    if (missing.length) blockers.push(`Missing convention record(s): ${missing.join(', ')}.`);
    const unreviewed = conventions.filter(item => item.status !== 'reviewed');
    if (unreviewed.length) attention.push(`${unreviewed.length} referenced convention(s) are not reviewed.`);
    for (const convention of conventions.filter(item => item.status === 'reviewed' && item.provenance === 'observed')) {
      if (!await verifyRefs(lineage, convention.evidence, roots)) {
        evidenceFreshnessVerified = false;
        blockers.push(`Reviewed convention evidence is stale, missing or mismatched: ${convention.key}.`);
      }
    }
  }

  let scaleVerification: EngineeringQualityGateResult['assurance']['scaleVerification'] = {
    status: 'not-required',
    verificationId: null
  };
  if (task.largeDataRisk) {
    const scaleRecord = [...verificationRecords].reverse().find(candidate => candidate.kind === 'sql_scale');
    if (!scaleRecord) {
      scaleVerification = { status: 'missing', verificationId: null };
      blockers.push('Large-data risk requires a Core-owned sql_scale validation_run; task scaleStatus alone is not machine proof.');
    } else if (!resolved) {
      scaleVerification = { status: 'stale', verificationId: scaleRecord.id };
      blockers.push('SQL scale verification cannot be checked without the current project workspace.');
    } else {
      const current = await verifyEngineeringVerification(
        scaleRecord,
        task,
        resolved,
        roots,
        currentKnowledge.generation,
        currentTaskFiles
      );
      if (!current.current) {
        scaleVerification = { status: 'stale', verificationId: scaleRecord.id };
        blockers.push(`SQL scale verification is stale: ${current.reason}.`);
      } else if (!scaleRecord.success) {
        scaleVerification = { status: 'current-fail', verificationId: scaleRecord.id };
        blockers.push('SQL scale verification did not establish the requested runtime evidence.');
      } else if (scaleRecord.scale?.level === 'runtime') {
        scaleVerification = { status: 'current-runtime', verificationId: scaleRecord.id };
      } else {
        scaleVerification = { status: 'current-static', verificationId: scaleRecord.id };
        attention.push('SQL table/index/statistics shape is machine-captured, but runtime scalability is not proven.');
      }
    }
  }
  if (task.remainingRisks.length) attention.push(`${task.remainingRisks.length} remaining risk(s) are recorded.`);
  if (!task.validations.length) {
    attention.push('No validation result is recorded for this task; quality_gate cannot establish implementation completion.');
  }

  if (task.knowledgeGeneration !== currentKnowledge.generation
    && !verificationRecords.some(record => record.knowledgeGeneration === currentKnowledge.generation)) {
    attention.push('Project Engineering knowledge changed after this task revision was saved; review the task against the current source snapshot before completion.');
  }

  const executionReplayed = commandVerifications.length > 0
    && commandVerifications.every(item => item.status === 'current-pass');
  const hasSubstantiveExecution = commandVerifications.some(item =>
    item.status === 'current-pass' && ['build', 'test', 'typecheck'].includes(item.purpose));
  if (executionReplayed && !hasSubstantiveExecution) {
    attention.push('Machine validation ran only custom/lint commands; at least one build, test or typecheck verification is required for Machine Verified.');
  }
  const candidateMachineVerified = blockers.length === 0
    && attention.length === 0
    && executionReplayed
    && hasSubstantiveExecution
    && (scaleVerification.status === 'not-required' || scaleVerification.status === 'current-runtime');
  if (candidateMachineVerified && resolved) {
    const latestTask = (await getEngineeringTasks(lineage, [task.key]))[0];
    if (!latestTask || latestTask.revision !== task.revision) {
      blockers.push('Engineering task changed while the quality gate was running; run the gate again against the current revision.');
    } else if (currentTaskFiles) {
      try {
        const finalTaskFiles = await measureEngineeringPhase(
          'gate.final_changed_files',
          () => captureEngineeringTaskFiles(task, resolved, roots)
        );
        if (!sameEngineeringTaskFileSnapshots(currentTaskFiles, finalTaskFiles)) {
          blockers.push('One or more implementation files changed while the quality gate was running; run validation again.');
        }
      } catch (error) {
        blockers.push(`Final implementation-file freshness check failed: ${error instanceof Error ? error.message : String(error)}.`);
      }
    }
  }
  const machineVerified = blockers.length === 0
    && attention.length === 0
    && executionReplayed
    && hasSubstantiveExecution
    && (scaleVerification.status === 'not-required' || scaleVerification.status === 'current-runtime');
  const learningProposalVerificationIds = [
    ...commandVerifications
      .filter(item => item.status === 'current-pass' && item.verificationId)
      .map(item => item.verificationId!),
    ...(scaleVerification.status === 'current-runtime' && scaleVerification.verificationId
      ? [scaleVerification.verificationId]
      : [])
  ];
  const learningProposal = buildEngineeringLearningProposal(task, machineVerified, learningProposalVerificationIds);

  return {
    lineage,
    task,
    status: blockers.length ? 'blocked' : attention.length ? 'attention' : 'pass',
    blockers,
    attention,
    assurance: {
      evidenceFreshnessVerified,
      referenceBindingsVerified,
      solutionReviewVerified,
      deliberationVerified,
      impactReviewVerified,
      learningRefs: learningRefAssurance,
      executionReplayed,
      machineVerified,
      reportedPassedValidations: reportedPassed.length,
      evidenceBackedPassedValidations: evidenceBackedPassed.length,
      commandVerifications,
      scaleVerification
    },
    learningProposal
  };
}
