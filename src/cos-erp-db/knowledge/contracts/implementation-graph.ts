import type { BusinessProcessRecordKind } from './business-process.js';
import type { KnowledgeEvidenceLocator } from './knowledge.js';

export type ImplementationGraphNodeKind =
  | BusinessProcessRecordKind
  | 'evidence'
  | 'source_file'
  | 'source_method'
  | 'form'
  | 'control'
  | 'document'
  | 'database_object'
  | 'database_column';

export type ImplementationGraphRelation =
  | 'parent'
  | 'supports'
  | 'context'
  | 'contradicts'
  | 'located_in'
  | 'describes'
  | 'has_column'
  | 'declares'
  | 'references'
  | 'calls'
  | 'binds';

export interface ImplementationGraphNode {
  id: string;
  kind: ImplementationGraphNodeKind;
  label: string;
  detail: string | null;
  recordKey: string | null;
  evidenceId: string | null;
  locator: KnowledgeEvidenceLocator | null;
}

export interface ImplementationGraphEdge {
  id: string;
  from: string;
  to: string;
  relation: ImplementationGraphRelation;
  confidence: 'high' | 'medium';
  evidenceId: string | null;
}

export interface ImplementationGraphSearchHit {
  node: ImplementationGraphNode;
  score: number;
  neighbors: ImplementationGraphNode[];
  edges: ImplementationGraphEdge[];
}

export interface ImplementationGraphSearchResult {
  scope: string;
  generation: string;
  query: string;
  hits: ImplementationGraphSearchHit[];
  totalMatches: number;
  truncated: boolean;
  limitations: string[];
}

export interface ImplementationGraphExpandResult {
  scope: string;
  generation: string;
  root: ImplementationGraphNode | null;
  nodes: ImplementationGraphNode[];
  edges: ImplementationGraphEdge[];
  truncated: boolean;
  limitations: string[];
}
