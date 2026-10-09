import type { BusinessProcessEvidenceRef } from './business-process.js';
import type { IncidentClass, IncidentTechnicalEvidenceRef } from './incident-technical-evidence.js';

export type IncidentOutcomeStatus = 'draft' | 'accepted' | 'invalidated';
export type IncidentOutcomeLiveStatus = 'draft' | 'accepted' | 'stale' | 'invalidated';
export type IncidentOutcomeValidationResult = 'pending' | 'passed' | 'failed';

export interface IncidentOutcomeValidationInput {
  result: IncidentOutcomeValidationResult;
  summary: string;
  evidence?: BusinessProcessEvidenceRef[];
}

export interface IncidentOutcomeInput {
  key: string;
  incidentKey: string;
  title: string;
  symptom: string;
  processKey: string;
  expectedBehaviorKey: string;
  /** Declared root-cause hypothesis until a typed evidence policy is causally verified. */
  rootCauseCategory: string;
  /** Declared root-cause hypothesis until a typed evidence policy is causally verified. */
  finding: string;
  remediation: string;
  /** Optional for backward compatibility. New machine-backed outcomes should classify the incident explicitly. */
  incidentClass?: IncidentClass | null;
  evidence?: BusinessProcessEvidenceRef[];
  deploymentEvidence?: BusinessProcessEvidenceRef[];
  runtimeEvidence?: BusinessProcessEvidenceRef[];
  technicalEvidence?: IncidentTechnicalEvidenceRef[];
  validation: IncidentOutcomeValidationInput;
  status?: IncidentOutcomeStatus;
  decisionNote?: string | null;
  tags?: string[];
  expectedRevision?: number;
}

export interface IncidentOutcomeValidation {
  result: IncidentOutcomeValidationResult;
  summary: string;
  evidence: BusinessProcessEvidenceRef[];
}

export interface IncidentOutcome {
  id: string;
  scope: string;
  key: string;
  incidentKey: string;
  title: string;
  symptom: string;
  processKey: string;
  expectedBehaviorKey: string;
  rootCauseCategory: string;
  finding: string;
  remediation: string;
  incidentClass: IncidentClass | null;
  evidence: BusinessProcessEvidenceRef[];
  deploymentEvidence: BusinessProcessEvidenceRef[];
  runtimeEvidence: BusinessProcessEvidenceRef[];
  technicalEvidence: IncidentTechnicalEvidenceRef[];
  validation: IncidentOutcomeValidation;
  status: IncidentOutcomeStatus;
  decisionNote: string | null;
  tags: string[];
  revision: number;
  acceptedAt: string | null;
  invalidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentOutcomeScopeSnapshot {
  version: 1;
  scope: string;
  updatedAt: string;
  outcomes: IncidentOutcome[];
  revisions: IncidentOutcome[];
}

export interface IncidentOutcomeProvenance {
  liveStatus: IncidentOutcomeLiveStatus;
  current: boolean;
  staleEvidenceCount: number;
  evidenceCount: number;
  processCurrent: boolean;
  expectedBehaviorCurrent: boolean;
  machineBacked: boolean;
  /** True only when the typed outcome hypothesis is bound to current machine-backed causal verification. */
  causalVerificationCurrent: boolean;
  verificationLevel: 'legacy_declared' | 'typed_machine_backed' | 'typed_incomplete';
  technicalEvidenceCurrent: boolean;
  technicalEvidenceCount: number;
  technicalEvidenceRoles: {
    observations: number;
    hypotheses: number;
    causalVerifications: number;
    legacyVerifications: number;
  };
  missingTechnicalEvidence: string[];
}

export interface IncidentOutcomePutResult {
  scope: string;
  changed: boolean;
  outcome: IncidentOutcome;
  provenance: IncidentOutcomeProvenance;
}

export interface IncidentOutcomeSearchHit {
  outcome: IncidentOutcome;
  score: number;
  provenance: IncidentOutcomeProvenance;
}

export interface IncidentOutcomeSearchResult {
  scope: string;
  query: string;
  hits: IncidentOutcomeSearchHit[];
  totalMatches: number;
  truncated: boolean;
}

export interface IncidentOutcomeGetResult {
  scope: string;
  outcomes: Array<{ outcome: IncidentOutcome; provenance: IncidentOutcomeProvenance }>;
  missingKeys: string[];
}

export interface IncidentOutcomeHistoryResult {
  scope: string;
  key: string;
  revisions: IncidentOutcome[];
}
