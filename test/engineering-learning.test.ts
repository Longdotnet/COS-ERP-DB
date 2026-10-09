import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { engineeringKnowledgeScope, type ResolvedEngineeringLineage } from '../src/cos-erp-db/engineering/lineage.js';
import { prepareEngineeringTask } from '../src/cos-erp-db/engineering/prepare-service.js';
import { engineeringQualityGate } from '../src/cos-erp-db/engineering/quality-gate.js';
import { initEngineeringStore, resetEngineeringStoreForTests } from '../src/cos-erp-db/engineering/store.js';
import { putEngineeringTask } from '../src/cos-erp-db/engineering/task-service.js';
import { runEngineeringValidation } from '../src/cos-erp-db/engineering/verification-service.js';
import { knowledgeSha256 } from '../src/cos-erp-db/knowledge/evidence.js';
import { putIncidentOutcome } from '../src/cos-erp-db/knowledge/outcome-service.js';
import { initIncidentOutcomeStore, resetIncidentOutcomeStoreForTests } from '../src/cos-erp-db/knowledge/outcome-store.js';
import { initIncidentPatternStore, resetIncidentPatternStoreForTests } from '../src/cos-erp-db/knowledge/pattern-store.js';
import { putBusinessProcessRecord } from '../src/cos-erp-db/knowledge/process-service.js';
import { initBusinessProcessStore, resetBusinessProcessStoreForTests } from '../src/cos-erp-db/knowledge/process-store.js';
import { indexKnowledge, resetKnowledgeSearchCacheForTests, searchKnowledge } from '../src/cos-erp-db/knowledge/service.js';
import { initKnowledgeStore, resetKnowledgeStoreForTests } from '../src/cos-erp-db/knowledge/store.js';
import { initIncidentTechnicalEvidenceStore, resetIncidentTechnicalEvidenceStoreForTests } from '../src/cos-erp-db/knowledge/technical-evidence-store.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { issueIncidentTestReceipt } from './incident-machine-fixture.js';

let directory = '';
let workspace = '';
let roots: Root[] = [];
let resolved: ResolvedEngineeringLineage;

beforeEach(async () => {
  directory = await makeTempDir('cos-engineering-learning-');
  workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'FeatureA.cs'), 'class FeatureA { const string Marker = "LearningIncident"; }', 'utf8');
  await fs.writeFile(path.join(workspace, 'FeatureB.cs'), 'class FeatureB { const string Marker = "LearningIncident"; int B = 2; }', 'utf8');
  await fs.writeFile(path.join(workspace, 'FeatureC.cs'), 'class FeatureC { const string Marker = "LearningIncident"; int C = 3; }', 'utf8');
  roots = [{ name: 'workspace', path: workspace }];
  const userData = path.join(directory, 'user-data');
  initEngineeringStore(userData);
  initKnowledgeStore(userData);
  initBusinessProcessStore(userData);
  initIncidentOutcomeStore(userData);
  initIncidentPatternStore(userData);
  initIncidentTechnicalEvidenceStore(userData);
  resetKnowledgeSearchCacheForTests();
  const rootIdentity = knowledgeSha256(workspace);
  resolved = {
    lineage: {
      key: knowledgeSha256(`engineering-learning-lineage\0${rootIdentity}`),
      projectId: null,
      rootIdentity,
      profile: 'generic',
      runtimeFamily: 'net10',
      sourceRevision: null
    },
    workspace: { virtual: '/workspace', real: workspace }
  };
});

afterEach(async () => {
  resetEngineeringStoreForTests();
  resetKnowledgeSearchCacheForTests();
  resetIncidentTechnicalEvidenceStoreForTests();
  resetIncidentPatternStoreForTests();
  resetIncidentOutcomeStoreForTests();
  resetBusinessProcessStoreForTests();
  resetKnowledgeStoreForTests();
  await removeTempDir(directory);
});

async function seedMachineBackedOutcome() {
  const scope = engineeringKnowledgeScope(resolved.lineage);
  await indexKnowledge({ scope, sources: [{ kind: 'source', path: '/workspace' }], mode: 'incremental' }, roots);
  const hit = (await searchKnowledge({ scope, query: 'LearningIncident', limit: 1 })).hits[0]!;
  const evidence = { evidenceId: hit.evidenceId, contentHash: hit.contentHash, relation: 'supports' as const };
  await putBusinessProcessRecord(scope, { key: 'customer:test', kind: 'customer', title: 'Test', statement: 'Test customer.' });
  await putBusinessProcessRecord(scope, {
    key: 'process:learning', kind: 'process', parentKey: 'customer:test', title: 'LearningIncident process',
    statement: 'LearningIncident process.', status: 'accepted', confidence: 'high', evidence: [evidence]
  });
  await putBusinessProcessRecord(scope, {
    key: 'rule:learning', kind: 'rule', parentKey: 'process:learning', title: 'LearningIncident rule',
    statement: 'LearningIncident rule.', status: 'accepted', confidence: 'high', evidence: [evidence]
  });
  await putBusinessProcessRecord(scope, {
    key: 'expected:learning', kind: 'expected_behavior', parentKey: 'rule:learning', title: 'LearningIncident expected behavior',
    statement: 'LearningIncident stays correct.', status: 'accepted', confidence: 'high', evidence: [evidence]
  });
  const base = {
    key: 'outcome:learning',
    incidentKey: 'INC-LEARNING',
    title: 'LearningIncident confirmed outcome',
    symptom: 'LearningIncident produced the wrong result.',
    processKey: 'process:learning',
    expectedBehaviorKey: 'expected:learning',
    rootCauseCategory: 'logic',
    finding: 'LearningIncident applied the rule twice.',
    remediation: 'Apply the rule once.',
    incidentClass: 'logic_correctness' as const,
    evidence: [evidence],
    validation: { result: 'pending' as const, summary: 'Regression validation for LearningIncident.', evidence: [evidence] },
    status: 'draft' as const,
    decisionNote: 'Await machine evidence.'
  };
  const draft = await putIncidentOutcome(scope, base);
  const receipt = await issueIncidentTestReceipt(resolved, roots, {
    scope,
    outcomeKey: base.key,
    taskKey: 'verify:outcome:learning',
    changedFile: 'FeatureA.cs'
  });
  const acceptedInput = {
    ...base,
    status: 'accepted' as const,
    validation: { ...base.validation, result: 'passed' as const },
    technicalEvidence: [receipt.ref],
    decisionNote: 'Machine-backed outcome accepted.',
    expectedRevision: draft.outcome.revision
  };
  const accepted = await putIncidentOutcome(scope, acceptedInput);
  return { scope, evidence, base, acceptedInput, accepted };
}

async function machineVerifyTask(taskKey: string) {
  await runEngineeringValidation(resolved, {
    kind: 'command', taskKey, name: 'test', command: 'dotnet', args: ['test']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: async () => ({ exitCode: 0, stdout: 'Passed.', stderr: '', truncated: false, timedOut: false, durationMs: 4 })
  });
}

it('keeps stale context learning informational and does not take away Machine Verified', async () => {
  const learning = await seedMachineBackedOutcome();
  const task = await putEngineeringTask(resolved.lineage, {
    key: 'context-task', goal: 'Implement using prior context only.', changedFiles: ['FeatureA.cs'],
    learningRefs: [{ kind: 'incident_outcome', key: learning.accepted.outcome.key, role: 'context' }],
    validations: [{ name: 'test', status: 'pending', detail: 'Run tests.' }]
  });
  await machineVerifyTask(task.key);
  expect((await engineeringQualityGate(resolved.lineage, task.key, roots, resolved.workspace)).assurance.machineVerified).toBe(true);

  await putIncidentOutcome(learning.scope, {
    ...learning.acceptedInput,
    status: 'invalidated',
    decisionNote: 'Later investigation invalidated this outcome.',
    expectedRevision: learning.accepted.outcome.revision
  });
  const gate = await engineeringQualityGate(resolved.lineage, task.key, roots, resolved.workspace);
  expect(gate.assurance.learningRefs).toMatchObject({ staleContext: 1, staleReliedUpon: 0 });
  expect(gate.assurance.machineVerified).toBe(true);
  expect(gate.status).toBe('pass');
});

it('keeps stale advisory learning informational and does not take away Machine Verified', async () => {
  const learning = await seedMachineBackedOutcome();
  const task = await putEngineeringTask(resolved.lineage, {
    key: 'advisory-task',
    goal: 'Implement with prior learning as advisory input only.',
    changedFiles: ['FeatureA.cs'],
    learningRefs: [{ kind: 'incident_outcome', key: learning.accepted.outcome.key, role: 'advisory' }],
    validations: [{ name: 'test', status: 'pending', detail: 'Run tests.' }]
  });
  await machineVerifyTask(task.key);
  expect((await engineeringQualityGate(resolved.lineage, task.key, roots, resolved.workspace)).assurance.machineVerified).toBe(true);

  await putIncidentOutcome(learning.scope, {
    ...learning.acceptedInput,
    status: 'invalidated',
    decisionNote: 'Later investigation invalidated this advisory outcome.',
    expectedRevision: learning.accepted.outcome.revision
  });
  const gate = await engineeringQualityGate(resolved.lineage, task.key, roots, resolved.workspace);
  expect(gate.assurance.learningRefs).toMatchObject({ staleAdvisory: 1, staleReliedUpon: 0 });
  expect(gate.assurance.machineVerified).toBe(true);
  expect(gate.status).toBe('pass');
});

it('blocks Machine Verified when relied-upon learning becomes stale', async () => {
  const learning = await seedMachineBackedOutcome();
  const task = await putEngineeringTask(resolved.lineage, {
    key: 'relied-task', goal: 'Implement a decision that relies on confirmed prior learning.', changedFiles: ['FeatureA.cs'],
    learningRefs: [{ kind: 'incident_outcome', key: learning.accepted.outcome.key, role: 'relied_upon' }],
    validations: [{ name: 'test', status: 'pending', detail: 'Run tests.' }]
  });
  await machineVerifyTask(task.key);
  expect((await engineeringQualityGate(resolved.lineage, task.key, roots, resolved.workspace)).assurance.machineVerified).toBe(true);

  await putIncidentOutcome(learning.scope, {
    ...learning.acceptedInput,
    status: 'invalidated',
    decisionNote: 'Prior relied-upon learning is no longer valid.',
    expectedRevision: learning.accepted.outcome.revision
  });
  const gate = await engineeringQualityGate(resolved.lineage, task.key, roots, resolved.workspace);
  expect(gate.assurance.learningRefs.staleReliedUpon).toBe(1);
  expect(gate.assurance.machineVerified).toBe(false);
  expect(gate.blockers.join(' ')).toContain('Relied-upon learning');
});

it('persists discovered prior learning as context during prepare instead of keeping it transient only', async () => {
  const learning = await seedMachineBackedOutcome();
  const prepared = await prepareEngineeringTask(resolved, {
    taskKey: 'prepared-learning',
    goal: 'Fix LearningIncident using current project evidence.',
    analogueQuery: 'LearningIncident',
    analogueLimit: 3
  }, roots);
  expect(prepared.task.learningRefs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'incident_outcome',
      key: learning.accepted.outcome.key,
      role: 'context',
      boundLiveStatus: 'accepted'
    })
  ]));
  expect(prepared.executionCapsule.learningRefs).toEqual(prepared.task.learningRefs);

  const promotedRole = await putEngineeringTask(resolved.lineage, {
    key: prepared.task.key,
    learningRefs: [{ kind: 'incident_outcome', key: learning.accepted.outcome.key, role: 'relied_upon' }],
    expectedRevision: prepared.task.revision
  });
  const before = promotedRole.learningRefs[0]!;
  const reparsed = await prepareEngineeringTask(resolved, {
    taskKey: prepared.task.key,
    goal: 'Fix LearningIncident using current project evidence.',
    analogueQuery: 'LearningIncident',
    analogueLimit: 3,
    expectedRevision: promotedRole.revision
  }, roots);
  expect(reparsed.task.learningRefs[0]).toMatchObject({
    role: 'relied_upon',
    semanticHash: before.semanticHash,
    boundAt: before.boundAt
  });
});
