# COS ERP DB growth compare worklog

## 2026-09-16

Implemented the fork-owned SQL Server growth comparison workflow while keeping Chat On Steroids
integration limited to the existing database IPC/preload/renderer hooks.

Current compare sources support live database ↔ live database, saved snapshot ↔ live database,
and saved snapshot ↔ saved snapshot. V2 snapshots retain full bounded table-storage metadata plus
compact column/index fingerprints. Comparison separates allocated file growth from used space,
attributes table/row/index growth before display truncation, reports added/removed tables, and
detects column/index drift for tables present in both sources. Legacy snapshots remain readable
and explicitly report incomplete attribution/schema evidence instead of treating missing data as
zero.

Validation performed for this change:

- `npm run typecheck`
- `npx vitest run test/database-growth-capture.test.ts test/database-growth-compare.test.ts test/database-growth-history.test.ts test/database-service.test.ts test/database-settings-ui.test.ts` — 46 tests passed.
- A read-only SQL Server probe of the column/index fingerprint query returned bounded metadata
  successfully. No database mutation was performed.

The fingerprint layer is deliberately a compact metadata-drift signal, not a full DDL-equivalence
engine. Detailed object inspection stays in Object Explorer and can be extended later without
moving growth comparison logic into upstream Chat On Steroids core files.
