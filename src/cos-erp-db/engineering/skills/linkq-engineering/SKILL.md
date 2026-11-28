---
name: linkq-engineering
description: Implement and review LINKQ features in the native project style while separating intentional conventions from legacy debt and requiring evidence for large-data quality claims.
---

# LINKQ Engineering

Use this skill for LINKQ feature work, bug fixes, SQL changes, migrations and engineering reviews.

## Goal

Write code that looks and behaves like it belongs in the current LINKQ runtime/module, without preserving historical implementation mistakes merely because they already exist.

## Workflow

1. Identify the exact runtime family, module and task goal before changing code.
2. Read project instructions and use the Engineering Harness context/profile when available.
3. If the user designates a working reference to port, inspect that exact implementation, its callers/configuration and the target counterpart first. Match its requested behavior with the smallest compatible delta. One relevant target counterpart and evidence from each designated reference suffice for coverage; review their relevance. Otherwise find 3–7 relevant analogues, preferring the same runtime family and module.
4. Classify important patterns before copying them:
   - `convention`: intentional project identity to preserve;
   - `business_rule`: behavior that must remain correct;
   - `legacy_debt`: existing implementation weakness not to reproduce;
   - `engineering_improvement`: a justified better implementation that still fits project contracts.
5. Run the task deliberation gate before implementation. If evidence leaves only one meaningful path, mark deliberation `not_required` with the concrete reason and continue without inventing fake alternatives. If 2-3 materially different admissible paths remain, state one explicit decision question, classify the trigger(s), compare 2-3 options with trade-offs/risks/evidence, select one, and explain why the others lost.
6. Resolve reversible internal technical choices yourself when project evidence/conventions decide them. Ask the user only when the choice changes business/process semantics, optional scope/behavior, destructive or migration behavior, compatibility/security/cost policy, or another preference that evidence cannot decide. For those cases, record deliberation as user-authority and keep it pending while you ask; after the user answers, persist the selected option and decision note. Do not ask questions to fill a quota.
7. Keep naming, C#/SQL structure, comments, summaries, error behavior and public contracts native to surrounding LINKQ code. Avoid AI-style explanatory comments and unrelated modernization.
8. Prefer the smallest compatible delta. In a reference port or scoped bug fix, preserve existing forms, helpers, services, public contracts and framework conventions. Trace shared consumers. Do not create new UI, helper, service, fallback or abstraction unless required by the reference or verified target incompatibility. If departing from an existing pattern, state the concrete evidence and get approval for optional redesign. Do not invent alternatives when the named implementation already resolves the task.
9. For large-data paths, inspect table scale/index/statistics and runtime evidence such as Query Store or live performance when available. Static review alone may justify a design direction but must not be called proven scalable.
10. Keep the Engineering Task Packet current: deliberation/question/options/selection, decisions, evidence, conventions, validations, changed files, scale status and remaining risks. For decided deliberation, map the implementation to the selected option before validation.
11. Build/test only the owning scope needed to prove the change, then run the engineering quality gate before calling the task complete.

## SQL and performance guardrails

- Prefer set-based work over per-row database/API calls.
- Avoid unbounded reads, N+1 round trips and unnecessary data transfer.
- Check predicate/join/index shape and realistic cardinality for large tables.
- Keep transactions no wider than required and consider concurrency/idempotency where applicable.
- Never infer production-scale performance from small test data alone.

## Evidence priority

For a user-directed port, the named working implementation is the behavior reference and the target project supplies the conventions and compatibility constraints. Otherwise prefer: same runtime/module implementations; same feature family; current project policy/skills; database contracts/configuration; broader LINKQ code; vendor documentation; general external practice.
