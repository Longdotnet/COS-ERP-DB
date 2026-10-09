import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ResolvedEngineeringLineage } from '../src/cos-erp-db/engineering/lineage.js';
import { initEngineeringStore, resetEngineeringStoreForTests } from '../src/cos-erp-db/engineering/store.js';
import { resetImplementationGraphCacheForTests } from '../src/cos-erp-db/knowledge/graph-service.js';
import { readIncidentContext } from '../src/cos-erp-db/knowledge/incident-context.js';
import { initIncidentOutcomeStore, resetIncidentOutcomeStoreForTests } from '../src/cos-erp-db/knowledge/outcome-store.js';
import { putIncidentOutcome } from '../src/cos-erp-db/knowledge/outcome-service.js';
import {
  initIncidentPatternStore,
  mutateIncidentPatternStore,
  resetIncidentPatternStoreForTests
} from '../src/cos-erp-db/knowledge/pattern-store.js';
import {
  getIncidentPatternHistory,
  putIncidentPatternOccurrence,
  searchIncidentPatterns
} from '../src/cos-erp-db/knowledge/pattern-service.js';
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
  directory = await makeTempDir('cos-incident-pattern-');
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
  resetImplementationGraphCacheForTests();
});

afterEach(async () => {
  resetEngineeringStoreForTests();
  resetImplementationGraphCacheForTests();
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
  const rootName = `workspace-${scope.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
  const workspace = path.join(directory, rootName);
  const sourcePath = path.join(workspace, 'PayrollRule.cs');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(sourcePath, [
    'public static class PayrollRule {',
    '  public const string Rule = "NetSalaryAdjustment";',
    ...(implementation ? [`  public const string Implementation = "${implementation}";`] : []),
    '}'
  ].join('\n'), 'utf8');
  const root: Root = { name: rootName, path: workspace };
  const rootIdentity = knowledgeSha256(workspace);
  const resolved: ResolvedEngineeringLineage = {
    lineage: {
      key: knowledgeSha256(`incident-pattern-lineage\0${rootIdentity}`),
      projectId: null,
      rootIdentity,
      profile: 'generic',
      runtimeFamily: 'net10',
      sourceRevision: null
    },
    workspace: { virtual: `/${rootName}`, real: workspace }
  };
  const project = { workspace, sourcePath, root, resolved };
  projects.set(scope, project);
  roots.push(root);
  return project;
}

async function seedScope(scope: string, customerKey: string, implementation?: string) {
  const project = await projectForScope(scope, implementation);
  const sourceVirtual = `${project.resolved.workspace.virtual}/PayrollRule.cs`;
  await indexKnowledge({ scope, sources: [{ kind: 'source', path: sourceVirtual }] }, [project.root]);
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

async function seedAcceptedOutcome(
  scope: string,
  customerKey: string,
  outcomeKey: string,
  incidentKey: string,
  implementation?: string
) {
  const evidence = await seedScope(scope, customerKey, implementation);
  const project = await projectForScope(scope, implementation);
  const base = {
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
      result: 'pending' as const,
      summary: 'Recalculation applies the approved adjustment exactly once.',
      evidence: [evidence]
    },
    incidentClass: 'logic_correctness' as const,
    status: 'draft' as const,
    decisionNote: 'Implementation and recalculation were reviewed and accepted.'
  };
  const draft = await putIncidentOutcome(scope, base);
  const receipt = await issueIncidentTestReceipt(project.resolved, [project.root], {
    scope,
    outcomeKey,
    taskKey: `verify:${outcomeKey}`,
    changedFile: 'PayrollRule.cs'
  });
  await putIncidentOutcome(scope, {
    ...base,
    status: 'accepted' as const,
    validation: { ...base.validation, result: 'passed' as const },
    technicalEvidence: [receipt.ref],
    expectedRevision: draft.outcome.revision
  });
  return evidence;
}

async function seedIndependentAcceptedOutcome(scope: string, customerKey: string, outcomeKey: string, incidentKey: string, implementation: string) {
  return seedAcceptedOutcome(scope, customerKey, outcomeKey, incidentKey, implementation);
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
  await seedIndependentAcceptedOutcome('customer-b', 'customer:b', 'outcome:b1', 'INC-B-1', 'CustomerBIndependent');

  const first = await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));
  expect(first.pattern.status).toBe('candidate');
  expect(first.pattern.supportingScopeCount).toBe(1);

  const second = await putIncidentPatternOccurrence('customer-b', patternInput('outcome:b1'));
  expect(second.pattern.status).toBe('promoted');
  expect(second.pattern.supportingScopeCount).toBe(2);
  expect(second.pattern.independentSupportingCount).toBe(2);
  expect(second.pattern.revision).toBe(2);

  const search = await searchIncidentPatterns('customer-c', 'net salary', 5);
  expect(search.hits).toHaveLength(1);
  expect(search.hits[0]?.provenance).toMatchObject({
    liveStatus: 'promoted',
    currentSupportingScopeCount: 2,
    currentIndependentSupportingCount: 2,
    otherSupportingScopeCount: 2,
    staleOccurrenceCount: 0
  });

  const history = await getIncidentPatternHistory('pattern:double-net-adjustment');
  expect(history.revisions.map(item => item.revision)).toEqual([1, 2]);
});

it('recomputes stronger independence for legacy stored occurrences without requiring a migration write', async () => {
  await seedAcceptedOutcome('customer-a', 'customer:a', 'outcome:a1', 'INC-A-1');
  await seedIndependentAcceptedOutcome('customer-b', 'customer:b', 'outcome:b1', 'INC-B-1', 'CustomerBIndependent');
  await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));
  await putIncidentPatternOccurrence('customer-b', patternInput('outcome:b1'));
  await mutateIncidentPatternStore(current => ({
    ...current,
    patterns: current.patterns.map(pattern => ({
      ...pattern,
      rootCauseCategory: null,
      rootCauseSignature: null,
      independentSupportingCount: 0,
      occurrences: pattern.occurrences.map(occurrence => ({
        ...occurrence,
        rootCauseCategory: null,
        rootCauseSignature: null,
        independenceFingerprint: null
      }))
    }))
  }));

  const search = await searchIncidentPatterns('customer-c', 'net salary', 5);
  expect(search.hits[0]?.provenance).toMatchObject({
    liveStatus: 'promoted',
    currentSupportingScopeCount: 2,
    currentIndependentSupportingCount: 2,
    staleOccurrenceCount: 0
  });
});

it('degrades promoted learning when one source scope no longer supports its recorded evidence', async () => {
  await seedAcceptedOutcome('customer-a', 'customer:a', 'outcome:a1', 'INC-A-1');
  await seedIndependentAcceptedOutcome('customer-b', 'customer:b', 'outcome:b1', 'INC-B-1', 'CustomerBIndependent');
  await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));
  await putIncidentPatternOccurrence('customer-b', patternInput('outcome:b1'));

  const customerB = await projectForScope('customer-b');
  await fs.writeFile(customerB.sourcePath, 'public static class PayrollRule { public const string Rule = "Changed"; }\n', 'utf8');
  await indexKnowledge({
    scope: 'customer-b',
    sources: [{ kind: 'source', path: `${customerB.resolved.workspace.virtual}/PayrollRule.cs` }]
  }, [customerB.root]);

  const search = await searchIncidentPatterns('customer-c', 'net salary', 5);
  expect(search.hits[0]?.provenance).toMatchObject({
    liveStatus: 'degraded',
    currentSupportingScopeCount: 1,
    staleOccurrenceCount: 1
  });
});

it('offers promoted cross-customer learning as a hint without importing foreign process facts into local context', async () => {
  await seedAcceptedOutcome('customer-a', 'customer:a', 'outcome:a1', 'INC-A-1');
  await seedIndependentAcceptedOutcome('customer-b', 'customer:b', 'outcome:b1', 'INC-B-1', 'CustomerBIndependent');
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
  await seedIndependentAcceptedOutcome('customer-b', 'customer:b', 'outcome:b1', 'INC-B-1', 'CustomerBIndependent');
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

it('does not promote two customer scopes that share the same implementation-evidence fingerprint', async () => {
  await seedAcceptedOutcome('customer-a', 'customer:a', 'outcome:a1', 'INC-A-1');
  await seedAcceptedOutcome('customer-b', 'customer:b', 'outcome:b1', 'INC-B-1');

  await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a1'));
  const second = await putIncidentPatternOccurrence('customer-b', patternInput('outcome:b1'));

  expect(second.pattern.supportingScopeCount).toBe(2);
  expect(second.pattern.independentSupportingCount).toBe(1);
  expect(second.pattern.status).toBe('candidate');
  const search = await searchIncidentPatterns('customer-c', 'net salary', 5);
  expect(search.hits[0]?.provenance).toMatchObject({
    liveStatus: 'candidate',
    currentSupportingScopeCount: 2,
    currentIndependentSupportingCount: 1
  });
});

it('does not let a stored non-null v1 fingerprint create false independence beside a new v2 clone', async () => {
  await seedAcceptedOutcome('customer-a', 'customer:a', 'outcome:a-mixed', 'INC-A-MIXED');
  const first = await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a-mixed'));
  expect(first.pattern.status).toBe('candidate');
  await mutateIncidentPatternStore(current => ({
    ...current,
    patterns: current.patterns.map(pattern => pattern.key === first.pattern.key ? {
      ...pattern,
      occurrences: pattern.occurrences.map(occurrence => ({
        ...occurrence,
        independenceFingerprint: knowledgeSha256('legacy-v1-source-hash-fingerprint')
      }))
    } : pattern)
  }));

  await seedAcceptedOutcome('customer-b', 'customer:b', 'outcome:b-mixed', 'INC-B-MIXED');
  const second = await putIncidentPatternOccurrence('customer-b', patternInput('outcome:b-mixed'));

  expect(second.pattern.supportingScopeCount).toBe(2);
  expect(second.pattern.independentSupportingCount).toBe(1);
  expect(second.pattern.status).toBe('candidate');
  const search = await searchIncidentPatterns('customer-c', 'net salary', 5);
  expect(search.hits[0]?.provenance).toMatchObject({
    liveStatus: 'candidate',
    currentSupportingScopeCount: 2,
    currentIndependentSupportingCount: 1
  });
});

it('does not mistake distinct validation evidence for independent root-cause lineage', async () => {
  const rootCauseA = await seedScope('customer-a', 'customer:a');
  const rootCauseB = await seedScope('customer-b', 'customer:b');
  const projectA = await projectForScope('customer-a');
  const projectB = await projectForScope('customer-b');
  await fs.writeFile(path.join(projectA.workspace, 'Validation.txt'), 'customer A validation receipt', 'utf8');
  await fs.writeFile(path.join(projectB.workspace, 'Validation.txt'), 'customer B validation receipt', 'utf8');
  await indexKnowledge({
    scope: 'customer-a',
    sources: [{ kind: 'source', path: `${projectA.resolved.workspace.virtual}/Validation.txt` }]
  }, [projectA.root]);
  await indexKnowledge({
    scope: 'customer-b',
    sources: [{ kind: 'source', path: `${projectB.resolved.workspace.virtual}/Validation.txt` }]
  }, [projectB.root]);
  const validationAHit = (await searchKnowledge({ scope: 'customer-a', query: 'validation receipt', limit: 1 })).hits[0]!;
  const validationBHit = (await searchKnowledge({ scope: 'customer-b', query: 'validation receipt', limit: 1 })).hits[0]!;
  const validationA = { evidenceId: validationAHit.evidenceId, contentHash: validationAHit.contentHash, relation: 'supports' as const };
  const validationB = { evidenceId: validationBHit.evidenceId, contentHash: validationBHit.contentHash, relation: 'supports' as const };

  const putOutcome = async (
    scope: string,
    outcomeKey: string,
    incidentKey: string,
    rootCauseEvidence: typeof rootCauseA,
    validationEvidence: typeof validationA
  ) => {
    const base = {
      key: outcomeKey,
      incidentKey,
      title: 'Confirmed double net adjustment',
      symptom: 'Final net salary differs after an approved adjustment.',
      processKey: 'process:payroll',
      expectedBehaviorKey: 'expected:net',
      rootCauseCategory: 'calculation-path',
      finding: 'The same approved adjustment was included twice.',
      remediation: 'Remove the duplicate inclusion from the final calculation path.',
      evidence: [rootCauseEvidence],
      validation: {
        result: 'pending' as const,
        summary: 'Recalculation applies the approved adjustment exactly once.',
        evidence: [validationEvidence]
      },
      incidentClass: 'logic_correctness' as const,
      status: 'draft' as const,
      decisionNote: 'Implementation and recalculation were reviewed.'
    };
    const draft = await putIncidentOutcome(scope, base);
    const project = await projectForScope(scope);
    const receipt = await issueIncidentTestReceipt(project.resolved, [project.root], {
      scope,
      outcomeKey,
      taskKey: `verify:${outcomeKey}`,
      changedFile: 'PayrollRule.cs'
    });
    await putIncidentOutcome(scope, {
      ...base,
      status: 'accepted' as const,
      validation: { ...base.validation, result: 'passed' as const },
      technicalEvidence: [receipt.ref],
      expectedRevision: draft.outcome.revision
    });
  };

  await putOutcome('customer-a', 'outcome:a-validation', 'INC-A-V', rootCauseA, validationA);
  await putOutcome('customer-b', 'outcome:b-validation', 'INC-B-V', rootCauseB, validationB);
  await putIncidentPatternOccurrence('customer-a', patternInput('outcome:a-validation'));
  const second = await putIncidentPatternOccurrence('customer-b', patternInput('outcome:b-validation'));

  expect(second.pattern.supportingScopeCount).toBe(2);
  expect(second.pattern.independentSupportingCount).toBe(1);
  expect(second.pattern.status).toBe('candidate');
});
