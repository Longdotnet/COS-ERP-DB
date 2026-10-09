export type KnowledgeEvidenceKind = 'source' | 'document' | 'database';

export interface KnowledgeEvidenceLocator {
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  page?: number;
  part?: string;
  connection?: string;
  database?: string;
  /** Hash of non-secret connection identity captured when database evidence was indexed. */
  databaseOrigin?: string;
  objectId?: number;
  objectType?: string;
  schema?: string;
  name?: string;
}

export interface KnowledgeEvidence {
  id: string;
  scope: string;
  kind: KnowledgeEvidenceKind;
  sourceKey: string;
  title: string;
  content: string;
  contentHash: string;
  sourceHash: string;
  capturedAt: string;
  locator: KnowledgeEvidenceLocator;
  sourceSize: number | null;
  sourceMtimeMs: number | null;
  /** Filesystem change time used with size+mtime as the incremental reuse fence. */
  sourceCtimeMs?: number | null;
}

export interface KnowledgeScopeSnapshot {
  version: 1;
  scope: string;
  generation: string;
  updatedAt: string;
  evidence: KnowledgeEvidence[];
}

export type KnowledgeIndexSource =
  | { kind: 'source' | 'document'; path: string }
  | { kind: 'database'; connection?: string };

export interface KnowledgeIndexRequest {
  scope: string;
  sources: KnowledgeIndexSource[];
  mode?: 'incremental' | 'refresh';
}

export interface KnowledgeIndexedSourceResult {
  kind: KnowledgeEvidenceKind;
  sourceKey: string;
  evidenceCount: number;
  limitations: string[];
}

export interface KnowledgeIndexResult {
  scope: string;
  generation: string;
  indexedAt: string;
  counts: {
    evidence: number;
    added: number;
    updated: number;
    removed: number;
  };
  sources: KnowledgeIndexedSourceResult[];
  limitations: string[];
  elapsedMs: number;
  /** Observation only: input/work volume, not a freshness or Machine Verified authority. */
  telemetry?: {
    filesDiscovered: number;
    filesProcessed: number;
    filesRead: number;
    filesReused: number;
    sourceBytesProcessed: number;
    sourceHashesComputed: number;
    documentsExtracted: number;
  };
}

export interface KnowledgeSearchHit {
  evidenceId: string;
  kind: KnowledgeEvidenceKind;
  title: string;
  locator: KnowledgeEvidenceLocator;
  snippet: string;
  contentHash: string;
  sourceHash: string;
  capturedAt: string;
  score: number;
}

export interface KnowledgeSearchResult {
  scope: string;
  generation: string;
  query: string;
  hits: KnowledgeSearchHit[];
  totalMatches: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface KnowledgeGetResult {
  scope: string;
  generation: string;
  evidence: KnowledgeEvidence[];
  missingIds: string[];
  truncated: boolean;
}

export type KnowledgeVerificationStatus = 'current' | 'stale' | 'missing' | 'hash-mismatch' | 'unavailable';

export interface KnowledgeVerificationEntry {
  evidenceId: string;
  status: KnowledgeVerificationStatus;
  expectedContentHash: string | null;
  indexedContentHash: string | null;
  currentSourceHash: string | null;
  detail: string;
}

export interface KnowledgeVerifyResult {
  scope: string;
  generation: string;
  verifiedAt: string;
  allCurrent: boolean;
  evidence: KnowledgeVerificationEntry[];
  elapsedMs: number;
}
