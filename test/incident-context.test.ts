import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readIncidentContext } from '../src/cos-erp-db/knowledge/incident-context.js';
import { resetImplementationGraphCacheForTests } from '../src/cos-erp-db/knowledge/graph-service.js';
import { initIncidentOutcomeStore, resetIncidentOutcomeStoreForTests } from '../src/cos-erp-db/knowledge/outcome-store.js';
import { initIncidentPatternStore, resetIncidentPatternStoreForTests } from '../src/cos-erp-db/knowledge/pattern-store.js';
import { initBusinessProcessStore, resetBusinessProcessStoreForTests } from '../src/cos-erp-db/knowledge/process-store.js';
import { putBusinessProcessRecord } from '../src/cos-erp-db/knowledge/process-service.js';
import { indexKnowledge, resetKnowledgeSearchCacheForTests, searchKnowledge } from '../src/cos-erp-db/knowledge/service.js';
import { initKnowledgeStore, resetKnowledgeStoreForTests } from '../src/cos-erp-db/knowledge/store.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let workspace = '';
let sourcePath = '';
let roots: Root[] = [];

beforeEach(async () => {
  directory = await makeTempDir('cos-incident-context-');
  workspace = path.join(directory, 'workspace');
  sourcePath = path.join(workspace, 'frmBangLuong.cs');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(sourcePath, [
    'public class frmBangLuong {',
    '  public void TinhLuong() { var rule = "NetSalaryAdjustment"; }',
    '}'
  ].join('\n'), 'utf8');
  roots = [{ name: 'workspace', path: workspace }];
  const userData = path.join(directory, 'user-data');
  initKnowledgeStore(userData);
  initBusinessProcessStore(userData);
  initIncidentOutcomeStore(userData);
  initIncidentPatternStore(userData);
  resetKnowledgeSearchCacheForTests();
  resetImplementationGraphCacheForTests();
});

afterEach(async () => {
  resetImplementationGraphCacheForTests();
  resetKnowledgeSearchCacheForTests();
  resetIncidentPatternStoreForTests();
  resetIncidentOutcomeStoreForTests();
  resetKnowledgeStoreForTests();
  resetBusinessProcessStoreForTests();
  await removeTempDir(directory);
});

async function seedPayrollContext(scope: string): Promise<void> {
  await indexKnowledge({ scope, sources: [{ kind: 'source', path: '/workspace/frmBangLuong.cs' }] }, roots);
  const found = await searchKnowledge({ scope, query: 'NetSalaryAdjustment', limit: 1 });
  const hit = found.hits[0]!;
  const evidence = [{ evidenceId: hit.evidenceId, contentHash: hit.contentHash, relation: 'supports' as const }];

  await putBusinessProcessRecord(scope, {
    key: 'customer:a', kind: 'customer', title: 'Customer A', statement: 'Customer A ERP deployment.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'process:payroll', kind: 'process', parentKey: 'customer:a', title: 'Monthly payroll',
    statement: 'Prepare and finalize monthly payroll.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'change:net-adjustment', kind: 'change_request', parentKey: 'process:payroll',
    title: 'Net salary adjustment', statement: 'Apply approved net salary adjustment once.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'rule:net-adjustment', kind: 'rule', parentKey: 'change:net-adjustment',
    title: 'Net salary rule', statement: 'The adjustment participates in final net salary.', evidence
  });
  await putBusinessProcessRecord(scope, {
    key: 'expected:net-adjustment', kind: 'expected_behavior', parentKey: 'rule:net-adjustment',
    title: 'Expected net salary', statement: 'Final net salary applies the approved adjustment exactly once.',
    status: 'accepted', confidence: 'high', evidence
  });
}

it('builds a verified Customer → Process → Change → Rule → Expected Behavior packet before diagnosis', async () => {
  const scope = 'customer-a';
  await seedPayrollContext(scope);

  const context = await readIncidentContext(scope, 'net salary', roots, 8);

  expect(context.readiness).toBe('grounded');
  expect(context.contextRecords.map(record => record.kind)).toEqual([
    'customer', 'process', 'change_request', 'rule', 'expected_behavior'
  ]);
  expect(context.verification?.allCurrent).toBe(true);
  expect(context.implementationLinks.some(link => link.nodes.some(node => node.kind === 'source_file'))).toBe(true);
  expect(context.gaps).toEqual([]);
});

it('downgrades readiness when indexed deployment/process evidence changed on disk', async () => {
  const scope = 'customer-stale';
  await seedPayrollContext(scope);
  await fs.writeFile(sourcePath, 'public class frmBangLuong { public void TinhLuong() { } }\n', 'utf8');

  const context = await readIncidentContext(scope, 'net salary', roots, 8);

  expect(context.readiness).toBe('partial');
  expect(context.verification?.allCurrent).toBe(false);
  expect(context.gaps.some(gap => gap.includes('stale'))).toBe(true);
});

it('keeps local incident context usable when the optional cross-customer pattern registry is unavailable', async () => {
  const scope = 'customer-local';
  await seedPayrollContext(scope);
  resetIncidentPatternStoreForTests();

  const context = await readIncidentContext(scope, 'net salary', roots, 8);

  expect(context.readiness).toBe('grounded');
  expect(context.crossCustomerSuggestions).toEqual([]);
  expect(context.crossCustomerLimitations[0]).toContain('pattern lookup was unavailable');
});

it('keeps local incident context usable when prior incident outcomes are unavailable', async () => {
  const scope = 'customer-local-outcome';
  await seedPayrollContext(scope);
  resetIncidentOutcomeStoreForTests();

  const context = await readIncidentContext(scope, 'net salary', roots, 8);

  expect(context.readiness).toBe('grounded');
  expect(context.priorConfirmedOutcomes).toEqual([]);
  expect(context.priorOutcomeLimitations[0]).toContain('outcome lookup was unavailable');
});
