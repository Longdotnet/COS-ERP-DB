import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { putEngineeringConvention } from '../src/cos-erp-db/engineering/convention-service.js';
import { discoverEngineeringAnalogues } from '../src/cos-erp-db/engineering/discovery.js';
import type { EngineeringProjectLineage } from '../src/cos-erp-db/engineering/contracts.js';
import { detectEngineeringRuntimeFamily, readEngineeringProjectDefaults } from '../src/cos-erp-db/engineering/lineage.js';
import { engineeringKnowledgeScope } from '../src/cos-erp-db/engineering/lineage.js';
import { engineeringQualityGate } from '../src/cos-erp-db/engineering/quality-gate.js';
import { initEngineeringStore, resetEngineeringStoreForTests } from '../src/cos-erp-db/engineering/store.js';
import { putEngineeringTask } from '../src/cos-erp-db/engineering/task-service.js';
import { knowledgeSha256 } from '../src/cos-erp-db/knowledge/evidence.js';
import { indexKnowledge, resetKnowledgeSearchCacheForTests, searchKnowledge } from '../src/cos-erp-db/knowledge/service.js';
import { initKnowledgeStore, resetKnowledgeStoreForTests } from '../src/cos-erp-db/knowledge/store.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let workspace = '';
let roots: Root[] = [];
let lineage: EngineeringProjectLineage;

beforeEach(async () => {
  directory = await makeTempDir('cos-engineering-');
  workspace = path.join(directory, 'workspace');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  roots = [{ name: 'workspace', path: workspace }];
  initEngineeringStore(path.join(directory, 'user-data'));
  initKnowledgeStore(path.join(directory, 'user-data'));
  resetKnowledgeSearchCacheForTests();
  lineage = {
    key: knowledgeSha256('test-engineering-lineage'),
    projectId: null,
    rootIdentity: knowledgeSha256(workspace),
    profile: 'linkq',
    runtimeFamily: 'net10',
    sourceRevision: null
  };
});

afterEach(async () => {
  resetEngineeringStoreForTests();
  resetKnowledgeSearchCacheForTests();
  resetKnowledgeStoreForTests();
  await removeTempDir(directory);
});

async function analogueEvidence() {
  await fs.writeFile(path.join(workspace, 'src', 'A.cs'), 'class A { void LoadAsync() { /* NativePattern */ } }', 'utf8');
  await fs.writeFile(path.join(workspace, 'src', 'B.cs'), 'class B { void LoadAsync() { /* NativePattern */ } }', 'utf8');
  const scope = engineeringKnowledgeScope(lineage);
  await indexKnowledge({ scope, sources: [{ kind: 'source', path: '/workspace/src' }] }, roots);
  const hits = (await searchKnowledge({ scope, query: 'NativePattern', kinds: ['source'], limit: 5 })).hits;
  expect(hits).toHaveLength(2);
  return hits;
}

it('reviews observed conventions only with multiple current independent examples', async () => {
  const hits = await analogueEvidence();
  await expect(putEngineeringConvention(lineage, {
    key: 'async-load',
    title: 'Async load pattern',
    statement: 'Load screens through the project async load pattern.',
    classification: 'convention',
    provenance: 'observed',
    status: 'reviewed',
    evidence: hits.slice(0, 1).map(hit => ({ evidenceId: hit.evidenceId, contentHash: hit.contentHash, relation: 'supports' }))
  }, roots)).rejects.toThrow('MULTIPLE_EXAMPLES');

  const reviewed = await putEngineeringConvention(lineage, {
    key: 'async-load',
    title: 'Async load pattern',
    statement: 'Load screens through the project async load pattern.',
    classification: 'convention',
    provenance: 'observed',
    status: 'reviewed',
    evidence: hits.map(hit => ({ evidenceId: hit.evidenceId, contentHash: hit.contentHash, relation: 'supports' }))
  }, roots);
  expect(reviewed.status).toBe('reviewed');
  expect(reviewed.revision).toBe(1);
});

it('does not treat a copied implementation as an independent convention example', async () => {
  const content = 'class Native { void LoadAsync() { /* CopiedPattern */ } }';
  await fs.writeFile(path.join(workspace, 'src', 'CopyA.cs'), content, 'utf8');
  await fs.writeFile(path.join(workspace, 'src', 'CopyB.cs'), content, 'utf8');
  const scope = engineeringKnowledgeScope(lineage);
  await indexKnowledge({ scope, sources: [{ kind: 'source', path: '/workspace/src' }] }, roots);
  const hits = (await searchKnowledge({ scope, query: 'CopiedPattern', kinds: ['source'], limit: 5 })).hits;
  expect(hits).toHaveLength(2);

  await expect(putEngineeringConvention(lineage, {
    key: 'copied-pattern',
    title: 'Copied pattern',
    statement: 'Do not infer a convention from copied mirrors.',
    classification: 'convention',
    provenance: 'observed',
    status: 'reviewed',
    evidence: hits.map(hit => ({ evidenceId: hit.evidenceId, contentHash: hit.contentHash, relation: 'supports' }))
  }, roots)).rejects.toThrow('NON_DUPLICATE_EXAMPLES');
});

it('discovers distinct implementation sources instead of counting chunks from one file', async () => {
  const repeated = Array.from({ length: 180 }, (_, index) => `class A${index} { void NativePattern() { } }`).join('\n');
  await fs.writeFile(path.join(workspace, 'src', 'A.cs'), repeated, 'utf8');
  await fs.writeFile(path.join(workspace, 'src', 'B.cs'), 'class B { void NativePattern() { } }', 'utf8');
  await fs.writeFile(path.join(workspace, 'src', 'C.cs'), 'class C { void NativePattern() { int x = 1; } }', 'utf8');
  const discovered = await discoverEngineeringAnalogues({
    lineage,
    workspace: { virtual: '/workspace', real: workspace }
  }, 'NativePattern', roots, 7);

  expect(discovered.coverage).toMatchObject({ minimum: 3, distinctImplementations: 3, targetMet: true });
  expect(new Set(discovered.candidates.map(candidate => candidate.locator.path)).size).toBe(3);
  expect(discovered.candidates.every(candidate => candidate.sourceHash && candidate.capturedAt)).toBe(true);
});

it('reports insufficient analogue coverage instead of padding repeated chunks', async () => {
  const repeated = Array.from({ length: 180 }, (_, index) => `class Only${index} { void UniqueNativePattern() { } }`).join('\n');
  await fs.writeFile(path.join(workspace, 'src', 'Only.cs'), repeated, 'utf8');
  const discovered = await discoverEngineeringAnalogues({
    lineage,
    workspace: { virtual: '/workspace', real: workspace }
  }, 'UniqueNativePattern', roots, 7);

  expect(discovered.candidates).toHaveLength(1);
  expect(discovered.coverage.targetMet).toBe(false);
  expect(discovered.limitations.join(' ')).toContain('distinct implementation');
});

it('ignores stale analogue evidence from an older virtual root binding of the same project', async () => {
  await fs.writeFile(path.join(workspace, 'src', 'A.cs'), 'class A { void AliasPattern() { } }', 'utf8');
  await fs.writeFile(path.join(workspace, 'src', 'B.cs'), 'class B { void AliasPattern() { int x = 1; } }', 'utf8');
  await fs.writeFile(path.join(workspace, 'src', 'C.cs'), 'class C { void AliasPattern() { int x = 2; } }', 'utf8');
  const scope = engineeringKnowledgeScope(lineage);
  const legacyRoots: Root[] = [{ name: 'legacy', path: workspace }];
  await indexKnowledge({ scope, sources: [{ kind: 'source', path: '/legacy' }] }, legacyRoots);

  const discovered = await discoverEngineeringAnalogues({
    lineage,
    workspace: { virtual: '/workspace', real: workspace }
  }, 'AliasPattern', roots, 3);

  expect(discovered.coverage).toMatchObject({ distinctImplementations: 3, targetMet: true });
  expect(discovered.candidates).toHaveLength(3);
  expect(discovered.candidates.every(candidate => String(candidate.locator.path).startsWith('/workspace/'))).toBe(true);
  expect(discovered.limitations.join(' ')).toContain('older project binding');
});

it('reads project-local engineering defaults without coupling the engine to LINKQ', async () => {
  await fs.mkdir(path.join(workspace, '.agents'), { recursive: true });
  await fs.writeFile(path.join(workspace, '.agents', 'engineering.json'), JSON.stringify({ profile: 'thaiviet', runtimeFamily: 'net48' }), 'utf8');
  await expect(readEngineeringProjectDefaults(workspace)).resolves.toEqual({ profile: 'thaiviet', runtimeFamily: 'net48' });
});

it('detects runtime family from project files when the manifest does not declare one', async () => {
  await fs.writeFile(path.join(workspace, 'Directory.Build.props'), '<Project><PropertyGroup><TargetFramework>net10.0-windows</TargetFramework></PropertyGroup></Project>', 'utf8');
  await fs.writeFile(path.join(workspace, 'Legacy.csproj'), '<Project><PropertyGroup><TargetFramework>net7.0-windows</TargetFramework></PropertyGroup></Project>', 'utf8');
  await expect(detectEngineeringRuntimeFamily(workspace)).resolves.toBe('net10');
});

it('detects non-.NET runtime families without adding project-specific rules to the engine', async () => {
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'fixture', private: true }), 'utf8');
  await expect(detectEngineeringRuntimeFamily(workspace)).resolves.toBe('node');
  await fs.writeFile(path.join(workspace, 'pyproject.toml'), '[project]\nname="fixture"\n', 'utf8');
  await expect(detectEngineeringRuntimeFamily(workspace)).resolves.toBe('mixed');
});

it('preserves prepared task context on revision-fenced partial updates unless a field is explicitly cleared', async () => {
  const first = await putEngineeringTask(lineage, {
    key: 'partial-update',
    goal: 'Implement the prepared screen.',
    requirements: ['Requirement from attachment'],
    openQuestions: ['Classify the analogue before coding.']
  });
  const second = await putEngineeringTask(lineage, {
    key: 'partial-update',
    changedFiles: ['src/Screen.cs'],
    validations: [{ name: 'build', status: 'pending', detail: 'Build after implementation.' }],
    expectedRevision: first.revision
  });
  expect(second.goal).toBe(first.goal);
  expect(second.requirements).toEqual(first.requirements);
  expect(second.openQuestions).toEqual(first.openQuestions);

  const third = await putEngineeringTask(lineage, {
    key: 'partial-update',
    openQuestions: [],
    expectedRevision: second.revision
  });
  expect(third.openQuestions).toEqual([]);
  expect(third.requirements).toEqual(first.requirements);
});

it('keeps task packets revision-fenced and refuses to turn self-reported scale into machine proof', async () => {
  const hits = await analogueEvidence();
  await putEngineeringConvention(lineage, {
    key: 'async-load',
    title: 'Async load pattern',
    statement: 'Load screens through the project async load pattern.',
    classification: 'convention',
    provenance: 'observed',
    status: 'reviewed',
    evidence: hits.map(hit => ({ evidenceId: hit.evidenceId, contentHash: hit.contentHash, relation: 'supports' }))
  }, roots);

  const first = await putEngineeringTask(lineage, {
    key: 'feature-x',
    goal: 'Implement feature X in the project-native style.',
    conventionKeys: ['async-load'],
    validations: [{ name: 'build', status: 'passed', detail: '0 errors' }],
    largeDataRisk: true,
    scaleStatus: 'static_reviewed'
  });
  expect(first.revision).toBe(1);
  const firstGate = await engineeringQualityGate(lineage, 'feature-x', roots);
  expect(firstGate.status).toBe('blocked');
  expect(firstGate.blockers.join(' ')).toContain('sql_scale');

  await expect(putEngineeringTask(lineage, {
    key: 'feature-x',
    goal: first.goal,
    expectedRevision: 99
  })).rejects.toThrow('REVISION_MISMATCH');

  const second = await putEngineeringTask(lineage, {
    key: 'feature-x',
    goal: first.goal,
    conventionKeys: ['async-load'],
    validations: [{ name: 'build', status: 'passed', detail: '0 errors' }],
    largeDataRisk: true,
    scaleStatus: 'runtime_evidenced',
    expectedRevision: 1
  });
  expect(second.revision).toBe(2);
  const gate = await engineeringQualityGate(lineage, 'feature-x', roots);
  expect(gate.status).toBe('blocked');
  expect(gate.blockers.join(' ')).toContain('sql_scale');
  expect(gate.attention.join(' ')).toContain('no Core-owned validation_run');
  expect(gate.assurance.executionReplayed).toBe(false);
  expect(gate.assurance.machineVerified).toBe(false);
});

it('blocks a task when evidence behind a referenced reviewed convention becomes stale', async () => {
  const hits = await analogueEvidence();
  await putEngineeringConvention(lineage, {
    key: 'async-load',
    title: 'Async load pattern',
    statement: 'Load screens through the project async load pattern.',
    classification: 'convention',
    provenance: 'observed',
    status: 'reviewed',
    evidence: hits.map(hit => ({ evidenceId: hit.evidenceId, contentHash: hit.contentHash, relation: 'supports' }))
  }, roots);
  await putEngineeringTask(lineage, {
    key: 'uses-convention',
    goal: 'Use the reviewed async convention.',
    conventionKeys: ['async-load'],
    validations: [{ name: 'review', status: 'pending', detail: 'not complete' }]
  });
  await fs.appendFile(path.join(workspace, 'src', 'A.cs'), '\n// changed\n', 'utf8');

  const gate = await engineeringQualityGate(lineage, 'uses-convention', roots);
  expect(gate.status).toBe('blocked');
  expect(gate.blockers.join(' ')).toContain('Reviewed convention evidence is stale');
});

it('blocks completion when task evidence becomes stale', async () => {
  const hits = await analogueEvidence();
  const selected = hits[0]!;
  await putEngineeringTask(lineage, {
    key: 'evidence-task',
    goal: 'Keep the implementation grounded in current source evidence.',
    evidence: [{ evidenceId: selected.evidenceId, contentHash: selected.contentHash, relation: 'supports' }],
    validations: [{ name: 'test', status: 'passed', detail: 'passed' }]
  });
  expect((await engineeringQualityGate(lineage, 'evidence-task', roots)).status).toBe('attention');

  await fs.appendFile(path.join(workspace, 'src', selected.locator.path?.endsWith('A.cs') ? 'A.cs' : 'B.cs'), '\n// changed\n', 'utf8');
  const gate = await engineeringQualityGate(lineage, 'evidence-task', roots);
  expect(gate.status).toBe('blocked');
  expect(gate.blockers.join(' ')).toContain('stale');
});
