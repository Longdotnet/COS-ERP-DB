import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeSqlCapture, correlateRuntimeExceptions, runtimeSqlSampleQuery } from '../src/cos-erp-db/runtime/capture-sql.js';
import { assertReadOnlySql, type DatabaseActionInput, type DatabaseQueryOutput } from '../src/main/database/service.js';

const row = { SessionId: 11, RequestId: 1, RequestStart: '2026-11-28T02:00:00', HostPid: 123, HostName: 'ASUZ', DatabaseName: 'L70NOIBO', StatementText: 'SELECT 1' };
const response = (rows: Record<string, unknown>[]): DatabaseQueryOutput => ({ action: 'query', connection: 'noibo', database: 'L70NOIBO', columns: [], rows, rowCount: rows.length, elapsedMs: 5, truncated: false });
afterEach(() => vi.useRealTimers());

it('samples only the configured database, local host and PID; deduplicates request observations', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-28T02:00:00Z'));
  const execute = vi.fn(async (input: DatabaseActionInput) => {
    if (input.action !== 'query') throw new Error('unexpected database action');
    expect(input.connection).toBe('noibo');
    return response([row, { ...row, HostPid: 124 }, { ...row, HostName: 'OTHER' }, { ...row, DatabaseName: 'OTHER' }]);
  });
  const capture = new RuntimeSqlCapture('noibo',123,'2026-11-28T02:00:10Z',execute,'ASUZ');
  capture.start();
  await vi.advanceTimersByTimeAsync(2000);
  const result = capture.snapshot();
  expect(result.observations).toHaveLength(1);
  expect(result.observations[0]?.sampleCount).toBe(3);
  expect(result.samples).toBe(3);
  expect(correlateRuntimeExceptions(result,{ events: [
    { pid: 123, timeUtc: '2026-11-28T02:00:01Z' },
    { pid: 123, timeUtc: '2026-11-28T02:00:08Z' },
    { pid: 999, timeUtc: '2026-11-28T02:00:01Z' }
  ]})).toEqual([
    { exceptionIndex: 0, candidates: [{ observationIndex: 0, distanceMs: 0 }], confidence: 'temporal-candidate' },
    { exceptionIndex: 1, candidates: [], confidence: 'temporal-candidate' }
  ]);
  capture.stop();
  await vi.advanceTimersByTimeAsync(20000);
  expect(execute).toHaveBeenCalledTimes(3);
});

it('stops when the CLR collector lease ends and rejects late SQL samples', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-28T02:00:00Z'));
  let active = true;
  let release!: (r: DatabaseQueryOutput) => void;
  const execute = vi.fn(() => new Promise<DatabaseQueryOutput>(resolve => { release = resolve; }));
  const capture = new RuntimeSqlCapture('noibo',123,'2026-11-28T02:00:10Z',execute,'ASUZ',Date.now,()=>active);
  capture.start();
  active = false;
  release(response([row]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(capture.snapshot()).toMatchObject({ state: 'stopped', observations: [] });
  expect(execute).toHaveBeenCalledTimes(1);
});

it('uses a bounded read-only query and escaped host literal', () => {
  const sql = assertReadOnlySql(runtimeSqlSampleQuery(123,"host'quoted"));
  expect(sql).toContain("N'host''quoted'");
  expect(sql).toContain('s.host_process_id=123');
  expect(sql).toContain('r.database_id=DB_ID()');
  expect(() => runtimeSqlSampleQuery(-1,'host')).toThrow();
});
