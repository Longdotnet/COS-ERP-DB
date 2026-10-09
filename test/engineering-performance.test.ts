import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  getEngineeringPerformance,
  initEngineeringPerformance,
  measureEngineeringPhase,
  observeEngineeringInvocation
} from '../src/cos-erp-db/engineering/performance.js';
import { initEngineeringStore, resetEngineeringStoreForTests } from '../src/cos-erp-db/engineering/store.js';
import { getEngineeringTasks, putEngineeringTask } from '../src/cos-erp-db/engineering/task-service.js';
import { engineeringQualityGate } from '../src/cos-erp-db/engineering/quality-gate.js';
import { runEngineeringValidation } from '../src/cos-erp-db/engineering/verification-service.js';
import type { EngineeringProjectLineage } from '../src/cos-erp-db/engineering/contracts.js';
import { knowledgeSha256 } from '../src/cos-erp-db/knowledge/evidence.js';
import { indexKnowledge, searchKnowledge } from '../src/cos-erp-db/knowledge/service.js';
import { initKnowledgeStore, resetKnowledgeStoreForTests } from '../src/cos-erp-db/knowledge/store.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let temp = '';
let workspace = '';
let userData = '';
let roots: Root[] = [];
let lineage: EngineeringProjectLineage;

beforeEach(async () => {
  temp = await makeTempDir('cos-performance-');
  workspace = path.join(temp, 'workspace');
  userData = path.join(temp, 'user-data');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'Feature.cs'), 'class Feature { int Value = 1; }', 'utf8');
  roots = [{ name: 'workspace', path: workspace }];
  lineage = {
    key: knowledgeSha256('performance-lineage-' + temp),
    projectId: null,
    rootIdentity: knowledgeSha256(workspace),
    profile: 'generic',
    runtimeFamily: 'net8',
    sourceRevision: null
  };
  initEngineeringStore(userData);
  initEngineeringPerformance(userData);
  initKnowledgeStore(userData);
});

afterEach(async () => {
  resetEngineeringStoreForTests();
  resetKnowledgeStoreForTests();
  await removeTempDir(temp);
});

it('persists task-scoped indexing/read counters across reinitialization without changing task revision', async () => {
  const task = await putEngineeringTask(lineage, { key: 'machine-a', goal: 'Inspect machine A.' });
  const result = await observeEngineeringInvocation(lineage.key, task.key, 'prepare', async () => {
    const index = await measureEngineeringPhase('prepare.current_discovery', () => indexKnowledge({
      scope: 'perf-test-' + lineage.key,
      sources: [{ kind: 'source', path: '/workspace' }],
      mode: 'incremental'
    }, roots));
    await searchKnowledge({ scope: index.scope, query: 'Feature', limit: 3 });
    return { task: { revision: task.revision } };
  }, value => value.task.revision);
  expect(result.task.revision).toBe(1);
  const first = await getEngineeringPerformance(lineage.key, task.key);
  expect(first.observedInvocationCount).toBe(1);
  expect(first.invocations[0]).toMatchObject({ action: 'prepare', revision: 1, success: true });
  expect(first.phases.find(item => item.name === 'knowledge.index')?.metrics).toMatchObject({
    filesDiscovered: 1, filesProcessed: 1, filesRead: 1, sourceHashesComputed: 1
  });
  expect(first.phases.some(item => item.name === 'prepare.current_discovery')).toBe(true);
  expect(first.phases.some(item => item.name === 'knowledge.search')).toBe(true);
  initEngineeringPerformance(userData);
  expect((await getEngineeringPerformance(lineage.key, task.key)).observedInvocationCount).toBe(1);
  expect((await getEngineeringTasks(lineage, [task.key]))[0]?.revision).toBe(1);
});

it('keeps concurrent tasks and lineages isolated, recording failures without losing successful invocations', async () => {
  const otherLineage = knowledgeSha256('other-lineage');
  await Promise.all([
    observeEngineeringInvocation(lineage.key, 'task-a', 'discover', async () => {
      await measureEngineeringPhase('discover.work', async () => Promise.resolve());
      return { revision: 2 };
    }, value => value.revision),
    observeEngineeringInvocation(lineage.key, 'task-b', 'validation_run', async () => {
      throw new Error('test failure');
    }).catch(() => undefined),
    observeEngineeringInvocation(otherLineage, 'task-a', 'quality_gate', async () => 'ok')
  ]);
  const first = await getEngineeringPerformance(lineage.key, 'task-a');
  const second = await getEngineeringPerformance(lineage.key, 'task-b');
  expect(first.observedInvocationCount).toBe(1);
  expect(second.invocations[0]).toMatchObject({ success: false, action: 'validation_run' });
  expect((await getEngineeringPerformance(otherLineage, 'task-a')).observedInvocationCount).toBe(1);
  expect(first.invocations[0]?.revision).toBe(2);
});

it('keeps Machine Verified semantics unchanged and fails open if telemetry storage is unavailable', async () => {
  const resolved = { lineage, workspace: { real: workspace, virtual: '/workspace' } };
  const task = await putEngineeringTask(lineage, {
    key: 'machine-verified',
    goal: 'Build a feature.',
    changedFiles: ['Feature.cs'],
    validations: [
      { name: 'build', status: 'pending', detail: 'Build feature.' },
      { name: 'test', status: 'pending', detail: 'Test feature.' },
      { name: 'typecheck', status: 'pending', detail: 'Typecheck feature.' }
    ]
  });
  const verification = await observeEngineeringInvocation(lineage.key, task.key, 'validation_run', () =>
    runEngineeringValidation(resolved, {
      kind: 'command', taskKey: task.key, name: 'build', command: 'dotnet', args: ['build']
    }, roots, {
      commandPolicy: { enabled: false, mode: 'allow', rules: [] },
      commandRunner: async () => ({
        exitCode: 0, stdout: 'Build succeeded.', stderr: '',
        truncated: false, timedOut: false, durationMs: 1
      })
    })
  );
  expect(verification.success).toBe(true);
  const testVerification = await observeEngineeringInvocation(lineage.key, task.key, 'validation_run', () =>
    runEngineeringValidation(resolved, {
      kind: 'command', taskKey: task.key, name: 'test', command: 'dotnet', args: ['test']
    }, roots, {
      commandPolicy: { enabled: false, mode: 'allow', rules: [] },
      commandRunner: async () => ({
        exitCode: 0, stdout: 'Tests passed.', stderr: '',
        truncated: false, timedOut: false, durationMs: 1
      })
    })
  );
  expect(testVerification.success).toBe(true);
  const typecheckVerification = await observeEngineeringInvocation(lineage.key, task.key, 'validation_run', () =>
    runEngineeringValidation(resolved, {
      kind: 'command', taskKey: task.key, name: 'typecheck', command: 'npm', args: ['run', 'typecheck']
    }, roots, {
      commandPolicy: { enabled: false, mode: 'allow', rules: [] },
      commandRunner: async () => ({
        exitCode: 0, stdout: 'Typecheck passed.', stderr: '',
        truncated: false, timedOut: false, durationMs: 1
      })
    })
  );
  expect(typecheckVerification.success).toBe(true);
  const gate = await observeEngineeringInvocation(lineage.key, task.key, 'quality_gate', () =>
    engineeringQualityGate(lineage, task.key, roots, resolved.workspace));
  expect(gate.status).toBe('pass');
  expect(gate.assurance.machineVerified).toBe(true);
  expect(gate.assurance.commandVerifications).toHaveLength(3);
  const report = await getEngineeringPerformance(lineage.key, task.key);
  expect(report.phases.some(item => item.name === 'validation.pre_index')).toBe(true);
  expect(report.phases.some(item => item.name === 'validation.post_index')).toBe(true);
  expect(report.phases.some(item => item.name === 'validation.command')).toBe(true);
  expect(report.phases.some(item => item.name === 'gate.current_index')).toBe(true);
  expect(report.phases.find(item => item.name === 'gate.changed_files')?.count).toBe(1);
  expect(report.phases.find(item => item.name === 'gate.final_changed_files')?.count).toBe(1);
  const indexMetrics = report.phases.find(item => item.name === 'knowledge.index')?.metrics;
  expect(indexMetrics?.filesReused ?? 0).toBe(0);
  expect((await getEngineeringTasks(lineage, [task.key]))[0]?.revision).toBe(task.revision);

  const blocker = path.join(temp, 'blocked-performance-root');
  await fs.writeFile(blocker, 'not a directory', 'utf8');
  initEngineeringPerformance(blocker);
  const unaffected = await observeEngineeringInvocation(lineage.key, task.key, 'quality_gate', () =>
    engineeringQualityGate(lineage, task.key, roots, resolved.workspace));
  expect(unaffected.assurance.machineVerified).toBe(true);
});
