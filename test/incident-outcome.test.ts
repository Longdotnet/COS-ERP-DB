import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ResolvedEngineeringLineage } from '../src/cos-erp-db/engineering/lineage.js';
import { initEngineeringStore, resetEngineeringStoreForTests } from '../src/cos-erp-db/engineering/store.js';
import { initIncidentOutcomeStore, resetIncidentOutcomeStoreForTests } from '../src/cos-erp-db/knowledge/outcome-store.js';
import {
  getIncidentOutcomes,
  putIncidentOutcome
} from '../src/cos-erp-db/knowledge/outcome-service.js';
import { initIncidentPatternStore, resetIncidentPatternStoreForTests } from '../src/cos-erp-db/knowledge/pattern-store.js';
import { putIncidentPatternOccurrence, searchIncidentPatterns } from '../src/cos-erp-db/knowledge/pattern-service.js';
import { initBusinessProcessStore, resetBusinessProcessStoreForTests } from '../src/cos-erp-db/knowledge/process-store.js';
import { putBusinessProcessRecord } from '../src/cos-erp-db/knowledge/process-service.js';
import { knowledgeSha256 } from '../src/cos-erp-db/knowledge/evidence.js';
import { indexKnowledge, resetKnowledgeSearchCacheForTests, searchKnowledge } from '../src/cos-erp-db/knowledge/service.js';
import { initKnowledgeStore, resetKnowledgeStoreForTests } from '../src/cos-erp-db/knowledge/store.js';
import { initIncidentTechnicalEvidenceStore, resetIncidentTechnicalEvidenceStoreForTests } from '../src/cos-erp-db/knowledge/technical-evidence-store.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { issueIncidentTestReceipt } from './incident-machine-fixture.js';

let directory = '';
let roots: Root[] = [];
const projects = new Map<string, {
  workspace: string;
  sourcePath: string;
  root: Root;
  resolved: ResolvedEngineeringLineage;
}>();

beforeEach(async () => {
  directory = await makeTempDir('cos-incident-outcome-');
  roots = [];
  projects.clear();
  const userData = path.join(directory, 'user-data');
  initEngineeringStore(userData);
  initKnowledgeStore(userData);
  initBusinessProcessStore(userData);
  initIncidentOutcomeStore(userData);
  initIncidentPatternStore(userData);
  initIncidentTechnicalEvidenceStore(userData);
  resetKnowledgeSearchCacheForTests();
});

afterEach(async () => {
  resetEngineeringStoreForTests();
  resetKnowledgeSearchCacheForTests();
  resetIncidentPatternStoreForTests();
  resetIncidentOutcomeStoreForTests();
  resetIncidentTechnicalEvidenceStoreForTests();
  resetKnowledgeStoreForTests();
  resetBusinessProcessStoreForTests();
  await removeTempDir(directory);
});

async function projectForScope(scope: string, implementation?: string) {
  const existing = projects.get(scope);
  if (existing) return existing;
  const rootName = 'workspace-' + scope.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const workspace = path.join(directory, rootName);
  const sourcePath = path.join(workspace, 'PayrollRule.cs');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(sourcePath, [
    'public static class PayrollRule {',
    '  public const string Rule = "NetSalaryAdjustment";',
    ...(implementation ? ['  public const string Implementation = "' + implementation + '";'] : []),
    '}'
  ].join('\n'), 'utf8');
  const root: Root = { name: rootName, path: workspace };
  const rootIdentity = knowledgeSha256(workspace);
  const resolved: ResolvedEngineeringLineage = {
    lineage: {
      key: knowledgeSha256('incident-outcome-lineage\0' + rootIdentity),
      projectId: null,
      rootIdentity,
      profile: 'generic',
      runtimeFamily: 'net10',
      sourceRevision: null
    },
    workspace: { virtual: '/' + rootName, real: workspace }
  };
  const project = { workspace, sourcePath, root, resolved };
  projects.set(scope, project);
  roots.push(root);
  return project;
}

async function seedScope(scope: string, customerKey: string, implementation?: string) {
  const project = await projectForScope(scope, implementation);
  await indexKnowledge({
    scope,
    sources: [{ kind: 'source', path: project.resolved.workspace.virtual + '/PayrollRule.cs' }]
  }, [project.root]);
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

async function putMachineBackedOutcome(
  scope: string,
  key: string,
  incidentKey: string,
  evidence: Awaited<ReturnType<typeof seedScope>>
) {
  const project = await projectForScope(scope);
  const accepted = outcomeInput(key, incidentKey, evidence);
  const draft = await putIncidentOutcome(scope, {
    ...accepted,
    incidentClass: 'logic_correctness' as const,
    status: 'draft' as const,
    validation: { ...accepted.validation, result: 'pending' as const }
  });
  const receipt = await issueIncidentTestReceipt(project.resolved, [project.root], {
    scope,
    outcomeKey: key,
    taskKey: `verify:${key}`,
    changedFile: 'PayrollRule.cs'
  });
  return putIncidentOutcome(scope, {
    ...accepted,
    incidentClass: 'logic_correctness' as const,
    technicalEvidence: [receipt.ref],
    expectedRevision: draft.outcome.revision
  });
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
  await putMachineBackedOutcome('customer-a', 'outcome:a1', 'INC-A-1', evidence);

  const first = await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));
  const duplicate = await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));
  expect(first.pattern.supportingScopeCount).toBe(1);
  expect(duplicate.changed).toBe(false);

  await putMachineBackedOutcome('customer-a', 'outcome:a2', 'INC-A-2', evidence);
  const secondSameScope = await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a2'));
  expect(secondSameScope.pattern.occurrences).toHaveLength(2);
  expect(secondSameScope.pattern.supportingScopeCount).toBe(1);
  expect(secondSameScope.pattern.status).toBe('candidate');
});

it('degrades accepted outcome and shared pattern support when validation evidence becomes stale', async () => {
  const evidenceA = await seedScope('customer-a', 'customer:a');
  const evidenceB = await seedScope('customer-b', 'customer:b', 'CustomerBIndependent');
  await putMachineBackedOutcome('customer-a', 'outcome:a1', 'INC-A-1', evidenceA);
  await putMachineBackedOutcome('customer-b', 'outcome:b1', 'INC-B-1', evidenceB);
  await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));
  await putIncidentPatternOccurrence('customer-b', patternInput('outcome:b1'));

  const customerB = await projectForScope('customer-b');
  await fs.writeFile(customerB.sourcePath, 'public static class PayrollRule { public const string Rule = "Changed"; }\n', 'utf8');
  await indexKnowledge({
    scope: 'customer-b',
    sources: [{ kind: 'source', path: customerB.resolved.workspace.virtual + '/PayrollRule.cs' }]
  }, [customerB.root]);

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
