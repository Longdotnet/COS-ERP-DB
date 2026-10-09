import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { EngineeringProjectLineage } from '../src/cos-erp-db/engineering/contracts.js';
import type { ResolvedEngineeringLineage } from '../src/cos-erp-db/engineering/lineage.js';
import { engineeringQualityGate } from '../src/cos-erp-db/engineering/quality-gate.js';
import {
  initEngineeringStore,
  mutateEngineeringScope,
  resetEngineeringStoreForTests
} from '../src/cos-erp-db/engineering/store.js';
import { putEngineeringTask } from '../src/cos-erp-db/engineering/task-service.js';
import { runEngineeringValidation } from '../src/cos-erp-db/engineering/verification-service.js';
import { knowledgeSha256 } from '../src/cos-erp-db/knowledge/evidence.js';
import { initKnowledgeStore, resetKnowledgeStoreForTests } from '../src/cos-erp-db/knowledge/store.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let workspace = '';
let roots: Root[] = [];
let lineage: EngineeringProjectLineage;
let resolved: ResolvedEngineeringLineage;

beforeEach(async () => {
  directory = await makeTempDir('cos-engineering-machine-');
  workspace = path.join(directory, 'workspace');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'Feature.cs'), 'class Feature { int Version = 1; }', 'utf8');
  roots = [{ name: 'workspace', path: workspace }];
  initEngineeringStore(path.join(directory, 'user-data'));
  initKnowledgeStore(path.join(directory, 'user-data'));
  lineage = {
    key: knowledgeSha256('machine-verification-lineage'),
    projectId: null,
    rootIdentity: knowledgeSha256(workspace),
    profile: 'generic',
    runtimeFamily: 'net10',
    sourceRevision: null
  };
  resolved = { lineage, workspace: { virtual: '/workspace', real: workspace } };
});

afterEach(async () => {
  resetEngineeringStoreForTests();
  resetKnowledgeStoreForTests();
  await removeTempDir(directory);
});

const successfulCommand = async () => ({
  exitCode: 0,
  stdout: 'Build succeeded.\n0 Error(s)',
  stderr: '',
  truncated: false,
  timedOut: false,
  durationMs: 42
});

it('reports Machine Verified only after Core actually runs a current successful validation', async () => {
  await putEngineeringTask(lineage, {
    key: 'screen-x',
    goal: 'Implement screen X.',
    changedFiles: ['src/Feature.cs'],
    validations: [{ name: 'build', status: 'passed', detail: 'AI says build passed.' }]
  });

  const before = await engineeringQualityGate(lineage, 'screen-x', roots, resolved.workspace);
  expect(before.status).toBe('attention');
  expect(before.assurance.machineVerified).toBe(false);
  expect(before.assurance.commandVerifications[0]?.status).toBe('missing');

  const record = await runEngineeringValidation(resolved, {
    kind: 'command', taskKey: 'screen-x', name: 'build', command: 'dotnet', args: ['build']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: successfulCommand
  });
  expect(record.success).toBe(true);
  expect(record.command?.exitCode).toBe(0);
  expect(record.command?.stdoutHash).toMatch(/^[a-f0-9]{64}$/);
  expect(record.provenanceHash).toMatch(/^[a-f0-9]{64}$/);

  const after = await engineeringQualityGate(lineage, 'screen-x', roots, resolved.workspace);
  expect(after.status).toBe('pass');
  expect(after.assurance.executionReplayed).toBe(true);
  expect(after.assurance.machineVerified).toBe(true);
  expect(after.assurance.commandVerifications[0]).toMatchObject({ status: 'current-pass', verificationId: record.id });
  expect(after.learningProposal).toMatchObject({ eligible: false, autoPersisted: false, candidates: [] });
});

it('keeps legacy Engineering verification provenance valid when incidentBinding was absent', async () => {
  await putEngineeringTask(lineage, {
    key: 'legacy-verification',
    goal: 'Preserve pre-incident-binding verification compatibility.',
    changedFiles: ['src/Feature.cs'],
    validations: [{ name: 'build', status: 'pending', detail: 'Build changed code.' }]
  });
  const record = await runEngineeringValidation(resolved, {
    kind: 'command',
    taskKey: 'legacy-verification',
    name: 'build',
    command: 'dotnet',
    args: ['build']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: successfulCommand
  });
  const {
    id: _currentId,
    provenanceHash: _currentHash,
    incidentBinding: _incidentBinding,
    ...legacyBase
  } = record;
  const provenanceHash = knowledgeSha256('engineering-verification:v1\0' + JSON.stringify(legacyBase));
  const id = knowledgeSha256([
    'engineering-verification-id:v1',
    legacyBase.lineageKey,
    legacyBase.taskKey,
    String(legacyBase.taskRevision),
    legacyBase.name,
    legacyBase.kind,
    legacyBase.createdAt,
    provenanceHash
  ].join('\0'));
  await mutateEngineeringScope(lineage, current => ({
    ...current,
    verifications: [{ ...legacyBase, provenanceHash, id }]
  }));

  const gate = await engineeringQualityGate(lineage, 'legacy-verification', roots, resolved.workspace);
  expect(gate.status).toBe('pass');
  expect(gate.assurance.commandVerifications[0]).toMatchObject({ status: 'current-pass', verificationId: id });
  expect(gate.assurance.machineVerified).toBe(true);
});

it('uses the real Core process runner to capture a project typecheck command', async () => {
  await fs.writeFile(path.join(workspace, 'check.js'), 'const answer = 42; console.log(answer);\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({
    name: 'engineering-validation-fixture',
    private: true,
    scripts: { typecheck: 'node --check check.js' }
  }), 'utf8');
  await putEngineeringTask(lineage, {
    key: 'real-runner', goal: 'Prove the production direct runner path.', changedFiles: ['check.js'],
    validations: [{ name: 'typecheck', status: 'pending', detail: 'Run project typecheck.' }]
  });

  const record = await runEngineeringValidation(resolved, {
    kind: 'command', taskKey: 'real-runner', name: 'typecheck', command: 'npm', args: ['run', 'typecheck'], timeoutMs: 30_000
  }, roots, { commandPolicy: { enabled: false, mode: 'allow', rules: [] } });

  expect(record.success).toBe(true);
  expect(record.command).toMatchObject({ purpose: 'typecheck', exitCode: 0, timedOut: false });
  expect(record.command?.stdoutHash).toMatch(/^[a-f0-9]{64}$/);
  const gate = await engineeringQualityGate(lineage, 'real-runner', roots, resolved.workspace);
  expect(gate.status).toBe('pass');
  expect(gate.assurance.machineVerified).toBe(true);
});

it('ignores generated bin and obj artifacts when checking source stability during validation', async () => {
  await putEngineeringTask(lineage, {
    key: 'generated-artifacts', goal: 'Build without treating generated output as a source change.', changedFiles: ['src/Feature.cs'],
    validations: [{ name: 'build', status: 'pending', detail: 'Build the owning project.' }]
  });

  const record = await runEngineeringValidation(resolved, {
    kind: 'command', taskKey: 'generated-artifacts', name: 'build', command: 'dotnet', args: ['build']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: async () => {
      await fs.mkdir(path.join(workspace, 'obj'), { recursive: true });
      await fs.mkdir(path.join(workspace, 'bin'), { recursive: true });
      await fs.writeFile(path.join(workspace, 'obj', 'generated.props'), '<Project />', 'utf8');
      await fs.writeFile(path.join(workspace, 'bin', 'generated.json'), '{}', 'utf8');
      return successfulCommand();
    }
  });

  expect(record.success).toBe(true);
  const gate = await engineeringQualityGate(lineage, 'generated-artifacts', roots, resolved.workspace);
  expect(gate.status).toBe('pass');
  expect(gate.assurance.machineVerified).toBe(true);
});

it('invalidates a successful machine verification when an implementation file changes', async () => {
  await putEngineeringTask(lineage, {
    key: 'screen-x', goal: 'Implement screen X.', changedFiles: ['src/Feature.cs'],
    validations: [{ name: 'test', status: 'pending', detail: 'Run tests.' }]
  });
  await runEngineeringValidation(resolved, {
    kind: 'command', taskKey: 'screen-x', name: 'test', command: 'dotnet', args: ['test']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: successfulCommand
  });
  expect((await engineeringQualityGate(lineage, 'screen-x', roots, resolved.workspace)).assurance.machineVerified).toBe(true);

  await fs.writeFile(path.join(workspace, 'src', 'Feature.cs'), 'class Feature { int Version = 2; }', 'utf8');
  const stale = await engineeringQualityGate(lineage, 'screen-x', roots, resolved.workspace);
  expect(stale.status).toBe('blocked');
  expect(stale.assurance.machineVerified).toBe(false);
  expect(stale.assurance.commandVerifications[0]?.status).toBe('stale');
  expect(stale.blockers.join(' ')).toContain('changed after verification');
});

it('records a real failed command as a machine failure instead of trusting task metadata', async () => {
  await putEngineeringTask(lineage, {
    key: 'screen-x', goal: 'Implement screen X.', changedFiles: ['src/Feature.cs'],
    validations: [{ name: 'build', status: 'passed', detail: 'Claimed passed.' }]
  });
  await runEngineeringValidation(resolved, {
    kind: 'command', taskKey: 'screen-x', name: 'build', command: 'dotnet', args: ['build']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: async () => ({ exitCode: 1, stdout: '', stderr: 'compile error', truncated: false, timedOut: false, durationMs: 7 })
  });
  const gate = await engineeringQualityGate(lineage, 'screen-x', roots, resolved.workspace);
  expect(gate.status).toBe('blocked');
  expect(gate.assurance.commandVerifications[0]?.status).toBe('current-fail');
  expect(gate.assurance.machineVerified).toBe(false);
});

it('refuses a trivial command disguised as a build validation', async () => {
  await putEngineeringTask(lineage, {
    key: 'screen-x', goal: 'Implement screen X.', changedFiles: ['src/Feature.cs'],
    validations: [{ name: 'build', status: 'pending', detail: 'Build the owning project.' }]
  });
  await expect(runEngineeringValidation(resolved, {
    kind: 'command', taskKey: 'screen-x', name: 'build', command: 'dotnet', args: ['--version']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: successfulCommand
  })).rejects.toThrow('COMMAND_MISMATCH');
});

it('does not call custom-only command execution Machine Verified', async () => {
  await putEngineeringTask(lineage, {
    key: 'screen-x', goal: 'Implement screen X.', changedFiles: ['src/Feature.cs'],
    validations: [{ name: 'manual-probe', purpose: 'custom', status: 'pending', detail: 'Run a project probe.' }]
  });
  await runEngineeringValidation(resolved, {
    kind: 'command', taskKey: 'screen-x', name: 'manual-probe', purpose: 'custom', command: 'tool', args: ['probe']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: successfulCommand
  });
  const gate = await engineeringQualityGate(lineage, 'screen-x', roots, resolved.workspace);
  expect(gate.status).toBe('attention');
  expect(gate.assurance.executionReplayed).toBe(true);
  expect(gate.assurance.machineVerified).toBe(false);
  expect(gate.attention.join(' ')).toContain('build, test or typecheck');
});

it('requires runtime SQL evidence for large-data Machine Verified and does not accept table shape alone', async () => {
  await putEngineeringTask(lineage, {
    key: 'scale-task',
    goal: 'Optimize a large-data query.',
    requirements: ['The production query reads dbo.BigTable by Id.'],
    changedFiles: ['src/Feature.cs'],
    validations: [{ name: 'build', status: 'pending', detail: 'Build changed code.' }],
    largeDataRisk: true,
    scaleStatus: 'runtime_evidenced'
  });
  await runEngineeringValidation(resolved, {
    kind: 'command', taskKey: 'scale-task', name: 'build', command: 'dotnet', args: ['build']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: successfulCommand
  });

  const connection = async () => ({ id: 'test', name: 'Test', accessMode: 'read-only', connection: {} }) as any;
  const tableScale = async () => ({
    connection: 'test', database: 'ERP', capturedAt: new Date().toISOString(),
    object: { objectId: 42, schema: 'dbo', table: 'BigTable' }, approximateRows: 5_000_000,
    reservedMb: 100, usedMb: 90, dataMb: 80, indexes: [], statistics: [],
    limitations: ['Runtime query scalability still requires Query Store evidence.'], elapsedMs: 1
  });

  const staticRecord = await runEngineeringValidation(resolved, {
    kind: 'sql_scale', taskKey: 'scale-task', name: 'scale-static', objectId: 42
  }, roots, { resolveConnection: connection, tableScale: tableScale as any });
  expect(staticRecord.scale?.level).toBe('static');
  const staticGate = await engineeringQualityGate(lineage, 'scale-task', roots, resolved.workspace);
  expect(staticGate.status).toBe('attention');
  expect(staticGate.assurance.scaleVerification.status).toBe('current-static');
  expect(staticGate.assurance.machineVerified).toBe(false);

  const runtimeRecord = await runEngineeringValidation(resolved, {
    kind: 'sql_scale', taskKey: 'scale-task', name: 'scale-runtime', objectId: 42,
    runtimeSource: 'query_store', queryContains: 'BigTable', hours: 24, sort: 'reads'
  }, roots, {
    resolveConnection: connection,
    tableScale: tableScale as any,
    queryStore: async () => ({
      connection: 'test', database: 'ERP', capturedAt: new Date().toISOString(), available: true,
      actualState: 'READ_WRITE', desiredState: 'READ_WRITE', readonlyReason: null,
      currentStorageMb: 10, maxStorageMb: 100, hours: 24, sort: 'reads',
      queries: [{
        queryId: 1, planId: 2, executionCount: 100, avgDurationMs: 8, avgCpuMs: 4,
        avgLogicalReads: 200, lastExecutionAt: new Date().toISOString(), planCount: 1,
        sql: 'SELECT Col FROM dbo.BigTable WHERE Id=@id'
      }], limitations: [], elapsedMs: 2
    })
  });
  expect(runtimeRecord.scale?.level).toBe('runtime');
  expect(runtimeRecord.scale?.queryBinding).toBe('task_text');
  expect(runtimeRecord.scale?.matchedRuntimeCount).toBe(1);

  const runtimeGate = await engineeringQualityGate(lineage, 'scale-task', roots, resolved.workspace);
  expect(runtimeGate.status).toBe('pass');
  expect(runtimeGate.assurance.scaleVerification.status).toBe('current-runtime');
  expect(runtimeGate.assurance.machineVerified).toBe(true);
});

it('rejects runtime SQL evidence that is not bound to the current task or changed implementation', async () => {
  await putEngineeringTask(lineage, {
    key: 'unrelated-runtime',
    goal: 'Optimize dbo.BigTable access.',
    changedFiles: ['src/Feature.cs'],
    validations: [{ name: 'build', status: 'pending', detail: 'Build.' }],
    largeDataRisk: true
  });
  const connection = async () => ({ id: 'test', name: 'Test', accessMode: 'read-only', connection: {} }) as any;
  const tableScale = async () => ({
    connection: 'test', database: 'ERP', capturedAt: new Date().toISOString(),
    object: { objectId: 42, schema: 'dbo', table: 'BigTable' }, approximateRows: 1_000_000,
    reservedMb: 10, usedMb: 9, dataMb: 8, indexes: [], statistics: [], limitations: [], elapsedMs: 1
  });
  await expect(runEngineeringValidation(resolved, {
    kind: 'sql_scale', taskKey: 'unrelated-runtime', name: 'scale-runtime', objectId: 42,
    runtimeSource: 'query_store', queryContains: 'UnrelatedAuditTable'
  }, roots, { resolveConnection: connection, tableScale: tableScale as any })).rejects.toThrow('SQL_QUERY_NOT_BOUND_TO_TASK');
});

it('does not combine table_scale_profile from one object with runtime evidence for a different table', async () => {
  await putEngineeringTask(lineage, {
    key: 'mismatched-scale',
    goal: 'Optimize dbo.BigTable access.',
    changedFiles: ['src/Feature.cs'],
    validations: [{ name: 'build', status: 'pending', detail: 'Build.' }],
    largeDataRisk: true
  });
  const connection = async () => ({ id: 'test', name: 'Test', accessMode: 'read-only', connection: {} }) as any;
  const record = await runEngineeringValidation(resolved, {
    kind: 'sql_scale', taskKey: 'mismatched-scale', name: 'scale-runtime', objectId: 99,
    runtimeSource: 'query_store', queryContains: 'BigTable', hours: 24
  }, roots, {
    resolveConnection: connection,
    tableScale: async () => ({
      connection: 'test', database: 'ERP', capturedAt: new Date().toISOString(),
      object: { objectId: 99, schema: 'dbo', table: 'OtherTable' }, approximateRows: 500_000,
      reservedMb: 10, usedMb: 9, dataMb: 8, indexes: [], statistics: [], limitations: [], elapsedMs: 1
    }),
    queryStore: async () => ({
      connection: 'test', database: 'ERP', capturedAt: new Date().toISOString(), available: true,
      actualState: 'READ_WRITE', desiredState: 'READ_WRITE', readonlyReason: null,
      currentStorageMb: 10, maxStorageMb: 100, hours: 24, sort: 'duration',
      queries: [{
        queryId: 1, planId: 1, executionCount: 10, avgDurationMs: 3, avgCpuMs: 2,
        avgLogicalReads: 30, lastExecutionAt: new Date().toISOString(), planCount: 1,
        sql: 'SELECT Id FROM dbo.BigTable WHERE Id=@id'
      }], limitations: [], elapsedMs: 1
    })
  });
  expect(record.success).toBe(false);
  expect(record.scale?.level).toBe('static');
  expect(record.scale?.matchedRuntimeCount).toBe(0);
});
