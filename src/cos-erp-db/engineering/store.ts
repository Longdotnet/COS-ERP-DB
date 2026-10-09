import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { EngineeringProjectLineage, EngineeringScopeSnapshot } from './contracts.js';

const STORE_VERSION = 1 as const;
const MAX_TASKS = 5_000;
const MAX_TASK_REVISIONS = 25_000;
const MAX_CONVENTIONS = 10_000;
const MAX_CONVENTION_REVISIONS = 50_000;
const MAX_VERIFICATIONS = 2_000;
let root = '';
const cache = new Map<string, EngineeringScopeSnapshot>();
const queues = new Map<string, Promise<void>>();

const lineageSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  projectId: z.string().uuid().nullable(),
  rootIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  profile: z.string().min(1).max(80),
  runtimeFamily: z.string().min(1).max(120).nullable(),
  sourceRevision: z.string().min(1).max(160).nullable()
}).strict();

const evidenceSchema = z.object({
  evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  relation: z.enum(['supports', 'context', 'contradicts'])
}).strict();

const reviewEvidenceSchema = evidenceSchema.extend({
  origin: z.enum(['current_project', 'authorized_reference']),
  referenceRootIdentity: z.string().regex(/^[a-f0-9]{64}$/).nullable()
}).strict();

const authorizedReferenceSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.literal('implementation_reference'),
  virtualPath: z.string().min(1).max(4096),
  rootIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  profile: z.string().min(1).max(80),
  runtimeFamily: z.string().min(1).max(120).nullable(),
  scope: z.array(z.string().min(1).max(160)).min(1).max(32),
  reason: z.string().min(1).max(2_000),
  provenance: z.literal('explicit_task_input')
}).strict();

const validationSchema = z.object({
  name: z.string().min(1).max(160),
  status: z.enum(['pending', 'passed', 'failed']),
  detail: z.string().max(2_000),
  purpose: z.enum(['build', 'test', 'typecheck', 'lint', 'custom']).default('custom'),
  evidence: z.array(evidenceSchema).max(32).default([])
}).strict();

const analogueAssessmentSchema = z.object({
  evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  classification: z.enum(['convention', 'business_rule', 'legacy_debt', 'engineering_improvement']),
  note: z.string().min(1).max(2_000)
}).strict();

const requirementComparisonSchema = z.object({
  requirement: z.string().min(1).max(2_000),
  status: z.enum(['existing', 'partial', 'missing', 'conflicting', 'investigate']),
  currentEvidence: z.array(reviewEvidenceSchema).max(32),
  referenceEvidence: z.array(reviewEvidenceSchema).max(32),
  findingKeys: z.array(z.string().min(1).max(160)).max(64),
  proposedDisposition: z.enum(['keep', 'adapt', 'implement', 'investigate']),
  note: z.string().max(4_000)
}).strict();

const solutionFindingSchema = z.object({
  key: z.string().min(1).max(160),
  title: z.string().min(1).max(512),
  type: z.enum([
    'required_by_evidence', 'contradiction', 'implementation_risk',
    'process_risk', 'proposed_improvement', 'investigate'
  ]),
  statement: z.string().min(1).max(8_000),
  impact: z.string().min(1).max(8_000),
  confidence: z.enum(['low', 'medium', 'high']),
  affectedRequirements: z.array(z.string().min(1).max(2_000)).max(64),
  processKeys: z.array(z.string().min(1).max(160)).max(64),
  evidence: z.array(reviewEvidenceSchema).max(64),
  recommendation: z.string().min(1).max(8_000),
  disposition: z.enum(['must_address', 'decision_required', 'advisory', 'investigate']),
  decision: z.enum(['pending', 'accepted', 'rejected', 'not_required']),
  decisionNote: z.string().max(4_000)
}).strict();

const solutionOptionSchema = z.object({
  key: z.string().min(1).max(160),
  title: z.string().min(1).max(512),
  approach: z.string().min(1).max(8_000),
  benefits: z.array(z.string().min(1).max(2_000)).max(32),
  tradeoffs: z.array(z.string().min(1).max(2_000)).min(1).max(32),
  risks: z.array(z.string().min(1).max(2_000)).max(32),
  evidence: z.array(reviewEvidenceSchema).max(64),
  rejectedReason: z.string().max(4_000).default('')
}).strict();

const taskSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  lineageKey: z.string().regex(/^[a-f0-9]{64}$/),
  prepared: z.boolean().default(false),
  knowledgeGeneration: z.string().regex(/^[a-f0-9]{64}$/).default('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
  key: z.string().min(1).max(160),
  goal: z.string().min(1).max(12_000),
  solutionReviewRequired: z.boolean().default(false),
  solutionReviewBasisHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  solutionReviewedAt: z.string().datetime().nullable().default(null),
  deliberationBasisHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  deliberatedAt: z.string().datetime().nullable().default(null),
  implementationBindingHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  implementationBoundAt: z.string().datetime().nullable().default(null),
  authorizedReferences: z.array(authorizedReferenceSchema).max(4).default([]),
  requirements: z.array(z.string().min(1).max(2_000)).max(200),
  decisions: z.array(z.string().min(1).max(2_000)).max(200),
  openQuestions: z.array(z.string().min(1).max(2_000)).max(100),
  evidence: z.array(evidenceSchema).max(128),
  analogueEvidence: z.array(evidenceSchema).max(7).default([]),
  referenceAnalogueEvidence: z.array(reviewEvidenceSchema).max(7).default([]),
  analogueAssessments: z.array(analogueAssessmentSchema).max(14).default([]),
  solutionReviewStatus: z.enum(['not_required', 'pending', 'reviewed']).default('not_required'),
  solutionReviewSummary: z.string().max(8_000).default(''),
  requirementComparisons: z.array(requirementComparisonSchema).max(200).default([]),
  solutionFindings: z.array(solutionFindingSchema).max(100).default([]),
  implementedFindingKeys: z.array(z.string().min(1).max(160)).max(100).default([]),
  deliberationStatus: z.enum(['pending', 'not_required', 'decided']).default('not_required'),
  deliberationQuestion: z.string().max(4_000).default(''),
  deliberationTriggers: z.array(z.enum([
    'ambiguity', 'architecture', 'business', 'performance', 'shared_code',
    'compatibility', 'migration', 'security', 'cost_policy'
  ])).max(9).default([]),
  deliberationSummary: z.string().max(8_000).default('Legacy task predates explicit deliberation.'),
  deliberationAuthority: z.enum(['agent', 'user']).default('agent'),
  solutionOptions: z.array(solutionOptionSchema).max(3).default([]),
  selectedOptionKey: z.string().min(1).max(160).nullable().default(null),
  deliberationDecisionNote: z.string().max(4_000).default('Legacy task predates explicit deliberation.'),
  implementedOptionKey: z.string().min(1).max(160).nullable().default(null),
  conventionKeys: z.array(z.string().min(1).max(160)).max(128),
  changedFiles: z.array(z.string().min(1).max(4096)).max(256),
  validations: z.array(validationSchema).max(128),
  largeDataRisk: z.boolean(),
  scaleStatus: z.enum(['not_assessed', 'static_reviewed', 'runtime_evidenced']),
  scaleEvidence: z.array(evidenceSchema).max(32).default([]),
  remainingRisks: z.array(z.string().min(1).max(2_000)).max(100),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

const conventionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  lineageKey: z.string().regex(/^[a-f0-9]{64}$/),
  key: z.string().min(1).max(160),
  title: z.string().min(1).max(512),
  statement: z.string().min(1).max(12_000),
  classification: z.enum(['convention', 'business_rule', 'legacy_debt', 'engineering_improvement']),
  provenance: z.enum(['observed', 'declared_policy']),
  applicability: z.array(z.string().min(1).max(160)).max(64),
  evidence: z.array(evidenceSchema).max(128),
  status: z.enum(['draft', 'reviewed', 'rejected', 'superseded']),
  decisionNote: z.string().max(2_000).nullable(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

const verificationFileSchema = z.object({
  path: z.string().min(1).max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable()
}).strict();

const commandVerificationSchema = z.object({
  purpose: z.enum(['build', 'test', 'typecheck', 'lint', 'custom']),
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(8192)).max(128),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  stdout: z.string().max(40_000),
  stderr: z.string().max(40_000),
  stdoutHash: z.string().regex(/^[a-f0-9]{64}$/),
  stderrHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

const scaleVerificationSchema = z.object({
  connection: z.string().min(1).max(64),
  database: z.string().max(512),
  objectId: z.number().int().positive(),
  objectName: z.string().min(1).max(1024),
  approximateRows: z.number().nonnegative().nullable(),
  indexCount: z.number().int().nonnegative(),
  statisticsCount: z.number().int().nonnegative(),
  level: z.enum(['static', 'runtime']),
  runtimeSource: z.enum(['none', 'query_store', 'live_performance']),
  queryContains: z.string().max(1000).nullable(),
  queryBinding: z.enum(['none', 'task_text', 'changed_file']).default('none'),
  matchedRuntimeCount: z.number().int().nonnegative(),
  capturedAt: z.string().datetime(),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/),
  limitations: z.array(z.string().max(2000)).max(100)
}).strict();

const verificationSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  lineageKey: z.string().regex(/^[a-f0-9]{64}$/),
  taskKey: z.string().min(1).max(160),
  taskRevision: z.number().int().positive(),
  name: z.string().min(1).max(160),
  kind: z.enum(['command', 'sql_scale']),
  success: z.boolean(),
  knowledgeGeneration: z.string().regex(/^[a-f0-9]{64}$/),
  fileSnapshots: z.array(verificationFileSchema).max(256),
  command: commandVerificationSchema.nullable(),
  scale: scaleVerificationSchema.nullable(),
  provenanceHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime()
}).strict();

const snapshotSchema = z.object({
  version: z.literal(STORE_VERSION),
  lineage: lineageSchema,
  updatedAt: z.string().datetime(),
  tasks: z.array(taskSchema).max(MAX_TASKS),
  taskRevisions: z.array(taskSchema).max(MAX_TASK_REVISIONS),
  conventions: z.array(conventionSchema).max(MAX_CONVENTIONS),
  conventionRevisions: z.array(conventionSchema).max(MAX_CONVENTION_REVISIONS),
  verifications: z.array(verificationSchema).max(MAX_VERIFICATIONS).default([])
}).strict();

function assertInitialized(): string {
  if (!root) throw new Error('Engineering store is not initialized');
  return root;
}

function fileFor(lineage: EngineeringProjectLineage): string {
  return path.join(assertInitialized(), `${lineage.key}.json`);
}

function sameBinding(left: EngineeringProjectLineage, right: EngineeringProjectLineage): boolean {
  return left.key === right.key
    && left.rootIdentity === right.rootIdentity
    && left.profile === right.profile;
}

export function initEngineeringStore(userDataDir: string): void {
  root = path.join(userDataDir, 'engineering');
  cache.clear();
  queues.clear();
}

export async function readEngineeringScope(lineage: EngineeringProjectLineage): Promise<EngineeringScopeSnapshot> {
  const parsedLineage = lineageSchema.parse(lineage);
  const cached = cache.get(parsedLineage.key);
  if (cached) {
    if (!sameBinding(cached.lineage, parsedLineage)) throw new Error('ENGINEERING_LINEAGE_MISMATCH: cached lineage was rebound');
    return cached;
  }
  let snapshot: EngineeringScopeSnapshot;
  try {
    snapshot = snapshotSchema.parse(JSON.parse(await fs.readFile(fileFor(parsedLineage), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Engineering scope could not be read: ' + (error instanceof Error ? error.message : String(error)));
    }
    snapshot = {
      version: STORE_VERSION,
      lineage: parsedLineage,
      updatedAt: new Date(0).toISOString(),
      tasks: [],
      taskRevisions: [],
      conventions: [],
      conventionRevisions: [],
      verifications: []
    };
  }
  if (!sameBinding(snapshot.lineage, parsedLineage)) throw new Error('ENGINEERING_LINEAGE_MISMATCH: persisted lineage belongs to another project');
  cache.set(parsedLineage.key, snapshot);
  return snapshot;
}

async function writeScope(snapshot: EngineeringScopeSnapshot): Promise<void> {
  const parsed = snapshotSchema.parse(snapshot);
  const file = fileFor(parsed.lineage);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(parsed) + '\n', 'utf8');
  await fs.rename(temp, file);
  cache.set(parsed.lineage.key, parsed);
}

export function mutateEngineeringScope(
  lineage: EngineeringProjectLineage,
  mutate: (current: EngineeringScopeSnapshot) => EngineeringScopeSnapshot | Promise<EngineeringScopeSnapshot>
): Promise<EngineeringScopeSnapshot> {
  const key = lineage.key;
  const previous = queues.get(key) ?? Promise.resolve();
  let resolveResult!: (value: EngineeringScopeSnapshot) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<EngineeringScopeSnapshot>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const run = previous.then(async () => {
    try {
      const current = await readEngineeringScope(lineage);
      const next = snapshotSchema.parse(await mutate(current));
      if (!sameBinding(next.lineage, lineage)) throw new Error('ENGINEERING_LINEAGE_MISMATCH: mutation changed lineage binding');
      await writeScope({ ...next, lineage: { ...lineage } });
      resolveResult(next);
    } catch (error) {
      rejectResult(error);
    }
  });
  const tracked = run.then(() => undefined, () => undefined);
  queues.set(key, tracked);
  void tracked.finally(() => {
    if (queues.get(key) === tracked) queues.delete(key);
  });
  return result;
}

export function resetEngineeringStoreForTests(): void {
  root = '';
  cache.clear();
  queues.clear();
}
