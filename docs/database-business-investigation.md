# Database business investigation

The Core database MCP is read-only. For ERP work, identify the actual customer database and version with list_connections and workspace_context before choosing a connection. The selected database workspace object is context, not proof of which application process executed a query.

## Agent workflow

1. Use business_trace with an explicit connection and exact ERP identifier (report ID, lookup column, list/form ID, parameter ID, table or procedure name). It reads the metadata schema before querying supported LinkQ routing tables, resolves discovered SQL objects, lists direct incoming/outgoing SQL dependencies and checks configured lookup columns against the actual target object. Optional sourceRoot scans approved source for verified procedure names.
2. Use object_details with connection, the returned objectId and section (columns, keys_indexes, ddl or dependencies). Never reuse objectId from another database.
3. Use business_compare with baselineConnection, currentConnection and search to compare discovered metadata, object column definitions or module source fingerprints, and observed dependency differences within the requested scope.
4. Use column_profile, field_consumers, query, incident_workspace and incident_cause_trace for specific data and runtime questions. Do not treat matching configuration or a catalog dependency as proof of execution, permission or root cause.
5. Use business_graph for bounded multi-hop live metadata and SQL dependency traversal; specify an approved sourceRoot when source references are required. Its nodes and edges carry observed data and the relationship contract; lookup candidates and unresolved SQL references are explicitly labeled. Permission configuration is summarized by Object_ID without returning member identities.
6. For a live Windows .NET incident, list processes with runtime_debug and start a capture with the exact PID/start timestamp and optional configured connection. Reproduce, then stop. The same capture includes bounded, read-only active SQL samples scoped to the target host/PID/database, plus temporal exception candidates. The CLR collector's active marker and the deadline bound the SQL sampler.
7. For historical evaluation, engineering history_benchmark reads retained local recording metrics, with explicit project/all-recorded scope, session pagination and optional run-pair comparison. It does not export messages or raw SQL, replay an agent, infer correctness or read ChatGPT cloud history.

Examples (configured connection IDs are installation-specific):

```json
{"action":"business_trace","connection":"l70noibo_ghitask","search":"CHAMCONG07"}
{"action":"business_trace","connection":"l70noibo_ghitask","search":"MA_LOAIHD"}
{"action":"business_graph","connection":"l70noibo_ghitask","search":"CHAMCONG07","depth":3}
{"action":"business_compare","baselineConnection":"l80linkq.r2","currentConnection":"l70huy_hoang_lam_ha","search":"L81DMTHUE"}
```

## Verification cases

Live read-only SQL observations on 2026-11-28, using the existing MCP query action:

| Case | Observed evidence |
| --- | --- |
| L70NOIBO report CHAMCONG07 | L00REPORT.SqlProc = sp_rptChamCongNgay; Is_App = true; three matching L00FormLayout rows; six direct SQL dependencies, including L10CHAMCONGDETAIL0. |
| L70NOIBO lookup MA_LOAIHD | L00LOOKUP points to L08DMLOAIHD. Ma_LoaiHD and Ten_LoaiHD both exist on the target. |
| L70 Lâm Hà vs L80 R2 | L81DMTHUE.Type_Id_VAT exists on Lâm Hà and was not visible in the R2 catalog; Lâm Hà sp_PrintHDDT has 13 observed direct dependencies. |

The regression suite reproduces report routing, a missing lookup display column, quoted search input, result clipping, database identity changes and cross-database object-ID isolation. The live SQL observations validate the underlying queries, not a restarted installation of the new MCP.

## Boundaries

## ERP workflow checks from Codex cases (2026-11-28)

The following additions reuse the existing Core and engineering surfaces. They are read-only checks, except that the optional patch scope restricts an explicitly requested file mutation.

- `apply_patch` accepts optional `writeScope` containing approved local directories. All resolved source and move destination paths must remain in these directories before any change. This is a per-patch rule, not a persistent user ACL or terminal sandbox. Specify it on every patch when the user limits changes to particular modules.
- `database.result_compare` takes `comparison: {baseline:{connection,sql},candidate:{connection,sql}}`. Both queries must pass the existing SELECT-only gate. Exact represented column shape and row multisets are compared, including duplicate counts. If either result is clipped (currently 200 rows / 1 MB), aliases are ambiguous or values unavailable, status is incomplete. Use an explicitly filtered case or aggregate query for large reports; matching results do not prove general SP equivalence.
- `database.migration_preflight` takes `migration: {sourceConnection,targetConnection,tables:[{source,target}]}` with schema-qualified table names (up to 12 pairs per request). It observes column mappings, types, nullable changes, primary keys, declared target foreign keys, approximate row counts, and candidate parent-first ordering. It does not execute migrations, resolve data conflicts or prove logical foreign keys.
- `database.migration_audit` takes `scriptPath` (approved local UTF-8/UTF-16LE SQL file, max 512 MiB). Streaming inspection reports SHA256, INSERT-leading lines, GO and SQLCMD include lines, and long lines. It does not expand includes or execute SQL. Counts are lexical estimates, not a T-SQL parse.
- `database.object_verify` takes `verification: {connection,object,expectedSha256?}` for schema-qualified modules. It hashes complete source definitions after LF normalization. A matching hash does not prove data correctness, DLL deployment or UI testing.
- `engineering.codex_history_benchmark` takes `item` JSON `{"sessionIds":["<explicitly selected Codex UUID>"]}`. Reads only selected local Codex session journals and returns aggregate outer-call and static database call-site counts. No chat text, SQL, reasoning or tool payloads are returned. Does not scan archives or execute historical calls. Static call sites may undercount loops and dynamic dispatch.

The seven recorded ERP cases highlighted scope drift (CRM6/LinkQ.Lists vs CRM module), a transfer package with excessive individual INSERTs, voucher chain reuse (PO/NM/PX/HD), and confusing deployment status. These checks provide evidence to the existing engineering workflow; they do not replace the user-approved scope, business requirements, or runtime testing.

### Validation boundaries

- Exact metadata identifiers, bounded records and direct catalog dependencies only. SQL assembled at runtime, cross-server references, hidden/encrypted objects, effective permissions and runtime execution need separate evidence.
- Parameter values are deliberately excluded from metadata discovery; targeted read-only queries remain available when authorized.
- Metadata and DDL comparisons observe live catalogs at their respective capture times, not an atomic cross-database snapshot. DDL hashes compare source text, not semantic equivalence.
- The graph expands bounded named metadata relations and SQL dependencies, not every arbitrary business relationship. It does not calculate effective permissions.
- Runtime SQL is active-request sampling, not a lossless trace; it requires sufficient SQL Server DMV privileges (e.g. VIEW SERVER PERFORMANCE STATE on SQL Server 2022). Short calls and unavailable parameter values can be missed. No server trace session or grant is created.
- History benchmarking covers the retained local profile, pages sessions, and examines a bounded recent event window per session. Explicit run pairs are descriptive comparisons, not a controlled before/after replay. Correctness requires reviewed expected outcomes.
