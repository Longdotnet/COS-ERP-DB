import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createKnowledgeEvidence, knowledgeSha256 } from '../src/cos-erp-db/knowledge/evidence.js';
import {
  expandImplementationGraph,
  resetImplementationGraphCacheForTests,
  searchImplementationGraph
} from '../src/cos-erp-db/knowledge/graph-service.js';
import { initBusinessProcessStore, resetBusinessProcessStoreForTests } from '../src/cos-erp-db/knowledge/process-store.js';
import { putBusinessProcessRecord } from '../src/cos-erp-db/knowledge/process-service.js';
import { indexKnowledge, resetKnowledgeSearchCacheForTests, searchKnowledge } from '../src/cos-erp-db/knowledge/service.js';
import { initKnowledgeStore, mutateKnowledgeScope, resetKnowledgeStoreForTests } from '../src/cos-erp-db/knowledge/store.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let workspace = '';
let roots: Root[] = [];

beforeEach(async () => {
  directory = await makeTempDir('cos-implementation-graph-');
  workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'frmBangLuong.cs'), [
    'partial class frmBangLuong {',
    '  private void Calc() {',
    '    var table = "L10BANGLUONG";',
    '    SQLExec("Sp_HRM_CalcBangLuong");',
    '  }',
    '  private void InitializeComponent() {',
    '    this.dgvMaNv.DataPropertyName = "MA_NV";',
    '  }',
    '}'
  ].join('\n'), 'utf8');
  roots = [{ name: 'workspace', path: workspace }];
  const userData = path.join(directory, 'user-data');
  initKnowledgeStore(userData);
  initBusinessProcessStore(userData);
  resetKnowledgeSearchCacheForTests();
  resetImplementationGraphCacheForTests();
});

afterEach(async () => {
  resetImplementationGraphCacheForTests();
  resetKnowledgeSearchCacheForTests();
  resetKnowledgeStoreForTests();
  resetBusinessProcessStoreForTests();
  await removeTempDir(directory);
});

async function addDatabaseFixture(scope: string): Promise<void> {
  const capturedAt = new Date().toISOString();
  const tableText = [
    'type=table',
    'schema=dbo',
    'name=L10BANGLUONG',
    'objectId=42',
    'columns:',
    '1. MA_NV varchar(20) [required]',
    '2. TONG_LUONG decimal(18,2) [nullable]'
  ].join('\n');
  const procText = [
    'type=procedure',
    'schema=dbo',
    'name=Sp_HRM_CalcBangLuong',
    'objectId=43'
  ].join('\n');
  const table = createKnowledgeEvidence({
    scope,
    kind: 'database',
    sourceKey: 'database:linkq:L80LINKQ.TEST',
    title: 'table dbo.L10BANGLUONG',
    content: tableText,
    sourceHash: knowledgeSha256(tableText),
    capturedAt,
    locator: {
      connection: 'linkq',
      database: 'L80LINKQ.TEST',
      objectId: 42,
      objectType: 'table',
      schema: 'dbo',
      name: 'L10BANGLUONG',
      part: 'metadata'
    }
  });
  const procedure = createKnowledgeEvidence({
    scope,
    kind: 'database',
    sourceKey: 'database:linkq:L80LINKQ.TEST',
    title: 'procedure dbo.Sp_HRM_CalcBangLuong',
    content: procText,
    sourceHash: knowledgeSha256(procText),
    capturedAt,
    locator: {
      connection: 'linkq',
      database: 'L80LINKQ.TEST',
      objectId: 43,
      objectType: 'procedure',
      schema: 'dbo',
      name: 'Sp_HRM_CalcBangLuong',
      part: 'metadata'
    }
  });
  await mutateKnowledgeScope(scope, current => {
    const evidence = [...current.evidence, table, procedure];
    return {
      ...current,
      generation: knowledgeSha256(evidence.map(item => item.id + ':' + item.contentHash).sort().join('|')),
      updatedAt: capturedAt,
      evidence
    };
  });
}

it('derives process → evidence → source/form/control/method → SQL object/column navigation', async () => {
  const scope = 'graph-payroll';
  await indexKnowledge({
    scope,
    sources: [{ kind: 'source', path: '/workspace/frmBangLuong.cs' }]
  }, roots);
  await addDatabaseFixture(scope);
  const sourceHit = (await searchKnowledge({ scope, query: 'Sp_HRM_CalcBangLuong', kinds: ['source'], limit: 1 })).hits[0]!;

  await putBusinessProcessRecord(scope, {
    key: 'customer:demo',
    kind: 'customer',
    title: 'Demo customer',
    statement: 'Demo customer.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'process:payroll',
    kind: 'process',
    parentKey: 'customer:demo',
    title: 'Payroll',
    statement: 'Monthly payroll.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'rule:calc-net',
    kind: 'rule',
    parentKey: 'process:payroll',
    title: 'Calculate net salary',
    statement: 'Payroll form invokes salary calculation.',
    evidence: [{
      evidenceId: sourceHit.evidenceId,
      contentHash: sourceHit.contentHash,
      relation: 'supports'
    }]
  });
  await putBusinessProcessRecord(scope, {
    key: 'expected:calc-net',
    kind: 'expected_behavior',
    parentKey: 'rule:calc-net',
    title: 'Expected payroll calculation',
    statement: 'frmBangLuong calculates salary using the payroll procedure.',
    status: 'accepted',
    evidence: [{
      evidenceId: sourceHit.evidenceId,
      contentHash: sourceHit.contentHash,
      relation: 'supports'
    }]
  });

  const formSearch = await searchImplementationGraph(scope, 'frmBangLuong', 10);
  expect(formSearch.hits.some(hit => hit.node.kind === 'form' && hit.node.label === 'frmBangLuong')).toBe(true);
  expect(formSearch.hits.some(hit => hit.node.kind === 'expected_behavior')).toBe(true);

  const procedureSearch = await searchImplementationGraph(scope, 'Sp_HRM_CalcBangLuong', 5);
  const procedure = procedureSearch.hits.find(hit => hit.node.kind === 'database_object');
  expect(procedure?.node.label).toBe('dbo.Sp_HRM_CalcBangLuong');
  expect(procedure?.edges.some(edge => edge.relation === 'calls')).toBe(true);

  const fileSearch = await searchImplementationGraph(scope, 'frmBangLuong.cs', 5);
  const sourceFile = fileSearch.hits.find(hit => hit.node.kind === 'source_file');
  expect(sourceFile).toBeTruthy();
  const expanded = await expandImplementationGraph(scope, sourceFile!.node.id);
  expect(expanded.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'form', label: 'frmBangLuong' }),
    expect.objectContaining({ kind: 'database_object', label: 'dbo.L10BANGLUONG' }),
    expect.objectContaining({ kind: 'database_object', label: 'dbo.Sp_HRM_CalcBangLuong' }),
    expect.objectContaining({ kind: 'database_column', label: 'dbo.L10BANGLUONG.MA_NV' }),
    expect.objectContaining({ kind: 'control', label: 'frmBangLuong.dgvMaNv' })
  ]));
  expect(expanded.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ relation: 'calls' }),
    expect.objectContaining({ relation: 'binds' }),
    expect.objectContaining({ relation: 'has_column' })
  ]));
});

it('keeps identical object ids from different databases as separate graph nodes', async () => {
  const scope = 'graph-db-origin';
  const capturedAt = new Date().toISOString();
  const makeTable = (database: string, name: string) => createKnowledgeEvidence({
    scope,
    kind: 'database',
    sourceKey: 'database:linkq:' + database,
    title: 'table dbo.' + name,
    content: ['type=table', 'schema=dbo', 'name=' + name, 'objectId=42'].join('\n'),
    sourceHash: knowledgeSha256(database + ':' + name),
    capturedAt,
    locator: {
      connection: 'linkq',
      database,
      objectId: 42,
      objectType: 'table',
      schema: 'dbo',
      name,
      part: 'metadata'
    }
  });
  await mutateKnowledgeScope(scope, current => {
    const evidence = [
      makeTable('L80LINKQ.A', 'L00COMMON'),
      makeTable('L80LINKQ.B', 'L00COMMON')
    ];
    return {
      ...current,
      generation: knowledgeSha256(evidence.map(item => item.id).join('|')),
      updatedAt: capturedAt,
      evidence
    };
  });

  const result = await searchImplementationGraph(scope, 'L00COMMON', 10);
  const databaseNodes = result.hits.filter(hit => hit.node.kind === 'database_object');
  expect(databaseNodes).toHaveLength(2);
  expect(new Set(databaseNodes.map(hit => hit.node.id)).size).toBe(2);
});
