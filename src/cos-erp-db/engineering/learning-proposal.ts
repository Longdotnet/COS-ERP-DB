import type {
  EngineeringQualityGateResult,
  EngineeringTask
} from './contracts.js';

type LearningProposal = EngineeringQualityGateResult['learningProposal'];

export function buildEngineeringLearningProposal(
  task: EngineeringTask,
  machineVerified: boolean,
  verificationIds: readonly string[]
): LearningProposal {
  const candidates: LearningProposal['candidates'] = [];
  const eligible = machineVerified && task.prepared && task.solutionReviewStatus === 'reviewed';
  if (eligible) {
    const implemented = new Set(task.implementedFindingKeys);
    for (const finding of task.solutionFindings) {
      if (!implemented.has(finding.key) || finding.decision !== 'accepted' || finding.confidence !== 'high') continue;
      const evidence = finding.evidence.filter(ref => ref.origin === 'current_project');
      if (!evidence.length) continue;
      const kind = finding.type === 'proposed_improvement' || finding.type === 'implementation_risk'
        ? 'convention_review' as const
        : finding.type === 'required_by_evidence' || finding.type === 'process_risk'
          ? 'business_process_review' as const
          : null;
      if (!kind) continue;
      candidates.push({
        kind,
        sourceFindingKey: finding.key,
        title: finding.title,
        statement: finding.recommendation,
        processKeys: [...finding.processKeys],
        evidence,
        requiresExplicitReview: true
      });
    }
  }
  return {
    eligible,
    sourceTaskKey: task.key,
    sourceTaskRevision: task.revision,
    implementationBindingHash: task.implementationBindingHash,
    verificationIds: [...new Set(verificationIds)].sort((left, right) => left.localeCompare(right)),
    autoPersisted: false,
    candidates
  };
}
