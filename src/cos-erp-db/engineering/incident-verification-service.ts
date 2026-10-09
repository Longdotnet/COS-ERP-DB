import { z } from 'zod';
import type { Root } from '../../shared/types.js';
import { readKnowledgeScope } from '../knowledge/store.js';
import {
  persistIncidentCausalVerification,
  setIncidentCausalVerificationFreshnessVerifier,
  type IncidentCausalVerificationPayload
} from '../knowledge/technical-evidence-service.js';
import { getIncidentOutcomes, incidentOutcomeTechnicalBasisHash } from '../knowledge/outcome-service.js';
import { engineeringKnowledgeScope } from './lineage.js';
import { engineeringQualityGate } from './quality-gate.js';
import type { ResolvedEngineeringLineage } from './lineage.js';
import { getEngineeringTasks } from './task-service.js';
import { getEngineeringVerifications, verifyEngineeringVerification } from './verification-service.js';

const inputSchema = z.object({
  scope: z.string().trim().min(1).max(120),
  outcomeKey: z.string().trim().min(1).max(160),
  taskKey: z.string().trim().min(1).max(160),
  verificationId: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export type IncidentMachineVerificationInput = z.infer<typeof inputSchema>;

async function verifyIncidentCausalReceiptFreshness(payload: IncidentCausalVerificationPayload) {
  try {
    if (payload.lineage.key !== payload.lineageKey) {
      return { current: false, reason: 'causal receipt lineage identity is inconsistent' };
    }
    if (engineeringKnowledgeScope(payload.lineage) !== payload.engineeringKnowledgeScope) {
      return { current: false, reason: 'causal receipt knowledge scope is inconsistent with its lineage' };
    }
    const task = (await getEngineeringTasks(payload.lineage, [payload.taskKey]))[0];
    if (!task) return { current: false, reason: 'engineering task for causal verification no longer exists' };
    const verification = (await getEngineeringVerifications(payload.lineage, payload.taskKey))
      .find(record => record.id === payload.verificationId);
    if (!verification) return { current: false, reason: 'engineering verification for causal receipt no longer exists' };
    if (verification.provenanceHash !== payload.provenanceHash) {
      return { current: false, reason: 'engineering verification provenance changed after causal receipt issuance' };
    }
    const currentKnowledge = await readKnowledgeScope(payload.engineeringKnowledgeScope);
    const rootName = payload.workspace.virtual.replace(/^\/+/, '').split('/')[0] || 'workspace';
    const roots: Root[] = [{ name: rootName, path: payload.workspace.real }];
    const current = await verifyEngineeringVerification(
      verification,
      task,
      { lineage: payload.lineage, workspace: payload.workspace },
      roots,
      currentKnowledge.generation
    );
    return {
      current: current.current,
      reason: current.reason
    };
  } catch (error) {
    return { current: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

setIncidentCausalVerificationFreshnessVerifier(verifyIncidentCausalReceiptFreshness);

export async function recordIncidentMachineVerification(
  resolved: ResolvedEngineeringLineage,
  rawInput: unknown,
  roots: readonly Root[]
) {
  const input = inputSchema.parse(rawInput);
  const outcomeResult = await getIncidentOutcomes(input.scope, [input.outcomeKey]);
  const outcome = outcomeResult.outcomes[0]?.outcome;
  if (!outcome) throw new Error('INCIDENT_MACHINE_VERIFICATION_OUTCOME_NOT_FOUND');
  if (!outcome.incidentClass) throw new Error('INCIDENT_MACHINE_VERIFICATION_REQUIRES_TYPED_OUTCOME');
  if (outcome.status === 'invalidated') throw new Error('INCIDENT_MACHINE_VERIFICATION_OUTCOME_INVALIDATED');
  const outcomeBasisHash = incidentOutcomeTechnicalBasisHash(outcome);
  const gate = await engineeringQualityGate(resolved.lineage, input.taskKey, roots, resolved.workspace);
  if (!gate.assurance.machineVerified) {
    throw new Error('INCIDENT_MACHINE_VERIFICATION_REQUIRES_MACHINE_VERIFIED_TASK');
  }
  const currentIds = new Set([
    ...gate.assurance.commandVerifications
      .filter(item => item.status === 'current-pass' && item.verificationId)
      .map(item => item.verificationId!),
    ...(gate.assurance.scaleVerification.status === 'current-runtime' && gate.assurance.scaleVerification.verificationId
      ? [gate.assurance.scaleVerification.verificationId]
      : [])
  ]);
  if (!currentIds.has(input.verificationId)) {
    throw new Error('INCIDENT_MACHINE_VERIFICATION_ID_IS_NOT_CURRENT_PASS');
  }
  const verification = (await getEngineeringVerifications(resolved.lineage, input.taskKey))
    .find(record => record.id === input.verificationId);
  if (!verification || !verification.success) {
    throw new Error('INCIDENT_MACHINE_VERIFICATION_RECORD_NOT_FOUND');
  }
  const binding = verification.incidentBinding;
  if (!binding
    || binding.scope !== input.scope
    || binding.outcomeKey !== outcome.key
    || binding.outcomeBasisHash !== outcomeBasisHash) {
    throw new Error('INCIDENT_MACHINE_VERIFICATION_REQUIRES_PREBOUND_OUTCOME_BASIS');
  }
  const acceptableVerification = outcome.incidentClass === 'performance'
    ? verification.scale?.level === 'runtime' || verification.command?.purpose === 'test'
    : verification.command?.purpose === 'test';
  if (!acceptableVerification) {
    throw new Error('INCIDENT_MACHINE_VERIFICATION_UNSUITABLE_FOR_' + outcome.incidentClass.toUpperCase());
  }
  const record = await persistIncidentCausalVerification(input.scope, {
    incidentKey: outcome.incidentKey,
    sourceAction: 'engineering/validation_run',
    connection: verification.scale?.connection ?? null,
    capturedAt: verification.createdAt,
    payload: {
      outcomeKey: outcome.key,
      outcomeBasisHash,
      verificationId: verification.id,
      lineageKey: verification.lineageKey,
      lineage: resolved.lineage,
      taskKey: verification.taskKey,
      taskRevision: verification.taskRevision,
      name: verification.name,
      kind: verification.kind,
      success: verification.success,
      purpose: verification.command?.purpose ?? null,
      scaleLevel: verification.scale?.level ?? null,
      runtimeSource: verification.scale?.runtimeSource ?? null,
      queryBinding: verification.scale?.queryBinding ?? null,
      matchedRuntimeCount: verification.scale?.matchedRuntimeCount ?? 0,
      knowledgeGeneration: verification.knowledgeGeneration,
      engineeringKnowledgeScope: engineeringKnowledgeScope(resolved.lineage),
      workspace: resolved.workspace,
      fileSnapshots: verification.fileSnapshots,
      provenanceHash: verification.provenanceHash,
      causalClaimBound: true,
      machineVerifiedAtCapture: true
    }
  });
  return {
    scope: input.scope,
    incidentKey: outcome.incidentKey,
    outcomeKey: outcome.key,
    outcomeBasisHash,
    taskKey: input.taskKey,
    verificationId: input.verificationId,
    evidence: record,
    ref: { evidenceId: record.id, contentHash: record.contentHash }
  };
}
