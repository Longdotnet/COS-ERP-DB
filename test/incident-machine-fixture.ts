import { recordIncidentMachineVerification } from '../src/cos-erp-db/engineering/incident-verification-service.js';
import type { ResolvedEngineeringLineage } from '../src/cos-erp-db/engineering/lineage.js';
import { putEngineeringTask } from '../src/cos-erp-db/engineering/task-service.js';
import { runEngineeringValidation } from '../src/cos-erp-db/engineering/verification-service.js';
import { getIncidentOutcomes, incidentOutcomeTechnicalBasisHash } from '../src/cos-erp-db/knowledge/outcome-service.js';
import type { Root } from '../src/shared/types.js';

export async function issueIncidentTestReceipt(
  resolved: ResolvedEngineeringLineage,
  roots: readonly Root[],
  input: {
    scope: string;
    outcomeKey: string;
    taskKey: string;
    changedFile: string;
  }
) {
  const outcome = (await getIncidentOutcomes(input.scope, [input.outcomeKey])).outcomes[0]?.outcome;
  if (!outcome) throw new Error('Incident test fixture requires an existing draft outcome.');
  const outcomeBasisHash = incidentOutcomeTechnicalBasisHash(outcome);
  await putEngineeringTask(resolved.lineage, {
    key: input.taskKey,
    goal: `Validate ${outcome.incidentKey} against its accepted expected behavior.`,
    changedFiles: [input.changedFile],
    validations: [{ name: 'test', status: 'pending', detail: 'Run incident regression test.' }]
  });
  const verification = await runEngineeringValidation(resolved, {
    kind: 'command',
    taskKey: input.taskKey,
    name: 'test',
    command: 'dotnet',
    args: ['test'],
    incidentBinding: {
      scope: input.scope,
      outcomeKey: outcome.key,
      outcomeBasisHash
    }
  }, roots, {
    commandPolicy: { enabled: false, mode: 'allow', rules: [] },
    commandRunner: async () => ({
      exitCode: 0,
      stdout: 'Passed.',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 4
    })
  });
  return recordIncidentMachineVerification(resolved, {
    scope: input.scope,
    outcomeKey: outcome.key,
    taskKey: input.taskKey,
    verificationId: verification.id
  }, roots);
}
