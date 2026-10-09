import type { Root } from '../../shared/types.js';
import type {
  DatabaseDeploymentFingerprint,
  DatabaseHealthGateResult,
  DatabaseIncidentSnapshot
} from '../investigation/types.js';
import {
  diagnoseIncident,
  executeDeploymentFingerprint,
  executeHealthGate
} from '../investigation/service.js';
import { readIncidentContext } from './incident-context.js';

export interface IncidentWorkspaceRequest {
  scope: string;
  symptom: string;
  connection?: string;
}

export type IncidentContextPacket = Awaited<ReturnType<typeof readIncidentContext>>;

export interface IncidentWorkspaceTechnicalEvidence {
  status: 'skipped' | 'captured' | 'partial' | 'unavailable';
  diagnosis: DatabaseIncidentSnapshot | null;
  health: DatabaseHealthGateResult | null;
  deployment: DatabaseDeploymentFingerprint | null;
  errors: string[];
}

export interface IncidentWorkspaceResult {
  scope: string;
  symptom: string;
  requestedConnection: string | null;
  contextReadiness: IncidentContextPacket['readiness'];
  context: IncidentContextPacket;
  technical: IncidentWorkspaceTechnicalEvidence;
  rootCauseConfirmed: false;
  guidance: string;
}

interface IncidentWorkspaceDependencies {
  readContext(scope: string, query: string, roots: readonly Root[]): Promise<IncidentContextPacket>;
  diagnose(connection?: string): Promise<DatabaseIncidentSnapshot>;
  health(connection?: string): Promise<DatabaseHealthGateResult>;
  deployment(connection?: string): Promise<DatabaseDeploymentFingerprint>;
}

const DEFAULT_DEPENDENCIES: IncidentWorkspaceDependencies = {
  readContext: (scope, query, roots) => readIncidentContext(scope, query, roots),
  diagnose: connection => diagnoseIncident(connection),
  health: connection => executeHealthGate(connection),
  deployment: connection => executeDeploymentFingerprint(connection)
};

function errorText(label: string, reason: unknown): string {
  return label + ': ' + (reason instanceof Error ? reason.message : String(reason));
}

export async function readIncidentWorkspace(
  request: IncidentWorkspaceRequest,
  roots: readonly Root[],
  dependencies: IncidentWorkspaceDependencies = DEFAULT_DEPENDENCIES
): Promise<IncidentWorkspaceResult> {
  const scope = request.scope.trim();
  const symptom = request.symptom.trim();
  const context = await dependencies.readContext(scope, symptom, roots);

  if (context.readiness === 'empty') {
    return {
      scope,
      symptom,
      requestedConnection: request.connection ?? null,
      contextReadiness: context.readiness,
      context,
      technical: {
        status: 'skipped',
        diagnosis: null,
        health: null,
        deployment: null,
        errors: []
      },
      rootCauseConfirmed: false,
      guidance: 'Live database diagnosis was not run because no curated local process context matched this incident. Resolve the context gaps first.'
    };
  }

  const [diagnosisState, healthState, deploymentState] = await Promise.allSettled([
    dependencies.diagnose(request.connection),
    dependencies.health(request.connection),
    dependencies.deployment(request.connection)
  ]);
  const diagnosis = diagnosisState.status === 'fulfilled' ? diagnosisState.value : null;
  const health = healthState.status === 'fulfilled' ? healthState.value : null;
  const deployment = deploymentState.status === 'fulfilled' ? deploymentState.value : null;
  const errors = [
    ...(diagnosisState.status === 'rejected' ? [errorText('Live diagnosis', diagnosisState.reason)] : []),
    ...(healthState.status === 'rejected' ? [errorText('Health gate', healthState.reason)] : []),
    ...(deploymentState.status === 'rejected' ? [errorText('Deployment fingerprint', deploymentState.reason)] : [])
  ];
  const capturedCount = [diagnosis, health, deployment].filter(Boolean).length;
  const technicalStatus = capturedCount === 3
    ? 'captured' as const
    : capturedCount > 0
      ? 'partial' as const
      : 'unavailable' as const;

  return {
    scope,
    symptom,
    requestedConnection: request.connection ?? null,
    contextReadiness: context.readiness,
    context,
    technical: {
      status: technicalStatus,
      diagnosis,
      health,
      deployment,
      errors
    },
    rootCauseConfirmed: false,
    guidance: context.readiness === 'grounded'
      ? 'Use the runtime and deployment evidence to test the accepted expected behavior. Confirm a root cause only through an evidence-backed accepted incident outcome with passed validation.'
      : 'Technical evidence was captured, but the process context is still partial. Resolve the listed context gaps before treating any technical finding as the confirmed root cause.'
  };
}
