import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  engineeringLineageKey,
  engineeringKnowledgeScope,
  type ResolvedEngineeringLineage
} from '../src/cos-erp-db/engineering/lineage.js';
import { prepareEngineeringTask } from '../src/cos-erp-db/engineering/prepare-service.js';
import { engineeringQualityGate } from '../src/cos-erp-db/engineering/quality-gate.js';
import {
  initEngineeringStore,
  readEngineeringScope,
  resetEngineeringStoreForTests
} from '../src/cos-erp-db/engineering/store.js';
import { getEngineeringTasks, putEngineeringTask } from '../src/cos-erp-db/engineering/task-service.js';
import { runEngineeringValidation } from '../src/cos-erp-db/engineering/verification-service.js';
import { knowledgeSha256 } from '../src/cos-erp-db/knowledge/evidence.js';
import { resetKnowledgeSearchCacheForTests, searchKnowledge } from '../src/cos-erp-db/knowledge/service.js';
import { initKnowledgeStore, resetKnowledgeStoreForTests } from '../src/cos-erp-db/knowledge/store.js';
import {
  initBusinessProcessStore,
  readBusinessProcessScope,
  resetBusinessProcessStoreForTests
} from '../src/cos-erp-db/knowledge/process-store.js';
import {
  initIncidentOutcomeStore,
  readIncidentOutcomeScope,
  resetIncidentOutcomeStoreForTests
} from '../src/cos-erp-db/knowledge/outcome-store.js';
import {
  initIncidentPatternStore,
  readIncidentPatternStore,
  resetIncidentPatternStoreForTests
} from '../src/cos-erp-db/knowledge/pattern-store.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let currentProject = '';
let referenceA = '';
let referenceB = '';
let roots: Root[] = [];

function resolved(root: string, virtual: string): ResolvedEngineeringLineage {
  const rootIdentity = knowledgeSha256(root);
  return {
    lineage: {
      key: engineeringLineageKey(rootIdentity, 'generic', 'net8'),
      projectId: null,
      rootIdentity,
      profile: 'generic',
      runtimeFamily: 'net8',
      sourceRevision: null
    },
    workspace: { real: root, virtual }
  };
}

async function writePattern(root: string, prefix: string, pattern: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await fs.writeFile(
      path.join(root, `${prefix}${index}.cs`),
      `class ${prefix}${index} { void ${pattern}() { int X = ${index}; } }`,
      'utf8'
    );
  }
}

function assessments(task: Awaited<ReturnType<typeof prepareEngineeringTask>>['task']) {
  return [...task.analogueEvidence, ...task.referenceAnalogueEvidence].map(ref => ({
    evidenceId: ref.evidenceId,
    contentHash: ref.contentHash,
    classification: 'convention' as const,
    note: 'Reviewed for this task only; no durable promotion.'
  }));
}

beforeEach(async () => {
  directory = await makeTempDir('cos-engineering-solution-review-');
  currentProject = path.join(directory, 'current');
  referenceA = path.join(directory, 'reference-a');
  referenceB = path.join(directory, 'reference-b');
  await fs.mkdir(currentProject, { recursive: true });
  await fs.mkdir(referenceA, { recursive: true });
  await fs.mkdir(referenceB, { recursive: true });
  roots = [
    { name: 'current', path: currentProject },
    { name: 'reference-a', path: referenceA },
    { name: 'reference-b', path: referenceB }
  ];
  const userData = path.join(directory, 'user-data');
  initEngineeringStore(userData);
  initKnowledgeStore(userData);
  initBusinessProcessStore(userData);
  initIncidentOutcomeStore(userData);
  initIncidentPatternStore(userData);
  resetKnowledgeSearchCacheForTests();
});

afterEach(async () => {
  resetEngineeringStoreForTests();
  resetKnowledgeSearchCacheForTests();
  resetKnowledgeStoreForTests();
  resetBusinessProcessStoreForTests();
  resetIncidentOutcomeStoreForTests();
  resetIncidentPatternStoreForTests();
  await removeTempDir(directory);
});

it('uses only an explicit task-scoped reference and keeps its Knowledge isolated', async () => {
  const project = resolved(currentProject, '/current');
  await writePattern(currentProject, 'Local', 'MachineTransferPattern', 1);
  await writePattern(referenceA, 'Reference', 'MachineTransferPattern', 3);
  await fs.writeFile(path.join(referenceA, 'ReferenceOnly.cs'), 'class ReferenceOnly { const string Marker = "REFERENCE_ONLY_MARKER"; }', 'utf8');

  const prepared = await prepareEngineeringTask(project, {
    taskKey: 'mmtb-transfer',
    goal: 'Implement machine transfer for the current customer project.',
    requirements: ['Transfer a machine between departments while preserving the accepted customer process.'],
    analogueQuery: 'MachineTransferPattern',
    analogueLimit: 4,
    authorizedReferences: [{
      path: '/reference-a',
      role: 'implementation_reference',
      scope: ['MMTB', 'machine-transfer'],
      reason: 'The implementation team explicitly directed this task to reference project A.'
    }]
  }, roots);

  expect(prepared.task.authorizedReferences).toHaveLength(1);
  expect(prepared.task.referenceAnalogueEvidence.length).toBeGreaterThan(0);
  expect(prepared.preparedAnalogues).toHaveLength(4);
  expect(prepared.preparedAnalogues.every(item => {
    const candidatePath = String(item.candidate.locator.path);
    return candidatePath.startsWith('/current/') || candidatePath.startsWith('/reference-a/');
  })).toBe(true);
  const leaked = await searchKnowledge({
    scope: engineeringKnowledgeScope(project.lineage),
    query: 'REFERENCE_ONLY_MARKER',
    limit: 10
  });
  expect(leaked.hits).toEqual([]);
});

it('blocks a blind spot until its business/process decision is recorded, then preserves review across implementation validation', async () => {
  const project = resolved(currentProject, '/current');
  await writePattern(currentProject, 'Local', 'MachineTransferPattern', 1);
  await writePattern(referenceA, 'Reference', 'MachineTransferPattern', 3);
  const prepared = await prepareEngineeringTask(project, {
    taskKey: 'mmtb-review',
    goal: 'Implement machine transfer.',
    requirements: ['Transfer machine ownership between departments.'],
    analogueQuery: 'MachineTransferPattern',
    analogueLimit: 4,
    authorizedReferences: [{
      path: '/reference-a',
      role: 'implementation_reference',
      scope: ['MMTB'],
      reason: 'Implementation team supplied this reference for MMTB only.'
    }]
  }, roots);
  const currentEvidence = prepared.task.analogueEvidence.slice(0, 1).map(ref => ({
    ...ref,
    origin: 'current_project' as const,
    referenceRootIdentity: null
  }));
  const referenceEvidence = prepared.task.referenceAnalogueEvidence.slice(0, 1);
  const finding = {
    key: 'confirm-transfer-history',
    title: 'Confirm transfer-history behavior',
    type: 'process_risk' as const,
    statement: 'The supplied requirement does not state whether historical ownership must be retained.',
    impact: 'A later report may be unable to reconstruct who owned the machine at an earlier date.',
    confidence: 'high' as const,
    affectedRequirements: prepared.task.requirements,
    processKeys: [],
    evidence: [...currentEvidence, ...referenceEvidence],
    recommendation: 'Implementation should ask the implementation/customer team to choose whether history is retained.',
    disposition: 'decision_required' as const,
    decision: 'pending' as const,
    decisionNote: ''
  };
  const improvementFinding = {
    key: 'reuse-current-save-path',
    title: 'Reuse the current transfer save path',
    type: 'proposed_improvement' as const,
    statement: 'The current project analogue already provides a localized transfer save path that avoids a parallel persistence mechanism.',
    impact: 'Reusing it keeps the change surface smaller and avoids duplicate persistence semantics.',
    confidence: 'high' as const,
    affectedRequirements: prepared.task.requirements,
    processKeys: [],
    evidence: currentEvidence,
    recommendation: 'Review this reuse choice as a project convention candidate after the implementation is Machine Verified.',
    disposition: 'advisory' as const,
    decision: 'accepted' as const,
    decisionNote: 'Accepted for this implementation only; durable promotion still requires explicit review.'
  };
  const reviewedPending = await putEngineeringTask(project.lineage, {
    key: prepared.task.key,
    analogueAssessments: assessments(prepared.task),
    solutionReviewStatus: 'reviewed',
    solutionReviewSummary: 'Reviewed the requested transfer flow against current and explicitly authorized reference evidence.',
    requirementComparisons: [{
      requirement: prepared.task.requirements[0]!,
      status: 'partial',
      currentEvidence,
      referenceEvidence,
      findingKeys: [finding.key],
      proposedDisposition: 'adapt',
      note: 'The core transfer exists as a pattern, but history behavior requires a business decision.'
    }],
    solutionFindings: [finding, improvementFinding],
    expectedRevision: prepared.task.revision
  });
  const pendingGate = await engineeringQualityGate(project.lineage, reviewedPending.key, roots, project.workspace);
  expect(pendingGate.status).toBe('blocked');
  expect(pendingGate.blockers.join(' ')).toContain('still requires a decision');
  expect(pendingGate.assurance.solutionReviewVerified).toBe(false);

  const decidedFinding = {
    ...finding,
    decision: 'rejected' as const,
    decisionNote: 'Implementation/customer review decided not to add a new history behavior in this task.'
  };
  const decided = await putEngineeringTask(project.lineage, {
    key: prepared.task.key,
    solutionReviewStatus: 'reviewed',
    solutionReviewSummary: reviewedPending.solutionReviewSummary,
    requirementComparisons: reviewedPending.requirementComparisons,
    solutionFindings: [decidedFinding, improvementFinding],
    deliberationStatus: 'decided',
    deliberationQuestion: 'Should this task add historical ownership persistence, or keep the accepted transfer-only behavior?',
    deliberationTriggers: ['business'],
    deliberationSummary: 'Compared retaining transfer history with preserving the current transfer-only behavior after the process-risk review.',
    deliberationAuthority: 'user',
    solutionOptions: [{
      key: 'retain-history',
      title: 'Retain ownership history',
      approach: 'Add historical ownership persistence as part of the transfer implementation.',
      benefits: ['Supports point-in-time ownership reporting.'],
      tradeoffs: ['Adds new persistence and reporting semantics outside the explicit transfer requirement.'],
      risks: ['Introduces a new customer process behavior without an accepted requirement.'],
      evidence: [...currentEvidence, ...referenceEvidence],
      rejectedReason: 'The implementation/customer decision rejected introducing a new history behavior in this task.'
    }, {
      key: 'keep-current-transfer',
      title: 'Keep current transfer semantics',
      approach: 'Implement the requested department ownership transfer without adding a new history behavior.',
      benefits: ['Stays within the explicit task scope and accepted decision.'],
      tradeoffs: ['Historical point-in-time ownership remains unavailable.'],
      risks: ['A future reporting request may require a separate history design.'],
      evidence: [...currentEvidence, ...referenceEvidence],
      rejectedReason: ''
    }],
    selectedOptionKey: 'keep-current-transfer',
    deliberationDecisionNote: 'Implementation/customer review explicitly rejected adding transfer-history behavior in this task, so the current transfer semantics were selected.',
    expectedRevision: reviewedPending.revision
  });
  const decidedGate = await engineeringQualityGate(project.lineage, decided.key, roots, project.workspace);
  expect(decidedGate.blockers.join(' ')).not.toContain('still requires a decision');
  expect(decidedGate.assurance.solutionReviewVerified).toBe(true);

  await fs.writeFile(path.join(currentProject, 'MachineTransfer.cs'), 'class MachineTransfer { void Save() {} }', 'utf8');
  const implementation = await putEngineeringTask(project.lineage, {
    key: prepared.task.key,
    changedFiles: ['MachineTransfer.cs'],
    implementedOptionKey: 'keep-current-transfer',
    implementedFindingKeys: [improvementFinding.key],
    validations: [{ name: 'build', status: 'pending', detail: 'Build the reviewed implementation.' }],
    expectedRevision: decided.revision
  });
  await runEngineeringValidation(project, {
    kind: 'command',
    taskKey: implementation.key,
    name: 'build',
    command: 'dotnet',
    args: ['build']
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: async () => ({
      exitCode: 0,
      stdout: 'Build succeeded.',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 1
    })
  });
  const scope = engineeringKnowledgeScope(project.lineage);
  const engineeringBeforeProposal = await readEngineeringScope(project.lineage);
  const processBeforeProposal = await readBusinessProcessScope(scope);
  const outcomesBeforeProposal = await readIncidentOutcomeScope(scope);
  const patternsBeforeProposal = await readIncidentPatternStore();
  const finalGate = await engineeringQualityGate(project.lineage, implementation.key, roots, project.workspace);
  expect(finalGate.status).toBe('pass');
  expect(finalGate.assurance.solutionReviewVerified).toBe(true);
  expect(finalGate.assurance.deliberationVerified).toBe(true);
  expect(finalGate.assurance.referenceBindingsVerified).toBe(true);
  expect(finalGate.assurance.machineVerified).toBe(true);
  expect(finalGate.learningProposal).toMatchObject({
    eligible: true,
    sourceTaskKey: implementation.key,
    sourceTaskRevision: implementation.revision,
    autoPersisted: false
  });
  expect(finalGate.learningProposal.verificationIds).toHaveLength(1);
  expect(finalGate.learningProposal.candidates).toEqual([
    expect.objectContaining({
      kind: 'convention_review',
      sourceFindingKey: improvementFinding.key,
      requiresExplicitReview: true
    })
  ]);
  const engineeringAfterProposal = await readEngineeringScope(project.lineage);
  const processAfterProposal = await readBusinessProcessScope(scope);
  const outcomesAfterProposal = await readIncidentOutcomeScope(scope);
  const patternsAfterProposal = await readIncidentPatternStore();
  expect(engineeringAfterProposal.conventions).toEqual(engineeringBeforeProposal.conventions);
  expect(engineeringAfterProposal.conventionRevisions).toEqual(engineeringBeforeProposal.conventionRevisions);
  expect(processAfterProposal).toEqual(processBeforeProposal);
  expect(outcomesAfterProposal).toEqual(outcomesBeforeProposal);
  expect(patternsAfterProposal).toEqual(patternsBeforeProposal);
});

it('requires an explicit deliberation classification but allows evidence-based not_required for a single-path task', async () => {
  const project = resolved(currentProject, '/current');
  await writePattern(currentProject, 'Local', 'SinglePathPattern', 3);
  const prepared = await prepareEngineeringTask(project, {
    taskKey: 'single-path',
    goal: 'Apply the established SinglePathPattern without changing its contract.',
    analogueQuery: 'SinglePathPattern'
  }, roots);
  const assessed = await putEngineeringTask(project.lineage, {
    key: prepared.task.key,
    analogueAssessments: assessments(prepared.task),
    expectedRevision: prepared.task.revision
  });

  const pending = await engineeringQualityGate(project.lineage, assessed.key, roots, project.workspace);
  expect(pending.blockers.join(' ')).toContain('Deliberation is still pending');
  expect(pending.assurance.deliberationVerified).toBe(false);

  const classified = await putEngineeringTask(project.lineage, {
    key: assessed.key,
    deliberationStatus: 'not_required',
    deliberationSummary: 'Three current-project analogues expose one established implementation contract and the task explicitly forbids changing it.',
    expectedRevision: assessed.revision
  });
  const classifiedGate = await engineeringQualityGate(project.lineage, classified.key, roots, project.workspace);
  expect(classifiedGate.blockers.join(' ')).not.toContain('Deliberation');
  expect(classifiedGate.assurance.deliberationVerified).toBe(true);
});

it('stales a completed deliberation when its reasoning basis changes', async () => {
  const project = resolved(currentProject, '/current');
  await writePattern(currentProject, 'Local', 'DeliberationDriftPattern', 3);
  const prepared = await prepareEngineeringTask(project, {
    taskKey: 'deliberation-drift',
    goal: 'Implement the established deliberation drift pattern.',
    analogueQuery: 'DeliberationDriftPattern'
  }, roots);
  const classified = await putEngineeringTask(project.lineage, {
    key: prepared.task.key,
    analogueAssessments: assessments(prepared.task),
    deliberationStatus: 'not_required',
    deliberationSummary: 'The current project exposes one established contract for this exact pattern.',
    expectedRevision: prepared.task.revision
  });
  const drifted = await putEngineeringTask(project.lineage, {
    key: classified.key,
    goal: 'Implement the pattern but also introduce a new fallback behavior.',
    expectedRevision: classified.revision
  });

  const gate = await engineeringQualityGate(project.lineage, drifted.key, roots, project.workspace);
  expect(gate.blockers.join(' ')).toContain('Deliberation is stale');
  expect(gate.assurance.deliberationVerified).toBe(false);
});

it('rejects review evidence that claims an unauthorized project identity', async () => {
  const project = resolved(currentProject, '/current');
  await writePattern(currentProject, 'Local', 'ReferenceGuardPattern', 1);
  await writePattern(referenceA, 'Reference', 'ReferenceGuardPattern', 3);
  const prepared = await prepareEngineeringTask(project, {
    taskKey: 'reference-injection',
    goal: 'Implement guarded reference behavior.',
    requirements: ['Use only evidence from the explicitly supplied reference.'],
    analogueQuery: 'ReferenceGuardPattern',
    analogueLimit: 4,
    authorizedReferences: [{
      path: '/reference-a',
      role: 'implementation_reference',
      scope: ['guard-test'],
      reason: 'Explicit test reference.'
    }]
  }, roots);
  const validReference = prepared.task.referenceAnalogueEvidence[0]!;
  const injectedReference = {
    ...validReference,
    referenceRootIdentity: 'f'.repeat(64)
  };
  const reviewed = await putEngineeringTask(project.lineage, {
    key: prepared.task.key,
    analogueAssessments: assessments(prepared.task),
    solutionReviewStatus: 'reviewed',
    solutionReviewSummary: 'Attempted review with a forged reference root.',
    requirementComparisons: [{
      requirement: prepared.task.requirements[0]!,
      status: 'partial',
      currentEvidence: [],
      referenceEvidence: [injectedReference],
      findingKeys: [],
      proposedDisposition: 'adapt',
      note: 'The evidence origin is intentionally forged for the red-team test.'
    }],
    solutionFindings: [],
    expectedRevision: prepared.task.revision
  });
  const gate = await engineeringQualityGate(project.lineage, reviewed.key, roots, project.workspace);
  expect(gate.status).toBe('blocked');
  expect(gate.blockers.join(' ')).toContain('stale, unauthorized or mismatched');
  expect(gate.assurance.referenceBindingsVerified).toBe(false);
});

it('keeps references isolated by task key and fails closed when an authorized reference path disappears', async () => {
  const project = resolved(currentProject, '/current');
  await writePattern(referenceA, 'A', 'TaskAPattern', 3);
  await writePattern(referenceB, 'B', 'TaskBPattern', 3);
  const taskA = await prepareEngineeringTask(project, {
    taskKey: 'task-a',
    goal: 'Implement task A.',
    analogueQuery: 'TaskAPattern',
    authorizedReferences: [{
      path: '/reference-a',
      role: 'implementation_reference',
      scope: ['task-a'],
      reason: 'Reference A is authorized for task A only.'
    }]
  }, roots);
  const taskB = await prepareEngineeringTask(project, {
    taskKey: 'task-b',
    goal: 'Implement task B.',
    analogueQuery: 'TaskBPattern',
    authorizedReferences: [{
      path: '/reference-b',
      role: 'implementation_reference',
      scope: ['task-b'],
      reason: 'Reference B is authorized for task B only.'
    }]
  }, roots);
  expect(taskA.task.authorizedReferences[0]?.rootIdentity)
    .not.toBe(taskB.task.authorizedReferences[0]?.rootIdentity);
  const persisted = await getEngineeringTasks(project.lineage, ['task-a', 'task-b']);
  expect(persisted.find(task => task.key === 'task-a')?.authorizedReferences[0]?.virtualPath).toBe('/reference-a');
  expect(persisted.find(task => task.key === 'task-b')?.authorizedReferences[0]?.virtualPath).toBe('/reference-b');

  const moved = referenceA + '-moved';
  await fs.rename(referenceA, moved);
  const gate = await engineeringQualityGate(project.lineage, taskA.task.key, roots, project.workspace);
  expect(gate.status).toBe('blocked');
  expect(gate.blockers.join(' ')).toContain('Authorized reference is stale or unavailable');
  expect(gate.assurance.referenceBindingsVerified).toBe(false);
});

it('invalidates a reviewed solution when the requirement basis changes without a fresh review', async () => {
  const project = resolved(currentProject, '/current');
  await writePattern(currentProject, 'Local', 'RequirementDriftPattern', 3);
  const prepared = await prepareEngineeringTask(project, {
    taskKey: 'requirement-drift',
    goal: 'Implement the reviewed requirement.',
    requirements: ['Original approved behavior.'],
    analogueQuery: 'RequirementDriftPattern'
  }, roots);
  const reviewed = await putEngineeringTask(project.lineage, {
    key: prepared.task.key,
    analogueAssessments: assessments(prepared.task),
    solutionReviewStatus: 'reviewed',
    solutionReviewSummary: 'Reviewed the original behavior against current project evidence.',
    requirementComparisons: [{
      requirement: prepared.task.requirements[0]!,
      status: 'existing',
      currentEvidence: prepared.task.analogueEvidence.slice(0, 1).map(ref => ({
        ...ref,
        origin: 'current_project' as const,
        referenceRootIdentity: null
      })),
      referenceEvidence: [],
      findingKeys: [],
      proposedDisposition: 'keep',
      note: 'The original behavior is already represented by the current project pattern.'
    }],
    solutionFindings: [],
    expectedRevision: prepared.task.revision
  });
  expect(reviewed.solutionReviewBasisHash).not.toBeNull();

  const drifted = await putEngineeringTask(project.lineage, {
    key: reviewed.key,
    requirements: ['Changed behavior from a later solution-document revision.'],
    expectedRevision: reviewed.revision
  });
  const gate = await engineeringQualityGate(project.lineage, drifted.key, roots, project.workspace);
  expect(gate.status).toBe('blocked');
  expect(gate.blockers.join(' ')).toContain('Solution review is stale');
  expect(gate.assurance.solutionReviewVerified).toBe(false);
});
