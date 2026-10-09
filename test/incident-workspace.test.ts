import { expect, it, vi } from 'vitest';
import { readIncidentWorkspace } from '../src/cos-erp-db/knowledge/incident-workspace.js';

function context(readiness: 'grounded' | 'partial' | 'empty') {
  return {
    scope: 'customer-a',
    query: 'salary wrong',
    readiness,
    process: { hits: [] },
    contextRecords: [],
    evidence: { hits: [] },
    implementation: { hits: [] },
    implementationLinks: [],
    priorConfirmedOutcomes: [],
    priorOutcomeLimitations: [],
    crossCustomerSuggestions: [],
    crossCustomerLimitations: [],
    verification: null,
    gaps: readiness === 'grounded' ? [] : ['Missing accepted expected behavior.'],
    elapsedMs: 1
  } as any;
}

function snapshot() {
  return {
    id: 'incident-1', connection: 'linkq-test', database: 'L80LINKQ.TEST',
    capturedAt: '2026-10-02T05:00:00.000Z', savedAt: null,
    summary: { totalMb: null, dataUsedMb: null, logUsedPercent: null, activeRequestCount: 0, blockedRequestCount: 0, failedJobCount: 0 },
    requests: [], jobs: [], findings: [], limitations: []
  } as any;
}

function health() {
  return {
    connection: 'linkq-test', database: 'L80LINKQ.TEST', capturedAt: '2026-10-02T05:00:00.000Z',
    status: 'healthy', checks: [], limitations: [], elapsedMs: 1
  } as any;
}

function deployment() {
  return {
    connection: 'linkq-test', database: 'L80LINKQ.TEST', capturedAt: '2026-10-02T05:00:00.000Z',
    complete: true, fingerprint: 'f', schemaHash: 's', moduleHash: 'm', configurationHash: 'c',
    counts: { objects: 1, columns: 1, indexes: 1, constraints: 1, modules: 1 },
    configuration: { compatibilityLevel: 160, collation: 'x', recoveryModel: 'FULL', readCommittedSnapshot: false, snapshotIsolationState: 'OFF' },
    limitations: [], elapsedMs: 1
  } as any;
}

it('stops before live SQL diagnostics when no curated process context matches', async () => {
  const dependencies = {
    readContext: vi.fn(async () => context('empty')),
    diagnose: vi.fn(async () => snapshot()),
    health: vi.fn(async () => health()),
    deployment: vi.fn(async () => deployment())
  };

  const result = await readIncidentWorkspace(
    { scope: ' customer-a ', symptom: ' salary wrong ', connection: 'linkq-test' },
    [],
    dependencies
  );

  expect(dependencies.readContext).toHaveBeenCalledWith('customer-a', 'salary wrong', []);
  expect(dependencies.diagnose).not.toHaveBeenCalled();
  expect(dependencies.health).not.toHaveBeenCalled();
  expect(dependencies.deployment).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    contextReadiness: 'empty',
    technical: { status: 'skipped', diagnosis: null, health: null, deployment: null },
    rootCauseConfirmed: false
  });
});

it('reads process context before capturing live deployment and runtime evidence', async () => {
  const dependencies = {
    readContext: vi.fn(async () => context('grounded')),
    diagnose: vi.fn(async () => snapshot()),
    health: vi.fn(async () => health()),
    deployment: vi.fn(async () => deployment())
  };

  const result = await readIncidentWorkspace(
    { scope: 'customer-a', symptom: 'salary wrong', connection: 'linkq-test' },
    [],
    dependencies
  );

  expect(dependencies.readContext.mock.invocationCallOrder[0]).toBeLessThan(dependencies.diagnose.mock.invocationCallOrder[0]!);
  expect(dependencies.readContext.mock.invocationCallOrder[0]).toBeLessThan(dependencies.health.mock.invocationCallOrder[0]!);
  expect(dependencies.readContext.mock.invocationCallOrder[0]).toBeLessThan(dependencies.deployment.mock.invocationCallOrder[0]!);
  expect(result).toMatchObject({
    contextReadiness: 'grounded',
    technical: {
      status: 'captured',
      diagnosis: { connection: 'linkq-test' },
      health: { status: 'healthy' },
      deployment: { fingerprint: 'f' },
      errors: []
    },
    rootCauseConfirmed: false
  });
});

it('keeps a partial context packet usable when one technical capture fails', async () => {
  const dependencies = {
    readContext: vi.fn(async () => context('partial')),
    diagnose: vi.fn(async () => snapshot()),
    health: vi.fn(async () => { throw new Error('health unavailable'); }),
    deployment: vi.fn(async () => deployment())
  };

  const result = await readIncidentWorkspace(
    { scope: 'customer-a', symptom: 'salary wrong' },
    [],
    dependencies
  );

  expect(result.contextReadiness).toBe('partial');
  expect(result.technical.status).toBe('partial');
  expect(result.technical.health).toBeNull();
  expect(result.technical.errors).toEqual(['Health gate: health unavailable']);
  expect(result.guidance).toContain('process context is still partial');
});
