import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  initDatabaseIncidentHistory,
  readDatabaseIncidentHistory,
  resetDatabaseIncidentHistoryForTests,
  saveDatabaseIncidentSnapshot
} from '../src/cos-erp-db/investigation/incident-history.js';

describe('database incident history V2', () => {
  it('reads V1 snapshots, normalizes new session evidence, and writes V2 on the next save', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-db-incident-'));
    const file = path.join(root, 'database-incident-history.json');
    try {
      await writeFile(file, `${JSON.stringify({
        version: 1,
        snapshots: [{
          id: '00000000-0000-4000-8000-000000000001',
          connection: 'linkq-test',
          database: 'L80LINKQ.TEST',
          capturedAt: '2026-09-17T07:30:00.000Z',
          savedAt: '2026-09-17T07:30:01.000Z',
          summary: { totalMb: 100, dataUsedMb: 70, logUsedPercent: 12.5, activeRequestCount: 1, blockedRequestCount: 1, failedJobCount: 0 },
          requests: [{
            sessionId: 71, status: 'suspended', command: 'SELECT', database: 'L80LINKQ.TEST', login: 'erp', host: 'PC-01', program: 'LinkQ ERP',
            elapsedMs: 15000, cpuMs: 12, logicalReads: 22, writes: 0, waitType: 'LCK_M_S', waitMs: 12000,
            blockingSessionId: -2, openTransactionCount: 0, sql: 'X'.repeat(9000)
          }],
          jobs: [], findings: [], limitations: []
        }]
      }, null, 2)}\n`, 'utf8');
      initDatabaseIncidentHistory(root);

      const legacy = await readDatabaseIncidentHistory('linkq-test');

      expect(legacy.snapshots).toHaveLength(1);
      expect(legacy.snapshots[0]?.requests[0]).toMatchObject({
        blockingSessionId: -2,
        isBlocked: true,
        isBlocker: false,
        isRootBlocker: false,
        isSleepingTransaction: false,
        lastWaitType: null,
        waitResource: null,
        transactionBeginTime: null,
        transactionAgeSeconds: null,
        queryHash: null,
        queryPlanHash: null,
        reasonMask: 0
      });
      expect(legacy.snapshots[0]?.requests[0]?.sql).toHaveLength(8000);

      const saved = await saveDatabaseIncidentSnapshot({ ...legacy.snapshots[0]!, savedAt: null });
      expect(saved.snapshots[0]?.savedAt).not.toBeNull();
      const disk = JSON.parse(await readFile(file, 'utf8')) as { version: number; snapshots: unknown[] };
      expect(disk.version).toBe(2);
      expect(disk.snapshots).toHaveLength(1);
    } finally {
      resetDatabaseIncidentHistoryForTests();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('incident diagnosis service', () => {
  it('diagnoses without persistence, resolves the default connection, and persists only through captureIncident', async () => {
    vi.resetModules();
    const resolveSqlServerProfile = vi.fn(async (requested?: string) => ({
      id: requested ?? 'linkq-default',
      name: 'LinkQ Test',
      accessMode: 'read-only',
      connection: {
        server: 'localhost',
        database: 'L80LINKQ.TEST',
        authentication: { type: 'sql', user: 'test', password: 'secret' }
      }
    }));
    const readSqlServerGrowthDiagnostics = vi.fn(async () => ({
      summary: { totalMb: 100, dataUsedMb: 70, logUsedPercent: 15 },
      findings: [],
      limitations: []
    }));
    const readSqlServerLivePerformance = vi.fn(async (connectionId: string) => ({
      connection: connectionId,
      database: 'L80LINKQ.TEST',
      capturedAt: '2026-09-19T01:00:00.000Z',
      requests: [],
      incidentSessions: [],
      hotspots: [],
      activeRequestCount: 0,
      blockedRequestCount: 0,
      rootBlockerSessionIds: [],
      thresholds: { blockingThresholdMs: 10000, longRequestThresholdMs: 60000, openTransactionThresholdSeconds: 60 },
      limitations: [],
      elapsedMs: 1
    }));
    const readSqlServerJobs = vi.fn(async (connectionId: string) => ({
      connection: connectionId,
      database: 'L80LINKQ.TEST',
      available: true,
      capturedAt: '2026-09-19T01:00:00.000Z',
      jobs: [],
      failedJobCount: 0,
      disabledJobCount: 0,
      limitations: [],
      elapsedMs: 1
    }));
    const saveDatabaseIncidentSnapshot = vi.fn(async (snapshot: { connection: string; savedAt: string | null }) => ({
      connection: snapshot.connection,
      snapshots: [{ ...snapshot, savedAt: '2026-09-19T01:00:01.000Z' }]
    }));

    vi.doMock('../src/main/database/profiles.js', () => ({ resolveSqlServerProfile }));
    vi.doMock('../src/main/database/growth-diagnostics.js', () => ({ readSqlServerGrowthDiagnostics }));
    vi.doMock('../src/cos-erp-db/investigation/sqlserver-investigator.js', async () => ({
      ...(await vi.importActual<typeof import('../src/cos-erp-db/investigation/sqlserver-investigator.js')>('../src/cos-erp-db/investigation/sqlserver-investigator.js')),
      readSqlServerLivePerformance,
      readSqlServerJobs
    }));
    vi.doMock('../src/cos-erp-db/investigation/incident-history.js', async () => ({
      ...(await vi.importActual<typeof import('../src/cos-erp-db/investigation/incident-history.js')>('../src/cos-erp-db/investigation/incident-history.js')),
      saveDatabaseIncidentSnapshot
    }));

    try {
      const service = await import('../src/cos-erp-db/investigation/service.js');
      const diagnostic = await service.diagnoseIncident();

      expect(resolveSqlServerProfile).toHaveBeenCalledWith(undefined);
      expect(diagnostic.connection).toBe('linkq-default');
      expect(diagnostic.savedAt).toBeNull();
      expect(saveDatabaseIncidentSnapshot).not.toHaveBeenCalled();

      const captured = await service.captureIncident('linkq-test');
      expect(resolveSqlServerProfile).toHaveBeenLastCalledWith('linkq-test');
      expect(saveDatabaseIncidentSnapshot).toHaveBeenCalledTimes(1);
      expect(captured.connection).toBe('linkq-test');
    } finally {
      vi.doUnmock('../src/main/database/profiles.js');
      vi.doUnmock('../src/main/database/growth-diagnostics.js');
      vi.doUnmock('../src/cos-erp-db/investigation/sqlserver-investigator.js');
      vi.doUnmock('../src/cos-erp-db/investigation/incident-history.js');
      vi.resetModules();
    }
  });
});
