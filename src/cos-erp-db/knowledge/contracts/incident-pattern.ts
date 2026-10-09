import type { BusinessProcessEvidenceRef } from './business-process.js';

export type IncidentPatternStatus = 'candidate' | 'promoted';
export type IncidentPatternLiveStatus = 'candidate' | 'promoted' | 'degraded';

export interface IncidentPatternOccurrenceInput {
  outcomeKey: string;
  note?: string | null;
}

export interface IncidentPatternInput {
  key: string;
  title: string;
  symptom: string;
  finding: string;
  recommendedChecks: string[];
  tags?: string[];
  expectedRevision?: number;
  occurrence: IncidentPatternOccurrenceInput;
}

export interface IncidentPatternOccurrence {
  id: string;
  sourceScope: string;
  outcomeKey?: string | null;
  incidentKey: string;
  processKey: string;
  expectedBehaviorKey: string;
  rootCauseCategory: string | null;
  rootCauseSignature: string | null;
  /** Server-derived from current supporting root-cause evidence content hashes, excluding validation/runtime evidence. */
  independenceFingerprint: string | null;
  evidence: BusinessProcessEvidenceRef[];
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentPattern {
  id: string;
  key: string;
  title: string;
  symptom: string;
  finding: string;
  /** Established from the first machine-backed occurrence; later occurrences must match. */
  rootCauseCategory: string | null;
  rootCauseSignature: string | null;
  recommendedChecks: string[];
  tags: string[];
  status: IncidentPatternStatus;
  supportingScopeCount: number;
  independentSupportingCount: number;
  occurrences: IncidentPatternOccurrence[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentPatternStoreSnapshot {
  version: 1;
  updatedAt: string;
  patterns: IncidentPattern[];
  revisions: IncidentPattern[];
}

export interface IncidentPatternPutResult {
  changed: boolean;
  pattern: IncidentPattern;
}

export interface IncidentPatternProvenanceSummary {
  liveStatus: IncidentPatternLiveStatus;
  currentSupportingScopeCount: number;
  currentIndependentSupportingCount: number;
  otherSupportingScopeCount: number;
  occurrenceCount: number;
  staleOccurrenceCount: number;
}

export interface IncidentPatternSearchHit {
  pattern: Omit<IncidentPattern, 'occurrences'>;
  score: number;
  provenance: IncidentPatternProvenanceSummary;
}

export interface IncidentPatternSearchResult {
  requestingScope: string;
  query: string;
  hits: IncidentPatternSearchHit[];
  totalMatches: number;
  truncated: boolean;
}

export interface IncidentPatternGetResult {
  requestingScope: string;
  patterns: Array<{
    pattern: IncidentPattern;
    provenance: IncidentPatternProvenanceSummary;
  }>;
  missingKeys: string[];
}

export interface IncidentPatternHistoryResult {
  key: string;
  revisions: IncidentPattern[];
}
