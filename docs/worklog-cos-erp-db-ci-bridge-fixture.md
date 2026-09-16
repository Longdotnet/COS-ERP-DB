# COS ERP DB CI bridge fixture fix

Date: 2026-09-16

GitHub CI on `main` failed in `test/desktop-input-maintenance.test.ts` on Windows, Linux and macOS after the COS ERP DB fork moved its browser bridge from the upstream identity/range to `cos-erp-db` on ports `8865-8869`.

The production extension was already correct. The test harness still seeded port `8765` and returned `/hello` responses with `app: chat-on-steroids`, so the fork extension rejected its own fixture before maintenance logic ran. The harness now imports the fork-owned bridge identity/ports and uses them for its shared bridge fixture. The two durable ACK restart cases also keep `/hello` available while simulating failure only for the ACK request, matching their intended "known bridge, HTTP ACK loss" scenario.

Validation:

- `npm test -- --run test/desktop-input-maintenance.test.ts` — 106/106 passed.
- `npm test -- --run test/extension.test.ts test/cos-erp-db-identity.test.ts` — 162/162 passed.
- `npm run typecheck` — passed.

No production bridge behavior was changed by this fix.
