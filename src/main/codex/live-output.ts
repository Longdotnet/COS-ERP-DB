import { StringDecoder } from 'node:string_decoder';
import type { TerminalLiveUpdate } from '../../shared/terminal-live.js';
import { redactCredentialText } from '../redaction.js';

/** Enough recent terminal text to inspect a build without turning IPC into an unbounded log. */
const MAX_LIVE_OUTPUT_CHARS = 64 * 1024;
/** Coalesce noisy stdout/stderr streams so a fast command cannot repaint the renderer per chunk. */
const PUBLISH_INTERVAL_MS = 80;
const FINISHED_RETENTION_MS = 5_000;

interface LiveTerminalState extends TerminalLiveUpdate {
  decoder: StringDecoder;
  publishTimer?: NodeJS.Timeout;
  retireTimer?: NodeJS.Timeout;
}

const terminals = new Map<number, LiveTerminalState>();
const listeners = new Set<(update: TerminalLiveUpdate) => void>();

function projection(state: LiveTerminalState): TerminalLiveUpdate {
  const { decoder: _decoder, publishTimer: _publishTimer, retireTimer: _retireTimer, ...update } = state;
  return { ...update, output: redactCredentialText(update.output) };
}

function emit(state: LiveTerminalState): void {
  state.publishTimer = undefined;
  const update = projection(state);
  for (const listener of listeners) {
    try { listener(update); }
    catch { /* Presentation listeners cannot interrupt command execution. */ }
  }
}

function schedule(state: LiveTerminalState): void {
  if (state.publishTimer || state.phase === 'finished') return;
  state.publishTimer = setTimeout(() => emit(state), PUBLISH_INTERVAL_MS);
  state.publishTimer.unref?.();
}

function appendText(state: LiveTerminalState, text: string): void {
  if (!text) return;
  const next = state.output + text;
  if (next.length > MAX_LIVE_OUTPUT_CHARS) {
    state.output = next.slice(-MAX_LIVE_OUTPUT_CHARS);
    state.truncated = true;
  } else {
    state.output = next;
  }
  state.updatedAt = Date.now();
}

export function onTerminalLive(listener: (update: TerminalLiveUpdate) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startTerminalLive(input: {
  sessionId: string | null;
  processId: number;
  command: string;
  cwd: string;
}): boolean {
  if (!input.sessionId) return false;
  const previous = terminals.get(input.processId);
  if (previous?.publishTimer) clearTimeout(previous.publishTimer);
  if (previous?.retireTimer) clearTimeout(previous.retireTimer);
  const now = Date.now();
  const state: LiveTerminalState = {
    sessionId: input.sessionId,
    processId: input.processId,
    command: redactCredentialText(input.command).slice(0, 2_000),
    cwd: input.cwd.slice(0, 1_000),
    phase: 'running',
    output: '',
    truncated: false,
    startedAt: now,
    updatedAt: now,
    decoder: new StringDecoder('utf8')
  };
  terminals.set(input.processId, state);
  emit(state);
  return true;
}

/** Mirrors bytes for presentation only. It never drains UnifiedExecProcess's model-facing buffer. */
export function appendTerminalLive(processId: number, chunk: Buffer): void {
  const state = terminals.get(processId);
  if (!state || state.phase === 'finished' || chunk.length === 0) return;
  appendText(state, state.decoder.write(chunk));
  schedule(state);
}

export function finishTerminalLive(processId: number, exitCode: number | null): void {
  const state = terminals.get(processId);
  if (!state || state.phase === 'finished') return;
  if (state.publishTimer) {
    clearTimeout(state.publishTimer);
    state.publishTimer = undefined;
  }
  appendText(state, state.decoder.end());
  state.phase = 'finished';
  state.exitCode = exitCode;
  state.output = redactCredentialText(state.output);
  state.updatedAt = Date.now();
  emit(state);
  state.retireTimer = setTimeout(() => {
    if (terminals.get(processId) === state) terminals.delete(processId);
  }, FINISHED_RETENTION_MS);
  state.retireTimer.unref?.();
}

/** Test-only reset; does not affect the unified exec process manager. */
export function resetTerminalLiveForTests(): void {
  for (const state of terminals.values()) {
    if (state.publishTimer) clearTimeout(state.publishTimer);
    if (state.retireTimer) clearTimeout(state.retireTimer);
  }
  terminals.clear();
  listeners.clear();
}
