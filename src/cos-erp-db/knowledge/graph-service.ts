import path from 'node:path';
import type {
  ImplementationGraphEdge,
  ImplementationGraphExpandResult,
  ImplementationGraphNode,
  ImplementationGraphRelation,
  ImplementationGraphSearchHit,
  ImplementationGraphSearchResult
} from './contracts/implementation-graph.js';
import type { KnowledgeEvidence } from './contracts/knowledge.js';
import { knowledgeSha256 } from './evidence.js';
import { readBusinessProcessScope } from './process-store.js';
import { readKnowledgeScope } from './store.js';

const MAX_GRAPH_NODES = 20_000;
const MAX_GRAPH_EDGES = 50_000;
const MAX_SEARCH_LIMIT = 50;
const MAX_NEIGHBORS_PER_HIT = 8;
const MAX_EXPAND_NODES = 250;
const MAX_EXPAND_EDGES = 500;
const EXPAND_DEPTH = 2;

interface GraphSnapshot {
  scope: string;
  generation: string;
  nodes: Map<string, ImplementationGraphNode>;
  edges: ImplementationGraphEdge[];
  adjacency: Map<string, ImplementationGraphEdge[]>;
  truncated: boolean;
  limitations: string[];
}

interface SourceFileInfo {
  nodeId: string;
  path: string;
  chunks: KnowledgeEvidence[];
  referencedObjectIds: Set<string>;
}

interface ColumnInfo {
  nodeId: string;
  objectNodeId: string;
  name: string;
}

const cache = new Map<string, GraphSnapshot>();

function generationFor(knowledgeGeneration: string, processUpdatedAt: string, revisions: readonly { id: string; revision: number }[]): string {
  return knowledgeSha256([
    'implementation-graph:v1',
    knowledgeGeneration,
    processUpdatedAt,
    ...revisions.map(record => record.id + ':' + record.revision).sort()
  ].join('|'));
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('vi-VN');
}

function safeDetail(value: string): string {
  return value.length <= 1_000 ? value : value.slice(0, 999) + '…';
}

function graphId(prefix: string, value: string): string {
  return prefix + ':' + knowledgeSha256(value);
}

function databaseObjectId(evidence: KnowledgeEvidence): string | null {
  const locator = evidence.locator;
  if (!locator.connection || typeof locator.database !== 'string' || !locator.objectId) return null;
  const origin = locator.databaseOrigin
    ?? knowledgeSha256(locator.connection.toLocaleLowerCase('en-US') + '|' + normalized(locator.database));
  return 'db:' + origin + ':' + locator.objectId;
}

function databaseColumnId(objectNodeId: string, column: string): string {
  return graphId('dbcol', objectNodeId + '|' + normalized(column));
}

function edgeId(from: string, relation: ImplementationGraphRelation, to: string, evidenceId: string | null): string {
  return knowledgeSha256(from + '|' + relation + '|' + to + '|' + (evidenceId ?? ''));
}

function parseColumns(content: string): string[] {
  const columns: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*\d+\.\s+([^\s]+)\s+/.exec(line);
    if (match?.[1]) columns.push(match[1]);
  }
  return [...new Set(columns)];
}

function sourceIdentifiers(content: string): Set<string> {
  return new Set((content.match(/[A-Za-z_][A-Za-z0-9_.$]*/g) ?? []).map(normalized));
}

function explicitFields(content: string): Array<{ field: string; relation: 'binds' | 'references' }> {
  const found = new Map<string, 'binds' | 'references'>();
  const bindings = [
    /DataPropertyName\s*=\s*["']([^"']+)["']/gi,
    /Field\s*<[^>]+>\s*\(\s*["']([^"']+)["']/gi
  ];
  for (const expression of bindings) {
    for (const match of content.matchAll(expression)) {
      if (match[1]) found.set(match[1], 'binds');
    }
  }
  for (const match of content.matchAll(/\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g)) {
    if (match[1] && !found.has(match[1])) found.set(match[1], 'references');
  }
  return [...found].map(([field, relation]) => ({ field, relation }));
}

function formName(content: string): string | null {
  return /\b(?:partial\s+)?class\s+(frm[A-Za-z0-9_]+)/i.exec(content)?.[1] ?? null;
}

function sourceMethods(content: string): string[] {
  const names: string[] = [];
  const expression = /\b(?:public|private|protected|internal)\s+(?:(?:static|async|virtual|override|sealed|new)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>,?.\[\]]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  for (const match of content.matchAll(expression)) {
    const name = match[1];
    if (name && !['if', 'for', 'foreach', 'while', 'switch', 'catch'].includes(name)) names.push(name);
  }
  return [...new Set(names)].slice(0, 50);
}

function buildAdjacency(edges: readonly ImplementationGraphEdge[]): Map<string, ImplementationGraphEdge[]> {
  const adjacency = new Map<string, ImplementationGraphEdge[]>();
  for (const edge of edges) {
    const left = adjacency.get(edge.from) ?? [];
    left.push(edge);
    adjacency.set(edge.from, left);
    const right = adjacency.get(edge.to) ?? [];
    right.push(edge);
    adjacency.set(edge.to, right);
  }
  return adjacency;
}

async function buildGraph(scope: string): Promise<GraphSnapshot> {
  const [knowledge, process] = await Promise.all([
    readKnowledgeScope(scope),
    readBusinessProcessScope(scope)
  ]);
  const generation = generationFor(knowledge.generation, process.updatedAt, process.records);
  const existing = cache.get(scope);
  if (existing?.generation === generation) return existing;

  const nodes = new Map<string, ImplementationGraphNode>();
  const edges: ImplementationGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  let truncated = false;

  const addNode = (node: ImplementationGraphNode): boolean => {
    if (nodes.has(node.id)) return true;
    if (nodes.size >= MAX_GRAPH_NODES) {
      truncated = true;
      return false;
    }
    nodes.set(node.id, node);
    return true;
  };
  const addEdge = (
    from: string,
    to: string,
    relation: ImplementationGraphRelation,
    confidence: 'high' | 'medium',
    evidenceId: string | null = null
  ): void => {
    if (!nodes.has(from) || !nodes.has(to)) return;
    const id = edgeId(from, relation, to, evidenceId);
    if (edgeKeys.has(id)) return;
    if (edges.length >= MAX_GRAPH_EDGES) {
      truncated = true;
      return;
    }
    edgeKeys.add(id);
    edges.push({ id, from, to, relation, confidence, evidenceId });
  };

  const evidenceById = new Map(knowledge.evidence.map(item => [item.id, item]));
  const evidenceNodes = new Map<string, string>();
  const ensureEvidenceNode = (evidenceId: string): string => {
    const existingNode = evidenceNodes.get(evidenceId);
    if (existingNode) return existingNode;
    const evidence = evidenceById.get(evidenceId);
    const id = 'evidence:' + evidenceId;
    addNode({
      id,
      kind: 'evidence',
      label: evidence?.title ?? 'Missing evidence ' + evidenceId.slice(0, 12),
      detail: evidence ? evidence.kind + ' evidence' : 'Evidence is no longer present in the current knowledge generation.',
      recordKey: null,
      evidenceId,
      locator: evidence?.locator ?? null
    });
    evidenceNodes.set(evidenceId, id);
    return id;
  };

  const recordNodes = new Map<string, string>();
  for (const record of process.records) {
    const id = 'record:' + record.id;
    addNode({
      id,
      kind: record.kind,
      label: record.title,
      detail: safeDetail(record.key + ' | ' + record.status + ' | confidence=' + record.confidence + ' | ' + record.statement),
      recordKey: record.key,
      evidenceId: null,
      locator: null
    });
    recordNodes.set(record.id, id);
  }
  const recordByKey = new Map(process.records.map(record => [normalized(record.key), record]));
  for (const record of process.records) {
    const nodeId = recordNodes.get(record.id);
    if (!nodeId) continue;
    if (record.parentKey) {
      const parent = recordByKey.get(normalized(record.parentKey));
      const parentNode = parent ? recordNodes.get(parent.id) : null;
      if (parentNode) addEdge(nodeId, parentNode, 'parent', 'high');
    }
    for (const reference of record.evidence) {
      const evidenceNode = ensureEvidenceNode(reference.evidenceId);
      addEdge(nodeId, evidenceNode, reference.relation, 'high', reference.evidenceId);
    }
  }

  const sourceFiles = new Map<string, SourceFileInfo>();
  const documentNodes = new Map<string, string>();
  const dbObjectNames = new Map<string, string[]>();
  const dbObjectKinds = new Map<string, string>();
  const dbColumnsByName = new Map<string, ColumnInfo[]>();
  const columnsByObject = new Map<string, Map<string, ColumnInfo>>();

  for (const evidence of knowledge.evidence) {
    if ((evidence.kind === 'source' || evidence.kind === 'document') && evidence.locator.path) {
      const filePath = evidence.locator.path;
      if (evidence.kind === 'source') {
        let file = sourceFiles.get(filePath);
        if (!file) {
          const nodeId = graphId('file', filePath);
          addNode({
            id: nodeId,
            kind: 'source_file',
            label: path.posix.basename(filePath),
            detail: filePath,
            recordKey: null,
            evidenceId: null,
            locator: { path: filePath }
          });
          file = { nodeId, path: filePath, chunks: [], referencedObjectIds: new Set() };
          sourceFiles.set(filePath, file);
        }
        file.chunks.push(evidence);
      } else if (!documentNodes.has(filePath)) {
        const nodeId = graphId('doc', filePath);
        addNode({
          id: nodeId,
          kind: 'document',
          label: path.posix.basename(filePath),
          detail: filePath,
          recordKey: null,
          evidenceId: null,
          locator: { path: filePath }
        });
        documentNodes.set(filePath, nodeId);
      }
      continue;
    }
    if (evidence.kind !== 'database') continue;
    const objectNodeId = databaseObjectId(evidence);
    if (!objectNodeId || !evidence.locator.name) continue;
    const objectLabel = [evidence.locator.schema, evidence.locator.name].filter(Boolean).join('.');
    addNode({
      id: objectNodeId,
      kind: 'database_object',
      label: objectLabel,
      detail: (evidence.locator.objectType ?? 'object') + ' @ ' + (evidence.locator.database ?? ''),
      recordKey: null,
      evidenceId: null,
      locator: evidence.locator
    });
    const objectNameKey = normalized(evidence.locator.name);
    const objectIds = dbObjectNames.get(objectNameKey) ?? [];
    if (!objectIds.includes(objectNodeId)) objectIds.push(objectNodeId);
    dbObjectNames.set(objectNameKey, objectIds);
    if (evidence.locator.objectType) dbObjectKinds.set(objectNodeId, evidence.locator.objectType);

    if (evidence.locator.part === 'metadata') {
      const objectColumns = columnsByObject.get(objectNodeId) ?? new Map<string, ColumnInfo>();
      for (const column of parseColumns(evidence.content)) {
        const columnNodeId = databaseColumnId(objectNodeId, column);
        addNode({
          id: columnNodeId,
          kind: 'database_column',
          label: objectLabel + '.' + column,
          detail: column,
          recordKey: null,
          evidenceId: null,
          locator: { ...evidence.locator, part: 'column:' + column }
        });
        addEdge(objectNodeId, columnNodeId, 'has_column', 'high', evidence.id);
        const info = { nodeId: columnNodeId, objectNodeId, name: column };
        objectColumns.set(normalized(column), info);
        const candidates = dbColumnsByName.get(normalized(column)) ?? [];
        if (!candidates.some(candidate => candidate.nodeId === columnNodeId)) candidates.push(info);
        dbColumnsByName.set(normalized(column), candidates);
      }
      columnsByObject.set(objectNodeId, objectColumns);
    }
  }

  for (const [evidenceId, evidenceNodeId] of evidenceNodes) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) continue;
    if (evidence.kind === 'source' && evidence.locator.path) {
      const file = sourceFiles.get(evidence.locator.path);
      if (file) addEdge(evidenceNodeId, file.nodeId, 'located_in', 'high', evidenceId);
    } else if (evidence.kind === 'document' && evidence.locator.path) {
      const document = documentNodes.get(evidence.locator.path);
      if (document) addEdge(evidenceNodeId, document, 'located_in', 'high', evidenceId);
    } else if (evidence.kind === 'database') {
      const objectNode = databaseObjectId(evidence);
      if (objectNode) addEdge(evidenceNodeId, objectNode, 'describes', 'high', evidenceId);
    }
  }

  for (const file of sourceFiles.values()) {
    const combined = file.chunks.map(chunk => chunk.content).join('\n');
    const identifiers = sourceIdentifiers(combined);
    for (const [name, objectNodeIds] of dbObjectNames) {
      if (name.length < 4 || !identifiers.has(name)) continue;
      for (const objectNodeId of objectNodeIds) {
        file.referencedObjectIds.add(objectNodeId);
        const kind = dbObjectKinds.get(objectNodeId);
        addEdge(
          file.nodeId,
          objectNodeId,
          kind === 'procedure' || kind === 'function' ? 'calls' : 'references',
          'high'
        );
      }
    }

    const form = formName(combined);
    const formNodeId = form ? graphId('form', file.path + '|' + form) : null;
    if (form && formNodeId) {
      addNode({
        id: formNodeId,
        kind: 'form',
        label: form,
        detail: file.path,
        recordKey: null,
        evidenceId: null,
        locator: { path: file.path }
      });
      addEdge(file.nodeId, formNodeId, 'declares', 'high');
    }

    const methodNodes = new Map<string, string>();
    for (const method of sourceMethods(combined)) {
      const methodNodeId = graphId('method', file.path + '|' + method);
      addNode({
        id: methodNodeId,
        kind: 'source_method',
        label: (form ?? path.posix.basename(file.path)) + '.' + method,
        detail: file.path,
        recordKey: null,
        evidenceId: null,
        locator: { path: file.path, part: 'method:' + method }
      });
      addEdge(formNodeId ?? file.nodeId, methodNodeId, 'declares', 'medium');
      methodNodes.set(method, methodNodeId);
    }

    for (const chunk of file.chunks) {
      const chunkMethods = sourceMethods(chunk.content);
      if (!chunkMethods.length) continue;
      const chunkIdentifiers = sourceIdentifiers(chunk.content);
      for (const [name, objectNodeIds] of dbObjectNames) {
        if (name.length < 4 || !chunkIdentifiers.has(name)) continue;
        for (const method of chunkMethods) {
          const methodNodeId = methodNodes.get(method);
          if (!methodNodeId) continue;
          for (const objectNodeId of objectNodeIds) {
            const kind = dbObjectKinds.get(objectNodeId);
            addEdge(
              methodNodeId,
              objectNodeId,
              kind === 'procedure' || kind === 'function' ? 'calls' : 'references',
              'medium',
              chunk.id
            );
          }
        }
      }
    }

    for (const match of combined.matchAll(/this\.([A-Za-z_][A-Za-z0-9_]*)\.DataPropertyName\s*=\s*["']([^"']+)["']/g)) {
      const control = match[1];
      const field = match[2];
      if (!control || !field) continue;
      const controlNodeId = graphId('control', file.path + '|' + control);
      addNode({
        id: controlNodeId,
        kind: 'control',
        label: (form ?? path.posix.basename(file.path)) + '.' + control,
        detail: 'DataPropertyName=' + field,
        recordKey: null,
        evidenceId: null,
        locator: { path: file.path, part: 'control:' + control }
      });
      addEdge(formNodeId ?? file.nodeId, controlNodeId, 'declares', 'high');
      const candidates = dbColumnsByName.get(normalized(field)) ?? [];
      const constrained = candidates.filter(candidate => file.referencedObjectIds.has(candidate.objectNodeId));
      const selected = constrained.length ? constrained : candidates.length === 1 ? candidates : [];
      for (const column of selected) addEdge(controlNodeId, column.nodeId, 'binds', 'high');
    }

    for (const field of explicitFields(combined)) {
      const candidates = dbColumnsByName.get(normalized(field.field)) ?? [];
      const constrained = candidates.filter(candidate => file.referencedObjectIds.has(candidate.objectNodeId));
      const selected = constrained.length ? constrained : candidates.length === 1 ? candidates : [];
      for (const column of selected) {
        addEdge(file.nodeId, column.nodeId, field.relation === 'binds' ? 'binds' : 'references', constrained.length ? 'high' : 'medium');
      }
    }
  }

  const snapshot: GraphSnapshot = {
    scope,
    generation,
    nodes,
    edges,
    adjacency: buildAdjacency(edges),
    truncated,
    limitations: [
      'Implementation graph is static evidence, not a compiler/runtime call graph; reflection, generated code and dynamic SQL can be missed.',
      'Database object links require exact identifier matches. Column links require explicit binding/indexer strings and are suppressed when ambiguous.',
      'Method nodes are bounded regex evidence used for navigation; runtime tracing remains the authority for executed call paths.'
    ]
  };
  cache.set(scope, snapshot);
  return snapshot;
}

function nodeSearchText(node: ImplementationGraphNode): string {
  return normalized([
    node.kind,
    node.label,
    node.detail ?? '',
    node.recordKey ?? '',
    node.locator?.path ?? '',
    node.locator?.schema ?? '',
    node.locator?.name ?? '',
    node.locator?.part ?? ''
  ].join(' '));
}

function nodeScore(node: ImplementationGraphNode, query: string): number {
  const phrase = normalized(query);
  const text = nodeSearchText(node);
  const label = normalized(node.label);
  const key = normalized(node.recordKey ?? '');
  let score = 0;
  if (key && key.includes(phrase)) score += 40;
  if (label.includes(phrase)) score += 30;
  if (text.includes(phrase)) score += 15;
  const tokens = [...new Set(phrase.match(/[\p{L}\p{N}_.$-]+/gu) ?? [])].filter(token => token.length >= 2).slice(0, 24);
  for (const token of tokens) {
    if (key.includes(token)) score += 8;
    if (label.includes(token)) score += 6;
    if (text.includes(token)) score += 2;
  }
  return score;
}

function neighborBundle(graph: GraphSnapshot, node: ImplementationGraphNode): Pick<ImplementationGraphSearchHit, 'neighbors' | 'edges'> {
  const edges = (graph.adjacency.get(node.id) ?? []).slice(0, MAX_NEIGHBORS_PER_HIT);
  const neighbors = edges
    .map(edge => graph.nodes.get(edge.from === node.id ? edge.to : edge.from))
    .filter((candidate): candidate is ImplementationGraphNode => candidate !== undefined);
  return { neighbors, edges };
}

export async function searchImplementationGraph(
  scope: string,
  queryInput: string,
  limit = 12
): Promise<ImplementationGraphSearchResult> {
  const query = queryInput.trim();
  if (!query || query.length > 1000) throw new Error('Graph search query must contain 1 to 1000 characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new Error('Graph search limit must be between 1 and ' + MAX_SEARCH_LIMIT + '.');
  }
  const graph = await buildGraph(scope);
  const matches = [...graph.nodes.values()]
    .map(node => ({ node, score: nodeScore(node, query) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.node.label.localeCompare(right.node.label));
  const hits = matches.slice(0, limit).map(({ node, score }) => ({ node, score, ...neighborBundle(graph, node) }));
  return {
    scope,
    generation: graph.generation,
    query,
    hits,
    totalMatches: matches.length,
    truncated: graph.truncated || matches.length > hits.length,
    limitations: graph.limitations
  };
}

export async function expandImplementationGraph(
  scope: string,
  nodeId: string
): Promise<ImplementationGraphExpandResult> {
  const graph = await buildGraph(scope);
  const root = graph.nodes.get(nodeId) ?? null;
  if (!root) {
    return {
      scope,
      generation: graph.generation,
      root: null,
      nodes: [],
      edges: [],
      truncated: graph.truncated,
      limitations: graph.limitations
    };
  }
  const seen = new Set<string>([root.id]);
  let frontier = [root.id];
  const selectedEdges = new Map<string, ImplementationGraphEdge>();
  let truncated = graph.truncated;
  for (let depth = 0; depth < EXPAND_DEPTH && frontier.length; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of graph.adjacency.get(current) ?? []) {
        if (selectedEdges.size >= MAX_EXPAND_EDGES || seen.size >= MAX_EXPAND_NODES) {
          truncated = true;
          break;
        }
        selectedEdges.set(edge.id, edge);
        const other = edge.from === current ? edge.to : edge.from;
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
      if (truncated && (selectedEdges.size >= MAX_EXPAND_EDGES || seen.size >= MAX_EXPAND_NODES)) break;
    }
    frontier = next;
  }
  return {
    scope,
    generation: graph.generation,
    root,
    nodes: [...seen].map(id => graph.nodes.get(id)).filter((node): node is ImplementationGraphNode => node !== undefined),
    edges: [...selectedEdges.values()],
    truncated,
    limitations: graph.limitations
  };
}

export function resetImplementationGraphCacheForTests(): void {
  cache.clear();
}
