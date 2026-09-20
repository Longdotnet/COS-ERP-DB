import type {
  DatabaseIncidentHistoryResult,
  DatabaseIncidentSnapshot,
  DatabaseIncidentWatchStatus
} from '../../cos-erp-db/investigation/types.js';
import { saveDatabaseIncidentSnapshot } from '../../cos-erp-db/investigation/incident-history.js';
import { diagnoseIncidentForWatch } from '../../cos-erp-db/investigation/service.js';

export const INCIDENT_WATCH_INTERVAL_MS = 10_000;
export const INCIDENT_WATCH_MIN_CAPTURE_GAP_MS = 10_000;

type Timer = ReturnType<typeof setTimeout>;

interface WatchState {
  connection: string;
  watching: boolean;
  generation: number;
  timer: Timer | null;
  inFlight: Promise<void> | null;
  startedAt: string | null;
  lastCheckedAt: string | null;
  lastCapturedAt: string | null;
  lastCaptureMs: number | null;
  capturedCount: number;
  incidentActive: boolean;
  lastFingerprint: string | null;
  lastError: string | null;
}

export interface IncidentWatchDependencies {
  diagnose(connection: string): Promise<DatabaseIncidentSnapshot>;
  save(snapshot: DatabaseIncidentSnapshot): Promise<DatabaseIncidentHistoryResult>;
  now(): number;
  schedule(run: () => void, delayMs: number): Timer;
  cancel(timer: Timer): void;
}

function defaultSchedule(run: () => void, delayMs: number): Timer {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return timer;
}

const DEFAULT_DEPENDENCIES: IncidentWatchDependencies = {
  diagnose: diagnoseIncidentForWatch,
  save: saveDatabaseIncidentSnapshot,
  now: Date.now,
  schedule: defaultSchedule,
  cancel: clearTimeout
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function incidentFingerprint(snapshot: DatabaseIncidentSnapshot): string | null {
  const evidence = snapshot.requests
    .filter(session => session.reasonMask !== 0)
    .map(session => [
      session.sessionId,
      session.blockingSessionId,
      session.reasonMask,
      session.isRootBlocker ? 1 : 0,
      session.isSleepingTransaction ? 1 : 0,
      session.database ?? '',
      session.transactionBeginTime ?? '',
      session.waitType ?? session.lastWaitType ?? '',
      session.queryHash ?? '',
      session.queryPlanHash ?? '',
      session.queryHash ? '' : (session.sql ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000)
    ].join(':'))
    .sort();
  return evidence.length ? evidence.join('|') : null;
}

export class IncidentWatchController {
  private readonly states = new Map<string, WatchState>();

  constructor(
    private readonly dependencies: IncidentWatchDependencies = DEFAULT_DEPENDENCIES,
    private readonly intervalMs = INCIDENT_WATCH_INTERVAL_MS,
    private readonly minCaptureGapMs = INCIDENT_WATCH_MIN_CAPTURE_GAP_MS
  ) {}

  private key(connection: string): string {
    return connection.trim().toLowerCase();
  }

  private state(connection: string): WatchState {
    const key = this.key(connection);
    let state = this.states.get(key);
    if (!state) {
      state = {
        connection,
        watching: false,
        generation: 0,
        timer: null,
        inFlight: null,
        startedAt: null,
        lastCheckedAt: null,
        lastCapturedAt: null,
        lastCaptureMs: null,
        capturedCount: 0,
        incidentActive: false,
        lastFingerprint: null,
        lastError: null
      };
      this.states.set(key, state);
    }
    return state;
  }

  private statusOf(state: WatchState): DatabaseIncidentWatchStatus {
    return {
      connection: state.connection,
      watching: state.watching,
      intervalMs: this.intervalMs,
      startedAt: state.startedAt,
      lastCheckedAt: state.lastCheckedAt,
      lastCapturedAt: state.lastCapturedAt,
      capturedCount: state.capturedCount,
      incidentActive: state.incidentActive,
      lastError: state.lastError
    };
  }

  status(connection: string): DatabaseIncidentWatchStatus {
    return this.statusOf(this.state(connection));
  }

  start(connection: string): DatabaseIncidentWatchStatus {
    for (const candidate of this.states.values()) {
      if (candidate.watching && this.key(candidate.connection) !== this.key(connection)) {
        this.stop(candidate.connection);
      }
    }
    const state = this.state(connection);
    if (state.watching) return this.statusOf(state);
    state.watching = true;
    state.generation += 1;
    state.startedAt = iso(this.dependencies.now());
    state.lastError = null;
    state.lastFingerprint = null;
    state.lastCaptureMs = null;
    state.incidentActive = false;
    this.schedule(state, 0);
    return this.statusOf(state);
  }

  stop(connection: string): DatabaseIncidentWatchStatus {
    const state = this.state(connection);
    state.watching = false;
    state.generation += 1;
    if (state.timer) this.dependencies.cancel(state.timer);
    state.timer = null;
    return this.statusOf(state);
  }

  async stopAll(): Promise<void> {
    const inFlight = [...this.states.values()]
      .map(state => state.inFlight)
      .filter((value): value is Promise<void> => value !== null);
    for (const state of this.states.values()) this.stop(state.connection);
    await Promise.allSettled(inFlight);
  }

  async pollNow(connection: string): Promise<DatabaseIncidentWatchStatus> {
    const state = this.state(connection);
    const run = this.poll(state, state.generation);
    state.inFlight = run;
    try {
      await run;
    } finally {
      if (state.inFlight === run) state.inFlight = null;
    }
    return this.statusOf(state);
  }

  private schedule(state: WatchState, delayMs: number): void {
    if (!state.watching || state.timer) return;
    const generation = state.generation;
    state.timer = this.dependencies.schedule(() => {
      state.timer = null;
      const run = this.poll(state, generation);
      state.inFlight = run;
      void run.finally(() => {
        if (state.inFlight === run) state.inFlight = null;
        if (state.watching && state.generation === generation) this.schedule(state, this.intervalMs);
      });
    }, delayMs);
  }

  private async poll(state: WatchState, generation: number): Promise<void> {
    if (!state.watching || state.generation !== generation) return;
    try {
      const snapshot = await this.dependencies.diagnose(state.connection);
      const checkedMs = this.dependencies.now();
      if (!state.watching || state.generation !== generation) return;
      state.lastCheckedAt = iso(checkedMs);
      state.lastError = null;
      const fingerprint = incidentFingerprint(snapshot);
      state.incidentActive = fingerprint !== null;
      if (!fingerprint) {
        state.lastFingerprint = null;
        return;
      }
      if (fingerprint === state.lastFingerprint) return;
      if (state.lastCaptureMs !== null && checkedMs - state.lastCaptureMs < this.minCaptureGapMs) return;
      await this.dependencies.save(snapshot);
      if (!state.watching || state.generation !== generation) return;
      const capturedMs = this.dependencies.now();
      state.lastFingerprint = fingerprint;
      state.lastCaptureMs = capturedMs;
      state.lastCapturedAt = iso(capturedMs);
      state.capturedCount += 1;
    } catch (error) {
      if (!state.watching || state.generation !== generation) return;
      state.lastCheckedAt = iso(this.dependencies.now());
      state.lastError = error instanceof Error ? error.message : String(error);
    }
  }
}

const controller = new IncidentWatchController();

export function startIncidentWatch(connection: string): DatabaseIncidentWatchStatus {
  return controller.start(connection);
}

export function stopIncidentWatch(connection: string): DatabaseIncidentWatchStatus {
  return controller.stop(connection);
}

export function readIncidentWatchStatus(connection: string): DatabaseIncidentWatchStatus {
  return controller.status(connection);
}

export function stopAllIncidentWatches(): Promise<void> {
  return controller.stopAll();
}
