import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  getBusinessProcessHistory,
  getBusinessProcessRecords,
  putBusinessProcessRecord,
  searchBusinessProcessRecords
} from '../src/cos-erp-db/knowledge/process-service.js';
import { initBusinessProcessStore, resetBusinessProcessStoreForTests } from '../src/cos-erp-db/knowledge/process-store.js';
import { indexKnowledge, resetKnowledgeSearchCacheForTests, searchKnowledge } from '../src/cos-erp-db/knowledge/service.js';
import { initKnowledgeStore, resetKnowledgeStoreForTests } from '../src/cos-erp-db/knowledge/store.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let workspace = '';
let sourcePath = '';
let roots: Root[] = [];

beforeEach(async () => {
  directory = await makeTempDir('cos-business-process-');
  workspace = path.join(directory, 'workspace');
  sourcePath = path.join(workspace, 'PayrollRule.cs');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(sourcePath, [
    'public static class PayrollRule {',
    '  public const string Rule = "NetSalaryAdjustment";',
    '}'
  ].join('\n'), 'utf8');
  roots = [{ name: 'workspace', path: workspace }];
  const userData = path.join(directory, 'user-data');
  initKnowledgeStore(userData);
  initBusinessProcessStore(userData);
  resetKnowledgeSearchCacheForTests();
});

afterEach(async () => {
  resetKnowledgeSearchCacheForTests();
  resetKnowledgeStoreForTests();
  resetBusinessProcessStoreForTests();
  await removeTempDir(directory);
});

async function supportingEvidence(scope: string) {
  await indexKnowledge({
    scope,
    sources: [{ kind: 'source', path: '/workspace/PayrollRule.cs' }]
  }, roots);
  const found = await searchKnowledge({ scope, query: 'NetSalaryAdjustment', limit: 1 });
  expect(found.hits).toHaveLength(1);
  const hit = found.hits[0]!;
  return { evidenceId: hit.evidenceId, contentHash: hit.contentHash, relation: 'supports' as const };
}

it('keeps a revisioned Customer → Process → Solution → Rule → Expected Behavior chain with evidence provenance', async () => {
  const scope = 'customer-a';
  const evidence = await supportingEvidence(scope);

  await putBusinessProcessRecord(scope, {
    key: 'customer:a',
    kind: 'customer',
    title: 'Customer A',
    statement: 'Customer A ERP configuration.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'process:payroll',
    kind: 'process',
    parentKey: 'customer:a',
    title: 'Monthly payroll',
    statement: 'Prepare and finalize monthly payroll.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'solution:payroll-v1',
    kind: 'solution',
    parentKey: 'process:payroll',
    title: 'Payroll solution V1',
    statement: 'Current approved payroll solution.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'rule:net-adjustment',
    kind: 'rule',
    parentKey: 'solution:payroll-v1',
    title: 'Net salary adjustment',
    statement: 'Approved adjustment participates in final net salary.',
    evidence: [evidence],
    confidence: 'high'
  });
  const created = await putBusinessProcessRecord(scope, {
    key: 'expected:net-adjustment',
    kind: 'expected_behavior',
    parentKey: 'rule:net-adjustment',
    title: 'Expected net salary',
    statement: 'Final net salary reflects the approved adjustment exactly once.',
    status: 'accepted',
    confidence: 'high',
    tags: ['payroll', 'net salary'],
    evidence: [evidence]
  });
  expect(created.changed).toBe(true);
  expect(created.record.revision).toBe(1);
  expect(created.record.parentKey).toBe('rule:net-adjustment');

  const unchanged = await putBusinessProcessRecord(scope, {
    key: 'expected:net-adjustment',
    kind: 'expected_behavior',
    parentKey: 'rule:net-adjustment',
    title: 'Expected net salary',
    statement: 'Final net salary reflects the approved adjustment exactly once.',
    status: 'accepted',
    confidence: 'high',
    tags: ['payroll', 'net salary'],
    evidence: [evidence]
  });
  expect(unchanged.changed).toBe(false);
  expect(unchanged.record.revision).toBe(1);

  const updated = await putBusinessProcessRecord(scope, {
    key: 'expected:net-adjustment',
    kind: 'expected_behavior',
    parentKey: 'rule:net-adjustment',
    title: 'Expected net salary',
    statement: 'Final net salary reflects each approved adjustment exactly once.',
    status: 'accepted',
    confidence: 'high',
    tags: ['payroll', 'net salary'],
    evidence: [evidence]
  });
  expect(updated.changed).toBe(true);
  expect(updated.record.revision).toBe(2);

  const history = await getBusinessProcessHistory(scope, 'expected:net-adjustment');
  expect(history.revisions.map(item => item.revision)).toEqual([1, 2]);
  expect(history.revisions[0]?.statement).toContain('the approved adjustment');
  expect(history.revisions[1]?.statement).toContain('each approved adjustment');

  const searched = await searchBusinessProcessRecords(scope, 'net salary', 5);
  expect(searched.hits[0]?.record.key).toBe('expected:net-adjustment');
  expect(searched.hits[0]?.evidenceState).toEqual([
    { evidenceId: evidence.evidenceId, status: 'indexed' }
  ]);
});

it('marks process facts stale against a re-indexed evidence chunk without rewriting the accepted fact', async () => {
  const scope = 'customer-stale';
  const evidence = await supportingEvidence(scope);
  await putBusinessProcessRecord(scope, {
    key: 'customer:a',
    kind: 'customer',
    title: 'Customer A',
    statement: 'Customer.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'process:payroll',
    kind: 'process',
    parentKey: 'customer:a',
    title: 'Payroll',
    statement: 'Payroll.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'rule:net',
    kind: 'rule',
    parentKey: 'process:payroll',
    title: 'Net rule',
    statement: 'Original rule.',
    evidence: [evidence]
  });
  await putBusinessProcessRecord(scope, {
    key: 'expected:net',
    kind: 'expected_behavior',
    parentKey: 'rule:net',
    title: 'Expected net',
    statement: 'Use the indexed rule.',
    status: 'accepted',
    evidence: [evidence]
  });

  await fs.writeFile(sourcePath, [
    'public static class PayrollRule {',
    '  public const string Rule = "NetSalaryAdjustmentChanged";',
    '}'
  ].join('\n'), 'utf8');
  await indexKnowledge({
    scope,
    sources: [{ kind: 'source', path: '/workspace/PayrollRule.cs' }]
  }, roots);

  const fetched = await getBusinessProcessRecords(scope, ['expected:net']);
  expect(fetched.records[0]?.record.revision).toBe(1);
  expect(fetched.records[0]?.evidenceState).toEqual([
    { evidenceId: evidence.evidenceId, status: 'hash-mismatch' }
  ]);
});

it('rejects invalid hierarchy and unsupported acceptance claims', async () => {
  await expect(putBusinessProcessRecord('invalid', {
    key: 'process:payroll',
    kind: 'process',
    title: 'Payroll',
    statement: 'Missing customer parent.'
  })).rejects.toThrow('requires an existing parent');

  await putBusinessProcessRecord('invalid', {
    key: 'customer:a',
    kind: 'customer',
    title: 'Customer',
    statement: 'Customer.'
  });
  await putBusinessProcessRecord('invalid', {
    key: 'process:payroll',
    kind: 'process',
    parentKey: 'customer:a',
    title: 'Payroll',
    statement: 'Payroll.'
  });
  await expect(putBusinessProcessRecord('invalid', {
    key: 'expected:bad',
    kind: 'expected_behavior',
    parentKey: 'process:payroll',
    title: 'Bad hierarchy',
    statement: 'Expected behavior cannot hang directly from a process.',
    status: 'accepted',
    acceptanceNote: 'Manually approved for hierarchy test.'
  })).rejects.toThrow('parent must be one of: rule');
});
