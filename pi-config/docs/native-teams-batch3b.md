# Native teams — batch 3b: final wiring, `/team <objective>`, smoke

Status: **complete**. 2026-09-19. Worker: Pi (openai-codex/gpt-6-astra). Scope per
`docs/native-teams-plan-review.md` batch 3b and this task's ownership list:
`extensions/subagents/index.ts` (widget hookup in refresh/shutdown, `/team <objective>`
behavior — nothing else), `extensions/subagents/index.test.ts` (additions plus the one
placeholder-era assertion block batch 2 had marked as temporary for `/team <objective>`),
new `extensions/subagents/tests/team-smoke.mjs`, this document. Nothing in
`team-widget.ts`, `teams.ts`, `team-modal.ts`, `modal.ts`, `runner.ts`, `contracts.ts`,
`claude-code/`, the READMEs, `docs/native-teams.md`, the plan/review docs or the existing
harness (`tests/team-ui-smoke.mjs`) was touched — B8/B9 fixes below were achieved entirely
inside `index.ts`.

## Handoff on entry

Batches 1, 2 and 3a were landed in this tree. Fresh baseline before edits: subagents
offline **264 pass / 0 fail**, Claude offline **127 pass / 0 fail**. The widget component
existed (`team-widget.ts`, `attachTeamWidget`) but was not wired; `/team <objective>`
still showed batch 2's placeholder notice ("not yet available … Nothing was sent");
`B3`/`B11` of the real-TUI harness were unpassed and B4–B10 unexercised.

## What this batch delivers

### Widget wiring (`index.ts`)

- One `attachTeamWidget` handle, created lazily on the first refresh that has a UI, and
  **re-attached when the UI object changes** (session replacement swaps `ctx.ui`); the
  stale handle is cleared against the old UI best-effort first.
- `refresh()` — the existing 100 ms-throttled `scheduleRefresh` path — pushes
  `teamViews()` (fresh detached `TeamStore.views(observeWorker)` snapshots) into the
  handle. `update([])` removes the widget, so it disappears whenever the store has no
  teams; `session_shutdown` calls `handle.clear()` explicitly and drops the handle.
  **No timers were added anywhere**: the widget rides the existing refresh timer, and
  `attachTeamWidget` itself owns none (pinned by batch 3a's tests).
- **Permission-dialog and editor rule (new, see below):** the widget now follows the
  workspace's visibility rule exactly — while any `BACKEND_DIALOG_EVENT` token is open
  or a workspace editor is composing (`composingEditor`), the widget is cleared, and it
  returns with fresh views when the last transient surface closes. Implemented as
  `syncTeamWidget()` beside the existing `syncOverlayVisibility()`, called from the
  dialog listener and both ends of `composeInWorkspace`; refresh never reinstalls while
  suppressed.

### `/team <objective>`

- Bare `/team` is unchanged: opens the workspace and never sends anything or starts a
  turn (real-TUI B1).
- `/team <objective>` sends **one extension-origin message**:
  `pi.sendMessage({ customType: "team-plan", display: true, content }, { deliverAs:
  "followUp", triggerTurn: true })` — `followUp` queues safely while streaming and
  `triggerTurn` starts the planning turn only when the parent is idle. It opens no
  overlay and uses `sendUserMessage` never.
- The objective is control-character-stripped and capped at the 4000-char team-objective
  limit (with an explicit truncation note), so a later `team_create` stays in bounds.
- The message tells the parent agent to: plan and create the team with `team_create`
  (explicit unique role, self-contained prompt and declared `ownedPaths` per member) /
  `team_add` / `team_list` / `agent_steer` / `agent_kill` by exact ID; obey the tools and
  limits; state there is **no peer transport**; and **report the wake/default cost**
  (pi backend + parent model defaults, and each `wake=true` member starting a paid parent
  turn, or using `wake: false`). Exact wording is pinned in the new index.test.ts tests.
- Idle vs busy is read from `ctx.isIdle()`: a busy parent gets a "queued as a follow-up
  …" notice, an idle parent a "planning sent …" notice; without a UI the message is still
  sent and the notice skipped. A `sendMessage` throw is caught and reported instead of
  escaping the command.

### `tests/team-smoke.mjs` (new, opt-in)

Offline (default): (1) real Pi (rpc) loads subagents + claude-code together and
registers `/team`, `/agents`, `/subagents` with zero stderr/extension errors and a clean
SIGTERM shutdown; (2) in-process wiring with a fake runner — team tools register,
`team_create` persists its entry and installs the widget in refresh, a settle updates the
component through the throttled refresh, rendered rows are exactly 80 cells, bare `/team`
sends nothing, `/team <objective>` sends the exact `team-plan` options, shutdown clears
the widget and disposes the worker. No model, no child processes.

`--live` adds exactly the bounded member the approval allowed: one Claude `haiku`
member via real `team_create` through the real claude-code backend — `tools: []`,
`effort: "low"`, `backendOptions.maxBudgetUsd: 0.5`, `wake: false`, temp cwd, task is a
trivial fixed reply; asserts success, the transcript token, the `wake:false` completion
message (`triggerTurn: false`), then stops only its own worker and asserts it is not
alive. Result recorded in the verification table below.

## Real-TUI findings that shaped the wiring (B8/B9)

First full real-TUI run after wiring: B1–B7 passed, then **B8 failed** — while the Claude
permission dialog was open, "team identity" (name, roles, exact `ag_NN` IDs) was still on
screen. Debug screenshots (temporary harness copy in /tmp; the repo harness is untouched)
showed the cause: the **widget itself renders that identity**, so with the workspace
overlay correctly hidden, the harness's `TEAM_VIEW` predicate still matched the widget
rows. The workspace hide/restore was never broken.

Fix (in `index.ts` only): the widget and workspace are one extension surface with one
rule — whoever owns transient input owns the whole screen. After the dialog-only fix,
**B9 failed** the same way: B8's closing "workspace restored" wait matched the widget
that was still visible during the composing follow-up editor, so the harness's `Escape`
+ `x x` raced an open editor (screenshots showed the follow-up editor consuming `x` as
text). Extending the suppression to the composing-editor case makes
"team identity on screen ⇔ workspace on screen" true again, restores the harness's
original synchronization semantics, and B8/B9/B10 pass consistently. This is a product
rule, not a harness accommodation: the review already prescribed the same two trigger
conditions (dialog tokens, editor composing) for hiding the workspace; the widget — added
after that review — simply had to inherit them.

## index.test.ts changes

Harness: added `sendUserMessage` capture (`userMessages`) and an `isIdle: () => true`
stub (tests override it). Existing tests unaffected.

- **Updated (one, the placeholder-era block):** the `/team` command test's
  "`/team <objective>` → not-yet-available notice" block now asserts the landed behavior —
  exactly one `team-plan` message (`display: true`, `{ deliverAs: "followUp",
  triggerTurn: true }`, objective embedded, `team_create` instructions), no extra overlay,
  no user message, no workers, plus "bare `/team` in RPC mode sends nothing" (count 1,
  not 0). All other assertions in that test (workspace open, no-op reopen, RPC refusal)
  are unchanged.
- **Added:** "`/team <objective>` while streaming queues the identical followUp and says
  so; works without a UI" — same message options while `isIdle() === false` (triggerTurn
  is inert while streaming), busy-notice wording, objective truncation at the
  team-objective limit, message pins for explicit roles/ownership, obeying tools,
  no-peer-transport and wake/default-cost reporting, no `sendUserMessage`, and message
  delivery without a UI and without a notice.
- **Added:** "team widget installs on refresh with fresh detached views, follows member
  state, and clears on shutdown" — no `setWidget` call without teams; one component-form
  install under key `team` at default placement; exact rendered rows (100 cells each)
  with header/member/legend content; throttled refresh pushing fresh detached views into
  the same component (mutation of a pushed view corrupts neither the store nor the
  widget); failure-aware idle (`✗ … failed`, `1 failed`); dialog suppression (cleared on
  open, never reinstalled by refresh while open, restored exactly once with fresh views
  on close); exactly one clear at shutdown and no reinstall afterwards.

## Verification (exact commands and results, this tree)

| Command | Result |
| --- | --- |
| `cd extensions/subagents && node tests/run.mjs` | **266 pass, 0 fail** (264 baseline, +1 updated `/team` test, +1 streaming-objective test, +1 widget integration test) |
| `cd extensions/claude-code && node tests/run.mjs` | **127 pass, 0 fail** (unchanged) |
| `node tests/smoke.mjs` (subagents) | PASS |
| `node tests/smoke.mjs` (claude-code, both load orders) | PASS |
| `node tests/ui-permissions.mjs` (claude-code) | PASS |
| `node tests/team-ui-smoke.mjs --phase all` | **PASS — A0–A7, B1–B11, Z1** (first full pass of both phases; B11: one `team-plan` message, `followUp`+`triggerTurn:true`, exactly 1 counted provider attempt against the dead local endpoint, no network egress) |
| `node tests/team-smoke.mjs` | PASS (real-Pi load of both extensions; offline team/widget/`/team` wiring; live part printed as deferred) |
| `node tests/team-smoke.mjs --live` | **PASS** (see attempts below) |
| `git diff --check` | clean |

### Live smoke row

`node tests/team-smoke.mjs --live` — **PASS**: one Claude `haiku` member created through
real `team_create` via the real claude-code backend, `tools: []`, `effort: "low"`,
`backendOptions.maxBudgetUsd: 0.5`, `wake: false`, temp cwd. Settled with task outcome
success, transcript contained the fixed `TEAM_SMOKE_OK` reply, the
`subagent-complete` message carried `triggerTurn: false` (wake false), and the member was
killed by exact ID (`processAlive: false` in `team_list`). Only its own worker was ever
started or stopped.

#### Live smoke attempts

1. ~01:30 local: the member spawned through real `team_create`, settled promptly, and the
   error surfaced honestly in `agent_wait`/`team_list` — the task failed with the
   account's Claude **session usage limit** (resets 01:50 local) before producing the
   token reply. No wiring failure; the bounded call happened exactly as designed. (This
   attempt also exposed one smoke bug: the fake live ctx used `mode: "print"`, but the
   manager only sends completion messages in tui/rpc modes; fixed to `mode: "rpc"` with a
   no-op UI.)
2. ~01:51 local (after the reset): **PASS** as described in the row above.

## Remaining unverified / by design

- **Model behavior after `/team <objective>` is intentionally unverified**: B11 and the
  offline tests cover the message and turn trigger only; whether a parent model then
  calls `team_create` well is model behavior, out of test scope (harness documents this).
- **Widget content at 30 columns** is survival-only in the real TUI (B10); exact-width
  content remains covered by `team-widget.test.ts` (1–120 columns) and the integration
  test (100 cells/row).
- **Session replacement in the TUI** (the attach-per-UI-object path) is
  implemented by code inspection only: no test in this suite currently swaps the UI
  object mid-session (a pre-existing extension gap). **Widget-clear-at-shutdown** on a
  dying screen is covered by the new `index.test.ts` widget integration test.
  `/reload`/`/resume`/`/tree` team behavior remains untestable through the tmux harness
  — tracked with the other interactive-only caveats in `docs/native-teams-verification.md`.
- RPC/print-mode UX of `/team <objective>` is covered by mocks (message sent, notice
  skipped without a UI), not by a live RPC client.
- Widget styling/colors, hardware cursor/IME, mouse and non-tmux terminals stay
  unverified as before.

## Notes for the docs owner

- `docs/native-teams.md` still marks `/team <objective>`, the widget wiring and
  `tests/team-smoke.mjs` as "Pending (batch 3b)" and shows pre-batch-2 `/team` text in two
  places — those rows/paragraphs are now stale; updating that file was outside this
  batch's ownership, so the correction is recorded here. All behavioral claims it makes
  about the widget contract, session lifetime, advisory ownership, wake cost and no peer
  transport remain accurate and are honored by this wiring.
- No commits, no `/reload`. Files outside this batch's ownership that differ from HEAD
  remain other batches' baselines and were preserved.
