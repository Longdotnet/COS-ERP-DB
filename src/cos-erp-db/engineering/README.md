# Project-Native Engineering Harness

This subsystem is owned by the COS-ERP-DB fork. It keeps project-specific engineering state out of upstream Chat On Steroids modules so upstream updates can be merged with a small integration footprint.

## Responsibilities

- Bind engineering state to a durable project lineage rather than a caller-chosen free-form scope.
- Keep revisioned Engineering Task Packets for goals, decisions, evidence, conventions, validation and scale status.
- Discover analogous implementations from bounded, provenance-backed source evidence.
- Bind cross-project implementation references explicitly per task; profile/name similarity never authorizes another project.
- Challenge solution requirements before coding and keep requested behavior separate from evidence-required fixes, process risks and optional improvements.
- Store reviewed conventions separately from business-process and incident-learning truth.
- Distinguish `convention`, `business_rule`, `legacy_debt` and `engineering_improvement`.
- Require current evidence before an observed convention can become reviewed.
- Surface large-data proof levels honestly: `not_assessed`, `static_reviewed`, `runtime_evidenced`.

## Non-goals

- No automatic learning from every task or diff.
- No automatic selection of a "standard" project from nearby folders, matching profiles, naming or previous tasks.
- No automatic convention promotion from majority/repetition alone.
- No replacement of source files, database metadata or runtime observations as authority.
- No project-specific policy in generic contracts; LINKQ is the first profile, not the engine identity.

## Ownership boundary

Implementation belongs under `src/cos-erp-db/**`. Upstream-owned `src/main/**` and `src/shared/**` should contain only the smallest bridge needed to register and initialize fork capabilities. Existing committed database infrastructure is not moved merely for namespace purity.

## Agent workflow

`context/profile -> prepare requirements/context + explicit task references -> bounded analogue discovery -> solution review/blind-spot challenge -> deliberation gate (not_required rationale or 2-3 options + decision) -> analogue classification + decisions -> implementation mapped to selected option -> validation_run -> quality gate`

`prepare` is the generic pre-code workflow. It keeps screenshot/text requirements as task input, indexes only project-local Word/PDF/Excel/text document paths into the same project-bound Knowledge scope, searches Process context and reviewed conventions, discovers 3–7 distinct implementation sources, and creates the initial Task Packet. Optional `authorizedReferences` are explicit task input: Core resolves each requested directory inside approved roots, stores its root identity plus reason/scope, indexes its source into a separate reference Knowledge scope, and never searches for a replacement project when that binding is unavailable. Current-project discovery and independent authorized-reference discovery run in one bounded parallel wave. The returned `executionCapsule` carries the selected analogue/document provenance, process/convention keys, reference bindings, task revision/generation and open questions so downstream agents/workers can reuse the prepared working set instead of rediscovering it. Foreign Knowledge is never merged into the current project scope.

When explicit requirements exist, `prepare` marks `solutionReviewRequired` and seeds one unresolved comparison per requirement. Before implementation completion, the engineering agent/dev must review the requested behavior against current-project evidence, accepted Process/Expected Behavior context, explicitly authorized reference evidence and relevant incident learning. Findings stay task-scoped and distinguish `required_by_evidence`, `contradiction`, `implementation_risk`, `process_risk`, `proposed_improvement` and `investigate`. A proposal or process-risk finding never becomes customer behavior merely because the agent suggested it; unresolved decision-required findings block the gate, while rejected proposals remain unimplemented. Core stores a server-owned review-basis hash so later requirement/evidence/reference/review changes stale an earlier review, while ordinary changed-files/validation updates do not.

Every task created through `prepare` also starts with deliberation `pending`. Before completion, the agent/dev must either mark it `not_required` with a concrete evidence-based reason that only one meaningful implementation path exists, or record an explicit decision question, one or more material trigger categories (`ambiguity`, `architecture`, `business`, `performance`, `shared_code`, `compatibility`, `migration`, `security`, `cost_policy`), and 2-3 concrete solution options with trade-offs, risks and provenance. A decided task selects one option, explains why it won, and records why every non-selected option was rejected. Technical choices grounded by project evidence are agent-resolvable; choices that change business behavior/scope or require external/destructive authority are recorded with `deliberationAuthority=user`. The current tool can structurally verify that such a decision was recorded, but it does not cryptographically prove authorship of a user message, so Machine Verified continues to attest implementation evidence rather than human approval provenance. Once implementation files are recorded for a decided deliberation, `implementedOptionKey` must match the selected option and Core stamps a server-owned implementation binding over the deliberation/review basis, changed files and implemented finding keys. Changing any of those inputs stales the binding until it is explicitly rebound. Direct legacy/task_put-only tasks remain backward compatible and are not forced through this prepared-task deliberation gate.

Prepared analogue evidence must still receive task-scoped classification as `convention`, `business_rule`, `legacy_debt` or `engineering_improvement`; those assessments remain task evidence and never auto-promote a new requirement into a durable convention or accepted business rule. Revision-fenced task updates preserve omitted preparation/review fields, so a later code/validation update cannot accidentally erase the original requirements, authorized references or solution findings.

`validation_run` is Core-owned machine verification. Command validation launches the requested executable directly through the existing command permission/policy path and records exit code, bounded stdout/stderr, hashes, duration, task revision and hashes of the task's changed files. `sql_scale` reads SQL Server only: table/index/statistics shape is static proof; runtime proof requires recent task-bound Query Store/live-performance evidence that also references the same table returned by `table_scale_profile`. Validation and quality-gate workspace indexing keep strict content hashing. Within one quality-gate invocation, multiple current command/scale records may share one ephemeral SHA-256 snapshot of the task's changed files; the gate re-reads the task revision and rechecks those files before a candidate Machine Verified pass. The snapshot is never persisted or reused across gate calls. `assurance.machineVerified=true` still requires current successful Core executions, current runtime evidence when large-data proof is required, complete prepared analogue classifications, and no blocker/attention. Editing the task or any verified implementation file makes an older verification stale.

## Latency Observatory (observe first)

`engineering performance_get` accepts exactly one task key via `items`; `task_get` also includes a bounded `performance` summary per requested task. Runtime records are saved separately under user data `engineering/performance/<lineageKey>.json`, **not** as task revisions or Machine Verified evidence. The report groups recorded `prepare`, `validation_run`, `quality_gate` and nested Knowledge index/search/verify work into observable timings, file counts, reused/read files, processed source bytes, source hash work, and unchanged-index calls. A report can be revisited in another chat using the same project binding and task key.

Only instrumented COS Engineering/Knowledge calls are measured. Generic file reads, agent reasoning, browser/worker wait and upstream tool dispatch are outside the report. Nested spans overlap, so do not add their totals together or infer end-to-end agent wall time from observed tool durations alone. Prepare/discovery indexing may reuse unchanged local source/document evidence when size, mtime and ctime all match the prior evidence; an exact no-op keeps the prepared search cache and skips rewriting the Knowledge scope. Legacy evidence without ctime is rehashed before it can reuse. This metadata fast path is deliberately opt-in and is not used by `validation_run` or `quality_gate`, where current source hashes remain the Machine Verified authority. Strict source indexing still reads/hashes every admitted file, but source files are processed in ordered bounded waves (maximum 4) sized from the existing 64 MiB budget; document extraction remains serial. Evidence verification uses bounded concurrency 6, changed-file SHA-256 capture uses bounded concurrency 8 with deterministic error ordering, and independent authorized-reference scopes refresh in parallel. These are wall-clock optimizations only: evidence order, byte budgets, hashes and freshness fences remain authoritative. Telemetry storage failure remains non-blocking.

## Project defaults

Each project can opt into a stable default Engineering identity with `.agents/engineering.json`:

```json
{ "profile": "linkq", "runtimeFamily": "net8" }
```

The manifest is project-local. When `runtimeFamily` is omitted, the generic engine makes a bounded manifest/project scan for .NET, Node, Python, Java, Go and Rust and returns one family or `mixed` when it cannot safely choose one. Runtime family is task/context metadata and does not fork the durable Engineering scope for the same root/profile. Profile auto-detection is registry-owned: today only the LINKQ profile supplies a bounded LINKQ repo detector, rather than embedding LINKQ rules in the generic engine. An explicit/manifest unknown name still canonicalizes to `generic` so a typo cannot silently fork Engineering state. A customer project may explicitly use the LINKQ profile when that describes its engineering conventions, but `profile=linkq` never grants authority to inspect another LINKQ project. Cross-project authority is task-scoped through `authorizedReferences`, and the generic engine never copies policy, attachments or Knowledge into another project automatically.

## LINKQ skill

`skills/linkq-engineering/SKILL.md` is an importable source package. The app does not install it automatically because the managed Skills library is user-owned. Runtime callers can also obtain the LINKQ profile through the `engineering` MCP tool without installing a skill.
