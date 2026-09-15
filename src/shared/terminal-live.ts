/** Ephemeral terminal projection sent to the desktop while a command is still running. */
export interface TerminalLiveUpdate {
  sessionId: string;
  processId: number;
  command: string;
  cwd: string;
  phase: 'running' | 'finished';
  output: string;
  truncated: boolean;
  startedAt: number;
  updatedAt: number;
  exitCode?: number | null;
}
