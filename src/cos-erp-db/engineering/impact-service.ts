import { z } from 'zod';
import type { Root } from '../../shared/types.js';
import { expandImplementationGraph, searchImplementationGraph } from '../knowledge/graph-service.js';
import { knowledgeSha256 } from '../knowledge/evidence.js';
import { readBusinessProcessScope } from '../knowledge/process-store.js';
import { indexKnowledge } from '../knowledge/service.js';
import type { ImplementationGraphEdge, ImplementationGraphNode } from '../knowledge/contracts/implementation-graph.js';
import type {
  EngineeringImpactAnalysis,
  EngineeringImpactAssessment,
  EngineeringImpactTarget,
  EngineeringTask
} from './contracts.js';
import { engineeringKnowledgeScope, type ResolvedEngineeringLineage } from './lineage.js';
import { getEngineeringTasks, putEngineeringTask } from './task-service.js';
import { captureEngineeringTaskFiles } from './verification-service.js';

const REQUIRED_KINDS = new Set<EngineeringImpactTarget['kind']>([
  'process',
  'rule',
  'expected_behavior',
  'database_object',
  'database_column'
]);
const TRACKED_KINDS = new Set<EngineeringImpactTarget['kind']>([
  ...REQUIRED_KINDS,
  'form',
  'control',
  'source_method'
]);

const impactPutInputSchema = z.object({
  taskKey: z.string().trim().min(1).max(160),
  assessments: z.array(z.object({
    nodeId: z.string().trim().min(1).max(256),
    decision: z.enum(['preserved', 'changed', 'not_applicable']),
    note: z.string().trim().min(1).max(4_000)
  }).strict()).max(256).default([]),
  expectedRevision: z.number().int().positive()
}).strict();

export type EngineeringImpactPutInput = z.infer<typeof impactPutInputSchema>;

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/').normalize('NFKC').toLocaleLowerCase('en-US');
}

function targetFingerprint(node: ImplementationGraphNode): string {
  return knowledgeSha256('engineering-impact-target:v1\0' + JSON.stringify({
    id: node.id,
    kind: node.kind,
    label: node.label,
    detail: node.detail,
    recordKey: node.recordKey,
    locator: node.locator
  }));
}

function adjacency(edges: readonly ImplementationGraphEdge[]): Map<string, ImplementationGraphEdge[]> {
  const result = new Map<string, ImplementationGraphEdge[]>();
  for (const edge of edges) {
    const left = result.get(edge.from) ?? [];
    left.push(edge);
    result.set(edge.from, left);
    const right = result.get(edge.to) ?? [];
    right.push(edge);
    result.set(edge.to, right);
  }
  return result;
}

function impactConfidence(
  rootId: string,
  nodes: ReadonlyMap<string, ImplementationGraphNode>,
  edges: readonly ImplementationGraphEdge[]
): Map<string, 'high' | 'medium'> {
  const graph = adjacency(edges);
  const result = new Map<string, 'high' | 'medium'>([[rootId, 'high']]);
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift()!;
    const currentConfidence = result.get(current)!;
    for (const edge of graph.get(current) ?? []) {
      const other = edge.from === current ? edge.to : edge.from;
      if (!nodes.has(other)) continue;
      const nextConfidence = currentConfidence === 'high' && edge.confidence === 'high' ? 'high' : 'medium';
      const previous = result.get(other);
      if (previous === 'high' || previous === nextConfidence) continue;
      result.set(other, nextConfidence);
      queue.push(other);
    }
  }
  return result;
}

function mergeTarget(
  bucket: Map<string, EngineeringImpactTarget>,
  node: ImplementationGraphNode,
  confidence: 'high' | 'medium',
  changedFile: string
): void {
  if (!TRACKED_KINDS.has(node.kind as EngineeringImpactTarget['kind'])) return;
  const kind = node.kind as EngineeringImpactTarget['kind'];
  const existing = bucket.get(node.id);
  const changedFiles = [...new Set([...(existing?.changedFiles ?? []), changedFile])].sort((a, b) => a.localeCompare(b));
  bucket.set(node.id, {
    nodeId: node.id,
    fingerprint: targetFingerprint(node),
    kind,
    label: node.label,
    recordKey: node.recordKey,
    confidence: existing?.confidence === 'high' || confidence === 'high' ? 'high' : 'medium',
    changedFiles
  });
}

function impactBasisHash(
  changedFiles: readonly { path: string; sha256: string | null }[],
  required: readonly EngineeringImpactTarget[],
  unknownChangedFiles: readonly string[]
): string {
  return knowledgeSha256('engineering-impact-review:v1\0' + JSON.stringify({
    changedFiles: [...changedFiles]
      .map(file => ({ path: file.path, sha256: file.sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    required: required
      .map(target => ({ nodeId: target.nodeId, fingerprint: target.fingerprint, changedFiles: [...target.changedFiles].sort() }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    unknownChangedFiles: [...unknownChangedFiles].sort((a, b) => a.localeCompare(b))
  }));
}

export async function analyzeEngineeringImpact(
  resolved: ResolvedEngineeringLineage,
  task: EngineeringTask,
  roots: readonly Root[],
  options: { refreshKnowledge?: boolean } = {}
): Promise<EngineeringImpactAnalysis> {
  const scope = engineeringKnowledgeScope(resolved.lineage);
  if (options.refreshKnowledge !== false) {
    await indexKnowledge({
      scope,
      sources: [{ kind: 'source', path: resolved.workspace.virtual }],
      mode: 'incremental'
    }, roots);
  }
  const snapshots = task.changedFiles.length
    ? await captureEngineeringTaskFiles(task, resolved, roots)
    : [];
  const processSnapshot = await readBusinessProcessScope(scope);
  const authoritativeRecords = new Map(
    processSnapshot.records
      .filter(record => record.status === 'accepted' && (record.confidence === 'high' || record.confidence === 'medium'))
      .map(record => [record.key.trim().toLocaleLowerCase('en-US'), record])
  );
  const targets = new Map<string, EngineeringImpactTarget>();
  const unknownChangedFiles: string[] = [];
  const limitations = new Set<string>();
  let coverageComplete = true;
  let graphGeneration = knowledgeSha256('engineering-impact-empty-graph');

  for (const snapshot of snapshots) {
    const query = snapshot.path.length <= 1_000 ? snapshot.path : snapshot.path.split('/').pop() ?? snapshot.path.slice(-1_000);
    const search = await searchImplementationGraph(scope, query, 50);
    graphGeneration = search.generation;
    for (const limitation of search.limitations) limitations.add(limitation);
    const root = search.hits
      .map(hit => hit.node)
      .find(node => node.kind === 'source_file'
        && typeof node.locator?.path === 'string'
        && normalizedPath(node.locator.path) === normalizedPath(snapshot.path));
    if (!root) {
      unknownChangedFiles.push(snapshot.path);
      coverageComplete = false;
      continue;
    }

    const expanded = await expandImplementationGraph(scope, root.id);
    graphGeneration = expanded.generation;
    for (const limitation of expanded.limitations) limitations.add(limitation);
    if (expanded.truncated) {
      coverageComplete = false;
      limitations.add(`Impact expansion was truncated for ${snapshot.path}.`);
    }
    const nodes = new Map(expanded.nodes.map(node => [node.id, node]));
    const confidence = impactConfidence(root.id, nodes, expanded.edges);
    for (const node of expanded.nodes) {
      if (node.id === root.id) continue;
      const nodeConfidence = confidence.get(node.id);
      if (!nodeConfidence) continue;
      mergeTarget(targets, node, nodeConfidence, snapshot.path);
    }
  }

  const required = [...targets.values()]
    .filter(target => {
      if (target.confidence !== 'high' || !REQUIRED_KINDS.has(target.kind)) return false;
      if (target.kind === 'database_object' || target.kind === 'database_column') return true;
      if (!target.recordKey) return false;
      return authoritativeRecords.has(target.recordKey.trim().toLocaleLowerCase('en-US'));
    })
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label));
  const requiredIds = new Set(required.map(target => target.nodeId));
  const advisory = [...targets.values()]
    .filter(target => !requiredIds.has(target.nodeId))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label));
  const changedFiles = snapshots.map(snapshot => snapshot.path).sort((a, b) => a.localeCompare(b));
  const unknown = [...new Set(unknownChangedFiles)].sort((a, b) => a.localeCompare(b));

  return {
    lineage: resolved.lineage,
    taskKey: task.key,
    graphGeneration,
    changedFiles,
    coverageComplete,
    required,
    advisory,
    unknownChangedFiles: unknown,
    basisHash: impactBasisHash(snapshots, required, unknown),
    limitations: [...limitations]
  };
}

export async function getEngineeringImpact(
  resolved: ResolvedEngineeringLineage,
  taskKey: string,
  roots: readonly Root[]
): Promise<EngineeringImpactAnalysis> {
  const task = (await getEngineeringTasks(resolved.lineage, [taskKey]))[0];
  if (!task) throw new Error(`ENGINEERING_TASK_NOT_FOUND: ${taskKey}`);
  return analyzeEngineeringImpact(resolved, task, roots);
}

export async function putEngineeringImpactReview(
  resolved: ResolvedEngineeringLineage,
  rawInput: unknown,
  roots: readonly Root[]
) {
  const input = impactPutInputSchema.parse(rawInput);
  const task = (await getEngineeringTasks(resolved.lineage, [input.taskKey]))[0];
  if (!task) throw new Error(`ENGINEERING_TASK_NOT_FOUND: ${input.taskKey}`);
  if (task.revision !== input.expectedRevision) {
    throw new Error(`ENGINEERING_REVISION_MISMATCH: expected ${input.expectedRevision}, current ${task.revision}`);
  }
  if (!task.impactReviewRequired) throw new Error('ENGINEERING_IMPACT_REVIEW_NOT_REQUIRED');
  if (!task.changedFiles.length) throw new Error('ENGINEERING_IMPACT_REVIEW_REQUIRES_CHANGED_FILES');

  const analysis = await analyzeEngineeringImpact(resolved, task, roots);
  if (!analysis.coverageComplete) {
    throw new Error(`ENGINEERING_IMPACT_REVIEW_INCOMPLETE_COVERAGE: ${analysis.unknownChangedFiles.join(', ') || 'implementation graph truncated'}`);
  }
  const assessments = input.assessments.map<EngineeringImpactAssessment>(assessment => ({
    nodeId: assessment.nodeId,
    decision: assessment.decision,
    note: assessment.note
  }));
  const assessmentIds = assessments.map(assessment => assessment.nodeId);
  if (new Set(assessmentIds).size !== assessmentIds.length) {
    throw new Error('ENGINEERING_IMPACT_REVIEW_DUPLICATE_ASSESSMENT');
  }
  const currentTargets = new Set([...analysis.required, ...analysis.advisory].map(target => target.nodeId));
  const foreign = assessments.filter(assessment => !currentTargets.has(assessment.nodeId));
  if (foreign.length) {
    throw new Error(`ENGINEERING_IMPACT_REVIEW_FOREIGN_TARGET: ${foreign.map(item => item.nodeId).join(', ')}`);
  }
  const assessed = new Set(assessmentIds);
  const missingRequired = analysis.required.filter(target => !assessed.has(target.nodeId));
  if (missingRequired.length) {
    throw new Error(`ENGINEERING_IMPACT_REVIEW_MISSING_REQUIRED: ${missingRequired.map(target => target.label).join(', ')}`);
  }

  const reviewedAt = new Date().toISOString();
  const saved = await putEngineeringTask(resolved.lineage, {
    key: task.key,
    expectedRevision: task.revision
  }, {
    impactReview: {
      status: 'reviewed',
      assessments,
      basisHash: analysis.basisHash,
      reviewedAt
    }
  });
  return { task: saved, impact: analysis };
}
