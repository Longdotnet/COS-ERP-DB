import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { currentCall, currentCaller } from '../../main/mcp/call-context.js';
import { fail, type SurfaceRegistrar, type ToolResult } from '../../main/mcp/kernel.js';
import { toolDeclaration } from '../../main/mcp/tool-declarations.js';
import { provenSession } from '../../main/codex/ownership.js';
import { captureClrExceptions } from '../runtime/capture-clr.js';

export const runtimeDebugSchema = z.object({
  action: z.enum(['processes', 'start', 'status', 'stop']),
  pid: z.number().int().positive().max(2147483647).optional(),
  processStartUtc: z.iso.datetime().optional(),
  seconds: z.number().int().min(10).max(120).optional(),
  traceId: z.uuid().optional()
}).strict().superRefine((a, ctx) => {
  const start = a.action === 'start';
  const follow = a.action === 'status' || a.action === 'stop';
  if (start !== (a.pid !== undefined && a.processStartUtc !== undefined)
    || (!start && (a.pid !== undefined || a.processStartUtc !== undefined || a.seconds !== undefined))
    || follow !== (a.traceId !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'start requires pid and processStartUtc; status/stop require traceId; processes takes no other fields' });
  }
});

type Input = z.infer<typeof runtimeDebugSchema>;
type Owner = { requestId: string | null; sessionId: string | null };
type Runner = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
type Capture = {
  id: string; pid: number; owner: Owner; created: number; terminal?: number;
  ready?: Record<string, unknown>; result?: Record<string, unknown>;
  state: 'starting' | 'capturing' | 'stopping' | 'completed' | 'failed';
  error?: string; busy: boolean; buffer: string;
};

function response(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function sameOwner(a: Owner, b: Owner): boolean {
  const first = provenSession(a.requestId, a.sessionId);
  const second = provenSession(b.requestId, b.sessionId);
  return first && second ? first === second : !!a.requestId && a.requestId === b.requestId;
}

const terminalOutput = (r: ToolResult) => r.structuredContent as {
  output?: string; session_id?: number; completed_session_id?: number; exit_code?: number
} | undefined;
const PROCESS_COMMAND = "Get-Process | Where-Object MainWindowTitle | ForEach-Object { try { [pscustomobject]@{ pid=$_.Id; process=$_.ProcessName; window=$_.MainWindowTitle; processStartUtc=$_.StartTime.ToUniversalTime().ToString('o') } } catch {} } | Select-Object -First 100 | ConvertTo-Json -Compress";

export class RuntimeDebugService {
  private traces = new Map<string, Capture>();
  constructor(private readonly owns = sameOwner) {}

  private view(t: Capture): ToolResult {
    const { id, pid, state, ready, result, error } = t;
    return response({ traceId: id, pid, state, ...(ready ? { target: ready } : {}),
      ...(result ? { evidence: result } : {}), ...(error ? { error } : {}),
      ...(state === 'capturing' ? { guidance: 'Ask the user to reproduce the issue before deadlineUtc, then call stop.' } : {}),
      ...(state === 'completed' ? { guidance: 'First-chance exceptions are evidence, not a confirmed root cause. Correlate with source and database.' } : {}) });
  }

  private consume(t: Capture, r: ToolResult): void {
    if (r.isError) {
      t.error = r.content.filter(c => c.type === 'text').map(c => c.text).join(' ').slice(0, 1500);
      // A failed poll does not prove the collector stopped; allow the owner to retry.
      if (!t.terminal) t.state = 'failed';
      return;
    }
    const o = terminalOutput(r);
    if (!o) { t.error = 'Missing terminal receipt'; if (!t.terminal) t.state = 'failed'; return; }
    t.error = undefined;
    t.terminal = o.session_id ?? o.completed_session_id ?? t.terminal;
    t.buffer += o.output ?? '';
    const lines = t.buffer.split(/\r?\n/);
    t.buffer = lines.pop() ?? '';
    if (o.exit_code !== undefined && t.buffer) { lines.push(t.buffer); t.buffer = ''; }
    for (const line of lines) {
      const match = /^TRACE_(READY|RESULT) (.*)$/.exec(line);
      if (!match) continue;
      try {
        const value = JSON.parse(match[2]!) as Record<string, unknown>;
        if (value.pid !== t.pid || value.session !== 'COS-LiveDebug-' + t.id.replaceAll('-', '')) continue;
        if (match[1] === 'READY') {
          const { stopFile: _localPath, ...receipt } = value;
          t.ready = receipt;
          if (t.state === 'starting') t.state = 'capturing';
        } else t.result = value;
      } catch { t.error = 'Incomplete trace receipt'; }
    }
    if (t.buffer.length > 64_000) { t.buffer = ''; t.error = 'Trace receipt exceeded output limit'; }
    if (o.exit_code !== undefined) {
      t.state = o.exit_code === 0 && t.result ? 'completed' : 'failed';
      if (t.state === 'failed') t.error ??= (o.output || 'Collector ended without a trace result').slice(0, 1500);
    } else if (!t.terminal) { t.state = 'failed'; t.error = 'No terminal session was returned'; }
  }

  async run(input: Input, owner: Owner, runner: Runner, workdir: string): Promise<ToolResult> {
    const command = (cmd: string, yield_time_ms = 1000) => runner('exec_command', {
      cmd, workdir, shell: 'powershell.exe', tty: false, yield_time_ms
    });
    if (input.action === 'processes') {
      const r = await command(PROCESS_COMMAND, 5000);
      if (r.isError || terminalOutput(r)?.exit_code !== 0) return r;
      const raw = terminalOutput(r)?.output?.trim();
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return response({ processes: Array.isArray(parsed) ? parsed : [parsed] });
    }
    if (!owner.requestId && !owner.sessionId) return fail('Runtime debugging requires a proven session or request identity.');
    const now = Date.now();
    for (const [id, trace] of this.traces) {
      if (!trace.busy && now - trace.created > 30 * 60_000) this.traces.delete(id);
    }
    if (input.action === 'start') {
      const active = [...this.traces.values()].filter(t => !['completed', 'failed'].includes(t.state) && now - t.created < 180_000);
      if (active.length >= 2 || active.some(t => t.pid === input.pid)) return fail('A trace is already active; read or stop it before starting another.');
      if (this.traces.size >= 32) {
        const oldest = [...this.traces.values()].find(t => !t.busy && ['completed', 'failed'].includes(t.state));
        if (!oldest) return fail('Trace retention limit reached.');
        this.traces.delete(oldest.id);
      }
      const t: Capture = { id: randomUUID(), pid: input.pid!, owner, created: now, state: 'starting', busy: true, buffer: '' };
      this.traces.set(t.id, t);
      try {
        const key = t.id.replaceAll('-', '');
        // The schema restricts the PID, duration and timestamp; no arbitrary shell text is accepted.
        const script = "& {\n" + captureClrExceptions + "\n} -TargetProcessId " + t.pid
          + " -DurationSeconds " + (input.seconds ?? 90) + " -TraceKey '" + key
          + "' -ExpectedStartUtc '" + input.processStartUtc + "'";
        this.consume(t, await command(script));
        if (t.state === 'starting' && t.terminal) {
          this.consume(t, await runner('write_stdin', { session_id: t.terminal, chars: '', yield_time_ms: 1000 }));
        }
        return this.view(t);
      } catch (error) {
        if (!t.terminal) t.state = 'failed';
        t.error = error instanceof Error ? error.message : String(error);
        return this.view(t);
      } finally { t.busy = false; }
    }
    const t = this.traces.get(input.traceId!);
    if (!t || !this.owns(t.owner, owner)) return fail('Trace not found for this session.');
    if (t.busy) return fail('Trace operation already in progress.');
    if (t.state === 'completed' || t.state === 'failed') return this.view(t);
    if (!t.terminal) return this.view(t);
    t.busy = true;
    try {
      if (input.action === 'stop' && t.state === 'capturing') {
        // Generated key only; no model-provided path. No marker is created after collector cleanup.
        const key = 'COS-LiveDebug-' + t.id.replaceAll('-', '');
        const r = await command("$folder = Join-Path ([IO.Path]::GetTempPath()) '" + key
          + "'; if ([IO.Directory]::Exists($folder)) { try { [IO.File]::WriteAllText((Join-Path $folder 'stop.signal'), '') } catch [IO.DirectoryNotFoundException] {} }");
        if (r.isError || terminalOutput(r)?.exit_code !== 0) return r;
        t.state = 'stopping';
      }
      this.consume(t, await runner('write_stdin', { session_id: t.terminal, chars: '', yield_time_ms: 1000 }));
      return this.view(t);
    } finally { t.busy = false; }
  }
}

const service = new RuntimeDebugService();

export function registerRuntimeDebugTool(reg: SurfaceRegistrar): void {
  if (process.platform !== 'win32' || !reg.exposedCaps.command) return;
  reg.register('runtime_debug', toolDeclaration('runtime_debug', () => ({
    title: 'Runtime debugging',
    description: 'Windows .NET exception trace: list processes, start a bounded capture, ask the user to reproduce, then stop or read status in the same chat. Returns timestamped exception evidence.',
    inputSchema: runtimeDebugSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  })), async input => reg.guarded('command', 'runtime_debug', async () => {
    const parent = currentCall();
    const root = reg.ctx.roots.find(r => !r.remote);
    if (!parent || !root) return fail('Runtime debugging requires a local approved workspace and call context.');
    const caller = currentCaller();
    try {
      return await service.run(input, { requestId: caller.requestId, sessionId: caller.sessionId ?? null },
        (name, args) => reg.invokeNested(name, args, parent), '/' + root.name);
    } catch (error) { return fail('Runtime debug failed: ' + (error instanceof Error ? error.message : String(error))); }
  }));
}
