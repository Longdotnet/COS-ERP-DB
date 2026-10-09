export type EngineeringConventionClassification =
  | 'convention'
  | 'business_rule'
  | 'legacy_debt'
  | 'engineering_improvement';

export type EngineeringConventionProvenance = 'observed' | 'declared_policy';
export type EngineeringConventionStatus = 'draft' | 'reviewed' | 'rejected' | 'superseded';
export type EngineeringEvidenceRelation = 'supports' | 'context' | 'contradicts';
export type EngineeringScaleStatus = 'not_assessed' | 'static_reviewed' | 'runtime_evidenced';
export type EngineeringValidationStatus = 'pending' | 'passed' | 'failed';
export type EngineeringValidationPurpose = 'build' | 'test' | 'typecheck' | 'lint' | 'custom';
export type EngineeringVerificationKind = 'command' | 'sql_scale';
export type EngineeringScaleVerificationLevel = 'static' | 'runtime';
export type EngineeringReferenceRole = 'implementation_reference';
export type EngineeringReferenceProvenance = 'explicit_task_input';
export type EngineeringReviewEvidenceOrigin = 'current_project' | 'authorized_reference';
export type EngineeringSolutionReviewStatus = 'not_required' | 'pending' | 'reviewed';
export type EngineeringRequirementComparisonStatus = 'existing' | 'partial' | 'missing' | 'conflicting' | 'investigate';
export type EngineeringRequirementDisposition = 'keep' | 'adapt' | 'implement' | 'investigate';
export type EngineeringSolutionFindingType =
  | 'required_by_evidence'
  | 'contradiction'
  | 'implementation_risk'
  | 'process_risk'
  | 'proposed_improvement'
  | 'investigate';
export type EngineeringSolutionFindingDisposition = 'must_address' | 'decision_required' | 'advisory' | 'investigate';
export type EngineeringSolutionFindingDecision = 'pending' | 'accepted' | 'rejected' | 'not_required';
export type EngineeringFindingConfidence = 'low' | 'medium' | 'high';
export type EngineeringDeliberationStatus = 'pending' | 'not_required' | 'decided';
export type EngineeringDeliberationAuthority = 'agent' | 'user';
export type EngineeringDeliberationTrigger =
  | 'ambiguity'
  | 'architecture'
  | 'business'
  | 'performance'
  | 'shared_code'
  | 'compatibility'
  | 'migration'
  | 'security'
  | 'cost_policy';

export interface EngineeringProjectLineage {
  key: string;
  projectId: string | null;
  rootIdentity: string;
  profile: string;
  runtimeFamily: string | null;
  sourceRevision: string | null;
}

export interface EngineeringEvidenceRef {
  evidenceId: string;
  contentHash: string;
  relation: EngineeringEvidenceRelation;
}

/**
 * Cross-project evidence is never implicit. A reference evidence item names the authorized
 * reference root that owns it so the quality gate can verify it in that root's isolated
 * Knowledge scope rather than mixing foreign evidence into the current project scope.
 */
export interface EngineeringReviewEvidenceRef extends EngineeringEvidenceRef {
  origin: EngineeringReviewEvidenceOrigin;
  referenceRootIdentity: string | null;
}

/**
 * Server-resolved task-scoped reference. Callers request a path during prepare; Core resolves
 * and stores the durable root identity. Later task updates cannot silently replace this binding.
 */
export interface EngineeringAuthorizedReference {
  id: string;
  role: EngineeringReferenceRole;
  virtualPath: string;
  rootIdentity: string;
  profile: string;
  runtimeFamily: string | null;
  scope: string[];
  reason: string;
  provenance: EngineeringReferenceProvenance;
}

export interface EngineeringRequirementComparison {
  requirement: string;
  status: EngineeringRequirementComparisonStatus;
  currentEvidence: EngineeringReviewEvidenceRef[];
  referenceEvidence: EngineeringReviewEvidenceRef[];
  findingKeys: string[];
  proposedDisposition: EngineeringRequirementDisposition;
  note: string;
}

export interface EngineeringSolutionFinding {
  key: string;
  title: string;
  type: EngineeringSolutionFindingType;
  statement: string;
  impact: string;
  confidence: EngineeringFindingConfidence;
  affectedRequirements: string[];
  processKeys: string[];
  evidence: EngineeringReviewEvidenceRef[];
  recommendation: string;
  disposition: EngineeringSolutionFindingDisposition;
  decision: EngineeringSolutionFindingDecision;
  decisionNote: string;
}

export interface EngineeringSolutionOption {
  key: string;
  title: string;
  approach: string;
  benefits: string[];
  tradeoffs: string[];
  risks: string[];
  evidence: EngineeringReviewEvidenceRef[];
  /** Required for non-selected options once deliberation is decided. */
  rejectedReason: string;
}

export interface EngineeringValidation {
  name: string;
  status: EngineeringValidationStatus;
  detail: string;
  purpose?: EngineeringValidationPurpose;
  /**
   * Optional current project evidence supporting this validation result. The quality gate
   * verifies freshness, but does not pretend that caller-supplied evidence is a replayed
   * build/test command.
   */
  evidence?: EngineeringEvidenceRef[];
}

export interface EngineeringAnalogueAssessment {
  evidenceId: string;
  contentHash: string;
  classification: EngineeringConventionClassification;
  note: string;
}

export interface EngineeringTaskInput {
  key: string;
  /** Required for a new task; optional on later revision-fenced partial updates. */
  goal?: string;
  requirements?: string[];
  decisions?: string[];
  openQuestions?: string[];
  evidence?: EngineeringEvidenceRef[];
  /** Implementation analogues selected by prepare; task-scoped evidence, never a durable standard by itself. */
  analogueEvidence?: EngineeringEvidenceRef[];
  /** Analogues selected only from explicit task-scoped cross-project references. */
  referenceAnalogueEvidence?: EngineeringReviewEvidenceRef[];
  /** Explicit classification of prepared analogues before they are copied as project-native practice. */
  analogueAssessments?: EngineeringAnalogueAssessment[];
  /**
   * Structured solution review. Semantic conclusions are supplied by the engineering agent/dev;
   * Core only persists and verifies their provenance/decision state.
   */
  solutionReviewStatus?: EngineeringSolutionReviewStatus;
  solutionReviewSummary?: string;
  requirementComparisons?: EngineeringRequirementComparison[];
  solutionFindings?: EngineeringSolutionFinding[];
  implementedFindingKeys?: string[];
  /**
   * Explicit pre-implementation deliberation. Prepared tasks start pending; the agent/dev must
   * either justify why multiple options are unnecessary or compare 2-3 concrete options and
   * record the selected one. Business/scope decisions can be marked as user-authority.
   */
  deliberationStatus?: EngineeringDeliberationStatus;
  deliberationQuestion?: string;
  deliberationTriggers?: EngineeringDeliberationTrigger[];
  deliberationSummary?: string;
  deliberationAuthority?: EngineeringDeliberationAuthority;
  solutionOptions?: EngineeringSolutionOption[];
  selectedOptionKey?: string | null;
  deliberationDecisionNote?: string;
  /** Explicit implementation mapping; not part of the review basis so code/validation updates do not stale review. */
  implementedOptionKey?: string | null;
  conventionKeys?: string[];
  changedFiles?: string[];
  validations?: EngineeringValidation[];
  largeDataRisk?: boolean;
  scaleStatus?: EngineeringScaleStatus;
  /** Evidence specifically supporting a runtime/production-scale claim. */
  scaleEvidence?: EngineeringEvidenceRef[];
  remainingRisks?: string[];
  expectedRevision?: number;
}

export interface EngineeringTask extends Omit<Required<EngineeringTaskInput>, 'expectedRevision'> {
  id: string;
  lineageKey: string;
  /** Server-owned marker: true only when the task was created/refreshed through engineering prepare. */
  prepared: boolean;
  /** Server-owned opt-in marker so pre-feature persisted tasks remain backward compatible. */
  solutionReviewRequired: boolean;
  /** Server-owned hash of the exact requirements/evidence/review basis last marked reviewed. */
  solutionReviewBasisHash: string | null;
  solutionReviewedAt: string | null;
  /** Server-owned explicit cross-project bindings resolved during prepare. */
  authorizedReferences: EngineeringAuthorizedReference[];
  /** Server-owned hash of the exact reasoning basis last classified/decided by the deliberation gate. */
  deliberationBasisHash: string | null;
  deliberatedAt: string | null;
  /** Server-owned binding from the decided option to the exact implementation file/finding set. */
  implementationBindingHash: string | null;
  implementationBoundAt: string | null;
  /** Server-observed Engineering knowledge generation at the time this task revision was saved. */
  knowledgeGeneration: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface EngineeringVerificationFileSnapshot {
  path: string;
  sha256: string | null;
}

export interface EngineeringCommandVerification {
  purpose: EngineeringValidationPurpose;
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutHash: string;
  stderrHash: string;
}

export interface EngineeringSqlScaleVerification {
  connection: string;
  database: string;
  objectId: number;
  objectName: string;
  approximateRows: number | null;
  indexCount: number;
  statisticsCount: number;
  level: EngineeringScaleVerificationLevel;
  runtimeSource: 'none' | 'query_store' | 'live_performance';
  queryContains: string | null;
  queryBinding: 'none' | 'task_text' | 'changed_file';
  matchedRuntimeCount: number;
  capturedAt: string;
  resultHash: string;
  limitations: string[];
}

export interface EngineeringVerificationRecord {
  id: string;
  lineageKey: string;
  taskKey: string;
  taskRevision: number;
  name: string;
  kind: EngineeringVerificationKind;
  success: boolean;
  knowledgeGeneration: string;
  fileSnapshots: EngineeringVerificationFileSnapshot[];
  command: EngineeringCommandVerification | null;
  scale: EngineeringSqlScaleVerification | null;
  provenanceHash: string;
  createdAt: string;
}

export interface EngineeringConventionInput {
  key: string;
  title: string;
  statement: string;
  classification: EngineeringConventionClassification;
  provenance: EngineeringConventionProvenance;
  applicability?: string[];
  evidence?: EngineeringEvidenceRef[];
  status?: EngineeringConventionStatus;
  decisionNote?: string | null;
  expectedRevision?: number;
}

export interface EngineeringConvention extends Omit<Required<EngineeringConventionInput>, 'expectedRevision'> {
  id: string;
  lineageKey: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface EngineeringScopeSnapshot {
  version: 1;
  lineage: EngineeringProjectLineage;
  updatedAt: string;
  tasks: EngineeringTask[];
  taskRevisions: EngineeringTask[];
  conventions: EngineeringConvention[];
  conventionRevisions: EngineeringConvention[];
  verifications: EngineeringVerificationRecord[];
}

export interface EngineeringConventionSearchHit {
  convention: EngineeringConvention;
  score: number;
}

export interface EngineeringConventionDiscoveryCandidate {
  evidenceId: string;
  contentHash: string;
  sourceHash: string;
  capturedAt: string;
  title: string;
  locator: Record<string, unknown>;
  snippet: string;
  score: number;
}

export interface EngineeringConventionDiscoveryResult {
  lineage: EngineeringProjectLineage;
  knowledgeScope: string;
  query: string;
  candidates: EngineeringConventionDiscoveryCandidate[];
  coverage: {
    minimum: number;
    requested: number;
    distinctImplementations: number;
    targetMet: boolean;
  };
  limitations: string[];
}

export type EngineeringQualityGateStatus = 'pass' | 'attention' | 'blocked';

export interface EngineeringQualityGateResult {
  lineage: EngineeringProjectLineage;
  task: EngineeringTask;
  status: EngineeringQualityGateStatus;
  blockers: string[];
  attention: string[];
  assurance: {
    evidenceFreshnessVerified: boolean;
    referenceBindingsVerified: boolean;
    solutionReviewVerified: boolean;
    deliberationVerified: boolean;
    executionReplayed: boolean;
    machineVerified: boolean;
    reportedPassedValidations: number;
    evidenceBackedPassedValidations: number;
    commandVerifications: Array<{
      name: string;
      purpose: EngineeringValidationPurpose;
      status: 'current-pass' | 'current-fail' | 'stale' | 'missing';
      verificationId: string | null;
    }>;
    scaleVerification: {
      status: 'current-runtime' | 'current-static' | 'current-fail' | 'stale' | 'missing' | 'not-required';
      verificationId: string | null;
    };
  };
}
