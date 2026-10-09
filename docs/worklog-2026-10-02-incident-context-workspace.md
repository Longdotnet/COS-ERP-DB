# Incident context-first workspace — 2026-10-02

## Goal

Close the execution gap in the LINKQ incident flow after Process Intelligence and the
Incident Outcome/Learning Loop. A normal LINKQ incident should resolve the customer's curated
Process and Expected Behavior before collecting live SQL Server evidence.

## Change

- Added `src/main/knowledge/incident-workspace.ts` as a one-shot coordinator.
- Added `database action=incident_workspace` with `scope`, `symptom`, and optional
  `connection`.
- The coordinator always reads `incident_context` first.
- `readiness=empty` returns the process/context gaps and performs no live diagnosis, health
  gate, or deployment fingerprint read.
- `partial` and `grounded` context may capture the live incident snapshot, database health,
  and deployment fingerprint concurrently. Individual technical failures remain explicit while
  preserving the verified context packet.
- The workspace always returns `rootCauseConfirmed=false`. Root-cause confirmation remains
  owned by an evidence-backed accepted Incident Outcome with passed validation.
- Kept lower-level `incident_diagnose` available for direct database diagnostics.
- Updated Core instructions, AGENTS contract, tool-surface documentation, and regression tests.

## Validation

- Process Intelligence / workspace regression set: **10 files, 34 tests passed**.
- `test/incident-workspace.test.ts` + `test/database-tool.test.ts`: **12 tests passed**.
- MCP worst-case no-query discovery budget: passed after compacting the database schema copy.
- Core instruction-size contract: passed.
- Final full `test/mcp.test.ts` rerun: **176 tests passed, 6 skipped**. This also cleared the
  earlier long-run terminal timing failures and revalidated the discovery/instruction budgets.
- `git diff --check`: passed.
- `npm run typecheck` still reports only the three pre-existing
  `TerminalLiveUpdate` name errors in `test/renderer-timeline.test.ts` at lines 220, 242, and
  328. No new TypeScript error is reported for the incident workspace changes.

## Remaining evidence level

This validates source and automated tests. No package/install step or live customer SQL Server
incident was run as part of this wave.
