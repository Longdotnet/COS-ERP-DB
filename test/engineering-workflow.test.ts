import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  engineeringLineageKey,
  engineeringKnowledgeScope,
  resolveEngineeringProjectIdentity,
  type ResolvedEngineeringLineage
} from '../src/cos-erp-db/engineering/lineage.js';
import { prepareEngineeringTask } from '../src/cos-erp-db/engineering/prepare-service.js';
import { canonicalEngineeringProfileId } from '../src/cos-erp-db/engineering/profiles/index.js';
import { engineeringQualityGate } from '../src/cos-erp-db/engineering/quality-gate.js';
import { initEngineeringStore, resetEngineeringStoreForTests } from '../src/cos-erp-db/engineering/store.js';
import { putEngineeringTask } from '../src/cos-erp-db/engineering/task-service.js';
import { runEngineeringValidation } from '../src/cos-erp-db/engineering/verification-service.js';
import { knowledgeSha256 } from '../src/cos-erp-db/knowledge/evidence.js';
import { indexKnowledge, resetKnowledgeSearchCacheForTests, searchKnowledge } from '../src/cos-erp-db/knowledge/service.js';
import { initKnowledgeStore, resetKnowledgeStoreForTests } from '../src/cos-erp-db/knowledge/store.js';
import { initBusinessProcessStore, resetBusinessProcessStoreForTests } from '../src/cos-erp-db/knowledge/process-store.js';
import { putBusinessProcessRecord } from '../src/cos-erp-db/knowledge/process-service.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let linkq = '';
let thaiviet = '';
let roots: Root[] = [];

beforeEach(async () => {
  directory = await makeTempDir('cos-engineering-workflow-');
  linkq = path.join(directory, 'linkq');
  thaiviet = path.join(directory, 'thaiviet');
  await fs.mkdir(linkq, { recursive: true });
  await fs.mkdir(thaiviet, { recursive: true });
  roots = [{ name: 'linkq', path: linkq }, { name: 'thaiviet', path: thaiviet }];
  const userData = path.join(directory, 'user-data');
  initEngineeringStore(userData);
  initKnowledgeStore(userData);
  initBusinessProcessStore(userData);
  resetKnowledgeSearchCacheForTests();
});

afterEach(async () => {
  resetEngineeringStoreForTests();
  resetKnowledgeSearchCacheForTests();
  resetKnowledgeStoreForTests();
  resetBusinessProcessStoreForTests();
  await removeTempDir(directory);
});

function resolvedFor(root: string, virtual: string, profile: string, runtimeFamily: string): ResolvedEngineeringLineage {
  const rootIdentity = knowledgeSha256(root);
  const canonicalProfile = canonicalEngineeringProfileId(profile);
  return {
    lineage: {
      key: engineeringLineageKey(rootIdentity, canonicalProfile, runtimeFamily),
      projectId: null,
      rootIdentity,
      profile: canonicalProfile,
      runtimeFamily,
      sourceRevision: null
    },
    workspace: { virtual, real: root }
  };
}

it('keeps LINKQ and ThaiViet engineering/knowledge isolated while using the same generic engine', async () => {
  const linkqResolved = resolvedFor(linkq, '/linkq', 'linkq', 'net8');
  const thaiResolved = resolvedFor(thaiviet, '/thaiviet', 'thaiviet', 'net45');
  expect(linkqResolved.lineage.profile).toBe('linkq');
  expect(thaiResolved.lineage.profile).toBe('generic');
  expect(linkqResolved.lineage.key).not.toBe(thaiResolved.lineage.key);
  expect(engineeringKnowledgeScope(linkqResolved.lineage)).not.toBe(engineeringKnowledgeScope(thaiResolved.lineage));

  await fs.writeFile(path.join(linkq, 'LinkqOnly.cs'), 'class LinkqOnly { const string Rule = "LINKQ_ONLY_RULE"; }', 'utf8');
  await indexKnowledge({
    scope: engineeringKnowledgeScope(linkqResolved.lineage),
    sources: [{ kind: 'source', path: '/linkq' }]
  }, roots);

  await fs.writeFile(path.join(thaiviet, 'ScreenA.cs'), 'class ScreenA { void ThaiVietScreenPattern() { } }', 'utf8');
  await fs.writeFile(path.join(thaiviet, 'ScreenB.cs'), 'class ScreenB { void ThaiVietScreenPattern() { int x = 1; } }', 'utf8');
  await fs.writeFile(path.join(thaiviet, 'ScreenC.cs'), 'class ScreenC { void ThaiVietScreenPattern() { int x = 2; } }', 'utf8');
  await fs.writeFile(path.join(thaiviet, 'requirements.txt'), 'ThaiVietScreenPattern: màn hình phải có nút Lưu và phím F3 để sửa.', 'utf8');

  const thaiScope = engineeringKnowledgeScope(thaiResolved.lineage);
  await putBusinessProcessRecord(thaiScope, {
    key: 'customer:thaiviet', kind: 'customer', title: 'ThaiViet', statement: 'ThaiViet project context.'
  });
  await putBusinessProcessRecord(thaiScope, {
    key: 'process:screen', kind: 'process', parentKey: 'customer:thaiviet', title: 'ThaiVietScreenPattern screen flow',
    statement: 'Maintain project-native screen behavior.'
  });

  const prepared = await prepareEngineeringTask(thaiResolved, {
    taskKey: 'screen-feature',
    goal: 'Implement ThaiVietScreenPattern screen.',
    requirements: ['Screenshot shows a Save button.', 'Use the attached requirement document as task context only.'],
    attachmentPaths: ['/thaiviet/requirements.txt'],
    analogueQuery: 'ThaiVietScreenPattern',
    analogueLimit: 7
  }, roots);

  expect(prepared.profile.id).toBe('generic');
  expect(prepared.requirementPolicy.durablePromotion).toBe(false);
  expect(prepared.task.requirements).toContain('Screenshot shows a Save button.');
  expect(prepared.task.evidence.length).toBeGreaterThan(0);
  expect(prepared.documentContext.hits.some(hit => hit.locator.path === '/thaiviet/requirements.txt')).toBe(true);
  expect(prepared.processContext.hits.some(hit => hit.record.key === 'process:screen')).toBe(true);
  expect(prepared.analogues.coverage.targetMet).toBe(true);
  expect(prepared.analogues.candidates).toHaveLength(3);
  expect(prepared.analogues.candidates.every(candidate => String(candidate.locator.path).startsWith('/thaiviet/'))).toBe(true);
  expect(prepared.analogues.candidates.some(candidate => candidate.locator.path === '/thaiviet/requirements.txt')).toBe(false);
  expect(prepared.task.prepared).toBe(true);
  expect(prepared.task.analogueEvidence).toHaveLength(3);
  expect(prepared.deliberationPolicy).toMatchObject({
    status: 'pending',
    optionCount: { minimum: 2, maximum: 3 }
  });
  expect(prepared.executionCapsule).toMatchObject({
    taskKey: 'screen-feature',
    taskRevision: prepared.task.revision,
    knowledgeGeneration: prepared.task.knowledgeGeneration,
    query: 'ThaiVietScreenPattern'
  });
  expect(prepared.executionCapsule.deliberation).toMatchObject({ status: 'pending', authority: 'agent' });
  expect(prepared.executionCapsule.analogues).toHaveLength(3);
  expect(prepared.executionCapsule.processKeys).toContain('process:screen');

  const beforeAssessment = await engineeringQualityGate(thaiResolved.lineage, prepared.task.key, roots, thaiResolved.workspace);
  expect(beforeAssessment.status).toBe('blocked');
  expect(beforeAssessment.blockers.join(' ')).toContain('task-scoped classification');

  const assessed = await putEngineeringTask(thaiResolved.lineage, {
    key: prepared.task.key,
    analogueAssessments: prepared.task.analogueEvidence.map(ref => ({
      evidenceId: ref.evidenceId,
      contentHash: ref.contentHash,
      classification: 'convention',
      note: 'Reviewed as a local ThaiViet implementation convention for this task only.'
    })),
    expectedRevision: prepared.task.revision
  });
  const afterAssessment = await engineeringQualityGate(thaiResolved.lineage, assessed.key, roots, thaiResolved.workspace);
  expect(afterAssessment.blockers.join(' ')).not.toContain('task-scoped classification');

  const leaked = await searchKnowledge({ scope: thaiScope, query: 'LINKQ_ONLY_RULE', limit: 10 });
  expect(leaked.hits).toEqual([]);
});

it('does not create a new profile identity for an unregistered ThaiViet name', () => {
  expect(canonicalEngineeringProfileId('thaiviet')).toBe('generic');
  expect(canonicalEngineeringProfileId('linkqq')).toBe('generic');
  expect(canonicalEngineeringProfileId('linkq')).toBe('linkq');
});

it('auto-detects project manifest profile plus runtime without hard-coding ThaiViet', async () => {
  await fs.mkdir(path.join(linkq, '.agents'), { recursive: true });
  await fs.writeFile(path.join(linkq, '.agents', 'engineering.json'), JSON.stringify({ profile: 'linkq' }), 'utf8');
  await fs.writeFile(path.join(linkq, 'Directory.Build.props'), '<Project><PropertyGroup><TargetFramework>net8.0-windows</TargetFramework></PropertyGroup></Project>', 'utf8');

  await fs.mkdir(path.join(thaiviet, '.agents'), { recursive: true });
  await fs.writeFile(path.join(thaiviet, '.agents', 'engineering.json'), JSON.stringify({ profile: 'thaiviet' }), 'utf8');
  await fs.writeFile(path.join(thaiviet, 'ThaiViet.csproj'), '<Project><PropertyGroup><TargetFrameworkVersion>v4.5</TargetFrameworkVersion></PropertyGroup></Project>', 'utf8');

  await expect(resolveEngineeringProjectIdentity(linkq)).resolves.toEqual({ profile: 'linkq', runtimeFamily: 'net8' });
  await expect(resolveEngineeringProjectIdentity(thaiviet)).resolves.toEqual({ profile: 'generic', runtimeFamily: 'net45' });
});

it('auto-detects LINKQ through profile-owned repo evidence while leaving an unrelated project generic', async () => {
  await fs.writeFile(path.join(linkq, 'LinkQ8.0.sln'), 'Microsoft Visual Studio Solution File', 'utf8');
  await fs.writeFile(path.join(linkq, 'LinkQ.App.csproj'), '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>', 'utf8');
  await fs.writeFile(path.join(thaiviet, 'ThaiViet.csproj'), '<Project><PropertyGroup><TargetFrameworkVersion>v4.5</TargetFrameworkVersion></PropertyGroup></Project>', 'utf8');

  await expect(resolveEngineeringProjectIdentity(linkq)).resolves.toEqual({ profile: 'linkq', runtimeFamily: 'net8' });
  await expect(resolveEngineeringProjectIdentity(thaiviet)).resolves.toEqual({ profile: 'generic', runtimeFamily: 'net45' });
});

it('checks a LINKQ solution marker before recursive profile-detection budget is exhausted', async () => {
  const heavy = path.join(linkq, '000-heavy');
  await fs.mkdir(heavy, { recursive: true });
  await Promise.all(Array.from({ length: 450 }, (_, index) =>
    fs.writeFile(path.join(heavy, `noise-${String(index).padStart(3, '0')}.txt`), 'noise', 'utf8')
  ));
  await fs.writeFile(path.join(linkq, 'LinkQ8.0.sln'), 'Microsoft Visual Studio Solution File', 'utf8');
  await fs.writeFile(path.join(linkq, 'Directory.Build.props'), '<Project><PropertyGroup><TargetFramework>net8.0-windows</TargetFramework></PropertyGroup></Project>', 'utf8');

  await expect(resolveEngineeringProjectIdentity(linkq)).resolves.toEqual({ profile: 'linkq', runtimeFamily: 'net8' });
});

it('does not infer the LINKQ profile from shared LinkQ.Modules project names inside ThaiViet', async () => {
  await fs.writeFile(path.join(thaiviet, 'ThaiViet.sln'), 'Microsoft Visual Studio Solution File', 'utf8');
  await fs.writeFile(path.join(thaiviet, 'LinkQ.Modules.Cash.csproj'), '<Project><PropertyGroup><TargetFrameworkVersion>v4.5</TargetFrameworkVersion></PropertyGroup></Project>', 'utf8');
  await fs.writeFile(path.join(thaiviet, 'LinkQ.Modules.General.csproj'), '<Project><PropertyGroup><TargetFrameworkVersion>v4.5</TargetFrameworkVersion></PropertyGroup></Project>', 'utf8');
  await expect(resolveEngineeringProjectIdentity(thaiviet)).resolves.toEqual({ profile: 'generic', runtimeFamily: 'net45' });
});

it('recognizes LINKQ solutionx roots without adding ThaiViet-specific logic', async () => {
  await fs.writeFile(path.join(linkq, 'LinkQ8.0.slnx'), '<Solution />', 'utf8');
  await fs.writeFile(path.join(linkq, 'Directory.Build.props'), '<Project><PropertyGroup><TargetFramework>net10.0-windows</TargetFramework></PropertyGroup></Project>', 'utf8');
  await expect(resolveEngineeringProjectIdentity(linkq)).resolves.toEqual({ profile: 'linkq', runtimeFamily: 'net10' });
});

it('rejects attachment paths from another approved project root instead of importing foreign requirements', async () => {
  const thaiResolved = resolvedFor(thaiviet, '/thaiviet', 'thaiviet', 'net45');
  await fs.writeFile(path.join(linkq, 'foreign-requirement.txt'), 'LINKQ_FOREIGN_REQUIREMENT', 'utf8');
  await fs.writeFile(path.join(thaiviet, 'ScreenA.cs'), 'class ScreenA { void LocalPattern() {} }', 'utf8');
  await fs.writeFile(path.join(thaiviet, 'ScreenB.cs'), 'class ScreenB { void LocalPattern() { int x=1; } }', 'utf8');
  await fs.writeFile(path.join(thaiviet, 'ScreenC.cs'), 'class ScreenC { void LocalPattern() { int x=2; } }', 'utf8');

  await expect(prepareEngineeringTask(thaiResolved, {
    taskKey: 'foreign-attachment', goal: 'Implement LocalPattern.',
    attachmentPaths: ['/linkq/foreign-requirement.txt'], analogueQuery: 'LocalPattern'
  }, roots)).rejects.toThrow('ATTACHMENT_OUTSIDE_PROJECT');

  const leaked = await searchKnowledge({
    scope: engineeringKnowledgeScope(thaiResolved.lineage), query: 'LINKQ_FOREIGN_REQUIREMENT', limit: 10
  });
  expect(leaked.hits).toEqual([]);
});

it('executes the full prepared workflow before reporting Machine Verified', async () => {
  const thaiResolved = resolvedFor(thaiviet, '/thaiviet', 'thaiviet', 'net45');
  await fs.writeFile(path.join(thaiviet, 'ScreenA.cs'), 'class ScreenA { void EndToEndPattern() {} }', 'utf8');
  await fs.writeFile(path.join(thaiviet, 'ScreenB.cs'), 'class ScreenB { void EndToEndPattern() { int x=1; } }', 'utf8');
  await fs.writeFile(path.join(thaiviet, 'ScreenC.cs'), 'class ScreenC { void EndToEndPattern() { int x=2; } }', 'utf8');
  await fs.writeFile(path.join(thaiviet, 'requirement.txt'), 'EndToEndPattern must keep the Save behavior.', 'utf8');

  const prepared = await prepareEngineeringTask(thaiResolved, {
    taskKey: 'end-to-end-screen',
    goal: 'Implement EndToEndPattern screen.',
    requirements: ['Screenshot confirms the Save button remains visible.'],
    attachmentPaths: ['/thaiviet/requirement.txt'],
    analogueQuery: 'EndToEndPattern'
  }, roots);
  expect(prepared.task.prepared).toBe(true);
  expect(prepared.task.analogueEvidence).toHaveLength(3);

  await fs.writeFile(path.join(thaiviet, 'NewScreen.cs'), 'class NewScreen { void EndToEndPattern() { int x=3; } }', 'utf8');
  const implementationTask = await putEngineeringTask(thaiResolved.lineage, {
    key: prepared.task.key,
    analogueAssessments: prepared.task.analogueEvidence.map(ref => ({
      evidenceId: ref.evidenceId,
      contentHash: ref.contentHash,
      classification: 'convention',
      note: 'Reviewed as a project-local convention; no durable promotion requested.'
    })),
    solutionReviewStatus: 'reviewed',
    solutionReviewSummary: 'Reviewed the requested Save behavior against current project evidence; no additional business-process decision is required for this fixture.',
    requirementComparisons: [{
      requirement: prepared.task.requirements[0]!,
      status: 'missing',
      currentEvidence: [],
      referenceEvidence: [],
      findingKeys: [],
      proposedDisposition: 'implement',
      note: 'The new screen must implement the explicitly requested Save behavior.'
    }],
    deliberationStatus: 'not_required',
    deliberationSummary: 'The requirement preserves an existing Save behavior already demonstrated by three project-local analogues; there is no competing implementation contract to choose between.',
    changedFiles: ['NewScreen.cs'],
    validations: [{ name: 'build', status: 'pending', detail: 'Build the implementation.' }],
    expectedRevision: prepared.task.revision
  });

  await runEngineeringValidation(thaiResolved, {
    kind: 'command', taskKey: implementationTask.key, name: 'build', command: 'dotnet', args: ['build']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: async () => ({
      exitCode: 0, stdout: 'Build succeeded.', stderr: '', truncated: false, timedOut: false, durationMs: 10
    })
  });

  const gate = await engineeringQualityGate(thaiResolved.lineage, implementationTask.key, roots, thaiResolved.workspace);
  expect(gate.status).toBe('pass');
  expect(gate.assurance.machineVerified).toBe(true);
  expect(gate.assurance.executionReplayed).toBe(true);
  expect(gate.assurance.solutionReviewVerified).toBe(true);
  expect(gate.assurance.deliberationVerified).toBe(true);
});
