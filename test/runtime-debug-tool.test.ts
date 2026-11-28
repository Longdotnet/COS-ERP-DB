import { describe, expect, it, vi } from 'vitest';
import { RuntimeDebugService, runtimeDebugSchema } from '../src/cos-erp-db/mcp/runtime-debug-tool.js';
import type { ToolResult } from '../src/main/mcp/kernel.js';

const owner = { sessionId: 'session-a', requestId: null };
const other = { sessionId: 'session-b', requestId: null };
const start = runtimeDebugSchema.parse({ action: 'start', pid: 123, processStartUtc: '2026-11-25T02:00:00.1234567Z' });
const receipt = (output: string, extra: Record<string, unknown> = {}): ToolResult => ({
  content: [{ type: 'text', text: output }], structuredContent: { output, ...extra }
});

describe('runtime_debug', () => {
  it('validates target identity and rejects mixed actions', () => {
    expect(runtimeDebugSchema.safeParse({ action: 'start', pid: 123 }).success).toBe(false);
    expect(runtimeDebugSchema.safeParse({ action: 'processes', pid: 123 }).success).toBe(false);
    expect(runtimeDebugSchema.safeParse({ action: 'processes', connection: 'noibo' }).success).toBe(false);
    expect(runtimeDebugSchema.safeParse({ ...start, connection: 'noibo' }).success).toBe(true);
    expect(runtimeDebugSchema.safeParse({ action: 'start', pid: 123, processStartUtc: "x'; whoami" }).success).toBe(false);
  });

  it('keeps capture custody across calls, stops only its own trace and returns captured evidence', async () => {
    const service = new RuntimeDebugService();
    let key = '';
    const run = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'exec_command' && String(args.cmd).includes('-TargetProcessId 123')) {
        key = /-TraceKey '([0-9a-f]{32})'/.exec(String(args.cmd))![1]!;
        return receipt('TRACE_READY ' + JSON.stringify({ session: 'COS-LiveDebug-' + key, pid: 123, deadlineUtc: '2026-11-25T02:02:00Z' }) + '\n', { session_id: 42 });
      }
      if (name === 'exec_command') {
        expect(args.cmd).toContain('COS-LiveDebug-' + key);
        expect(args.cmd).toContain('stop.signal');
        return receipt('', { exit_code: 0 });
      }
      expect(args.session_id).toBe(42);
      return receipt('TRACE_RESULT ' + JSON.stringify({ session: 'COS-LiveDebug-' + key, pid: 123, events: [{ type: 'System.FormatException' }] }) + '\n', { exit_code: 0 });
    });
    const started = await service.run(start, owner, run, '/project');
    const traceId = started.structuredContent!.traceId as string;
    expect(started.structuredContent).toMatchObject({ state: 'capturing' });
    const stop = runtimeDebugSchema.parse({ action: 'stop', traceId });
    expect((await service.run(stop, other, run, '/project')).isError).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await service.run(start, owner, run, '/project')).isError).toBe(true);
    const done = await service.run(stop, owner, run, '/project');
    expect(done.structuredContent).toMatchObject({ state: 'completed', evidence: { events: [{ type: 'System.FormatException' }] } });
    expect(await service.run(stop, owner, run, '/project')).toEqual(done);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('does not claim readiness when ETW startup fails', async () => {
    const service = new RuntimeDebugService();
    const result = await service.run(start, owner, async () => receipt('Access is denied', { exit_code: 1 }), '/project');
    expect(result.structuredContent).toMatchObject({ state: 'failed', error: 'Access is denied' });
  });

  it('parses a single window into an array and an empty list without a fake process', async () => {
    const service = new RuntimeDebugService();
    const list = runtimeDebugSchema.parse({ action: 'processes' });
    expect((await service.run(list, owner, async () => receipt('{"pid":123}', { exit_code: 0 }), '/project')).structuredContent).toEqual({ processes: [{ pid: 123 }] });
    expect((await service.run(list, owner, async () => receipt('', { exit_code: 0 }), '/project')).structuredContent).toEqual({ processes: [] });
  });
});
