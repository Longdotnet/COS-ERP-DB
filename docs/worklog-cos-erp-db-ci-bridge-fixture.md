# COS ERP DB CI bridge fixture fix

Date: 2026-09-16

GitHub CI on `main` failed in `test/desktop-input-maintenance.test.ts` on Windows, Linux and macOS after the COS ERP DB fork moved its browser bridge from the upstream identity/range to `cos-erp-db` on ports `8865-8869`.

The production extension was already correct. The test harness still seeded port `8765` and returned `/hello` responses with `app: chat-on-steroids`, so the fork extension rejected its own fixture before maintenance logic ran. The harness now imports the fork-owned bridge identity/ports and uses them for its shared bridge fixture. The two durable ACK restart cases also keep `/hello` available while simulating failure only for the ACK request, matching their intended "known bridge, HTTP ACK loss" scenario.

Validation:

- `npm test -- --run test/desktop-input-maintenance.test.ts` — 106/106 passed.
- `npm test -- --run test/extension.test.ts test/cos-erp-db-identity.test.ts` — 162/162 passed.
- `npm run typecheck` — passed.

No production bridge behavior was changed by this fix.

The next hosted CI run confirmed the bridge regression was gone and exposed older upstream
expectations that predated the fork branding/database surface. Those checks were aligned with the
fork-owned connector name, bridge ports, package artifact names, database tool count and bounded
database tab scroller. The product mark remains intentionally untranslated. The SQL Server MCP
declaration and server guidance were also shortened so the existing Core discovery and instruction
budgets remain enforced instead of raising their ceilings.

Follow-up validation:

- renderer layout/i18n, plugin manager, modern MCP discovery and feature parity focused tests passed.
- packaging suite — 22/22 passed.
- MCP instruction budget check — passed under 18,000 characters.
- MCP Core no-query discovery budget check — passed under 20,500 bytes.
- the previously timing-sensitive scrubbed-child-environment case passed on isolated rerun.
- `npm run typecheck` — passed.
