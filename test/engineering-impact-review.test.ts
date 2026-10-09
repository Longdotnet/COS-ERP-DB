import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { getEngineeringImpact, putEngineeringImpactReview } from '../src/cos-erp-db/engineering/impact-service.js';
import { engineeringKnowledgeScope, type ResolvedEngineeringLineage } from '../src/cos-erp-db/engineering/lineage.js';
import { engineeringQualityGate } from '../src/cos-erp-db/engineering/quality-gate.js';
import { initEngineeringStore, resetEngineeringStoreForTests } from '../src/cos-erp-db/engineering/store.js';
import { getEngineeringTasks, putEngineeringTask } from '../src/cos-erp-db/engineering/task-service.js';
import { runEngineeringValidation } from '../src/cos-erp-db/engineering/verification-service.js';
import { knowledgeSha256 } from '../src/cos-erp-db/knowledge/evidence.js';
import { putBusinessProcessRecord } from '../src/cos-erp-db/knowledge/process-service.js';
import { initBusinessProcessStore, resetBusinessProcessStoreForTests } from '../src/cos-erp-db/knowledge/process-store.js';
import { indexKnowledge, resetKnowledgeSearchCacheForTests, searchKnowledge } from '../src/cos-erp-db/knowledge/service.js';
import { initKnowledgeStore, resetKnowledgeStoreForTests } from '../src/cos-erp-db/knowledge/store.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let workspace = '';
let roots: Root[] = [];
let resolved: ResolvedEngineeringLineage;

beforeEach(async () => {
  directory = await makeTempDir('cos-engineering-impact-');
  workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, 'Feature.cs'),
    'public sealed class Feature { public const string Marker = "MachineTransferImpactMarker"; }',
    'utf8'
  );
  roots = [{ name: 'workspace', path: workspace }];
  const userData = path.join(directory, 'user-data');
  initEngineeringStore(userData);
  initKnowledgeStore(userData);
  initBusinessProcessStore(userData);
  resetKnowledgeSearchCacheForTests();
  const rootIdentity = knowledgeSha256(workspace);
  resolved = {
    lineage: {
      key: knowledgeSha256(`impact-lineage\0${rootIdentity}`),
      projectId: null,
      rootIdentity,
      profile: 'generic',
      runtimeFamily: 'net10',
      sourceRevision: null
    },
    workspace: { real: workspace, virtual: '/workspace' }
  };
});

afterEach(async () => {
  resetEngineeringStoreForTests();
  resetKnowledgeSearchCacheForTests();
  resetKnowledgeStoreForTests();
  resetBusinessProcessStoreForTests();
  await removeTempDir(directory);
});

async function sourceEvidence() {
  const scope = engineeringKnowledgeScope(resolved.lineage);
  await indexKnowledge({ scope, sources: [{ kind: 'source', path: '/workspace' }], mode: 'incremental' }, roots);
  const found = await searchKnowledge({ scope, query: 'MachineTransferImpactMarker', limit: 1 });
  expect(found.hits).toHaveLength(1);
  return {
    evidenceId: found.hits[0]!.evidenceId,
    contentHash: found.hits[0]!.contentHash,
    relation: 'supports' as const
  };
}

async function addAcceptedImpactChain() {
  const scope = engineeringKnowledgeScope(resolved.lineage);
  const evidence = await sourceEvidence();
  await putBusinessProcessRecord(scope, {
    key: 'customer:test',
    kind: 'customer',
    title: 'Test customer',
    statement: 'Impact-review test customer.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'process:machine-transfer',
    kind: 'process',
    parentKey: 'customer:test',
    title: 'Machine transfer',
    statement: 'Move a machine between departments.',
    status: 'accepted',
    confidence: 'high',
    evidence: [evidence]
  });
  await putBusinessProcessRecord(scope, {
    key: 'rule:machine-transfer',
    kind: 'rule',
    parentKey: 'process:machine-transfer',
    title: 'Transfer ownership rule',
    statement: 'The selected department becomes the current owner.',
    status: 'accepted',
    confidence: 'high',
    evidence: [evidence]
  });
  await putBusinessProcessRecord(scope, {
    key: 'expected:machine-transfer',
    kind: 'expected_behavior',
    parentKey: 'rule:machine-transfer',
    title: 'Expected machine ownership',
    statement: 'A successful transfer exposes the target department as current owner.',
    status: 'accepted',
    confidence: 'high',
    evidence: [evidence]
  });
}

it('requires reviewed high-confidence accepted business impacts before Machine Verified', async () => {
  await addAcceptedImpactChain();
  const task = await putEngineeringTask(resolved.lineage, {
    key: 'machine-transfer-change',
    goal: 'Change the machine transfer implementation without breaking its accepted contract.',
    changedFiles: ['Feature.cs'],
    validations: [{ name: 'build', status: 'pending', detail: 'Build changed code.' }]
  }, { impactReviewRequired: true });

  const impact = await getEngineeringImpact(resolved, task.key, roots);
  expect(impact.required.map(target => target.kind)).toEqual(expect.arrayContaining([
    'process',
    'rule',
    'expected_behavior'
  ]));
  expect(impact.required.every(target => target.confidence === 'high')).toBe(true);

  await expect(putEngineeringImpactReview(resolved, {
    taskKey: task.key,
    assessments: impact.required.slice(0, 1).map(target => ({
      nodeId: target.nodeId,
      decision: 'preserved',
      note: 'Reviewed only one target for the negative test.'
    })),
    expectedRevision: task.revision
  }, roots)).rejects.toThrow('ENGINEERING_IMPACT_REVIEW_MISSING_REQUIRED');

  const reviewed = await putEngineeringImpactReview(resolved, {
    taskKey: task.key,
    assessments: impact.required.map(target => ({
      nodeId: target.nodeId,
      decision: 'preserved',
      note: `Verified the changed implementation preserves ${target.label}.`
    })),
    expectedRevision: task.revision
  }, roots);
  expect(reviewed.task.impactReviewStatus).toBe('reviewed');
  expect(reviewed.task.impactReviewBasisHash).toBe(impact.basisHash);

  await runEngineeringValidation(resolved, {
    kind: 'command',
    taskKey: task.key,
    name: 'build',
    command: 'dotnet',
    args: ['build']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: async () => ({
      exitCode: 0,
      stdout: 'Build succeeded.',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 5
    })
  });

  const gate = await engineeringQualityGate(resolved.lineage, task.key, roots, resolved.workspace);
  expect(gate.status).toBe('pass');
  expect(gate.assurance.impactReviewVerified).toBe(true);
  expect(gate.assurance.machineVerified).toBe(true);
});

it('keeps draft or weak business records advisory instead of turning them into quality-gate blockers', async () => {
  const scope = engineeringKnowledgeScope(resolved.lineage);
  const evidence = await sourceEvidence();
  await putBusinessProcessRecord(scope, {
    key: 'customer:test',
    kind: 'customer',
    title: 'Test customer',
    statement: 'Impact-review test customer.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'process:draft-machine-transfer',
    kind: 'process',
    parentKey: 'customer:test',
    title: 'Draft machine transfer idea',
    statement: 'Unaccepted observation only.',
    status: 'draft',
    confidence: 'low',
    evidence: [evidence]
  });
  const task = await putEngineeringTask(resolved.lineage, {
    key: 'advisory-only',
    goal: 'Change code with only weak process context.',
    changedFiles: ['Feature.cs']
  }, { impactReviewRequired: true });

  const impact = await getEngineeringImpact(resolved, task.key, roots);
  expect(impact.required).toEqual([]);
  expect(impact.advisory.some(target => target.recordKey === 'process:draft-machine-transfer')).toBe(true);
});

it('invalidates a reviewed impact basis when changedFiles change', async () => {
  await addAcceptedImpactChain();
  const task = await putEngineeringTask(resolved.lineage, {
    key: 'impact-drift',
    goal: 'Review impact before expanding the implementation surface.',
    changedFiles: ['Feature.cs']
  }, { impactReviewRequired: true });
  const impact = await getEngineeringImpact(resolved, task.key, roots);
  const reviewed = await putEngineeringImpactReview(resolved, {
    taskKey: task.key,
    assessments: impact.required.map(target => ({
      nodeId: target.nodeId,
      decision: 'preserved',
      note: `Reviewed ${target.label}.`
    })),
    expectedRevision: task.revision
  }, roots);

  await fs.writeFile(path.join(workspace, 'Other.cs'), 'public sealed class Other {}', 'utf8');
  const changed = await putEngineeringTask(resolved.lineage, {
    key: task.key,
    changedFiles: ['Feature.cs', 'Other.cs'],
    expectedRevision: reviewed.task.revision
  });
  expect(changed.impactReviewStatus).toBe('pending');
  expect(changed.impactAssessments).toEqual([]);
  expect(changed.impactReviewBasisHash).toBeNull();
  expect((await getEngineeringTasks(resolved.lineage, [task.key]))[0]?.impactReviewStatus).toBe('pending');
});

it('stales a reviewed impact basis when the same changed file content changes', async () => {
  await addAcceptedImpactChain();
  const task = await putEngineeringTask(resolved.lineage, {
    key: 'impact-content-drift',
    goal: 'Review impact and then prove same-path edits cannot reuse the old review.',
    changedFiles: ['Feature.cs']
  }, { impactReviewRequired: true });
  const impact = await getEngineeringImpact(resolved, task.key, roots);
  const reviewed = await putEngineeringImpactReview(resolved, {
    taskKey: task.key,
    assessments: impact.required.map(target => ({
      nodeId: target.nodeId,
      decision: 'preserved',
      note: `Reviewed ${target.label}.`
    })),
    expectedRevision: task.revision
  }, roots);

  await fs.writeFile(
    path.join(workspace, 'Feature.cs'),
    'public sealed class Feature { public const string Marker = "MachineTransferImpactMarker"; public int Version => 2; }',
    'utf8'
  );
  const current = await getEngineeringImpact(resolved, task.key, roots);
  expect(current.basisHash).not.toBe(reviewed.task.impactReviewBasisHash);

  const gate = await engineeringQualityGate(resolved.lineage, task.key, roots, resolved.workspace);
  expect(gate.assurance.impactReviewVerified).toBe(false);
  expect(gate.blockers.join(' ')).toContain('impact review is stale');
});

it('fails closed when a changed file cannot be mapped into the current Implementation Graph', async () => {
  await fs.writeFile(path.join(workspace, 'Opaque.bin'), 'opaque-change', 'utf8');
  await putEngineeringTask(resolved.lineage, {
    key: 'impact-unknown-file',
    goal: 'Do not treat missing graph coverage as proof of no impact.',
    changedFiles: ['Opaque.bin']
  }, { impactReviewRequired: true });

  const impact = await getEngineeringImpact(resolved, 'impact-unknown-file', roots);
  expect(impact.coverageComplete).toBe(false);
  expect(impact.unknownChangedFiles).toHaveLength(1);

  const gate = await engineeringQualityGate(resolved.lineage, 'impact-unknown-file', roots, resolved.workspace);
  expect(gate.assurance.impactReviewVerified).toBe(false);
  expect(gate.blockers.join(' ')).toContain('coverage is incomplete');
});

it('does not let a changed accepted business impact self-authorize through an impact note alone', async () => {
  await addAcceptedImpactChain();
  const task = await putEngineeringTask(resolved.lineage, {
    key: 'impact-business-change',
    goal: 'Change an accepted machine-transfer business contract.',
    changedFiles: ['Feature.cs']
  }, { impactReviewRequired: true });
  const impact = await getEngineeringImpact(resolved, task.key, roots);
  const businessTarget = impact.required.find(target => target.kind === 'expected_behavior')!;
  const reviewed = await putEngineeringImpactReview(resolved, {
    taskKey: task.key,
    assessments: impact.required.map(target => ({
      nodeId: target.nodeId,
      decision: target.nodeId === businessTarget.nodeId ? 'changed' : 'preserved',
      note: target.nodeId === businessTarget.nodeId
        ? 'The implementation intentionally changes this accepted behavior.'
        : `Verified ${target.label} is preserved.`
    })),
    expectedRevision: task.revision
  }, roots);
  expect(reviewed.task.impactReviewStatus).toBe('reviewed');

  const gate = await engineeringQualityGate(resolved.lineage, task.key, roots, resolved.workspace);
  expect(gate.assurance.impactReviewVerified).toBe(false);
  expect(gate.blockers.join(' ')).toContain('requires a user-authority deliberation');
});
