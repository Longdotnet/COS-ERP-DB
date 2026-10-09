import { promises as fs } from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverEngineeringAnalogues } from '../src/cos-erp-db/engineering/discovery.js';
import {
  engineeringLineageKey,
  engineeringKnowledgeScope,
  resolveEngineeringProjectIdentity,
  type ResolvedEngineeringLineage
} from '../src/cos-erp-db/engineering/lineage.js';
import { prepareEngineeringTask } from '../src/cos-erp-db/engineering/prepare-service.js';
import { engineeringQualityGate } from '../src/cos-erp-db/engineering/quality-gate.js';
import { initEngineeringStore, resetEngineeringStoreForTests } from '../src/cos-erp-db/engineering/store.js';
import { putEngineeringTask } from '../src/cos-erp-db/engineering/task-service.js';
import { runEngineeringValidation } from '../src/cos-erp-db/engineering/verification-service.js';
import { knowledgeSha256 } from '../src/cos-erp-db/knowledge/evidence.js';
import { indexKnowledge, resetKnowledgeSearchCacheForTests, searchKnowledge } from '../src/cos-erp-db/knowledge/service.js';
import { initKnowledgeStore, resetKnowledgeStoreForTests } from '../src/cos-erp-db/knowledge/store.js';
import { initBusinessProcessStore, resetBusinessProcessStoreForTests } from '../src/cos-erp-db/knowledge/process-store.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let projectA = '';
let projectB = '';
let roots: Root[] = [];

beforeEach(async () => {
  directory = await makeTempDir('cos-engineering-red-team-');
  projectA = path.join(directory, 'a');
  projectB = path.join(directory, 'b');
  await fs.mkdir(projectA, { recursive: true });
  await fs.mkdir(projectB, { recursive: true });
  roots = [{ name: 'a', path: projectA }, { name: 'b', path: projectB }];
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

function resolved(root: string, virtual: string, profile: 'linkq' | 'generic' = 'generic'): ResolvedEngineeringLineage {
  const rootIdentity = knowledgeSha256(root);
  return {
    lineage: {
      key: engineeringLineageKey(rootIdentity, profile, 'net8'),
      projectId: null,
      rootIdentity,
      profile,
      runtimeFamily: 'net8',
      sourceRevision: null
    },
    workspace: { real: root, virtual }
  };
}

function minimalPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'ascii');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}

describe('Project-Native Engineering executable red-team eval', () => {
  it('ATTACK duplicate chunks/copies: cannot fabricate the 3-analogue threshold', async () => {
    const r = resolved(projectA, '/a');
    const repeated = Array.from({ length: 200 }, (_, index) => `class C${index} { void AttackPattern() {} }`).join('\n');
    await fs.writeFile(path.join(projectA, 'One.cs'), repeated, 'utf8');
    await fs.writeFile(path.join(projectA, 'Mirror.cs'), repeated, 'utf8');
    const result = await discoverEngineeringAnalogues(r, 'AttackPattern', roots, 7);
    expect(result.candidates).toHaveLength(1);
    expect(result.coverage.targetMet).toBe(false);
  });

  it('ATTACK AI metadata: passed/runtime_evidenced cannot manufacture Machine Verified', async () => {
    const r = resolved(projectA, '/a');
    await fs.writeFile(path.join(projectA, 'Feature.cs'), 'class Feature {}', 'utf8');
    await putEngineeringTask(r.lineage, {
      key: 'false-pass', goal: 'False-pass attack.', changedFiles: ['Feature.cs'],
      validations: [{ name: 'build', status: 'passed', detail: 'AI claims success.' }],
      largeDataRisk: true, scaleStatus: 'runtime_evidenced'
    });
    const gate = await engineeringQualityGate(r.lineage, 'false-pass', roots, r.workspace);
    expect(gate.status).toBe('blocked');
    expect(gate.assurance.machineVerified).toBe(false);
    expect(gate.assurance.commandVerifications[0]?.status).toBe('missing');
    expect(gate.assurance.scaleVerification.status).toBe('missing');
  });

  it('ATTACK stale verification: changing source after a successful Core run blocks the gate', async () => {
    const r = resolved(projectA, '/a');
    await fs.writeFile(path.join(projectA, 'Feature.cs'), 'class Feature { int X = 1; }', 'utf8');
    await putEngineeringTask(r.lineage, {
      key: 'stale', goal: 'Stale attack.', changedFiles: ['Feature.cs'],
      validations: [{ name: 'build', status: 'pending', detail: 'Build.' }]
    });
    await runEngineeringValidation(r, {
      kind: 'command', taskKey: 'stale', name: 'build', command: 'dotnet', args: ['build']
    }, roots, {
      commandPolicy: { enabled: false, mode: 'allow', rules: [] },
      commandRunner: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false, durationMs: 1 })
    });
    expect((await engineeringQualityGate(r.lineage, 'stale', roots, r.workspace)).assurance.machineVerified).toBe(true);
    await fs.writeFile(path.join(projectA, 'Feature.cs'), 'class Feature { int X = 2; }', 'utf8');
    const gate = await engineeringQualityGate(r.lineage, 'stale', roots, r.workspace);
    expect(gate.status).toBe('blocked');
    expect(gate.assurance.machineVerified).toBe(false);
    expect(gate.assurance.commandVerifications[0]?.status).toBe('stale');
  });

  it('ATTACK cross-project leak: LINKQ source/doc evidence never appears in generic ThaiViet preparation', async () => {
    const linkq = resolved(projectA, '/a', 'linkq');
    const thai = resolved(projectB, '/b', 'generic');
    await fs.writeFile(path.join(projectA, 'OnlyLinkq.cs'), 'class OnlyLinkq { const string SecretConvention = "LINKQ_PRIVATE_STANDARD"; }', 'utf8');
    await indexKnowledge({ scope: engineeringKnowledgeScope(linkq.lineage), sources: [{ kind: 'source', path: '/a' }] }, roots);
    for (const [name, extra] of [['A.cs', ''], ['B.cs', ' int X=1;'], ['C.cs', ' int X=2;']] as const) {
      await fs.writeFile(path.join(projectB, name), `class ${name[0]} { void ThaiAttackScreen() {${extra}} }`, 'utf8');
    }
    await fs.writeFile(path.join(projectB, 'req.txt'), 'ThaiAttackScreen requires a Save action.', 'utf8');
    const prepared = await prepareEngineeringTask(thai, {
      taskKey: 'thai-screen', goal: 'Implement ThaiAttackScreen.', attachmentPaths: ['/b/req.txt'], analogueQuery: 'ThaiAttackScreen'
    }, roots);
    expect(prepared.profile.id).toBe('generic');
    expect(prepared.analogues.coverage.targetMet).toBe(true);
    expect(prepared.analogues.candidates.every(candidate => String(candidate.locator.path).startsWith('/b/'))).toBe(true);
    expect((await searchKnowledge({ scope: prepared.knowledgeScope, query: 'LINKQ_PRIVATE_STANDARD', limit: 10 })).hits).toEqual([]);
  });

  it('ATTACK attachment workflow: task input reads local text/Word/Excel/PDF while screenshot stays explicit task input only', async () => {
    const r = resolved(projectB, '/b', 'generic');
    for (const [name, extra] of [['A.cs', ''], ['B.cs', ' int X=1;'], ['C.cs', ' int X=2;']] as const) {
      await fs.writeFile(path.join(projectB, name), `class ${name[0]} { void AttachmentScreen() {${extra}} }`, 'utf8');
    }
    await fs.writeFile(path.join(projectB, 'req.txt'), 'AttachmentScreen text requirement.', 'utf8');
    await fs.writeFile(path.join(projectB, 'req.docx'), zipSync({
      'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>AttachmentScreen Word requirement</w:t></w:r></w:p></w:body></w:document>')
    }));
    await fs.writeFile(path.join(projectB, 'req.xlsx'), zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>AttachmentScreen Excel requirement</t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>')
    }));
    await fs.writeFile(path.join(projectB, 'req.pdf'), minimalPdf('AttachmentScreen PDF requirement'));
    await fs.writeFile(path.join(projectB, 'scan.pdf'), minimalPdf(''));
    await fs.writeFile(path.join(projectB, 'screen.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const prepared = await prepareEngineeringTask(r, {
      taskKey: 'attachment-screen',
      goal: 'Implement AttachmentScreen.',
      requirements: ['Screenshot shows AttachmentScreen Save button.'],
      attachmentPaths: ['/b/req.txt', '/b/req.docx', '/b/req.xlsx', '/b/req.pdf', '/b/scan.pdf', '/b/screen.png'],
      analogueQuery: 'AttachmentScreen'
    }, roots);

    expect(prepared.analogues.coverage.targetMet).toBe(true);
    expect(prepared.task.requirements).toContain('Screenshot shows AttachmentScreen Save button.');
    const paths = new Set(prepared.documentContext.hits.map(hit => hit.locator.path));
    expect(paths.has('/b/req.txt')).toBe(true);
    expect(paths.has('/b/req.docx')).toBe(true);
    expect(paths.has('/b/req.xlsx')).toBe(true);
    expect(paths.has('/b/req.pdf')).toBe(true);
    expect(prepared.limitations.join(' ')).toContain('/b/screen.png');
    expect(prepared.task.openQuestions.join(' ')).toContain('/b/scan.pdf produced no extractable text');
    expect(prepared.requirementPolicy.durablePromotion).toBe(false);
  });

  it('ATTACK prepared-state erasure: clearing analogue evidence after prepare still blocks the quality gate', async () => {
    const r = resolved(projectB, '/b', 'generic');
    for (const [name, extra] of [['A.cs', ''], ['B.cs', ' int X=1;'], ['C.cs', ' int X=2;']] as const) {
      await fs.writeFile(path.join(projectB, name), `class ${name[0]} { void PreparedPattern() {${extra}} }`, 'utf8');
    }
    const prepared = await prepareEngineeringTask(r, {
      taskKey: 'prepared-erasure', goal: 'Implement PreparedPattern.', analogueQuery: 'PreparedPattern'
    }, roots);
    expect(prepared.task.prepared).toBe(true);
    const erased = await putEngineeringTask(r.lineage, {
      key: prepared.task.key,
      analogueEvidence: [],
      analogueAssessments: [],
      expectedRevision: prepared.task.revision
    });
    const gate = await engineeringQualityGate(r.lineage, erased.key, roots, r.workspace);
    expect(gate.status).toBe('blocked');
    expect(gate.blockers.join(' ')).toContain('only 0 independent analogue');
  });

  it('ATTACK shallow deliberation: cannot bypass comparison with one fake option or unmapped implementation', async () => {
    const r = resolved(projectB, '/b', 'generic');
    for (const [name, extra] of [['A.cs', ''], ['B.cs', ' int X=1;'], ['C.cs', ' int X=2;']] as const) {
      await fs.writeFile(path.join(projectB, name), `class ${name[0]} { void OptionPattern() {${extra}} }`, 'utf8');
    }
    await fs.writeFile(path.join(projectB, 'Feature.cs'), 'class Feature { void OptionPattern() {} }', 'utf8');
    const prepared = await prepareEngineeringTask(r, {
      taskKey: 'fake-options', goal: 'Choose a safe OptionPattern implementation.', analogueQuery: 'OptionPattern'
    }, roots);
    const decided = await putEngineeringTask(r.lineage, {
      key: prepared.task.key,
      analogueAssessments: prepared.task.analogueEvidence.map(ref => ({
        evidenceId: ref.evidenceId,
        contentHash: ref.contentHash,
        classification: 'convention' as const,
        note: 'Local option-pattern evidence.'
      })),
      deliberationStatus: 'decided',
      deliberationQuestion: 'Is there a genuine alternative implementation path?',
      deliberationTriggers: ['architecture'],
      deliberationSummary: 'Pretend comparison.',
      deliberationAuthority: 'agent',
      solutionOptions: [{
        key: 'only-option', title: 'Only option', approach: 'Use the only listed option.',
        benefits: ['Short.'], tradeoffs: ['No real comparison.'], risks: [], evidence: [], rejectedReason: ''
      }],
      selectedOptionKey: 'only-option',
      deliberationDecisionNote: 'Selected because it was the only option.',
      changedFiles: ['Feature.cs'],
      expectedRevision: prepared.task.revision
    });

    const gate = await engineeringQualityGate(r.lineage, decided.key, roots, r.workspace);
    expect(gate.status).toBe('blocked');
    expect(gate.blockers.join(' ')).toContain('requires 2-3 concrete solution options');
    expect(gate.blockers.join(' ')).toContain('not mapped to the selected deliberation option');
    expect(gate.assurance.deliberationVerified).toBe(false);
  });

  it('ATTACK deliberation drift: silently switching the selected option after decision makes the basis stale', async () => {
    const r = resolved(projectB, '/b', 'generic');
    for (const [name, extra] of [['A.cs', ''], ['B.cs', ' int X=1;'], ['C.cs', ' int X=2;']] as const) {
      await fs.writeFile(path.join(projectB, name), `class ${name[0]} { void DecisionPattern() {${extra}} }`, 'utf8');
    }
    const prepared = await prepareEngineeringTask(r, {
      taskKey: 'decision-drift', goal: 'Choose a DecisionPattern implementation.', analogueQuery: 'DecisionPattern'
    }, roots);
    const baseOptions = [{
      key: 'a', title: 'Option A', approach: 'Follow A.', benefits: ['Simple.'], tradeoffs: ['Less flexible.'], risks: [], evidence: [], rejectedReason: ''
    }, {
      key: 'b', title: 'Option B', approach: 'Follow B.', benefits: ['Flexible.'], tradeoffs: ['More moving parts.'], risks: [], evidence: [], rejectedReason: 'A matches the current conventions more closely.'
    }];
    const decided = await putEngineeringTask(r.lineage, {
      key: prepared.task.key,
      analogueAssessments: prepared.task.analogueEvidence.map(ref => ({
        evidenceId: ref.evidenceId,
        contentHash: ref.contentHash,
        classification: 'convention' as const,
        note: 'Local decision-pattern evidence.'
      })),
      deliberationStatus: 'decided', deliberationQuestion: 'Which internal implementation shape best fits the current conventions?',
      deliberationTriggers: ['architecture'], deliberationSummary: 'Compared A and B.', deliberationAuthority: 'agent',
      solutionOptions: baseOptions, selectedOptionKey: 'a', deliberationDecisionNote: 'A better matches current conventions.',
      expectedRevision: prepared.task.revision
    });
    const tampered = await putEngineeringTask(r.lineage, {
      key: decided.key,
      selectedOptionKey: 'b',
      expectedRevision: decided.revision
    });

    const gate = await engineeringQualityGate(r.lineage, tampered.key, roots, r.workspace);
    expect(gate.blockers.join(' ')).toContain('Deliberation is stale');
    expect(gate.assurance.deliberationVerified).toBe(false);
  });

  it('ATTACK implementation drift: changing bound files without rebinding the selected option stales completion', async () => {
    const r = resolved(projectB, '/b', 'generic');
    for (const [name, extra] of [['A.cs', ''], ['B.cs', ' int X=1;'], ['C.cs', ' int X=2;']] as const) {
      await fs.writeFile(path.join(projectB, name), `class ${name[0]} { void BindingPattern() {${extra}} }`, 'utf8');
    }
    await fs.writeFile(path.join(projectB, 'Feature.cs'), 'class Feature { void BindingPattern() {} }', 'utf8');
    await fs.writeFile(path.join(projectB, 'Extra.cs'), 'class Extra { void BindingPattern() {} }', 'utf8');
    const prepared = await prepareEngineeringTask(r, {
      taskKey: 'binding-drift', goal: 'Choose and bind a BindingPattern implementation.', analogueQuery: 'BindingPattern'
    }, roots);
    const assessed = prepared.task.analogueEvidence.map(ref => ({
      evidenceId: ref.evidenceId,
      contentHash: ref.contentHash,
      classification: 'convention' as const,
      note: 'Local binding-pattern evidence.'
    }));
    const decided = await putEngineeringTask(r.lineage, {
      key: prepared.task.key,
      analogueAssessments: assessed,
      deliberationStatus: 'decided',
      deliberationQuestion: 'Should the implementation keep the minimal local shape or add the broader extension point?',
      deliberationTriggers: ['architecture'],
      deliberationSummary: 'Compared the minimal project-native implementation with a broader extension point.',
      deliberationAuthority: 'agent',
      solutionOptions: [{
        key: 'minimal', title: 'Minimal local shape', approach: 'Follow the current local pattern.',
        benefits: ['Small compatible delta.'], tradeoffs: ['Less extensible.'], risks: [], evidence: [], rejectedReason: ''
      }, {
        key: 'extension', title: 'Broader extension point', approach: 'Introduce an additional extension abstraction.',
        benefits: ['More future flexibility.'], tradeoffs: ['Larger surface and more maintenance.'], risks: [], evidence: [],
        rejectedReason: 'No current requirement or convention justifies the extra abstraction.'
      }],
      selectedOptionKey: 'minimal',
      deliberationDecisionNote: 'The minimal option matches current project evidence and avoids speculative abstraction.',
      expectedRevision: prepared.task.revision
    });
    const bound = await putEngineeringTask(r.lineage, {
      key: decided.key,
      changedFiles: ['Feature.cs'],
      implementedOptionKey: 'minimal',
      expectedRevision: decided.revision
    });
    expect(bound.implementationBindingHash).toMatch(/^[a-f0-9]{64}$/);

    const drifted = await putEngineeringTask(r.lineage, {
      key: bound.key,
      changedFiles: ['Feature.cs', 'Extra.cs'],
      expectedRevision: bound.revision
    });
    const gate = await engineeringQualityGate(r.lineage, drifted.key, roots, r.workspace);
    expect(gate.blockers.join(' ')).toContain('Implementation binding is stale');
    expect(gate.assurance.deliberationVerified).toBe(false);
  });

  it('ATTACK profile typo/manifest: unknown project profile canonicalizes to generic while runtime still auto-detects', async () => {
    await fs.mkdir(path.join(projectB, '.agents'), { recursive: true });
    await fs.writeFile(path.join(projectB, '.agents', 'engineering.json'), JSON.stringify({ profile: 'linkqq' }), 'utf8');
    await fs.writeFile(path.join(projectB, 'App.csproj'), '<Project><PropertyGroup><TargetFrameworkVersion>v4.5</TargetFrameworkVersion></PropertyGroup></Project>', 'utf8');
    await expect(resolveEngineeringProjectIdentity(projectB)).resolves.toEqual({ profile: 'generic', runtimeFamily: 'net45' });
  });

  it('ATTACK profile leakage: explicit ThaiViet manifest remains generic even when LINKQ-like files exist nearby', async () => {
    await fs.mkdir(path.join(projectB, '.agents'), { recursive: true });
    await fs.writeFile(path.join(projectB, '.agents', 'engineering.json'), JSON.stringify({ profile: 'thaiviet' }), 'utf8');
    await fs.writeFile(path.join(projectB, 'LinkQ.sln'), 'Microsoft Visual Studio Solution File', 'utf8');
    await fs.writeFile(path.join(projectB, 'ThaiViet.csproj'), '<Project><PropertyGroup><TargetFrameworkVersion>v4.5</TargetFrameworkVersion></PropertyGroup></Project>', 'utf8');
    await expect(resolveEngineeringProjectIdentity(projectB)).resolves.toEqual({ profile: 'generic', runtimeFamily: 'net45' });
  });

  it('ATTACK runtime override: the same project root/profile cannot silently fork durable Engineering state', () => {
    const rootIdentity = knowledgeSha256(projectB);
    expect(engineeringLineageKey(rootIdentity, 'generic', 'net45'))
      .toBe(engineeringLineageKey(rootIdentity, 'generic', 'mixed'));
  });

  it('ATTACK generic SQL needle: runtime verification rejects a non-specific keyword', async () => {
    const r = resolved(projectA, '/a');
    await fs.writeFile(path.join(projectA, 'Feature.cs'), 'class Feature {}', 'utf8');
    await putEngineeringTask(r.lineage, {
      key: 'sql-needle', goal: 'Scale check.', changedFiles: ['Feature.cs'],
      validations: [{ name: 'build', status: 'pending', detail: 'Build.' }], largeDataRisk: true
    });
    await expect(runEngineeringValidation(r, {
      kind: 'sql_scale', taskKey: 'sql-needle', name: 'scale', objectId: 1,
      runtimeSource: 'query_store', queryContains: 'select'
    }, roots)).rejects.toThrow(/task-specific identifier|queryContains/i);
  });
});
