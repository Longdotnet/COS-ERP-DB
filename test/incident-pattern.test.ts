import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resetImplementationGraphCacheForTests } from '../src/cos-erp-db/knowledge/graph-service.js';
import { readIncidentContext } from '../src/cos-erp-db/knowledge/incident-context.js';
import { initIncidentOutcomeStore, resetIncidentOutcomeStoreForTests } from '../src/cos-erp-db/knowledge/outcome-store.js';
import { putIncidentOutcome } from '../src/cos-erp-db/knowledge/outcome-service.js';
import { initIncidentPatternStore, resetIncidentPatternStoreForTests } from '../src/cos-erp-db/knowledge/pattern-store.js';
import {
  getIncidentPatternHistory,
  putIncidentPatternOccurrence,
  searchIncidentPatterns
} from '../src/cos-erp-db/knowledge/pattern-service.js';
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
  directory = await makeTempDir('cos-incident-pattern-');
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

async function seedScope(scope: string, customerKey: string) {
  await indexKnowledge({ scope, sources: [{ kind: 'source', path: '/workspace/PayrollRule.cs' }] }, roots);
  const found = await searchKnowledge({ scope, query: 'NetSalaryAdjustment', limit: 1 });
  const hit = found.hits[0]!;
  const evidence = { evidenceId: hit.evidenceId, contentHash: hit.contentHash, relation: 'supports' as const };
  await putBusinessProcessRecord(scope, {
    key: customerKey, kind: 'customer', title: customerKey, statement: 'ERP customer deployment.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'process:payroll', kind: 'process', parentKey: customerKey, title: 'Monthly payroll',
    statement: 'Prepare and finalize monthly payroll.'
  });
  await putBusinessProcessRecord(scope, {
    key: 'rule:net', kind: 'rule', parentKey: 'process:payroll', title: 'Net salary rule',
    statement: 'Apply approved adjustment in final net salary.', evidence: [evidence]
  });
  await putBusinessProcessRecord(scope, {
    key: 'expected:net', kind: 'expected_behavior', parentKey: 'rule:net', title: 'Expected net salary',
    statement: 'Apply each approved adjustment exactly once.', status: 'accepted', confidence: 'high', evidence: [evidence]
  });
  return evidence;
}

async function seedAcceptedOutcome(scope: string, customerKey: string, outcomeKey: string, incidentKey: string) {
  const evidence = await seedScope(scope, customerKey);
  await putIncidentOutcome(scope, {
    key: outcomeKey,
    incidentKey,
    title: 'Confirmed double net adjustment',
    symptom: 'Final net salary differs after an approved adjustment.',
    processKey: 'process:payroll',
    expectedBehaviorKey: 'expected:net',
    rootCauseCategory: 'calculation-path',
    finding: 'The same approved adjustment was included twice.',
    remediation: 'Remove the duplicate inclusion from the final calculation path.',
    evidence: [evidence],
    validation: {
      result: 'passed',
      summary: 'Recalculation applies the approved adjustment exactly once.',
      evidence: [evidence]
    },
    status: 'accepted',
    decisionNote: 'Implementation and recalculation were reviewed and accepted.'
  });
  return evidence;
}

function patternInput(outcomeKey: string) {
  return {
    key: 'pattern:double-net-adjustment',
    title: 'Net salary adjustment counted twice',
    symptom: 'Final net salary differs after an approved adjustment.',
    finding: 'A final calculation path can include the same approved adjustment more than once.',
    recommendedChecks: [
      'Trace the final net salary calculation path.',
      'Check whether the adjustment is already included before a later aggregation step.'
    ],
    tags: ['payroll', 'net salary'],
    occurrence: {
      outcomeKey
    }
  };
}

it('promotes a reusable incident pattern only after two distinct customer scopes support it', async () => {
  await seedAcceptedOutcome('customer-a', 'customer:a', 'outcome:a1', 'INC-A-1');
  await seedAcceptedOutcome('customer-b', 'customer:b', 'outcome:b1', 'INC-B-1');

  const first = await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));
  expect(first.pattern.status).toBe('candidate');
  expect(first.pattern.supportingScopeCount).toBe(1);

  const second = await putIncidentPatternOccurrence('customer-b', patternInput('outcome:b1'));
  expect(second.pattern.status).toBe('promoted');
  expect(second.pattern.supportingScopeCount).toBe(2);
  expect(second.pattern.revision).toBe(2);

  const search = await searchIncidentPatterns('customer-c', 'net salary', 5);
  expect(search.hits).toHaveLength(1);
  expect(search.hits[0]?.provenance).toMatchObject({
    liveStatus: 'promoted',
    currentSupportingScopeCount: 2,
    otherSupportingScopeCount: 2,
    staleOccurrenceCount: 0
  });

  const history = await getIncidentPatternHistory('pattern:double-net-adjustment');
  expect(history.revisions.map(item => item.revision)).toEqual([1, 2]);
});

it('degrades promoted learning when one source scope no longer supports its recorded evidence', async () => {
  await seedAcceptedOutcome('customer-a', 'customer:a', 'outcome:a1', 'INC-A-1');
  await seedAcceptedOutcome('customer-b', 'customer:b', 'outcome:b1', 'INC-B-1');
  await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));
  await putIncidentPatternOccurrence('customer-b', patternInput('outcome:b1'));

  await fs.writeFile(sourcePath, 'public static class PayrollRule { public const string Rule = "Changed"; }\n', 'utf8');
  await indexKnowledge({ scope: 'customer-b', sources: [{ kind: 'source', path: '/workspace/PayrollRule.cs' }] }, roots);

  const search = await searchIncidentPatterns('customer-c', 'net salary', 5);
  expect(search.hits[0]?.provenance).toMatchObject({
    liveStatus: 'degraded',
    currentSupportingScopeCount: 1,
    staleOccurrenceCount: 1
  });
});

it('offers promoted cross-customer learning as a hint without importing foreign process facts into local context', async () => {
  await seedAcceptedOutcome('customer-a', 'customer:a', 'outcome:a1', 'INC-A-1');
  await seedAcceptedOutcome('customer-b', 'customer:b', 'outcome:b1', 'INC-B-1');
  await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));
  await putIncidentPatternOccurrence('customer-b', patternInput('outcome:b1'));

  const context = await readIncidentContext('customer-c', 'net salary', roots, 8);

  expect(context.readiness).toBe('empty');
  expect(context.contextRecords).toEqual([]);
  expect(context.verification).toBeNull();
  expect(context.crossCustomerSuggestions).toHaveLength(1);
  expect(context.crossCustomerSuggestions[0]?.provenance.otherSupportingScopeCount).toBe(2);
  expect(context.crossCustomerSuggestions[0]?.guidance).toContain('verify this customer');
  expect(JSON.stringify(context.crossCustomerSuggestions)).not.toContain('customer-a');
  expect(JSON.stringify(context.crossCustomerSuggestions)).not.toContain('customer-b');
});

it('requires revision proof before one contributor can change the shared pattern definition', async () => {
  await seedAcceptedOutcome('customer-a', 'customer:a', 'outcome:a1', 'INC-A-1');
  await seedAcceptedOutcome('customer-b', 'customer:b', 'outcome:b1', 'INC-B-1');
  await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));

  const conflicting = patternInput('outcome:b1');
  conflicting.finding = 'A different generalized finding.';
  await expect(putIncidentPatternOccurrence('customer-b', conflicting)).rejects.toThrow('expectedRevision');

  const reviewed = { ...conflicting, expectedRevision: 1 };
  const result = await putIncidentPatternOccurrence('customer-b', reviewed);
  expect(result.pattern.finding).toBe('A different generalized finding.');
  expect(result.pattern.status).toBe('promoted');
  expect(result.pattern.revision).toBe(2);
});
