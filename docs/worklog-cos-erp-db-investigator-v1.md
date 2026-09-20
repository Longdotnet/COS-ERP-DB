# COS ERP DB Investigator V1 worklog

## 2026-09-17

Implemented the fork-owned Database Investigator workspace while keeping the substantial UI and SQL Server investigation logic under `src/cos-erp-db/`. Chat On Steroids integration remains limited to thin database IPC, preload API, and subsystem initialization hooks so future upstream updates have a smaller conflict surface.

The Database workspace now separates Investigate, Explore, Storage, and Connections. The fork-specific workspace supports English and Vietnamese independently from the upstream application language.

Investigator V1 includes six investigation surfaces:

- Incident Snapshot captures bounded storage/log, active-request, blocking, and SQL Agent evidence and stores at most 24 local snapshots per connection with delete support.
- Column Inspector searches SQL Server column metadata and profiles up to 10,000 rows for NULL, blank, distinct, min/max, data length, and sample values.
- Data Flow combines SQL Server dependency metadata with module-text evidence and reports confidence plus known limitations.
- Live Performance reads active user requests, blocking/root blockers, waits, I/O, and cached query hotspots when the login has the required DMV permissions.
- Schema Compare compares live connections at table, column, and index definition level and reports exact additions, removals, changes, confidence, truncation, and V1 limitations.
- Jobs reads SQL Server Agent job state/history from `msdb` when available and degrades to an explicit limitation when the server or login cannot provide it.

Validation performed for this change:

- `npm run typecheck` — passed.
- `npx vitest run test/database-settings-ui.test.ts test/database-investigator.test.ts test/database-growth-diagnostics.test.ts test/database-object-details.test.ts` — 28 tests passed.
- `npx vitest run test/renderer-i18n.test.ts -t "covers every static app label"` initially exposed the fork product mark as untranslated static copy; the test exemption now recognizes `LongVTT/COS-ERP-DB` as a non-translatable product mark.
- `npm run verify` passed privacy, third-party notice validation, and typecheck before the broad Windows/upstream suite reported failures in unrelated runtime/integration tests (Windows accessibility/apps, exec/code-mode/artifact-download and related host-sensitive coverage). Database-focused tests remained green.

V1 intentionally does not yet provide Query Store regression history, deadlock/XEvent history, execution-plan analysis, stored-procedure/view body comparison, application-source field tracing, or a generated incident evidence report. Those can extend the isolated investigator modules without moving the feature into upstream core ownership.
