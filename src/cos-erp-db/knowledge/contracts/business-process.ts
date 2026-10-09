export type BusinessProcessRecordKind =
  | 'customer'
  | 'process'
  | 'solution'
  | 'change_request'
  | 'rule'
  | 'expected_behavior';

export type BusinessProcessRecordStatus = 'draft' | 'accepted' | 'superseded';
export type BusinessProcessConfidence = 'high' | 'medium' | 'low' | 'unknown';
export type BusinessProcessEvidenceRelation = 'supports' | 'context' | 'contradicts';

export interface BusinessProcessEvidenceRef {
  evidenceId: string;
  contentHash: string;
  relation: BusinessProcessEvidenceRelation;
}

export interface BusinessProcessRecordInput {
  key: string;
  kind: BusinessProcessRecordKind;
  title: string;
  statement: string;
  parentKey?: string | null;
  status?: BusinessProcessRecordStatus;
  confidence?: BusinessProcessConfidence;
  tags?: string[];
  evidence?: BusinessProcessEvidenceRef[];
  acceptanceNote?: string | null;
}

export interface BusinessProcessRecord {
  id: string;
  scope: string;
  key: string;
  kind: BusinessProcessRecordKind;
  title: string;
  statement: string;
  parentId: string | null;
  parentKey: string | null;
  status: BusinessProcessRecordStatus;
  confidence: BusinessProcessConfidence;
  tags: string[];
  evidence: BusinessProcessEvidenceRef[];
  acceptanceNote: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessProcessScopeSnapshot {
  version: 1;
  scope: string;
  updatedAt: string;
  records: BusinessProcessRecord[];
  revisions: BusinessProcessRecord[];
}

export interface BusinessProcessPutResult {
  scope: string;
  changed: boolean;
  record: BusinessProcessRecord;
}

export interface BusinessProcessEvidenceState {
  evidenceId: string;
  status: 'indexed' | 'missing' | 'hash-mismatch';
}

export interface BusinessProcessSearchHit {
  record: BusinessProcessRecord;
  score: number;
  evidenceState: BusinessProcessEvidenceState[];
}

export interface BusinessProcessSearchResult {
  scope: string;
  query: string;
  hits: BusinessProcessSearchHit[];
  totalMatches: number;
  truncated: boolean;
}

export interface BusinessProcessGetResult {
  scope: string;
  records: Array<{
    record: BusinessProcessRecord;
    evidenceState: BusinessProcessEvidenceState[];
  }>;
  missingKeys: string[];
}

export interface BusinessProcessHistoryResult {
  scope: string;
  key: string;
  revisions: BusinessProcessRecord[];
}
