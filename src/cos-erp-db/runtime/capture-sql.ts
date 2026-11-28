import { hostname } from 'node:os';
import { executeDatabaseAction, type DatabaseActionInput, type DatabaseActionOutput } from '../../main/database/service.js';

type Execute = (input: DatabaseActionInput, options?: { signal?: AbortSignal }) => Promise<DatabaseActionOutput>;
type Row = Record<string, unknown>;
const MAX_REQUESTS = 60;
const MAX_SAMPLES = 120;
const SAMPLE_INTERVAL_MS = 1000;

export function runtimeSqlSampleQuery(pid: number, host: string): string {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !host.trim() || host.length > 255) throw new Error('Invalid SQL runtime target.');
  const literal = "N'" + host.replace(/'/g, "''") + "'";
  return `SELECT TOP (31) r.session_id AS SessionId,r.request_id AS RequestId,r.start_time AS RequestStart,
    s.host_process_id AS HostPid,s.host_name AS HostName,DB_NAME(r.database_id) AS DatabaseName,
    r.status AS Status,r.command AS Command,r.total_elapsed_time AS ElapsedMs,r.cpu_time AS CpuMs,
    r.logical_reads AS LogicalReads,r.wait_type AS WaitType,r.blocking_session_id AS BlockingSessionId,
    LEFT(SUBSTRING(txt.text,(r.statement_start_offset/2)+1,
      ((CASE WHEN r.statement_end_offset=-1 THEN DATALENGTH(txt.text) ELSE r.statement_end_offset END-r.statement_start_offset)/2)+1),2000) AS StatementText,
    LEFT(buf.event_info,2000) AS SubmittedBatch
  FROM sys.dm_exec_requests r JOIN sys.dm_exec_sessions s ON s.session_id=r.session_id
  OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) txt
  OUTER APPLY sys.dm_exec_input_buffer(r.session_id,r.request_id) buf
  WHERE s.is_user_process=1 AND r.session_id<>@@SPID AND r.database_id=DB_ID()
    AND s.host_process_id=${pid} AND UPPER(s.host_name)=UPPER(${literal})
  ORDER BY r.start_time,r.session_id,r.request_id`;
}

export interface RuntimeSqlObservation {
  firstSeenUtc: string;
  lastSeenUtc: string;
  sampleCount: number;
  request: Row;
}

export interface RuntimeSqlEvidence {
  connection: string;
  database: string | null;
  pid: number;
  host: string;
  state: 'sampling' | 'stopped' | 'unavailable';
  samples: number;
  emptySamples: number;
  truncated: boolean;
  observations: RuntimeSqlObservation[];
  limitations: string[];
  error?: string;
}

/** Uses the same configured DB read service and query gate as the normal MCP query action.
 * No SQL Server trace sessions are created; the only work is bounded SELECT sampling.
 */
export class RuntimeSqlCapture {
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private state: RuntimeSqlEvidence['state'] = 'sampling';
  private samples = 0;
  private emptySamples = 0;
  private database: string | null = null;
  private resolvedConnection: string | null = null;
  private truncated = false;
  private error: string | undefined;
  private readonly observed = new Map<string, RuntimeSqlObservation>();
  private readonly query: string;
  private readonly deadline: number;

  constructor(
    private readonly connection: string,
    private readonly pid: number,
    captureDeadlineUtc: string,
    private readonly execute: Execute = (input, options) => executeDatabaseAction(input, undefined, options),
    private readonly host = hostname(),
    private readonly clock = Date.now,
    private readonly isCollectorActive = () => true
  ) {
    this.query = runtimeSqlSampleQuery(pid, host);
    const deadline = Date.parse(captureDeadlineUtc);
    if (!Number.isFinite(deadline)) throw new Error('Missing capture deadline.');
    this.deadline = Math.min(deadline, clock() + 120_000);
  }

  start(): void {
    if (this.state !== 'sampling' || this.deadlineTimer || this.samples) return;
    this.deadlineTimer = setTimeout(() => this.stop(), Math.max(0, this.deadline - this.clock()));
    this.deadlineTimer.unref?.();
    void this.sample();
  }

  stop(): void {
    if (this.state === 'sampling') this.state = 'stopped';
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.timer = undefined;
    this.deadlineTimer = undefined;
  }

  private async sample(): Promise<void> {
    if (this.state !== 'sampling' || this.clock() >= this.deadline || this.samples >= MAX_SAMPLES || !this.isCollectorActive()) {
      this.stop();
      return;
    }
    this.samples++;
    try {
      const result = await this.execute({ action: 'query', connection: this.connection, sql: this.query }, { signal: this.abort.signal });
      if (this.abort.signal.aborted || this.clock() >= this.deadline || !this.isCollectorActive()) { this.stop(); return; }
      if (result.action !== 'query') throw new Error('Unexpected SQL sampling response.');
      if ((this.database && this.database !== result.database) || (this.resolvedConnection && this.resolvedConnection !== result.connection)) {
        throw new Error('Database identity changed during runtime capture.');
      }
      this.database = result.database;
      this.resolvedConnection = result.connection;
      const seen = new Date(this.clock()).toISOString();
      const rows = result.rows.filter(row => row.HostPid === this.pid &&
        typeof row.HostName === 'string' && row.HostName.toLowerCase() === this.host.toLowerCase() &&
        row.DatabaseName === this.database);
      if (!rows.length) this.emptySamples++;
      this.truncated ||= result.truncated || rows.length > 30;
      for (const row of rows.slice(0, 30)) {
        const key = JSON.stringify([row.SessionId,row.RequestId,row.RequestStart,row.StatementText,row.SubmittedBatch]);
        const existing = this.observed.get(key);
        if (existing) { existing.lastSeenUtc = seen; existing.sampleCount++; existing.request = row; continue; }
        if (this.observed.size >= MAX_REQUESTS) { this.truncated = true; continue; }
        this.observed.set(key, { firstSeenUtc: seen, lastSeenUtc: seen, sampleCount: 1, request: row });
      }
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      this.state = 'unavailable';
      this.stop();
      return;
    }
    if (this.state === 'sampling' && this.clock() < this.deadline && this.samples < MAX_SAMPLES) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.sample(); }, Math.min(SAMPLE_INTERVAL_MS, this.deadline - this.clock()));
      this.timer.unref?.();
    } else this.stop();
  }

  snapshot(captureEndUtc?: string): RuntimeSqlEvidence {
    const end = captureEndUtc ? Date.parse(captureEndUtc) : Infinity;
    const observations = [...this.observed.values()].filter(item => Date.parse(item.firstSeenUtc) <= end).map(item => ({
      ...item,
      lastSeenUtc: Date.parse(item.lastSeenUtc) > end ? new Date(end).toISOString() : item.lastSeenUtc,
      request: { ...item.request }
    }));
    return {
      connection: this.resolvedConnection ?? this.connection, database: this.database, pid: this.pid, host: this.host,
      state: this.state, samples: this.samples, emptySamples: this.emptySamples, truncated: this.truncated, observations,
      limitations: [
        'Read-only active-request sampling, not a lossless SQL trace. Fast requests, completed calls and unavailable DMV rows can be missed.',
        'Host name and client process ID are SQL session metadata, not cryptographic identity. Use the observed .NET process and capture window; no causal attribution is implied.',
        'SQL Server DMV permissions may limit visibility; an empty sample does not prove no SQL ran.',
        'Submitted batch may contain literals or parameters when available; SQL Server does not expose all parameter values.'
      ], ...(this.error ? { error: this.error } : {})
    };
  }
}

/** Candidate associations only: observations and exceptions overlap in local time.
 * Do not attach a request to an exception merely because it is the latest row.
 */
export function correlateRuntimeExceptions(sql: RuntimeSqlEvidence, evidence?: Row) {
  const events = Array.isArray(evidence?.events) ? evidence.events as Row[] : [];
  return events.flatMap((event, index) => {
    const time = typeof event.timeUtc === 'string' ? Date.parse(event.timeUtc) : NaN;
    if (!Number.isFinite(time) || (event.pid !== undefined && event.pid !== sql.pid)) return [];
    const candidates = sql.observations.flatMap((observation, observationIndex) => {
      const first = Date.parse(observation.firstSeenUtc), last = Date.parse(observation.lastSeenUtc);
      const distanceMs = Math.max(first - time, time - last, 0);
      return distanceMs <= 1000 ? [{ observationIndex, distanceMs }] : [];
    }).sort((a,b) => a.distanceMs - b.distanceMs).slice(0, 5);
    return [{ exceptionIndex: index, candidates, confidence: 'temporal-candidate' as const }];
  });
}
