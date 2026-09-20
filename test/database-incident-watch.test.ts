import { describe, expect, it, vi } from 'vitest';
import type { DatabaseIncidentSnapshot } from '../src/cos-erp-db/investigation/types.js';
import {
  IncidentWatchController,
  incidentFingerprint
} from '../src/main/database/incident-watch.js';

function snapshot(reasonMask: number, blocker = 88): DatabaseIncidentSnapshot {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    connection: 'linkq-test',
    database: 'L80LINKQ.TEST',
    capturedAt: '2026-09-19T02:00:00.000Z',
    savedAt: null,
    summary: {
      totalMb: null,
      dataUsedMb: null,
      logUsedPercent: null,
      activeRequestCount: reasonMask ? 1 : 0,
      blockedRequestCount: reasonMask & 1 ? 1 : 0,
      failedJobCount: null
    },
    requests: reasonMask ? [{
      sessionId: 71,
      status: 'suspended',
      command: 'SELECT',
      database: 'L80LINKQ.TEST',
      login: 'erp',
      host: 'PC-01',
      program: 'LinkQ ERP',
      elapsedMs: 20_000,
      cpuMs: 100,
      logicalReads: 500,
      writes: 0,
      waitType: 'LCK_M_S',
      lastWaitType: 'LCK_M_S',
      waitMs: 15_000,
      waitResource: 'KEY: 7:1',
      blockingSessionId: blocker,
      openTransactionCount: 0,
      transactionBeginTime: null,
      transactionAgeSeconds: null,
      queryHash: '0x1111',
      queryPlanHash: '0xAAAA',
      isBlocked: true,
      isBlocker: false,
      isRootBlocker: false,
      isSleepingTransaction: false,
      reasonMask,
      sql: 'SELECT * FROM dbo.L09TDDMUNGVIEN'
    }] : [],
    jobs: [],
    findings: [],
    limitations: []
  };
}

describe('database incident watch', () => {
  it('deduplicates one active incident and rearms after it clears', async () => {
    let now = 0;
    const diagnose = vi.fn();
    diagnose
      .mockResolvedValueOnce(snapshot(9))
      .mockResolvedValueOnce(snapshot(9))
      .mockResolvedValueOnce(snapshot(0))
      .mockResolvedValueOnce(snapshot(9));
    const save = vi.fn(async (value: DatabaseIncidentSnapshot) => ({
      connection: value.connection,
      snapshots: [{ ...value, savedAt: new Date(now).toISOString() }]
    }));
    const controller = new IncidentWatchController({
      diagnose,
      save,
      now: () => now,
      schedule: (() => ({ unref: () => undefined } as unknown as ReturnType<typeof setTimeout>)),
      cancel: () => undefined
    });

    controller.start('linkq-test');
    await controller.pollNow('linkq-test');
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.status('linkq-test')).toMatchObject({ incidentActive: true, capturedCount: 1 });

    now = 10_000;
    await controller.pollNow('linkq-test');
    expect(save).toHaveBeenCalledTimes(1);

    now = 20_000;
    await controller.pollNow('linkq-test');
    expect(controller.status('linkq-test').incidentActive).toBe(false);

    now = 30_000;
    await controller.pollNow('linkq-test');
    expect(save).toHaveBeenCalledTimes(2);
    expect(controller.status('linkq-test').capturedCount).toBe(2);
  });

  it('treats blocker/query evidence changes as a new fingerprint and exposes failures without stopping the watch', async () => {
    expect(incidentFingerprint(snapshot(9, 88))).not.toBe(incidentFingerprint(snapshot(9, 99)));

    let now = 1000;
    const controller = new IncidentWatchController({
      diagnose: vi.fn(async () => { throw new Error('SELECT permission denied'); }),
      save: vi.fn(),
      now: () => now,
      schedule: (() => ({ unref: () => undefined } as unknown as ReturnType<typeof setTimeout>)),
      cancel: () => undefined
    });

    controller.start('linkq-test');
    await controller.pollNow('linkq-test');
    expect(controller.status('linkq-test')).toMatchObject({
      watching: true,
      lastError: 'SELECT permission denied',
      lastCheckedAt: '1970-01-01T00:00:01.000Z'
    });

    now = 2000;
    expect(controller.stop('linkq-test').watching).toBe(false);
  });

  it('does not persist an in-flight diagnosis after Stop invalidates its generation', async () => {
    let release!: (value: DatabaseIncidentSnapshot) => void;
    const diagnose = vi.fn(() => new Promise<DatabaseIncidentSnapshot>(resolve => { release = resolve; }));
    const save = vi.fn(async (value: DatabaseIncidentSnapshot) => ({ connection: value.connection, snapshots: [value] }));
    const controller = new IncidentWatchController({
      diagnose,
      save,
      now: () => 5_000,
      schedule: (() => ({ unref: () => undefined } as unknown as ReturnType<typeof setTimeout>)),
      cancel: () => undefined
    });

    controller.start('linkq-test');
    const poll = controller.pollNow('linkq-test');
    expect(diagnose).toHaveBeenCalledTimes(1);
    controller.stop('linkq-test');
    release(snapshot(9));
    await poll;

    expect(save).not.toHaveBeenCalled();
    expect(controller.status('linkq-test')).toMatchObject({ watching: false, capturedCount: 0 });
  });
});
