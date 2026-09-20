# COS ERP DB Investigator V2 worklog

## 2026-09-17

Extended the fork-owned Database Investigator with the requested V2 investigation paths while keeping SQL Server access bounded/read-only and keeping the app integration behind fixed IPC/preload methods.

The Investigator UI keeps the four symptom-first tabs (`Incident`, `Field & Flow`, `Performance`, `Compare`) and adds one `Tools` dropdown for direct access to Incident Snapshot, Field/C#/WinForms trace, Live Performance, Query Store history, Deadlock history, Procedure & View Compare, Table & Index Compare, and SQL Agent Jobs. This follows the existing COS `<details>/<summary>` popover pattern used by plugins, composer controls, and the database grid instead of adding a separate navigation system.

V2 includes:

- Procedure/View Compare captures stored procedure and view definitions for two configured SQL Server connections, canonicalizes definition text for comparison, reports added/removed/changed objects, and shows SQL-code differences as per-object Baseline/Current cards. Structural table/index differences remain available from the same Compare surface.
- SQL to C#/WinForms Trace starts from a selected ERP field, combines SQL Server consumer evidence with a bounded scan of an approved COS source root, classifies field/table/SQL-call/WinForms-binding matches, skips generated/build folders and symlinks, and reports confidence plus scan limits.
- Query Store history reads Query Store state and bounded runtime statistics over 1 hour, 6 hours, 24 hours, or 7 days, with duration/CPU/read/execution sorting and explicit unavailable/read-only limitations.
- Deadlock history reads bounded `xml_deadlock_report` events retained by SQL Server `system_health`, then extracts victim, session, host, application, wait resource, object, and input-buffer evidence. The V2 validation exposed and fixed a parser bug where `<process-list>` could be mistaken for the first `<process>` element and hide the victim attributes.

UX correctness fixes made while finishing V2:

- Changing the selected ERP field clears the previous C#/WinForms trace so stale source evidence cannot remain on screen.
- Schema Compare preserves the chosen baseline/current connections across result re-renders.
- Procedure/View code differences no longer share the wide five-column structural table; each object gets a readable Baseline/Current code card with change type, confidence, and comparison detail.
- English/Vietnamese Database Workspace copy covers the V2 launcher and compare labels.

Validation performed for this change:

- `npm run typecheck` — passed after the final V2 UI changes.
- `npx vitest run test/database-investigator.test.ts --reporter=verbose` — 9/9 investigator backend tests passed, including Query Store, deadlock XML parsing, schema/code comparison, and C#/WinForms source tracing.
- `npx vitest run test/database-settings-ui.test.ts test/database-investigator.test.ts --reporter=verbose` — 25/25 tests passed after the final V2 UX changes, including the direct Tools launcher and Baseline/Current Procedure/View card rendering.
- `npx vitest run test/database-settings-ui.test.ts test/renderer-i18n.test.ts --reporter=verbose` — 22/22 tests passed before the final code-card-only refinement; the affected Database UI suite was rerun afterward and remained green.
- `npx vitest run test/ipc.test.ts test/database-service.test.ts test/database-tool.test.ts --reporter=verbose` — 109/109 integration/service/tool tests passed.
- `npm run build` — Electron Vite main, preload, and renderer builds passed. Vite only reported existing dynamic/static import chunking warnings.
- `git diff --check` — passed; Git only reported the existing CRLF/LF working-copy warning for the Database UI test file.
- `npm run verify` — privacy, third-party notice validation, typecheck, and the Database suites all passed inside the repo-wide run. The broad Windows/upstream suite still reported host-sensitive failures outside Database Investigator (Windows accessibility/apps, code-mode, exec/exec-hints, and artifact-download families) and did not self-terminate after more than 90 seconds of no output, so that same run was interrupted instead of duplicating completed work. These are the same classes of broad host/runtime failures already recorded during V1 validation.
