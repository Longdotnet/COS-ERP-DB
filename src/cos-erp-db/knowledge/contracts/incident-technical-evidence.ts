export type IncidentClass = 'logic_correctness' | 'performance' | 'deployment' | 'data' | 'concurrency';

export type IncidentTechnicalEvidenceKind =
  | 'runtime_diagnosis'
  | 'health_gate'
  | 'deployment_fingerprint'
  | 'deployment_compare'
  | 'query_store'
  | 'deadlocks'
  | 'data_timeline'
  | 'machine_validation';

/**
 * Epistemic role of a technical-evidence record.
 *
 * - observation: machine-captured fact about the environment/runtime.
 * - hypothesis: an investigation claim that is explicitly not causal proof.
 * - causal_verification: machine-backed verification bound to the exact outcome hypothesis.
 * - verification: legacy alias retained so existing persisted receipts remain readable.
 */
export type IncidentTechnicalEvidenceRole =
  | 'observation'
  | 'hypothesis'
  | 'causal_verification'
  | 'verification';

export interface IncidentTechnicalEvidenceRef {
  evidenceId: string;
  contentHash: string;
}

export interface IncidentTechnicalEvidenceRecord {
  id: string;
  scope: string;
  incidentKey: string;
  kind: IncidentTechnicalEvidenceKind;
  role: IncidentTechnicalEvidenceRole;
  sourceAction: string;
  connection: string | null;
  capturedAt: string;
  contentHash: string;
  payload: unknown;
  createdAt: string;
}

export interface IncidentTechnicalEvidenceScopeSnapshot {
  version: 1;
  scope: string;
  updatedAt: string;
  records: IncidentTechnicalEvidenceRecord[];
}

export interface IncidentEvidencePolicyResult {
  incidentClass: IncidentClass;
  satisfied: boolean;
  machineBacked: boolean;
  missing: string[];
  currentRecords: IncidentTechnicalEvidenceRecord[];
  roleCounts: {
    observations: number;
    hypotheses: number;
    causalVerifications: number;
    legacyVerifications: number;
  };
}
