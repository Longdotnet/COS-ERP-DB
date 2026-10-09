# Model-facing tool surface

This is the current public reference for the tool surface. The implementation and tests are
authoritative; `src/main/mcp/surfaces.ts`, `src/main/mcp/tools-core.ts`,
`src/main/mcp/tools-desktop.ts` and `test/mcp.test.ts` should agree with this file.

## Connectors

Chat On Steroids publishes Core on Windows, macOS and Linux. Windows and macOS additionally publish
the optional Desktop connector. They are separate discovery and permission boundaries and use
separate secret tokenized local paths.

| Connector | Purpose | Possible tools |
| --- | --- | --- |
| **Chat On Steroids Core** | Approved files, verified local knowledge, project-native engineering, SQL Server, patches, terminal, task plans, workers | `read`, `view_image`, `find`, `knowledge`, `engineering`, `database`, `apply_patch`, `exec_command`, `write_stdin`, `update_plan`, `agents` |
| **Chat On Steroids Desktop** | **Windows/macOS:** screen, windows, mouse/keyboard and clipboard | `observe`, `computer` |

The Desktop connector is optional on Windows/macOS. Core is the main connector everywhere.

On a fresh current config, Core permissions are enabled, along with
session recording and multi-agent mode; read-only mode is off. Windows also enables Desktop permissions; macOS starts them off and the user switches them on. Linux masks
Desktop permissions off at runtime while preserving stored choices for a config later reopened on
Windows or macOS. Existing configs keep explicit choices during upgrades; missing legacy permissions are
not silently widened.

With fresh defaults, Core advertises `read`, `view_image`, `find`, `knowledge`, `engineering`, `database`,
`apply_patch`, `exec_command`, `write_stdin`, `update_plan`, and `agents`.
`find` is the bounded repository-search primitive whenever search permission is enabled;
`exec_command` is independent and remains the shell escape hatch. Tool exposure is monotonic
within a running connector instance, so a permission
changed mid-conversation can leave a previously exposed name listed; its handler still enforces
the current permission.

`knowledge` keeps a local, isolated evidence index for approved source trees, solution documents
and configured SQL metadata. Search results carry stable evidence ids plus content/source hashes.
`get` returns bounded evidence text, and `verify` rechecks the live file or database object so
stale indexed material is not silently treated as current truth.
For `action=index`, `items` use `source:/path`, `document:/path`, `database`, or
`database:connection`. For `verify`, each item is `evidenceId` or `evidenceId@contentHash`.
`process_put` stores one JSON record in `items` with `key`, `kind`, `title`, `statement`
and optional `parentKey`, `status`, `confidence`, `tags`, `evidence` and
`acceptanceNote`. The hierarchy is Customer → Process → Solution/Change Request → Rule →
Expected Behavior. Accepted records require supporting indexed evidence or an explicit acceptance
note. `process_search`, `process_get` and `process_history` read the living model and its
revision/provenance state. `incident_context` composes that curated process model with verified
evidence and the implementation graph for one symptom/query. Its `readiness` is `grounded`,
`partial`, or `empty`, and `gaps` names missing expected behavior, implementation links, or stale
evidence. LINKQ incident investigation uses this context packet before live database diagnosis so
customer-specific process intent stays separate from runtime symptoms.
`outcome_put` stores one customer-scoped incident outcome JSON. Draft outcomes may capture a proposed
finding, but accepted outcomes require the real Process, accepted Expected Behavior, supporting
root-cause evidence, remediation, passed validation with supporting evidence, and a decision note.
`outcome_search`, `outcome_get` and `outcome_history` expose its live provenance and revisions;
stale/invalidated outcomes are not current learning. `incident_context` may also return matching
current `priorConfirmedOutcomes`; outcome lookup failure does not block the local context packet.
`pattern_put` contributes one occurrence by `outcomeKey`; it derives incident/process/evidence from
that current accepted local outcome rather than trusting caller-supplied foreign facts. A pattern is
promoted only after at least two distinct scopes support it. `pattern_search`, `pattern_get` and
`pattern_history` expose revision/provenance state.
`incident_context` may return promoted patterns as cross-customer suggestions, but never copies
foreign process records or evidence into the current scope; the suggestion remains a hypothesis
until the current customer's process, deployment and runtime evidence verifies it.

`engineering` is the project-bound Project-Native Engineering Harness. `context` resolves the
current project root, registered/generic profile and runtime family and returns the derived
Knowledge scope. `.agents/engineering.json` can declare project defaults; otherwise profile
detection stays profile-owned and runtime detection is a bounded scan across supported project
manifests. `prepare` takes a task goal, explicit requirements and project-local attachment paths.
It indexes supported Word/PDF/Excel/text requirements as task context in that same scope, searches
Process/convention context, performs bounded 3–7 analogue discovery and creates the initial
Engineering Task Packet. Foreign-root attachments are rejected even when the other root is also
approved. Screenshots are inspected by the agent and their extracted requirements are passed to
`prepare`; image content is not silently promoted to durable project truth. Prepared analogues
must be classified task-locally as convention/business_rule/legacy_debt/engineering_improvement;
new task requirements or those assessments never become accepted durable truth without explicit
review/acceptance.

`validation_run` creates server-owned verification records rather than trusting task metadata.
For `kind=command`, the input names a task/validation plus executable and argv. Core applies the
current command permission and saved allow/deny policy, runs the process directly in the project
root, captures exit/timing/bounded output plus hashes, and binds the record to the task revision
and hashes of `changedFiles`. For `kind=sql_scale`, Core reads `table_scale_profile` evidence and,
when requested, task-related Query Store or live-performance evidence. Table/index/statistics shape
alone is only static proof; runtime Machine Verified requires recent SQL matching both the task
binding and the exact table profiled by `table_scale_profile`. No SQL writes are issued.
`quality_gate` rechecks record integrity, task revision and implementation-file
hashes and exposes `assurance.machineVerified`; caller-supplied `passed` or `runtime_evidenced`
metadata alone can never produce Machine Verified.
`database action=incident_workspace` is the context-first LINKQ incident coordinator. It always
builds `incident_context` first. With `readiness=empty` it returns the context gaps and skips live
SQL diagnosis. With `partial` or `grounded` context it then captures the deployment fingerprint,
database health gate and live incident snapshot in parallel. Partial technical capture is returned
with explicit errors instead of discarding the verified process packet. The workspace never marks a
root cause confirmed; that requires an evidence-backed accepted `outcome_put` with passed validation.

## Core tools

### `read`

Reads approved paths. It accepts one or more paths, lists a directory one level deep, expands
bounded globs, supports line ranges, and can return supported image content. Path resolution
and result-size limits are enforced by the app: the per-file default payload is 256 KB, which
covers an ordinary source file whole, and the aggregate payload for one call stays bounded at
512 KB. The defaults are set so that batching paths into one call and reading a file whole are
the cheap path, because the round trip costs far more than the bytes.

### `view_image`

The dedicated Codex-compatible image tool. It is a real Core tool, separate from `read`, and
is gated by the read capability. Image transport and decode checks remain bounded.

### `find`

Search fallback used when search is enabled and command execution was unavailable when the
surface snapshot was built. It covers filename/glob and text search without granting a shell.

### `apply_patch`

The text mutation primitive. It uses the V4A patch envelope and preflights a multi-file patch
before writing. Create, edit, move and delete-file permissions are checked independently.
Directory deletion and arbitrary binary writes are deliberately not hidden patch operations.

### `exec_command`

Runs a command in the host's real shell: PowerShell/cmd on Windows and the user's normal POSIX
shell on macOS/Linux. This permission is **not** confined to approved folders. Long-running
commands return an opaque `session_id` that `write_stdin` can continue.

It takes exactly one of `cmd` (a single command) or `cmds` (up to 20 commands run sequentially
in one shell session). A batch shares one process, so variables, environment changes and the
working directory carry across its items; each item gets a labeled output section and its own
exit code, an ordinary non-zero result does not stop the rest, and the call's exit code is the
first non-zero one. Batching exists to spend one connector round trip instead of several on
related checks. The `apply_patch` interception and the benign-non-zero-exit classification
apply to single-command calls only.

Settings can optionally enforce one application-wide command policy. It is disabled by default;
while disabled, command behavior is unchanged and the saved mode and rules remain available.
Allowlist mode permits only `cmd` items matching an exact argv rule such as `git status`, or a
rule ending in a standalone `*`, such as `git diff *`, which also permits `git diff` with no extra
arguments. Denylist mode rejects matching items and permits non-matches. An enabled empty
Allowlist rejects every launch; an enabled empty Denylist permits ordinary supported invocations.
In both modes, compound commands, substitutions, redirections, globs and other ambiguous shell
syntax are rejected with `COMMAND_NOT_ALLOWED` before patch interception or process launch.
Rules are case-sensitive and do not collapse executable paths to basenames.

This is a launch policy, not an OS sandbox. A permitted program remains trusted after it starts,
including its child processes, project/build code, shell environment and interactive input.
`write_stdin` behavior and process ownership checks are unchanged. The human-operated workspace
terminal is outside this policy.

### `write_stdin`

Writes to or polls a live command session by `session_id`, with optional yield time and output
budget. A blank `chars` value is a poll rather than a separate process-status tool. An empty
poll returns as soon as the process produces output rather than holding the full yield window;
anything that arrives afterwards stays buffered for the next poll. A non-empty write keeps
Codex's collection-window behaviour so one interactive response is gathered whole.

### `update_plan`

Available while recording is enabled. Replaces the exact caller’s displayed progress plan; it does
not execute queued work. Local history continues recording messages and real tool results for the
app transcript and continuation. There is no model-facing recording search/read tool.

Compact & Resume is app/browser orchestration. There is no model-visible `save_handoff` or
`resume_session` tool.

### `agents`

Available while multi-agent mode is enabled. It has exactly four actions:

- `spawn` creates worker chats from one shared context plus per-worker tasks. Used once per run:
  a run that needs a worker again reuses one it already has. Each worker takes an optional
  `model` slug: the worker's chat opens with `?model=<slug>` in its fresh-chat URL, so a prime
  on a limited model can spawn workers on a cheaper one. Omitted means the account default;
  a slug ChatGPT does not recognise opens with the default too. The model is fixed for the
  life of that conversation, including across sleep/wake reuse. Each worker also takes an
  optional `reasoning_effort`: pro, none, minimal, low, medium, high, xhigh, max or ultra,
  forwarded on the open URL independently of `model` — a level never selects or changes the
  model, and omitting either inherits the default set in app settings, or the account default
  when no setting is chosen. The vocabulary is the one in `shared/session.ts`; `pro` is the
  ChatGPT browser Power tier and is listed here because a worker is a real browser chat.
- `message` sends one message or an all-or-nothing batch. Messaging a sleeping worker is what
  wakes it, in the chat it already has.
- `status` reports the run and workers, including who is asleep and how many worker slots are free.
- `finish` is a worker's handoff to the prime. It reports a result and puts that worker to sleep.

Workers sleep rather than end. A worker that has reported keeps its ChatGPT conversation and
stays reusable; its worker slot is free while it sleeps, so the limit counts only workers that
are actually working. Waking one needs a free slot, reopens or refocuses that worker's own chat,
and types the prime's message into it as an ordinary user message. A worker becomes permanently
finished only when its chat reaches the context ceiling (400,000 tokens by the app's own session
accounting); crossing it never interrupts work in flight, it only makes the next stop the last one.
If that in-flight turn merely goes silent after bounded recovery, silence is not promoted into a
terminal verdict. The worker may park with its slot free while retaining unresolved-turn state and,
when the recorder knows it, the exact response identity; that state forbids new `message` wake/new
work and is not eligible for tab reuse/closure. Only proven activity from a retained exact response
may resume it. An explicit finish proven to belong to that response, a current canonical final, or
a user terminal action still ends the ceiling worker normally.
Workers never run Compact & Resume, automatically or manually: their conversation is their durable
agent identity, so the 400,000-token boundary changes only later revive eligibility and never opens
a replacement worker chat.

There is no model-supplied agent credential or `agent_key`. Worker/prime identity is bound to
the ChatGPT conversation using extension evidence; control calls fail closed when that identity
cannot be proven.

## Desktop tools

This section exists on Windows and macOS. Linux does not advertise or execute these schemas.

### `observe`

Reads desktop state without moving focus: screenshots, windows and snapshot-scoped UI-control
information. Window capture tries a direct background path first and labels a visible-screen
fallback when the pixels may be occluded. Screen access is independent from mouse/keyboard
control.

### `computer`

Executes a bounded batch of desktop actions. The current action set is:
`click_ref`, `set_value`, `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`,
`focus`, `wait`, `read_clipboard`, and `write_clipboard`.

Recent screenshot frames are retained independently; a coordinate action names its frame and
the helper revalidates target-window geometry immediately before physical input. Semantic refs
address cached UI Automation or AXUIElement objects from one bounded snapshot and fail stale rather
than rescanning by a reusable native identity. Batches report completed-step and route evidence, including
the exact failing index on partial failure. An optional compact `verify` postcondition can wait
for a foreground window, window open/close, or UI control appearance/disappearance and capture
the resulting state in the same tool call.

Each step is checked against the current screen/control/clipboard permissions. Read-only mode
can keep observation available while disabling state-changing desktop actions.

## Permission and discovery invariants

- A tool call is checked against current permissions even if its schema was exposed earlier.
- Core and Desktop do not forward or alias each other's tools.
- A connector token for one surface does not authorize the other surface.
- Read-only mode removes effective file-write, command, control and clipboard-write permissions
  without pretending the underlying configuration was changed.
- Approved filesystem roots do not sandbox command execution or desktop control.
- CoS's own windows are never listed, inspected, focused or targeted by window id, on Windows or
  macOS. This is not a sandbox: desktop-level coordinates still reach whatever is on screen.
- Tool results and validation errors are bounded; large structured or binary payloads must not
  grow without an explicit cap.

## Compatibility notes

Older conversations can retain a cached MCP schema after an upgrade. Refresh/review the app in
ChatGPT, or recreate it if your workspace requires that, then start a new conversation when the
connector's exposed tool shape changes. The current extension pairs automatically with the local
bridge; there is no pairing code to enter.

## Tests that protect the surface

`test/mcp.test.ts` checks exact surface membership, cross-surface rejection, discovery-size
budgets, permission gating, retired names and schema shape. Native image parity has additional
coverage in `test/codex-view-image-parity.test.ts`.

When changing the public tool surface, update the implementation, the surface declarations,
the tests and this document together. Do not add a permanently exposed tool for a workflow
that can be expressed safely through the existing primitives.
