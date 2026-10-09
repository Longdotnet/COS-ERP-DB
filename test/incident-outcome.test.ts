import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initIncidentOutcomeStore, resetIncidentOutcomeStoreForTests } from '../src/cos-erp-db/knowledge/outcome-store.js';
import {
  getIncidentOutcomes,
  putIncidentOutcome
} from '../src/cos-erp-db/knowledge/outcome-service.js';
import { initIncidentPatternStore, resetIncidentPatternStoreForTests } from '../src/cos-erp-db/knowledge/pattern-store.js';
import { putIncidentPatternOccurrence, searchIncidentPatterns } from '../src/cos-erp-db/knowledge/pattern-service.js';
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
  directory = await makeTempDir('cos-incident-outcome-');
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
});

afterEach(async () => {
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

function outcomeInput(key: string, incidentKey: string, evidence: Awaited<ReturnType<typeof seedScope>>, status: 'draft' | 'accepted' = 'accepted') {
  return {
    key,
    incidentKey,
    title: 'Double net adjustment',
    symptom: 'Final net salary differs after an approved adjustment.',
    processKey: 'process:payroll',
    expectedBehaviorKey: 'expected:net',
    rootCauseCategory: 'calculation-path',
    finding: 'The same approved adjustment was included twice.',
    remediation: 'Remove the duplicate inclusion from the final calculation path.',
    evidence: [evidence],
    validation: {
      result: status === 'accepted' ? 'passed' as const : 'pending' as const,
      summary: status === 'accepted'
        ? 'Recalculation applies the approved adjustment exactly once.'
        : 'Validation has not been completed.',
      evidence: status === 'accepted' ? [evidence] : []
    },
    status,
    decisionNote: status === 'accepted' ? 'Implementation and recalculation were reviewed and accepted.' : null
  };
}

function patternInput(outcomeKey: string) {
  return {
    key: 'pattern:double-net-adjustment',
    title: 'Net salary adjustment counted twice',
    symptom: 'Final net salary differs after an approved adjustment.',
    finding: 'A final calculation path can include the same approved adjustment more than once.',
    recommendedChecks: ['Trace the final net salary calculation path.'],
    occurrence: { outcomeKey }
  };
}

it('does not let an unconfirmed incident outcome contribute shared learning', async () => {
  const evidence = await seedScope('customer-a', 'customer:a');
  await putIncidentOutcome('customer-a', outcomeInput('outcome:a1', 'INC-A-1', evidence, 'draft'));

  await expect(
    putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'))
  ).rejects.toThrow('accepted incident outcome');
});

it('contributes accepted outcomes idempotently and counts distinct customer scopes, not incident count', async () => {
  const evidence = await seedScope('customer-a', 'customer:a');
  await putIncidentOutcome('customer-a', outcomeInput('outcome:a1', 'INC-A-1', evidence));

  const first = await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));
  const duplicate = await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));
  expect(first.pattern.supportingScopeCount).toBe(1);
  expect(duplicate.changed).toBe(false);

  await putIncidentOutcome('customer-a', outcomeInput('outcome:a2', 'INC-A-2', evidence));
  const secondSameScope = await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a2'));
  expect(secondSameScope.pattern.occurrences).toHaveLength(2);
  expect(secondSameScope.pattern.supportingScopeCount).toBe(1);
  expect(secondSameScope.pattern.status).toBe('candidate');
});

it('degrades accepted outcome and shared pattern support when validation evidence becomes stale', async () => {
  const evidenceA = await seedScope('customer-a', 'customer:a');
  const evidenceB = await seedScope('customer-b', 'customer:b');
  await putIncidentOutcome('customer-a', outcomeInput('outcome:a1', 'INC-A-1', evidenceA));
  await putIncidentOutcome('customer-b', outcomeInput('outcome:b1', 'INC-B-1', evidenceB));
  await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));
  await putIncidentPatternOccurrence('customer-b', patternInput('outcome:b1'));

  await fs.writeFile(sourcePath, 'public static class PayrollRule { public const string Rule = "Changed"; }\n', 'utf8');
  await indexKnowledge({ scope: 'customer-b', sources: [{ kind: 'source', path: '/workspace/PayrollRule.cs' }] }, roots);

  const local = await getIncidentOutcomes('customer-b', ['outcome:b1']);
  expect(local.outcomes[0]?.provenance).toMatchObject({ liveStatus: 'stale', current: false });
  expect(local.outcomes[0]?.provenance.staleEvidenceCount).toBeGreaterThan(0);

  const shared = await searchIncidentPatterns('customer-c', 'net salary', 5);
  expect(shared.hits[0]?.provenance).toMatchObject({
    liveStatus: 'degraded',
    currentSupportingScopeCount: 1,
    staleOccurrenceCount: 1
  });
});

it('requires revision proof to change an already accepted outcome', async () => {
  const evidence = await seedScope('customer-a', 'customer:a');
  const accepted = outcomeInput('outcome:a1', 'INC-A-1', evidence);
  const first = await putIncidentOutcome('customer-a', accepted);
  expect(first.outcome.revision).toBe(1);

  await expect(putIncidentOutcome('customer-a', {
    ...accepted,
    remediation: 'A different reviewed remediation.'
  })).rejects.toThrow('expectedRevision');

  const revised = await putIncidentOutcome('customer-a', {
    ...accepted,
    remediation: 'A different reviewed remediation.',
    expectedRevision: 1
  });
  expect(revised.outcome.revision).toBe(2);
});
