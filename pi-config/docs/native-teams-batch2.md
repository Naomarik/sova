# Native teams — batch 2: native team workspace

Status: **complete**. 2026-09-19. Worker: Pi (openai-codex/gpt-6-astra). Scope per
`docs/native-teams-plan-review.md` batch 2 and this task's ownership list: new
`extensions/subagents/team-modal.ts`, new `extensions/subagents/team-modal.test.ts`,
`modal.ts` (shared-helper exports only, behavior preserved), `modal.test.ts` (not touched —
its import shape did not change), one delimited region of `index.ts` (team workspace/open
wiring + `/team` bare command), this document. One `index.test.ts` test was rewritten (see
below). Nothing in `runner.ts`, `contracts.ts`, `teams.ts`, `claude-code/`, the harness
scripts, the READMEs or the plan/review docs was touched.

## Handoff inspection

The previous Claude batch 2 session hit its limit **before creating any batch-2 files**: no
`team-modal.ts`, no `team-modal.test.ts`, no batch-2 doc, and no batch-2 edits were present
in `index.ts`/`modal.ts` when this session started (the `/team` handler was still the batch-1
placeholder). Batch 1's state/tools seams, the snapshot API, `isStopping`, and all in-flight
baseline changes were preserved untouched.

While this batch ran, the parallel batch 3a owner landed `team-widget.ts` +
`team-widget.test.ts` (19 tests, both present and passing in this tree). Those files and
`docs/native-teams.md` are theirs; this batch did not touch them, and the widget is **not**
wired into `refresh()` yet (that is batch 3b), which matters for the harness results below.

## What this batch delivers

- **`TeamModal`** (`team-modal.ts`): three panes — teams (left, session + branch history,
  follow-newest until pinned), roster (middle: role, exact worker ID on line 1;
  state + short availability + declared ownership on line 2), activity (right: the selected
  member's retained transcript with the monitor's wrap-cache/`transcriptRevision` design,
  usage tail, and the member's latest bounded control action). Explicit states:
  `pruned` and `previous-session` members render as **unavailable** with their reason and
  last known status in the activity pane; a memberless (restored) team shows its objective;
  empty state points at `team_create`. Every line is exactly `width` cells; below 34×minimum
  rows it renders a one-line fallback that never exceeds width. Same key vocabulary as
  `/agents`: Tab/←→ panes, ↑↓/jk select, PgUp/PgDn/Home/End scroll, `r`/`f`, `x`-then-`x`,
  Esc/`q` close. `x x` stops **only** the exact selected member (team-wide stop stays
  deferred per review decision 4); any other key cancels the 3s-armed confirmation; nothing
  arms on finished/stopping/stopped/unavailable members. Roster identity is the exact
  worker ID, so availability flips and rebuilt views never retarget a keypress.
- **Host interface** per the review (`getTeams()`, `getWorker(workerId)`, `steerMember?(id,
  mode)`, `stopMember(id)`, `requestRender()`, `close()`); editors and delivery are
  host-owned.
- **`modal.ts`**: `clamp`, `pad`, `inline`, `bodyText`, `relativeTime`, `formatTokens`
  exported as-is; `windowStart` and `transcriptLabel` extracted to shared module functions
  with `AgentsModal` delegating — zero behavior change (all 42 modal tests pass unmodified).
  `failedOutcome`/`dotFor` were *not* exported: team member dots run on the failure-aware
  `MemberState` domain instead of `Worker` status, so there was no honest reuse point.
- **`index.ts` wiring (delimited)**: `openTeam` builds the `TeamModal` inside the existing
  batch-1 `openWorkspace` single-overlay slot (exclusivity, hide-on-dialog, editor-hiding
  and shutdown cleanup all inherited, unchanged). Follow-up/redirect go through the batch-1
  shared `steerWorker(..., "user")` and stops through `killWorker(..., "user")`, so every
  workspace control lands in the team's bounded action record (`requested →
  accepted-or-queued | failed | unknown`; never "delivered"/"executed"). Editor titles name
  the member: `Follow up: <role> (<ag_NN>)`, and redirect carries the interrupt warning:
  `Redirect: <role> (<ag_NN>) — interrupts current task` (Claude redirect is
  interrupt + settle + replacement; a redirect editor is not a chat box).
- **`/team` bare command** now opens the team workspace. `/team <anything>` shows a notice
  ("planning is not yet available … Nothing was sent to the model") and opens the workspace;
  it never calls `sendMessage`/`sendUserMessage` and never triggers a turn. `/team` in
  non-TUI modes keeps the existing "requires Pi's interactive TUI" warning path.

## `index.test.ts` note

Exactly one test was rewritten: batch 1's temporary `/team exists but only reports
availability …` placeholder asserted a notice-only behavior that batch 2 intentionally
replaces. It is now `/team opens the team workspace and never sends a message or starts
work`, asserting the same boundaries (no messages, no workers, no model input) plus
overlay-open/no-op-reopen/args-notice/RPC-refusal behavior. No other index.test.ts test was
modified; all batch-1 coverage is intact.

## New tests (43 in team-modal.test.ts)

Component: exact-width rendering at 34…200 cols incl. ANSI junk data; fallback below 34 and
short-row counts; empty state; teams/members windowing; failure-aware member dots for all
seven states; pruned/history/last-known rendering; objective pane; transcript follow/pause
semantics; follow-newest/pinned team selection; member reset on team switch; unread badge
clearing; double-x semantics (stray key, scroll key, tab, escape, finished/unavailable
targets, prune-while-armed, no team-wide stop); steer gating (focus, stopping/isStopping,
unavailable, host without `steerMember`, confirm-cancel-before-callback); selection
retention across rebuilt views; wrap/frame cache correctness incl. theme recolor without
re-wrap; sanitization (no C0/C1/OSC/tab/CR leakage, widths hold).

Integration (full `registerSubagents` wiring, fake workers; no model calls): `/team` opens a
TeamModal through the shared slot; exclusivity in both directions with notices; backend
dialog tokens hide/restore the team overlay (incl. opened-while-dialog-active, both handle
orders); the real claude-code permission emitter + permission queue uncovers the `/team`
workspace and restores focus state (dialog variant of claude-code/dialog.test.ts without
editing that file); follow-up/redirect editors hide the overlay, reach the exact member with
the right mode/titles, and write `user` actions; cancelled editors deliver and record
nothing; rejected/thrown steers notify (warning/error) and settle actions as `failed`;
double-x kills exactly the selected member and records the `stop`; shutdown with the team
editor open never restores a stale overlay and drops late input; pruned members render with
last known status from live views; history teams render read-only with counters/branch rules
intact.

## Verification (exact commands and results, this tree)

| Command | Result |
| --- | --- |
| `cd extensions/subagents && node tests/run.mjs` | **264 pass, 0 fail** (202 batch-1 baseline incl. the rewritten `/team` test, +19 parallel batch-3a widget tests, +43 new) |
| `cd extensions/claude-code && node tests/run.mjs` | **127 pass, 0 fail** (unchanged) |
| `node tests/smoke.mjs` (subagents) | PASS |
| `node tests/smoke.mjs` (claude-code) | PASS (both load orders) |
| `node tests/ui-permissions.mjs` (claude-code) | PASS |
| `node tests/team-ui-smoke.mjs --phase agents` | PASS — A0–A7, Z1 (no monitor regression) |
| `node tests/team-ui-smoke.mjs --phase team` | A0 PASS; B1 PASS (bare `/team` opens the workspace and still sends nothing / no provider request); B2 PASS; **B3 FAIL** — the compact widget exists as batch-3a files but is only wired by batch 3b, so nothing renders above the editor yet. The harness rethrows on B3, so **B4–B10 and B11 were not exercised** (batch 2 workspace behavior B4–B10 is covered offline by the tests above; B11 belongs to batch 3b). Harness untouched. |
| `git diff --check` | clean |

## Unverified / not provable offline

- Real-terminal behavior of the `/team` workspace (B4–B10: roster/IDs on screen, editor
  uncovering, permission-dialog uncovery over `/team`, resize survival there, exact-member
  `x x` through tmux) is covered by the component/integration tests above but not by the
  real-TUI harness until batch 3b wires the widget past B3. Run
  `node tests/team-ui-smoke.mjs --phase team` after widget wiring to close this gap.
- Keyboard focus returning to the team workspace after its editor closes in a live terminal
  (tracked with the same caveat in `docs/native-teams-verification.md`).
- Roster line-2 truncation is terminal-width-dependent by design: at narrow widths the
  `owns:` tail is ellipsized while state + availability (`· pruned` / `· history`) survive;
  the full reason always shows in the activity pane.

No commits, no `/reload`, no paid model tasks. Files outside my ownership that differ from
HEAD remain other workers' in-flight baselines and were preserved.
