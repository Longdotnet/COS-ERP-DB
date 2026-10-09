import { z } from 'zod';
import type { Root } from '../../shared/types.js';
import {
  executeDataTimeline,
  executeDeadlocks,
  executeDeploymentCompare,
  executeQueryStore
} from '../investigation/service.js';
import { readIncidentWorkspace } from './incident-workspace.js';
import type {
  IncidentClass,
  IncidentEvidencePolicyResult,
  IncidentTechnicalEvidenceKind,
  IncidentTechnicalEvidenceRecord,
  IncidentTechnicalEvidenceRef,
  IncidentTechnicalEvidenceRole
} from './contracts/incident-technical-evidence.js';
import { knowledgeSha256 } from './evidence.js';
import { appendIncidentTechnicalEvidenceRecord, readIncidentTechnicalEvidenceScope } from './technical-evidence-store.js';

const workspaceCaptureSchema = z.object({
  incidentKey: z.string().trim().min(1).max(160),
  source: z.literal('workspace'),
  symptom: z.string().trim().min(1).max(1000),
  connection: z.string().trim().min(1).max(64).optional()
}).strict();

const queryStoreCaptureSchema = z.object({
  incidentKey: z.string().trim().min(1).max(160),
  source: z.literal('query_store'),
  connection: z.string().trim().min(1).max(64),
  hours: z.union([z.literal(1), z.literal(6), z.literal(24), z.literal(168)]).optional(),
  sort: z.enum(['duration', 'cpu', 'reads', 'executions']).optional()
}).strict();

const deadlockCaptureSchema = z.object({
  incidentKey: z.string().trim().min(1).max(160),
  source: z.literal('deadlocks'),
  connection: z.string().trim().min(1).max(64)
}).strict();

const dataTimelineCaptureSchema = z.object({
  incidentKey: z.string().trim().min(1).max(160),
  source: z.literal('data_timeline'),
  connection: z.string().trim().min(1).max(64),
  objectId: z.number().int().positive(),
  subject: z.string().trim().min(3).max(1300),
  limit: z.number().int().min(1).max(100).optional()
}).strict();

const deploymentCompareCaptureSchema = z.object({
  incidentKey: z.string().trim().min(1).max(160),
  source: z.literal('deployment_compare'),
  baselineConnection: z.string().trim().min(1).max(64),
  currentConnection: z.string().trim().min(1).max(64)
}).strict();

export const incidentTechnicalCaptureInputSchema = z.discriminatedUnion('source', [
  workspaceCaptureSchema,
  queryStoreCaptureSchema,
  deadlockCaptureSchema,
  dataTimelineCaptureSchema,
  deploymentCompareCaptureSchema
]);
export type IncidentTechnicalCaptureInput = z.infer<typeof incidentTechnicalCaptureInputSchema>;

function technicalRecordContentHash(input: {
  scope: string;
  incidentKey: string;
  kind: IncidentTechnicalEvidenceKind;
  role: IncidentTechnicalEvidenceRole;
  sourceAction: string;
  connection: string | null;
  capturedAt: string;
  payload: unknown;
}): string {
  return knowledgeSha256('incident-technical-evidence:v1\0' + JSON.stringify({
    scope: input.scope,
    incidentKey: input.incidentKey,
    kind: input.kind,
    role: input.role,
    sourceAction: input.sourceAction,
    connection: input.connection,
    capturedAt: input.capturedAt,
    payload: input.payload
  }));
}

function recordId(
  scope: string,
  incidentKey: string,
  kind: IncidentTechnicalEvidenceKind,
  contentHash: string,
  capturedAt: string
): string {
  return knowledgeSha256(['incident-technical-evidence-id:v1', scope, incidentKey, kind, contentHash, capturedAt].join('\0'));
}

async function persistIncidentTechnicalEvidenceRecord(
  scopeInput: string,
  input: {
    incidentKey: string;
    kind: IncidentTechnicalEvidenceKind;
    role: IncidentTechnicalEvidenceRole;
    sourceAction: string;
    connection: string | null;
    capturedAt: string;
    payload: unknown;
  }
): Promise<IncidentTechnicalEvidenceRecord> {
  const scope = scopeInput.trim();
  const incidentKey = input.incidentKey.trim();
  const causalRole = input.role === 'causal_verification' || input.role === 'verification';
  if (input.kind === 'machine_validation' && !causalRole) {
    throw new Error('Machine-validation evidence must be causal verification.');
  }
  if (input.kind !== 'machine_validation' && causalRole) {
    throw new Error('Causal verification evidence must use the machine_validation kind.');
  }
  const contentHash = technicalRecordContentHash({ scope, ...input });
  const id = recordId(scope, incidentKey, input.kind, contentHash, input.capturedAt);
  const createdAt = new Date().toISOString();
  const candidate: IncidentTechnicalEvidenceRecord = {
    id,
    scope,
    incidentKey,
    kind: input.kind,
    role: input.role,
    sourceAction: input.sourceAction,
    connection: input.connection,
    capturedAt: input.capturedAt,
    contentHash,
    payload: input.payload,
    createdAt
  };
  return appendIncidentTechnicalEvidenceRecord(scope, candidate);
}

/**
 * Public writer for observations, hypotheses and legacy verification records.
 * New causal verification receipts are sealed through persistIncidentCausalVerification.
 */
export async function persistIncidentTechnicalEvidence(
  scopeInput: string,
  input: {
    incidentKey: string;
    kind: IncidentTechnicalEvidenceKind;
    role: Exclude<IncidentTechnicalEvidenceRole, 'causal_verification'>;
    sourceAction: string;
    connection: string | null;
    capturedAt: string;
    payload: unknown;
  }
): Promise<IncidentTechnicalEvidenceRecord> {
  return persistIncidentTechnicalEvidenceRecord(scopeInput, input);
}

const causalVerificationPayloadSchema = z.object({
  outcomeKey: z.string().trim().min(1).max(160),
  outcomeBasisHash: z.string().regex(/^[a-f0-9]{64}$/),
  verificationId: z.string().regex(/^[a-f0-9]{64}$/),
  lineageKey: z.string().regex(/^[a-f0-9]{64}$/),
  lineage: z.object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    projectId: z.string().max(256).nullable(),
    rootIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    profile: z.string().min(1).max(80),
    runtimeFamily: z.string().min(1).max(120).nullable(),
    sourceRevision: z.string().min(1).max(160).nullable()
  }).strict(),
  taskKey: z.string().trim().min(1).max(160),
  taskRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(160),
  kind: z.enum(['command', 'sql_scale']),
  success: z.literal(true),
  purpose: z.enum(['build', 'test', 'typecheck', 'lint', 'custom']).nullable(),
  scaleLevel: z.enum(['static', 'runtime']).nullable(),
  runtimeSource: z.enum(['none', 'query_store', 'live_performance']).nullable(),
  queryBinding: z.enum(['none', 'task_text', 'changed_file']).nullable(),
  matchedRuntimeCount: z.number().int().nonnegative(),
  knowledgeGeneration: z.string().regex(/^[a-f0-9]{64}$/),
  engineeringKnowledgeScope: z.string().trim().min(1).max(160),
  workspace: z.object({
    virtual: z.string().min(1).max(4096),
    real: z.string().min(1).max(4096)
  }).strict(),
  fileSnapshots: z.array(z.object({
    path: z.string().min(1).max(4096),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable()
  }).strict()).max(256),
  provenanceHash: z.string().regex(/^[a-f0-9]{64}$/),
  causalClaimBound: z.literal(true),
  machineVerifiedAtCapture: z.literal(true)
}).strict();

export type IncidentCausalVerificationPayload = z.infer<typeof causalVerificationPayloadSchema>;
export type IncidentCausalVerificationFreshness = {
  current: boolean;
  reason: string | null;
};
export type IncidentCausalVerificationFreshnessVerifier = (
  payload: IncidentCausalVerificationPayload
) => Promise<IncidentCausalVerificationFreshness>;

let causalVerificationFreshnessVerifier: IncidentCausalVerificationFreshnessVerifier | null = null;

export function setIncidentCausalVerificationFreshnessVerifier(
  verifier: IncidentCausalVerificationFreshnessVerifier | null
): void {
  causalVerificationFreshnessVerifier = verifier;
}

async function causalVerificationFreshness(record: IncidentTechnicalEvidenceRecord): Promise<IncidentCausalVerificationFreshness> {
  const parsed = causalVerificationPayloadSchema.safeParse(record.payload);
  if (!parsed.success) return { current: false, reason: 'causal verification receipt predates current freshness binding' };
  if (!causalVerificationFreshnessVerifier) {
    return { current: false, reason: 'causal verification freshness verifier is unavailable' };
  }
  return causalVerificationFreshnessVerifier(parsed.data);
}

export async function persistIncidentCausalVerification(
  scopeInput: string,
  input: {
    incidentKey: string;
    sourceAction: string;
    connection: string | null;
    capturedAt: string;
    payload: unknown;
  }
): Promise<IncidentTechnicalEvidenceRecord> {
  const payload = causalVerificationPayloadSchema.parse(input.payload);
  return persistIncidentTechnicalEvidenceRecord(scopeInput, {
    ...input,
    kind: 'machine_validation',
    role: 'causal_verification',
    payload
  });
}

export async function captureIncidentTechnicalEvidence(
  scope: string,
  rawInput: unknown,
  roots: readonly Root[]
): Promise<{ records: IncidentTechnicalEvidenceRecord[]; refs: IncidentTechnicalEvidenceRef[] }> {
  const input = incidentTechnicalCaptureInputSchema.parse(rawInput);
  const records: IncidentTechnicalEvidenceRecord[] = [];
  if (input.source === 'workspace') {
    const workspace = await readIncidentWorkspace({
      scope,
      symptom: input.symptom,
      ...(input.connection ? { connection: input.connection } : {})
    }, roots);
    const candidates = [
      workspace.technical.diagnosis ? {
        kind: 'runtime_diagnosis' as const,
        sourceAction: 'incident_workspace/diagnosis',
        connection: workspace.technical.diagnosis.connection,
        capturedAt: workspace.technical.diagnosis.capturedAt,
        payload: workspace.technical.diagnosis
      } : null,
      workspace.technical.health ? {
        kind: 'health_gate' as const,
        sourceAction: 'incident_workspace/health_gate',
        connection: workspace.technical.health.connection,
        capturedAt: workspace.technical.health.capturedAt,
        payload: workspace.technical.health
      } : null,
      workspace.technical.deployment ? {
        kind: 'deployment_fingerprint' as const,
        sourceAction: 'incident_workspace/deployment_fingerprint',
        connection: workspace.technical.deployment.connection,
        capturedAt: workspace.technical.deployment.capturedAt,
        payload: workspace.technical.deployment
      } : null
    ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
    for (const candidate of candidates) {
      records.push(await persistIncidentTechnicalEvidence(scope, {
        incidentKey: input.incidentKey,
        role: 'observation',
        ...candidate
      }));
    }
  } else if (input.source === 'query_store') {
    const payload = await executeQueryStore({ connection: input.connection, hours: input.hours, sort: input.sort });
    records.push(await persistIncidentTechnicalEvidence(scope, {
      incidentKey: input.incidentKey,
      kind: 'query_store',
      role: 'observation',
      sourceAction: 'query_store',
      connection: payload.connection,
      capturedAt: payload.capturedAt,
      payload
    }));
  } else if (input.source === 'deadlocks') {
    const payload = await executeDeadlocks(input.connection);
    records.push(await persistIncidentTechnicalEvidence(scope, {
      incidentKey: input.incidentKey,
      kind: 'deadlocks',
      role: 'observation',
      sourceAction: 'deadlocks',
      connection: payload.connection,
      capturedAt: payload.capturedAt,
      payload
    }));
  } else if (input.source === 'data_timeline') {
    const payload = await executeDataTimeline({
      connection: input.connection,
      objectId: input.objectId,
      subject: input.subject,
      ...(input.limit ? { limit: input.limit } : {})
    });
    records.push(await persistIncidentTechnicalEvidence(scope, {
      incidentKey: input.incidentKey,
      kind: 'data_timeline',
      role: 'observation',
      sourceAction: 'data_timeline',
      connection: payload.connection,
      capturedAt: payload.capturedAt,
      payload
    }));
  } else {
    const payload = await executeDeploymentCompare({
      baselineConnection: input.baselineConnection,
      currentConnection: input.currentConnection
    });
    records.push(await persistIncidentTechnicalEvidence(scope, {
      incidentKey: input.incidentKey,
      kind: 'deployment_compare',
      role: 'observation',
      sourceAction: 'deployment_compare',
      connection: input.currentConnection,
      capturedAt: payload.current.capturedAt,
      payload
    }));
  }
  return { records, refs: records.map(record => ({ evidenceId: record.id, contentHash: record.contentHash })) };
}

export async function resolveIncidentTechnicalEvidence(
  scope: string,
  incidentKey: string,
  refs: readonly IncidentTechnicalEvidenceRef[]
): Promise<{ current: IncidentTechnicalEvidenceRecord[]; staleCount: number }> {
  const snapshot = await readIncidentTechnicalEvidenceScope(scope);
  const byId = new Map(snapshot.records.map(record => [record.id, record]));
  const current: IncidentTechnicalEvidenceRecord[] = [];
  let staleCount = 0;
  for (const ref of refs) {
    const record = byId.get(ref.evidenceId);
    if (!record || record.contentHash !== ref.contentHash || record.incidentKey !== incidentKey) {
      staleCount += 1;
      continue;
    }
    if (technicalRecordContentHash(record) !== record.contentHash) {
      staleCount += 1;
      continue;
    }
    if (recordId(record.scope, record.incidentKey, record.kind, record.contentHash, record.capturedAt) !== record.id) {
      staleCount += 1;
      continue;
    }
    current.push(record);
  }
  return { current, staleCount };
}

export async function getIncidentTechnicalEvidence(scope: string, ids: readonly string[]) {
  if (!ids.length || ids.length > 20) throw new Error('Incident technical-evidence get requires 1 to 20 ids.');
  const snapshot = await readIncidentTechnicalEvidenceScope(scope);
  const byId = new Map(snapshot.records.map(record => [record.id, record]));
  const records: IncidentTechnicalEvidenceRecord[] = [];
  const missingIds: string[] = [];
  for (const id of ids) {
    const record = byId.get(id);
    if (record) records.push(record);
    else missingIds.push(id);
  }
  return { scope, records, missingIds };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function validDeploymentCompare(record: IncidentTechnicalEvidenceRecord): boolean {
  if (record.kind !== 'deployment_compare' || record.role !== 'observation') return false;
  const payload = objectValue(record.payload);
  if (!payload) return false;
  const baseline = objectValue(payload.baseline);
  const current = objectValue(payload.current);
  const schema = objectValue(payload.schema);
  return baseline?.complete === true
    && current?.complete === true
    && payload.exactFingerprintMatch === false
    && schema?.truncated === false;
}

function validDataTimeline(record: IncidentTechnicalEvidenceRecord): boolean {
  if (record.kind !== 'data_timeline' || record.role !== 'observation') return false;
  const payload = objectValue(record.payload);
  if (!payload) return false;
  const sources = objectValue(payload.sources);
  const hasLinkedAudit = sources?.createModifyLog === true || sources?.voucherHistory === true;
  return payload.ambiguous === false
    && payload.matchedRows === 1
    && arrayValue(payload.current).length === 1
    && (arrayValue(payload.events).length > 0 || hasLinkedAudit);
}

function validConcurrencyObservation(record: IncidentTechnicalEvidenceRecord): boolean {
  if (record.role !== 'observation') return false;
  const payload = objectValue(record.payload);
  if (!payload) return false;
  if (record.kind === 'deadlocks') {
    return payload.available === true && arrayValue(payload.events).length > 0;
  }
  if (record.kind !== 'runtime_diagnosis') return false;
  const summary = objectValue(payload.summary);
  const requests = arrayValue(payload.requests).map(objectValue).filter((value): value is Record<string, unknown> => Boolean(value));
  return typeof summary?.blockedRequestCount === 'number'
    && summary.blockedRequestCount > 0
    && requests.some(request => request.isRootBlocker === true || request.isBlocked === true);
}

export async function evaluateIncidentEvidencePolicy(
  scope: string,
  incidentKey: string,
  incidentClass: IncidentClass,
  outcomeBasisHash: string,
  refs: readonly IncidentTechnicalEvidenceRef[]
): Promise<IncidentEvidencePolicyResult> {
  const resolved = await resolveIncidentTechnicalEvidence(scope, incidentKey, refs);
  const missing: string[] = [];
  const roleCounts = {
    observations: resolved.current.filter(record => record.role === 'observation').length,
    hypotheses: resolved.current.filter(record => record.role === 'hypothesis').length,
    causalVerifications: resolved.current.filter(record => record.role === 'causal_verification').length,
    legacyVerifications: resolved.current.filter(record => record.role === 'verification').length
  };
  const eligibleMachineValidations = resolved.current.filter(record => {
    if (record.kind !== 'machine_validation' || record.role !== 'causal_verification') return false;
    if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) return false;
    const payload = record.payload as Record<string, unknown>;
    if (payload.outcomeBasisHash !== outcomeBasisHash) return false;
    if (payload.causalClaimBound !== true || payload.machineVerifiedAtCapture !== true) return false;
    const purpose = typeof payload.purpose === 'string' ? payload.purpose : null;
    const scaleLevel = typeof payload.scaleLevel === 'string' ? payload.scaleLevel : null;
    const runtimeSource = typeof payload.runtimeSource === 'string' ? payload.runtimeSource : null;
    const queryBinding = typeof payload.queryBinding === 'string' ? payload.queryBinding : null;
    const matchedRuntimeCount = typeof payload.matchedRuntimeCount === 'number' ? payload.matchedRuntimeCount : 0;
    if (incidentClass === 'logic_correctness') return purpose === 'test';
    if (incidentClass === 'performance') {
      return scaleLevel === 'runtime'
        && (runtimeSource === 'query_store' || runtimeSource === 'live_performance')
        && (queryBinding === 'task_text' || queryBinding === 'changed_file')
        && matchedRuntimeCount > 0;
    }
    return purpose === 'test';
  });
  let matchingMachineValidation: IncidentTechnicalEvidenceRecord | undefined;
  let causalFreshnessFailure: string | null = null;
  for (const record of eligibleMachineValidations) {
    const freshness = await causalVerificationFreshness(record);
    if (freshness.current) {
      matchingMachineValidation = record;
      break;
    }
    causalFreshnessFailure ??= freshness.reason;
  }
  if (!matchingMachineValidation) missing.push(
    incidentClass === 'performance'
      ? 'pre-bound runtime SQL verification with task-bound query evidence'
      : 'pre-bound causal machine test for the current outcome basis'
  );
  if (!matchingMachineValidation && causalFreshnessFailure) {
    missing.push('causal verification is stale: ' + causalFreshnessFailure);
  }
  if (incidentClass === 'deployment') {
    const deploymentCompare = resolved.current.find(validDeploymentCompare);
    if (!deploymentCompare) missing.push('complete deployment_compare with a baseline/current mismatch');
  }
  if (incidentClass === 'data' && !resolved.current.some(validDataTimeline)) {
    missing.push('unambiguous single-row data_timeline with current/audit evidence');
  }
  if (incidentClass === 'concurrency' && !resolved.current.some(validConcurrencyObservation)) {
    missing.push('available deadlock event or runtime blocking/root-blocker observation');
  }
  if (resolved.staleCount) missing.push(`${resolved.staleCount} stale technical evidence ref(s)`);
  const satisfied = missing.length === 0;
  return {
    incidentClass,
    satisfied,
    machineBacked: satisfied && Boolean(matchingMachineValidation),
    missing,
    currentRecords: resolved.current,
    roleCounts
  };
}
