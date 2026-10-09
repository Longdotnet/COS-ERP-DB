import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { recordIncidentMachineVerification } from '../src/cos-erp-db/engineering/incident-verification-service.js';
import { engineeringKnowledgeScope, type ResolvedEngineeringLineage } from '../src/cos-erp-db/engineering/lineage.js';
import { initEngineeringStore, resetEngineeringStoreForTests } from '../src/cos-erp-db/engineering/store.js';
import { putEngineeringTask } from '../src/cos-erp-db/engineering/task-service.js';
import { runEngineeringValidation } from '../src/cos-erp-db/engineering/verification-service.js';
import { knowledgeSha256 } from '../src/cos-erp-db/knowledge/evidence.js';
import {
  getIncidentOutcomes,
  incidentOutcomeTechnicalBasisHash,
  putIncidentOutcome
} from '../src/cos-erp-db/knowledge/outcome-service.js';
import { initIncidentOutcomeStore, resetIncidentOutcomeStoreForTests } from '../src/cos-erp-db/knowledge/outcome-store.js';
import { putBusinessProcessRecord } from '../src/cos-erp-db/knowledge/process-service.js';
import { initBusinessProcessStore, resetBusinessProcessStoreForTests } from '../src/cos-erp-db/knowledge/process-store.js';
import { indexKnowledge, resetKnowledgeSearchCacheForTests, searchKnowledge } from '../src/cos-erp-db/knowledge/service.js';
import { initKnowledgeStore, resetKnowledgeStoreForTests } from '../src/cos-erp-db/knowledge/store.js';
import { persistIncidentTechnicalEvidence } from '../src/cos-erp-db/knowledge/technical-evidence-service.js';
import { initIncidentTechnicalEvidenceStore, resetIncidentTechnicalEvidenceStoreForTests } from '../src/cos-erp-db/knowledge/technical-evidence-store.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let workspace = '';
let roots: Root[] = [];
let resolved: ResolvedEngineeringLineage;

beforeEach(async () => {
  directory = await makeTempDir('cos-incident-technical-');
  workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'Feature.cs'), 'public sealed class Feature { public const string Rule = "IncidentRule"; }', 'utf8');
  roots = [{ name: 'workspace', path: workspace }];
  const userData = path.join(directory, 'user-data');
  initEngineeringStore(userData);
  initKnowledgeStore(userData);
  initBusinessProcessStore(userData);
  initIncidentOutcomeStore(userData);
  initIncidentTechnicalEvidenceStore(userData);
  resetKnowledgeSearchCacheForTests();
  const rootIdentity = knowledgeSha256(workspace);
  resolved = {
    lineage: {
      key: knowledgeSha256(`incident-technical-lineage\0${rootIdentity}`),
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
  resetIncidentOutcomeStoreForTests();
  resetBusinessProcessStoreForTests();
  resetKnowledgeStoreForTests();
  await removeTempDir(directory);
});

async function seedBusinessEvidence() {
  const scope = engineeringKnowledgeScope(resolved.lineage);
  await indexKnowledge({ scope, sources: [{ kind: 'source', path: '/workspace' }], mode: 'incremental' }, roots);
  const search = await searchKnowledge({ scope, query: 'IncidentRule', limit: 1 });
  const hit = search.hits[0]!;
  const evidence = { evidenceId: hit.evidenceId, contentHash: hit.contentHash, relation: 'supports' as const };
  await putBusinessProcessRecord(scope, {
    key: 'customer:test', kind: 'customer', title: 'Test', statement: 'Test customer.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'process:incident', kind: 'process', parentKey: 'customer:test', title: 'Incident process',
    statement: 'Process under incident diagnosis.', status: 'accepted', confidence: 'high', evidence: [evidence]
  });
  await putBusinessProcessRecord(scope, {
    key: 'rule:incident', kind: 'rule', parentKey: 'process:incident', title: 'Incident rule',
    statement: 'The incident rule applies exactly once.', status: 'accepted', confidence: 'high', evidence: [evidence]
  });
  await putBusinessProcessRecord(scope, {
    key: 'expected:incident', kind: 'expected_behavior', parentKey: 'rule:incident', title: 'Expected behavior',
    statement: 'The incident rule remains correct.', status: 'accepted', confidence: 'high', evidence: [evidence]
  });
  return { scope, evidence };
}

function draftOutcome(
  evidence: Awaited<ReturnType<typeof seedBusinessEvidence>>['evidence'],
  incidentClass: 'logic_correctness' | 'performance' | 'deployment' | 'data' | 'concurrency' = 'logic_correctness'
) {
  return {
    key: 'outcome:incident-1',
    incidentKey: 'INC-1',
    title: 'Incident outcome',
    symptom: 'Observed incorrect result.',
    processKey: 'process:incident',
    expectedBehaviorKey: 'expected:incident',
    rootCauseCategory: 'logic',
    finding: 'The implementation applies the rule incorrectly.',
    remediation: 'Apply the accepted rule exactly once.',
    incidentClass,
    evidence: [evidence],
    validation: { result: 'pending' as const, summary: 'Regression test proves the corrected rule.', evidence: [evidence] },
    status: 'draft' as const,
    decisionNote: 'Awaiting machine verification.'
  };
}

async function machineReceipt(scope: string, outcomeKey: string) {
  const outcome = (await getIncidentOutcomes(scope, [outcomeKey])).outcomes[0]!.outcome;
  const outcomeBasisHash = incidentOutcomeTechnicalBasisHash(outcome);
  await putEngineeringTask(resolved.lineage, {
    key: 'incident-fix',
    goal: 'Fix incident INC-1 according to accepted behavior.',
    changedFiles: ['Feature.cs'],
    validations: [{ name: 'test', status: 'pending', detail: 'Run regression test.' }]
  });
  const verification = await runEngineeringValidation(resolved, {
    kind: 'command',
    taskKey: 'incident-fix',
    name: 'test',
    command: 'dotnet',
    args: ['test'],
    incidentBinding: { scope, outcomeKey, outcomeBasisHash }
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: async () => ({
      exitCode: 0, stdout: 'Tests passed.', stderr: '', truncated: false, timedOut: false, durationMs: 5
    })
  });
  return recordIncidentMachineVerification(resolved, {
    scope,
    outcomeKey,
    taskKey: 'incident-fix',
    verificationId: verification.id
  }, roots);
}

async function performanceReceipt(scope: string, outcomeKey: string) {
  const outcome = (await getIncidentOutcomes(scope, [outcomeKey])).outcomes[0]!.outcome;
  const outcomeBasisHash = incidentOutcomeTechnicalBasisHash(outcome);
  await putEngineeringTask(resolved.lineage, {
    key: 'incident-performance-fix',
    goal: 'Fix performance incident INC-1 for IncidentRule over dbo.FeatureTable.',
    changedFiles: ['Feature.cs'],
    validations: [{ name: 'test', status: 'pending', detail: 'Run regression test.' }],
    largeDataRisk: true,
    scaleStatus: 'runtime_evidenced'
  });
  await runEngineeringValidation(resolved, {
    kind: 'command',
    taskKey: 'incident-performance-fix',
    name: 'test',
    command: 'dotnet',
    args: ['test']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: async () => ({
      exitCode: 0, stdout: 'Tests passed.', stderr: '', truncated: false, timedOut: false, durationMs: 5
    })
  });
  const connection = async () => ({ id: 'test', name: 'Test', accessMode: 'read-only', connection: {} }) as any;
  const verification = await runEngineeringValidation(resolved, {
    kind: 'sql_scale',
    taskKey: 'incident-performance-fix',
    name: 'runtime',
    objectId: 42,
    runtimeSource: 'query_store',
    queryContains: 'IncidentRule',
    hours: 24,
    incidentBinding: { scope, outcomeKey, outcomeBasisHash }
  }, roots, {
    resolveConnection: connection,
    tableScale: async () => ({
      connection: 'test',
      database: 'ERP',
      capturedAt: new Date().toISOString(),
      object: { objectId: 42, schema: 'dbo', table: 'FeatureTable' },
      approximateRows: 1_000_000,
      reservedMb: 10,
      usedMb: 9,
      dataMb: 8,
      indexes: [],
      statistics: [],
      limitations: [],
      elapsedMs: 1
    }),
    queryStore: async () => ({
      connection: 'test',
      database: 'ERP',
      capturedAt: new Date().toISOString(),
      available: true,
      actualState: 'READ_WRITE',
      desiredState: 'READ_WRITE',
      readonlyReason: null,
      currentStorageMb: 10,
      maxStorageMb: 100,
      hours: 24,
      sort: 'duration' as const,
      queries: [{
        queryId: 1,
        planId: 1,
        executionCount: 25,
        avgDurationMs: 12,
        avgCpuMs: 4,
        avgLogicalReads: 100,
        lastExecutionAt: new Date().toISOString(),
        planCount: 1,
        sql: "SELECT * FROM dbo.FeatureTable WHERE Rule='IncidentRule'"
      }],
      limitations: [],
      elapsedMs: 1
    })
  });
  return recordIncidentMachineVerification(resolved, {
    scope,
    outcomeKey,
    taskKey: 'incident-performance-fix',
    verificationId: verification.id
  }, roots);
}

it('binds typed outcome acceptance to a current Machine Verified receipt and exact outcome basis', async () => {
  const { scope, evidence } = await seedBusinessEvidence();
  const draft = await putIncidentOutcome(scope, draftOutcome(evidence));

  await expect(putIncidentOutcome(scope, {
    ...draftOutcome(evidence),
    status: 'accepted',
    validation: { ...draftOutcome(evidence).validation, result: 'passed' },
    decisionNote: 'Caller claims validation passed.',
    expectedRevision: draft.outcome.revision
  })).rejects.toThrow('machine-backed technical evidence');

  const receipt = await machineReceipt(scope, draft.outcome.key);
  expect(receipt.evidence.role).toBe('causal_verification');
  const accepted = await putIncidentOutcome(scope, {
    ...draftOutcome(evidence),
    status: 'accepted',
    validation: { ...draftOutcome(evidence).validation, result: 'passed' },
    technicalEvidence: [receipt.ref],
    decisionNote: 'Machine verification is bound to this outcome basis.',
    expectedRevision: draft.outcome.revision
  });
  expect(accepted.provenance).toMatchObject({
    liveStatus: 'accepted',
    current: true,
    machineBacked: true,
    verificationLevel: 'typed_machine_backed'
  });

  await expect(putIncidentOutcome(scope, {
    ...draftOutcome(evidence),
    finding: 'A materially different root-cause hypothesis.',
    status: 'accepted',
    validation: { ...draftOutcome(evidence).validation, result: 'passed' },
    technicalEvidence: [receipt.ref],
    decisionNote: 'Attempt to reuse old receipt.',
    expectedRevision: accepted.outcome.revision
  })).rejects.toThrow('machine-backed technical evidence');
});

it('makes an accepted typed outcome stale when its verified implementation file changes later', async () => {
  const { scope, evidence } = await seedBusinessEvidence();
  const input = draftOutcome(evidence);
  const draft = await putIncidentOutcome(scope, input);
  const receipt = await machineReceipt(scope, draft.outcome.key);
  await putIncidentOutcome(scope, {
    ...input,
    status: 'accepted',
    validation: { ...input.validation, result: 'passed' },
    technicalEvidence: [receipt.ref],
    decisionNote: 'Machine verification is current at acceptance time.',
    expectedRevision: draft.outcome.revision
  });

  await fs.writeFile(
    path.join(workspace, 'Feature.cs'),
    'public sealed class Feature { public const string Rule = "IncidentRuleChangedAfterVerification"; }',
    'utf8'
  );

  const current = (await getIncidentOutcomes(scope, [input.key])).outcomes[0]!;
  expect(current.provenance).toMatchObject({
    liveStatus: 'stale',
    current: false,
    machineBacked: false,
    causalVerificationCurrent: false,
    technicalEvidenceCurrent: false
  });
  expect(current.provenance.missingTechnicalEvidence.join(' ')).toContain(
    'implementation files changed after verification'
  );
});

it('requires task-bound runtime DB verification for a performance outcome', async () => {
  const { scope, evidence } = await seedBusinessEvidence();
  const performance = draftOutcome(evidence, 'performance');
  const draft = await putIncidentOutcome(scope, performance);
  const testOnlyReceipt = await machineReceipt(scope, draft.outcome.key);

  await expect(putIncidentOutcome(scope, {
    ...performance,
    status: 'accepted',
    validation: { ...performance.validation, result: 'passed' },
    technicalEvidence: [testOnlyReceipt.ref],
    decisionNote: 'Machine test alone is not task-bound runtime performance evidence.',
    expectedRevision: draft.outcome.revision
  })).rejects.toThrow('runtime SQL verification');

  const receipt = await performanceReceipt(scope, draft.outcome.key);
  const accepted = await putIncidentOutcome(scope, {
    ...performance,
    status: 'accepted',
    validation: { ...performance.validation, result: 'passed' },
    technicalEvidence: [receipt.ref],
    decisionNote: 'Task-bound runtime SQL verification satisfies the performance evidence policy.',
    expectedRevision: draft.outcome.revision
  });
  expect(accepted.provenance.machineBacked).toBe(true);
  expect(accepted.provenance).toMatchObject({
    causalVerificationCurrent: true,
    technicalEvidenceRoles: {
      observations: 0,
      hypotheses: 0,
      causalVerifications: 1,
      legacyVerifications: 0
    }
  });
});

it('keeps an explicit investigation hypothesis separate from causal verification', async () => {
  const { scope, evidence } = await seedBusinessEvidence();
  const input = draftOutcome(evidence);
  const draft = await putIncidentOutcome(scope, input);
  const hypothesis = await persistIncidentTechnicalEvidence(scope, {
    incidentKey: input.incidentKey,
    kind: 'runtime_diagnosis',
    role: 'hypothesis',
    sourceAction: 'test/investigation-hypothesis',
    connection: null,
    capturedAt: new Date().toISOString(),
    payload: { claim: 'The runtime symptom may be caused by duplicate rule application.' }
  });

  await expect(putIncidentOutcome(scope, {
    ...input,
    status: 'accepted',
    validation: { ...input.validation, result: 'passed' },
    technicalEvidence: [{ evidenceId: hypothesis.id, contentHash: hypothesis.contentHash }],
    decisionNote: 'A hypothesis is recorded but has not been causally verified.',
    expectedRevision: draft.outcome.revision
  })).rejects.toThrow('machine-backed technical evidence');
});

it('refuses to attach an unrelated passed Engineering verification after execution', async () => {
  const { scope, evidence } = await seedBusinessEvidence();
  const input = draftOutcome(evidence);
  const draft = await putIncidentOutcome(scope, input);
  await putEngineeringTask(resolved.lineage, {
    key: 'unbound-incident-fix',
    goal: 'Run a valid but unbound regression test.',
    changedFiles: ['Feature.cs'],
    validations: [{ name: 'test', status: 'pending', detail: 'Run regression test.' }]
  });
  const verification = await runEngineeringValidation(resolved, {
    kind: 'command',
    taskKey: 'unbound-incident-fix',
    name: 'test',
    command: 'dotnet',
    args: ['test']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: async () => ({
      exitCode: 0,
      stdout: 'Tests passed.',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 5
    })
  });

  await expect(recordIncidentMachineVerification(resolved, {
    scope,
    outcomeKey: draft.outcome.key,
    taskKey: 'unbound-incident-fix',
    verificationId: verification.id
  }, roots)).rejects.toThrow('PREBOUND_OUTCOME_BASIS');
});

it('does not accept a legacy caller-forged verification record as causal authority', async () => {
  const { scope, evidence } = await seedBusinessEvidence();
  const input = draftOutcome(evidence);
  const draft = await putIncidentOutcome(scope, input);
  const legacy = await persistIncidentTechnicalEvidence(scope, {
    incidentKey: input.incidentKey,
    kind: 'machine_validation',
    role: 'verification',
    sourceAction: 'legacy/test-fixture',
    connection: null,
    capturedAt: new Date().toISOString(),
    payload: {
      outcomeKey: input.key,
      outcomeBasisHash: incidentOutcomeTechnicalBasisHash(draft.outcome),
      purpose: 'test',
      machineVerifiedAtCapture: true
    }
  });

  await expect(putIncidentOutcome(scope, {
    ...input,
    status: 'accepted',
    validation: { ...input.validation, result: 'passed' },
    technicalEvidence: [{ evidenceId: legacy.id, contentHash: legacy.contentHash }],
    decisionNote: 'Legacy receipt remains readable but is not new causal authority.',
    expectedRevision: draft.outcome.revision
  })).rejects.toThrow('pre-bound causal machine test');
});

it('requires complete non-truncated deployment comparison evidence', async () => {
  const { scope, evidence } = await seedBusinessEvidence();
  const input = draftOutcome(evidence, 'deployment');
  const draft = await putIncidentOutcome(scope, input);
  const receipt = await machineReceipt(scope, draft.outcome.key);
  const incomplete = await persistIncidentTechnicalEvidence(scope, {
    incidentKey: input.incidentKey,
    kind: 'deployment_compare',
    role: 'observation',
    sourceAction: 'test/deployment-compare',
    connection: 'CURRENT',
    capturedAt: new Date().toISOString(),
    payload: {
      baseline: { complete: true },
      current: { complete: true },
      exactFingerprintMatch: false,
      schema: { truncated: true }
    }
  });
  await expect(putIncidentOutcome(scope, {
    ...input,
    status: 'accepted',
    validation: { ...input.validation, result: 'passed' },
    technicalEvidence: [receipt.ref, { evidenceId: incomplete.id, contentHash: incomplete.contentHash }],
    decisionNote: 'Truncated deployment comparison cannot establish the environment mismatch.',
    expectedRevision: draft.outcome.revision
  })).rejects.toThrow('complete deployment_compare');

  const complete = await persistIncidentTechnicalEvidence(scope, {
    incidentKey: input.incidentKey,
    kind: 'deployment_compare',
    role: 'observation',
    sourceAction: 'test/deployment-compare',
    connection: 'CURRENT',
    capturedAt: new Date(Date.now() + 1).toISOString(),
    payload: {
      baseline: { complete: true },
      current: { complete: true },
      exactFingerprintMatch: false,
      schema: { truncated: false }
    }
  });
  const accepted = await putIncidentOutcome(scope, {
    ...input,
    status: 'accepted',
    validation: { ...input.validation, result: 'passed' },
    technicalEvidence: [receipt.ref, { evidenceId: complete.id, contentHash: complete.contentHash }],
    decisionNote: 'Complete deployment mismatch plus causal test satisfy deployment policy.',
    expectedRevision: draft.outcome.revision
  });
  expect(accepted.provenance.machineBacked).toBe(true);
});

it('requires one unambiguous data row with current or linked audit evidence', async () => {
  const { scope, evidence } = await seedBusinessEvidence();
  const input = draftOutcome(evidence, 'data');
  const draft = await putIncidentOutcome(scope, input);
  const receipt = await machineReceipt(scope, draft.outcome.key);
  const ambiguous = await persistIncidentTechnicalEvidence(scope, {
    incidentKey: input.incidentKey,
    kind: 'data_timeline',
    role: 'observation',
    sourceAction: 'test/data-timeline',
    connection: 'TEST',
    capturedAt: new Date().toISOString(),
    payload: {
      ambiguous: true,
      matchedRows: 2,
      current: [{ id: 1 }, { id: 2 }],
      events: [],
      sources: { createModifyLog: false, voucherHistory: false }
    }
  });
  await expect(putIncidentOutcome(scope, {
    ...input,
    status: 'accepted',
    validation: { ...input.validation, result: 'passed' },
    technicalEvidence: [receipt.ref, { evidenceId: ambiguous.id, contentHash: ambiguous.contentHash }],
    decisionNote: 'Ambiguous rows are observation only.',
    expectedRevision: draft.outcome.revision
  })).rejects.toThrow('unambiguous single-row data_timeline');

  const exact = await persistIncidentTechnicalEvidence(scope, {
    incidentKey: input.incidentKey,
    kind: 'data_timeline',
    role: 'observation',
    sourceAction: 'test/data-timeline',
    connection: 'TEST',
    capturedAt: new Date(Date.now() + 1).toISOString(),
    payload: {
      ambiguous: false,
      matchedRows: 1,
      current: [{ id: 1, state: 'incorrect' }],
      events: [{ kind: 'modified', happenedAt: new Date().toISOString() }],
      sources: { createModifyLog: true, voucherHistory: false }
    }
  });
  const accepted = await putIncidentOutcome(scope, {
    ...input,
    status: 'accepted',
    validation: { ...input.validation, result: 'passed' },
    technicalEvidence: [receipt.ref, { evidenceId: exact.id, contentHash: exact.contentHash }],
    decisionNote: 'Exact row timeline plus causal test satisfy data policy.',
    expectedRevision: draft.outcome.revision
  });
  expect(accepted.provenance.machineBacked).toBe(true);
});

it('requires an actual deadlock or live blocking observation for concurrency', async () => {
  const { scope, evidence } = await seedBusinessEvidence();
  const input = draftOutcome(evidence, 'concurrency');
  const draft = await putIncidentOutcome(scope, input);
  const receipt = await machineReceipt(scope, draft.outcome.key);
  const empty = await persistIncidentTechnicalEvidence(scope, {
    incidentKey: input.incidentKey,
    kind: 'deadlocks',
    role: 'observation',
    sourceAction: 'test/deadlocks',
    connection: 'TEST',
    capturedAt: new Date().toISOString(),
    payload: { available: true, events: [] }
  });
  await expect(putIncidentOutcome(scope, {
    ...input,
    status: 'accepted',
    validation: { ...input.validation, result: 'passed' },
    technicalEvidence: [receipt.ref, { evidenceId: empty.id, contentHash: empty.contentHash }],
    decisionNote: 'An empty deadlock history is not evidence of this concurrency incident.',
    expectedRevision: draft.outcome.revision
  })).rejects.toThrow('deadlock event');

  const observed = await persistIncidentTechnicalEvidence(scope, {
    incidentKey: input.incidentKey,
    kind: 'deadlocks',
    role: 'observation',
    sourceAction: 'test/deadlocks',
    connection: 'TEST',
    capturedAt: new Date(Date.now() + 1).toISOString(),
    payload: {
      available: true,
      events: [{ happenedAt: new Date().toISOString(), victimProcessId: 'p1', processes: [], objects: ['dbo.FeatureTable'] }]
    }
  });
  const accepted = await putIncidentOutcome(scope, {
    ...input,
    status: 'accepted',
    validation: { ...input.validation, result: 'passed' },
    technicalEvidence: [receipt.ref, { evidenceId: observed.id, contentHash: observed.contentHash }],
    decisionNote: 'Observed deadlock plus causal test satisfy concurrency policy.',
    expectedRevision: draft.outcome.revision
  });
  expect(accepted.provenance.machineBacked).toBe(true);
});
