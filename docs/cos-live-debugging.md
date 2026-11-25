# COS Live Debugging

Core exposes `runtime_debug` on Windows when command permission is available. It is built into the fork and uses the existing managed-terminal admission, command policy and exact chat ownership. No dependency on a local skill or Codex installation.

1. `{ action: "processes" }` lists visible-window processes and their UTC creation time. Select the exact customer/company window.
2. `{ action: "start", pid: 123, processStartUtc: "...", seconds: 90 }` checks process birth time, starts a bounded CLR ETW capture and returns an opaque trace ID. Only `state: "capturing"` confirms ETW readiness. If starting, read status first.
3. Ask the user to perform the named action before the reported deadline and reply. Do not start a replacement capture simply because the chat has changed turns.
4. `{ action: "stop", traceId: "..." }` signals early stop and reads evidence. If still stopping, call status. `status` also retrieves a capture completed by deadline.
5. Correlate the timestamped exception type/message with the action, code and configured database. Use database incident_cause_trace/source_trace when SQL evidence is relevant. A first-chance exception (including a caught exception) is not by itself a verified root cause.

A trace is scoped to the owning local chat/request. PID reuse is checked using process start time. Capture lasts 10–120 seconds, with 16 MB circular ETL and at most 30 returned events, messages capped at 500 characters. ETW temporarily receives CLR exception events system-wide; only the selected PID and capture time range are returned. Other process events are not exposed to the model. The collector stops and removes its private temporary directory during normal cleanup. Abrupt termination may require manual removal of the exact named ETW session. Results are retained in app memory (up to 32, 30 minutes), not across app restart. Trace captures CLR exceptions, not a full managed stack, SQL batch or native exceptions. No matching event does not establish successful reproduction.

Requires Windows and ETW permission; no elevation or policy bypass. Actual host error is returned if collection cannot start. The tool reuses existing Core command guards, so restrictive command allowlists may reject it. Runtime evidence is available to the existing incident workflow via the returned structured result; no automatic database writes or root-cause claims.
