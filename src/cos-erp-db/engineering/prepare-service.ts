import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Root } from '../../shared/types.js';
import { isContained, resolvePath } from '../../main/sandbox.js';
import { indexKnowledge, searchKnowledge } from '../knowledge/service.js';
import { KNOWLEDGE_DOCUMENT_EXTENSIONS } from '../knowledge/document-text.js';
import { searchIncidentOutcomes } from '../knowledge/outcome-service.js';
import { searchIncidentPatterns } from '../knowledge/pattern-service.js';
import { searchBusinessProcessRecords } from '../knowledge/process-service.js';
import { discoverEngineeringAnalogues, discoverEngineeringAnaloguesInScope } from './discovery.js';
import { searchEngineeringConventions } from './convention-service.js';
import { engineeringKnowledgeScope, type ResolvedEngineeringLineage } from './lineage.js';
import { engineeringProfile } from './profiles/index.js';
import {
  engineeringReferenceKnowledgeScope,
  resolveEngineeringAuthorizedReferences
} from './reference-service.js';
import { putEngineeringTask } from './task-service.js';
import { measureEngineeringPhase } from './performance.js';

const authorizedReferenceRequestSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  role: z.literal('implementation_reference').default('implementation_reference'),
  scope: z.array(z.string().trim().min(1).max(160)).min(1).max(32),
  reason: z.string().trim().min(1).max(2_000)
}).strict();

export const engineeringPrepareInputSchema = z.object({
  taskKey: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(12_000),
  requirements: z.array(z.string().trim().min(1).max(2_000)).max(200).default([]),
  attachmentPaths: z.array(z.string().trim().min(1).max(4096)).max(16).default([]),
  authorizedReferences: z.array(authorizedReferenceRequestSchema).max(4).default([]),
  analogueQuery: z.string().trim().min(1).max(1000).optional(),
  analogueLimit: z.number().int().min(3).max(7).default(7),
  contextLimit: z.number().int().min(1).max(20).default(8),
  expectedRevision: z.number().int().positive().optional()
}).strict();

export type EngineeringPrepareInput = z.infer<typeof engineeringPrepareInputSchema>;

function queryFor(input: EngineeringPrepareInput): string {
  const query = input.analogueQuery?.trim()
    || [input.goal, ...input.requirements].filter(Boolean).join(' ');
  return query.slice(0, 1000);
}

function supportedDocument(pathname: string): boolean {
  return KNOWLEDGE_DOCUMENT_EXTENSIONS.has(path.extname(pathname).toLocaleLowerCase('en-US'));
}

function selectedPreparedAnalogues(
  current: Awaited<ReturnType<typeof discoverEngineeringAnalogues>>,
  references: Array<{
    reference: Awaited<ReturnType<typeof resolveEngineeringAuthorizedReferences>>[number];
    discovery: Awaited<ReturnType<typeof discoverEngineeringAnaloguesInScope>>;
  }>,
  limit: number
) {
  const selected: Array<{
    origin: 'current_project' | 'authorized_reference';
    referenceRootIdentity: string | null;
    candidate: (typeof current.candidates)[number];
  }> = [];
  const seenSourceHashes = new Set<string>();
  const add = (
    origin: 'current_project' | 'authorized_reference',
    referenceRootIdentity: string | null,
    candidate: (typeof current.candidates)[number] | undefined
  ) => {
    if (!candidate || selected.length >= limit || seenSourceHashes.has(candidate.sourceHash)) return;
    seenSourceHashes.add(candidate.sourceHash);
    selected.push({ origin, referenceRootIdentity, candidate });
  };

  if (!references.length) {
    for (const candidate of current.candidates) add('current_project', null, candidate);
    return selected;
  }

  add('current_project', null, current.candidates[0]);
  for (const item of references) add('authorized_reference', item.reference.rootIdentity, item.discovery.candidates[0]);
  const remainder = [
    ...current.candidates.slice(1).map(candidate => ({
      origin: 'current_project' as const,
      referenceRootIdentity: null,
      candidate
    })),
    ...references.flatMap(item => item.discovery.candidates.slice(1).map(candidate => ({
      origin: 'authorized_reference' as const,
      referenceRootIdentity: item.reference.rootIdentity,
      candidate
    })))
  ].sort((left, right) => right.candidate.score - left.candidate.score);
  for (const item of remainder) add(item.origin, item.referenceRootIdentity, item.candidate);
  return selected;
}

async function projectLocalAttachmentPaths(
  resolved: ResolvedEngineeringLineage,
  requestedPaths: readonly string[],
  roots: readonly Root[]
): Promise<string[]> {
  const paths: string[] = [];
  for (const requested of requestedPaths) {
    const file = await resolvePath(roots, requested);
    if (!isContained(resolved.workspace.real, file.real)) {
      throw new Error(`ENGINEERING_ATTACHMENT_OUTSIDE_PROJECT: ${requested}`);
    }
    const stat = await fs.stat(file.real);
    if (!stat.isFile()) throw new Error(`ENGINEERING_ATTACHMENT_NOT_FILE: ${requested}`);
    paths.push(file.virtual);
  }
  return paths;
}

export async function prepareEngineeringTask(
  resolved: ResolvedEngineeringLineage,
  rawInput: unknown,
  roots: readonly Root[]
) {
  const input = engineeringPrepareInputSchema.parse(rawInput);
  const scope = engineeringKnowledgeScope(resolved.lineage);
  const query = queryFor(input);
  const limitations: string[] = [];
  const authorizedReferences = await resolveEngineeringAuthorizedReferences(
    resolved,
    input.authorizedReferences,
    roots
  );
  const attachmentPaths = await projectLocalAttachmentPaths(resolved, input.attachmentPaths, roots);
  const documentPaths = attachmentPaths.filter(supportedDocument);
  const skippedAttachments = attachmentPaths.filter(item => !supportedDocument(item));
  const attachmentQuestions: string[] = [];
  if (skippedAttachments.length) {
    limitations.push(
      `Non-document attachments were not indexed (${skippedAttachments.join(', ')}). ` +
      'For screenshots/images, the agent must inspect the image and pass the extracted requirement as task requirements; image content is task input, not an automatically accepted durable standard.'
    );
  }
  if (documentPaths.length) {
    const indexed = await measureEngineeringPhase('prepare.document_index', () => indexKnowledge({
      scope,
      sources: documentPaths.map(documentPath => ({ kind: 'document' as const, path: documentPath })),
      mode: 'incremental'
    }, roots, { reuseUnchangedFiles: true }));
    limitations.push(...indexed.limitations);
    for (const source of indexed.sources.filter(source => source.kind === 'document' && source.evidenceCount === 0)) {
      const sourcePath = source.sourceKey.startsWith('document:') ? source.sourceKey.slice('document:'.length) : source.sourceKey;
      attachmentQuestions.push(
        `Attachment ${sourcePath} produced no extractable text; inspect the attachment directly and add its requirements before implementation.`
      );
    }
  }

  const [analogues, referenceAnalogues] = await Promise.all([
    measureEngineeringPhase('prepare.current_discovery', () =>
      discoverEngineeringAnalogues(resolved, query, roots, input.analogueLimit)),
    Promise.all(authorizedReferences.map(async reference => ({
      reference,
      discovery: await measureEngineeringPhase('prepare.reference_discovery', () => discoverEngineeringAnaloguesInScope(
        resolved,
        reference.virtualPath,
        engineeringReferenceKnowledgeScope(reference.rootIdentity),
        query,
        roots,
        input.analogueLimit,
        'older reference binding'
      ))
    })))
  ]);
  limitations.push(...analogues.limitations);
  for (const item of referenceAnalogues) limitations.push(...item.discovery.limitations);
  const preparedAnalogues = selectedPreparedAnalogues(analogues, referenceAnalogues, input.analogueLimit);
  const [documentContext, processContext, conventionCandidates, priorOutcomeState, patternState] = await measureEngineeringPhase('prepare.context_queries', () => Promise.all([
    searchKnowledge({ scope, query, kinds: ['document'], limit: input.contextLimit }),
    searchBusinessProcessRecords(scope, query, input.contextLimit),
    searchEngineeringConventions(resolved.lineage, query, input.contextLimit),
    searchIncidentOutcomes(scope, query, Math.min(4, input.contextLimit))
      .then(value => ({ value, error: null as string | null }))
      .catch(error => ({ value: null, error: error instanceof Error ? error.message : String(error) })),
    searchIncidentPatterns(scope, query, Math.min(4, input.contextLimit))
      .then(value => ({ value, error: null as string | null }))
      .catch(error => ({ value: null, error: error instanceof Error ? error.message : String(error) }))
  ]));
  if (priorOutcomeState.error) limitations.push('Prior incident outcomes unavailable: ' + priorOutcomeState.error);
  if (patternState.error) limitations.push('Cross-customer incident patterns unavailable: ' + patternState.error);

  const documentEvidence = documentContext.hits.map(hit => ({
    evidenceId: hit.evidenceId,
    contentHash: hit.contentHash,
    relation: 'context' as const
  }));
  const analogueEvidence = preparedAnalogues
    .filter(item => item.origin === 'current_project')
    .map(item => ({
      evidenceId: item.candidate.evidenceId,
      contentHash: item.candidate.contentHash,
      relation: 'context' as const
    }));
  const referenceAnalogueEvidence = preparedAnalogues
    .filter(item => item.origin === 'authorized_reference')
    .map(item => ({
      evidenceId: item.candidate.evidenceId,
      contentHash: item.candidate.contentHash,
      relation: 'context' as const,
      origin: 'authorized_reference' as const,
      referenceRootIdentity: item.referenceRootIdentity
    }));
  const insufficientAnalogueQuestion = preparedAnalogues.length >= 3
    ? []
    : [`Only ${preparedAnalogues.length} independent authorized implementation analogue(s) were found; resolve the project-native pattern before coding.`];
  const requirementComparisons = input.requirements.map(requirement => ({
    requirement,
    status: 'investigate' as const,
    currentEvidence: [],
    referenceEvidence: [],
    findingKeys: [],
    proposedDisposition: 'investigate' as const,
    note: ''
  }));
  const task = await putEngineeringTask(resolved.lineage, {
    key: input.taskKey,
    goal: input.goal,
    requirements: input.requirements,
    evidence: documentEvidence,
    analogueEvidence,
    referenceAnalogueEvidence,
    analogueAssessments: [],
    solutionReviewStatus: input.requirements.length ? 'pending' : 'not_required',
    solutionReviewSummary: '',
    requirementComparisons,
    solutionFindings: [],
    implementedFindingKeys: [],
    deliberationStatus: 'pending',
    deliberationQuestion: '',
    deliberationTriggers: [],
    deliberationSummary: '',
    deliberationAuthority: 'agent',
    solutionOptions: [],
    selectedOptionKey: null,
    deliberationDecisionNote: '',
    implementedOptionKey: null,
    openQuestions: [...insufficientAnalogueQuestion, ...attachmentQuestions],
    expectedRevision: input.expectedRevision
  }, {
    prepared: true,
    authorizedReferences,
    solutionReviewRequired: input.requirements.length > 0
  });

  return {
    lineage: resolved.lineage,
    profile: engineeringProfile(resolved.lineage.profile),
    knowledgeScope: scope,
    requirementPolicy: {
      durablePromotion: false,
      statement: 'New screenshots/documents/text remain task requirements/context until explicitly reviewed and accepted as a business-process record or Engineering convention.'
    },
    classificationPolicy: {
      categories: ['convention', 'business_rule', 'legacy_debt', 'engineering_improvement'] as const,
      statement: 'Analogue repetition is evidence, not a standard. The engineering agent must classify relevant findings before copying them and persist only reviewed/accepted durable records.'
    },
    solutionReviewPolicy: {
      required: input.requirements.length > 0,
      statement: 'Before coding explicit requirements, challenge the solution against accepted process/expected behavior, current project evidence, authorized references and prior incident learning. Keep requested behavior separate from required-by-evidence findings and proposed improvements; unresolved business/process choices require a recorded decision before completion.'
    },
    deliberationPolicy: {
      status: 'pending' as const,
      optionCount: { minimum: 2, maximum: 3 },
      statement: 'Before implementation, explicitly classify deliberation. Use not_required with a concrete evidence-based rationale when there is only one meaningful implementation path. Otherwise compare 2-3 concrete options with trade-offs/risks/evidence, select one, and record why. Technical choices supported by project evidence are agent-resolvable; business behavior, scope, destructive/external action, or unresolved requirement authority must be recorded as a user-authority decision.'
    },
    referencePolicy: {
      autoDiscovery: false,
      statement: 'Cross-project evidence is allowed only from explicit task-scoped authorizedReferences. Profile similarity or repository naming never grants reference authority.'
    },
    executionCapsule: {
      taskKey: task.key,
      taskRevision: task.revision,
      knowledgeGeneration: task.knowledgeGeneration,
      query,
      analogues: preparedAnalogues.map(item => ({
        origin: item.origin,
        referenceRootIdentity: item.referenceRootIdentity,
        evidenceId: item.candidate.evidenceId,
        contentHash: item.candidate.contentHash,
        sourceHash: item.candidate.sourceHash,
        title: item.candidate.title,
        locator: item.candidate.locator,
        snippet: item.candidate.snippet
      })),
      documentContext: documentContext.hits.slice(0, input.contextLimit).map(hit => ({
        evidenceId: hit.evidenceId,
        contentHash: hit.contentHash,
        title: hit.title,
        locator: hit.locator,
        snippet: hit.snippet
      })),
      processKeys: processContext.hits.slice(0, input.contextLimit).map(hit => hit.record.key),
      conventionKeys: conventionCandidates.slice(0, input.contextLimit).map(hit => hit.convention.key),
      authorizedReferences: authorizedReferences.map(reference => ({
        rootIdentity: reference.rootIdentity,
        virtualPath: reference.virtualPath,
        scope: reference.scope,
        reason: reference.reason
      })),
      deliberation: {
        status: task.deliberationStatus,
        question: task.deliberationQuestion,
        triggers: task.deliberationTriggers,
        authority: task.deliberationAuthority,
        summary: task.deliberationSummary,
        options: task.solutionOptions,
        selectedOptionKey: task.selectedOptionKey,
        decisionNote: task.deliberationDecisionNote,
        implementedOptionKey: task.implementedOptionKey
      },
      openQuestions: [...task.openQuestions]
    },
    task,
    analogues,
    referenceAnalogues,
    preparedAnalogues,
    documentContext,
    processContext,
    priorConfirmedOutcomes: (priorOutcomeState.value?.hits ?? []).filter(hit => hit.provenance.liveStatus === 'accepted'),
    crossCustomerSuggestions: (patternState.value?.hits ?? []).filter(hit => hit.provenance.liveStatus === 'promoted'),
    conventionCandidates,
    limitations: [...new Set(limitations)]
  };
}
