# Native teams — independent final review

Reviewer: Claude Sonnet 5, independent pass. Date: 2026-09-19. Scope: milestone 1 of
`docs/native-teams-plan.md`, as landed by batches 1, 2, 3a, 3b. No source was edited (read-only
review, as instructed); the tree was dirty and being edited concurrently by another worker during
this review (`docs/native-teams.md` was updated mid-review to fix a staleness issue this review
had already flagged — noted below, not claimed as this review's own fix).

## Verdict

**Ready.** The milestone is functionally complete against the plan/review's boundaries and
review decisions, all offline suites and the real-TUI harness pass in full, and no blocking defect
was found in the implementation. Three nonblocking documentation/verification gaps should be
fixed (or explicitly accepted) before telling the user the milestone is "done," but none of them
block a safe `/reload`:

1. `README.md` (root) and `extensions/subagents/README.md` still have **zero mention** of teams,
   `team_create`/`team_add`/`team_list`, `/team`, or `docs/native-teams.md` — the plan assigned
   these two README updates to batch 3a and they were never made (see Finding 1).
2. `docs/native-teams-batch3b.md`'s "Remaining unverified" section claims session-replacement
   (UI-object change) handling for the widget is "covered offline (`index.test.ts`,
   `team-modal.test.ts`)". No such test exists in either file (Finding 2) — this is an unsupported
   test claim, not a functional defect; the code path looks correct by inspection.
3. No test anywhere (subagents or claude-code) exercises the real Claude backend's
   `MAX_CLAUDE_INPUT_CHARS` rejection against a **composed** (header + task) team member prompt,
   even though the review explicitly asked for this (Finding 3). The ordering guarantee (header
   composed before `backend.validate`) is correct by inspection and is tested with a fake backend,
   just not with the real length limit.

You can ask the user to `/reload` once you've decided whether to fix or explicitly accept these
three items; they are documentation/coverage gaps, not implementation bugs.

## Verification performed (this tree, read-only)

| Command | Result |
| --- | --- |
| `cd extensions/subagents && node tests/run.mjs` | **266 pass, 0 fail** |
| `cd extensions/claude-code && node tests/run.mjs` | **127 pass, 0 fail** |
| `cd extensions/subagents && node tests/smoke.mjs` | PASS |
| `cd extensions/claude-code && node tests/smoke.mjs` | PASS |
| `cd extensions/claude-code && node tests/ui-permissions.mjs` | PASS |
| `cd extensions/subagents && node tests/team-ui-smoke.mjs --phase all` | **PASS — A0–A7, B1–B11, Z1** (real interactive Pi in a private tmux server; real overlay hide/restore, real Claude permission dialog uncovering `/team`, exact-member `x x` stop, resize survival at 30/60/120 cols, one counted dead-endpoint provider attempt for B11, zero for A7) |
| `cd extensions/subagents && node tests/team-smoke.mjs` (no `--live`) | PASS (real Pi loads both extensions; offline team/widget/`/team` wiring). Live smoke intentionally **not** run per instructions (no paid/live model tasks). |
| `git diff --check` | clean |

No commits, no `/reload`, no paid/live model calls were made during this review.

## Review against the accepted decisions (`docs/native-teams-plan.md` §"Review decisions")

1. **One active workspace slot.** `openWorkspace`/`workspaceKind` in `index.ts` (index.ts:1127)
   generalizes the single overlay correctly; `/agents` and `/team` share it, opening the other kind
   while one is open is refused with a notice (`index.ts:1137-1140`). Confirmed live by B5/A2 and
   the pre-existing overlay tests, all passing unmodified.
2. **Action states `requested → accepted-or-queued | failed | unknown`.** Implemented exactly as
   specified in `teams.ts` (`TeamActionState`) and used consistently by `steerWorker`/`killWorker`
   in `index.ts`. Nothing in the code or docs claims delivery/execution beyond this.
3. **Header composition before backend validation.** `teams.prepareCreate`/`prepareAdd` call
   `composeMemberPrompt` and hand the composed string to `resolveMemberSpec` *before* `spawnBatch`
   ever calls `backend.validate` (`index.ts:539-566`, `teams.ts:410-449`). Confirmed exactly by
   `index.test.ts`'s "team_create composes headers before backend validation..." test, which
   intercepts the fake backend's `validate` and asserts the full header text and ordering.
4. **Team-wide stop deferred.** `TeamModal.handleInput`'s `x` handling only arms/fires when
   `this.focus === "members"` (`team-modal.ts:227`); the teams pane never arms anything. `agent_kill`
   remains available for exact IDs or a run group (not a whole team). Matches the decision.
5. **Strict `team_create`/`team_add`/`team_list` schemas.** `TeamMemberSpec` rejects `count`,
   `fork`, `extensions`, `agentType` with a clear pointer to `agent_spawn`
   (`checkTeamKeys`/`TEAM_MEMBER_KEYS`, index.ts:87-137); teams span independent run groups
   (`team_add` calls `spawnBatch` with a fresh `groupId`, never reusing the create-time group).
   Defaults are explicit and backend-native (`resolveMemberSpec`, teams.ts:220-238).
6. **Metadata restore/branch scoping.** `restoreHistory(branch)` is called from `getBranch()` only
   (`index.ts:1371,1377`); `reserveCounter` scans *all* entries (`index.ts:1370`). Restored members
   are always `previous-session`/unavailable and never matched against live workers
   (`teams.ts:540,548-554`); evicted live members keep a last-known snapshot
   (`recordEviction`/`PRUNED_REASON`). All confirmed by `teams.test.ts` and `index.test.ts`.
7. **`/team <objective>` queues via `sendMessage`/followUp+triggerTurn; bare `/team` never
   triggers a model call.** Confirmed in `index.ts:1322-1347` and by both the offline tests and the
   real-TUI B1/B11 checks (one counted dead-endpoint provider attempt for B11, zero for a bare
   `/team`).
8. **Width-safe widget component, throttled refresh, no context percentages, wake-per-member,
   Claude bypassPermissions default documented.** `TeamWidget.render(width)` is exactly `width`
   cells at 1–120 columns (`team-widget.test.ts`); it rides `refresh()`'s existing 100ms
   `scheduleRefresh` and owns no timers of its own (also pinned by a dedicated test); no duration
   or percentage field is rendered anywhere in `team-widget.ts`; `wake` defaults `true` per member
   matching `agent_spawn`; `docs/native-teams.md` documents the Claude `bypassPermissions` default.
9. **Parallel ownership boundaries respected.** `git log`/batch docs show the batches touched only
   their assigned files; `runner.ts`, `contracts.ts`, and `extensions/claude-code/` were not
   touched by any team batch (confirmed: `contracts.ts` only gained the pre-existing
   `isStopping?()` addition noted as a peer change in the plan, and both runners already exposed
   `isStopping()` before this milestone started).
10. **Baseline coordination.** Not independently reverifiable at this distance in time, but the
    batch docs' recorded baselines (167/127 → 202/127 → 264/127 → 266/127) are self-consistent and
    each batch's own verification table matches what I reproduced just now (266/127).

## Safety boundaries (plan §"Boundaries for the first milestone")

- **Session-scoped only.** `session_shutdown` disposes every agent (including `rollingBack`) and
  calls `teams.clear()` (`index.ts:1410-1416`); reload/session-replacement stop workers via the
  same path (existing pre-teams behavior, unchanged). No live-reattachment claim exists anywhere
  in the docs.
- **No peer transport, no autonomous orchestrator, no polling LLM loop, no auto-compaction, no git
  operations, no permission changes.** Confirmed by reading `teams.ts`, `team-modal.ts`,
  `team-widget.ts` and the `index.ts` team-tool/command wiring end to end: there is no code path
  that calls a model on a timer, touches git, or overrides a backend's permission handling.
  `/team <objective>` sends **exactly one** message per invocation (verified by both the offline
  test and the B11 real-TUI check counting exactly one provider attempt).
- **Existing `/agents`, tools, caps, rollback, permission prompts, shutdown compatibility.** All
  three pre-existing overlay tests pass unmodified; A0–A7 in the real-TUI harness (the `/agents`
  regression phase) pass exactly as before teams existed.
- **No commits, no `/reload` during implementation; preserve uncommitted work.** Followed by every
  batch doc and by this review (read-only, no destructive commands run).
- **UI honesty (no unsupported claims of tests-passed/ownership-enforced/context%/peer-delivery/
  process-survival).** `ownedPaths` is documented and coded as advisory only, never enforced
  (grep confirms no filesystem-lock code exists); the widget/modal never render a context
  percentage; action states never exceed `SteerResult`'s actual granularity.

## Snapshot API, lifecycle, state atomicity/history

- **Snapshot API unchanged.** `publishWorkers()` (`index.ts:346-355`) emits the same row shape for
  team members and plain workers; `index.test.ts`'s team_create test explicitly asserts
  byte-identical key sets between a team member's snapshot row and a plain worker's, and that no
  `role`/`ownedPaths`/`team` field leaks in. This is the exact compatibility constraint the
  `sessions` extension depends on, per the plan's own note.
- **Lifecycle.** `openWorkspace`'s `finally` block and `session_shutdown` fully unwind
  `workspaceKind`/`workspaceView`/`overlayHandle`/`teamWidget`/`backendDialogs`/`composingEditor`
  every time, including on abnormal exit (confirmed by the "shutdown with a team editor open never
  restores a stale overlay" integration test, and Z1 in the real-TUI harness).
- **State atomicity.** `spawnBatch`'s `beforeCommit` hook (used by `team_create`/`team_add` to
  append the persisted entry and commit in-memory membership) runs strictly after every factory in
  the batch returns and strictly before `groups.push`/`agents.push`/`committed = true`
  (`index.ts:627,663-665`). A thrown `beforeCommit` is treated exactly like a factory failure:
  full rollback, no team, no entry, no group, and the consumed `team_NN`/`ag_NN` numbers are never
  reissued (`index.test.ts`'s "team_create rejects cleanly..." test exercises this directly with a
  factory failure on the second member).
- **History.** Team ID reservation (`reserveCounter`, scans all branches) happens before restore
  (`restoreHistory`, active branch only) in `session_start`, exactly the ordering the code and a
  regression test in `teams.test.ts` both require ("session teams never reuse an ID reserved from
  history" — this was in fact a real bug caught and fixed during batch 1's own testing, per its
  doc, and remains correctly ordered here).

## UI width, input routing, permission overlays

- **Width.** `TeamModal.render(width)` and `TeamWidget.render(width)` both guarantee exactly
  `width` cells per line (fallback line below `MIN_LAYOUT_WIDTH` for the modal; ellipsis+pad for
  the widget), verified by component tests at 1–200 columns and by the real-TUI harness surviving
  30/60/120-column resizes (B10, A6).
- **Input routing / permission overlays.** `syncOverlayVisibility()` and the newly-added
  `syncTeamWidget()` are both driven by the same two triggers — an open `BACKEND_DIALOG_EVENT`
  token, or a composing editor (`composeInWorkspace`) — so the workspace and the widget hide and
  restore together. This was specifically fixed in batch 3b after the real-TUI harness caught the
  widget rendering team identity (name/roles/exact IDs) while a Claude permission dialog correctly
  hid the workspace overlay underneath it (B8/B9 in `docs/native-teams-batch3b.md`). I re-ran
  `--phase all` and confirmed B8/B9 both pass now, with the dialog owning input and the widget
  correctly suppressed. One consequence worth naming explicitly (not a defect, a conservative
  choice): the team widget is suppressed by **any** open backend dialog, even one belonging to a
  non-team plain worker, and by **any** composing editor including `/agents`' own follow-up/redirect
  editors — this is the intended "whoever owns transient input owns the whole screen" rule stated
  in the batch 3b doc, and it is the safe direction to be conservative in.

## Objective semantics

- `/team` bare never sends anything (B1, and the corresponding offline test); `/team <objective>`
  sends exactly one `customType: "team-plan"` message via `deliverAs: "followUp", triggerTurn:
  true`, is control-character-stripped and truncated at `MAX_OBJECTIVE_CHARS` with an explicit
  truncation note (`planObjective`, `index.ts:1309-1315`), and reports queued-vs-idle honestly
  based on `ctx.isIdle()` (with a defensive fallback to `true` only for host contexts/tests that
  don't implement `isIdle` — the real `ExtensionContext.isIdle` is a required method in the
  installed `pi-coding-agent` type declarations, so this fallback is dead code in production, not
  a correctness gap).

## Findings

### Finding 1 (nonblocking, docs) — Team feature is undiscoverable from the extension's own README

Neither `README.md` (root) nor `extensions/subagents/README.md` mentions teams anywhere: no
`team_create`/`team_add`/`team_list`, no `/team`, no link to `docs/native-teams.md`. The plan
explicitly assigned these two README updates to batch 3a ("Owns: ... `extensions/subagents/
README.md`, `README.md` (root), new `docs/native-teams.md`"), and only the new standalone doc was
actually written. A user who reads the extension's own README — the normal entry point — has no
way to discover that teams exist; the "Tools" table in `extensions/subagents/README.md` still
lists only the six `agent_*` tools. This is not a functional defect (the tools and command work
fine and register correctly), but it is a real "docs consistency" gap per your review criteria.
Recommend a short addition to both READMEs (a `team_*` tools row and a pointer to
`docs/native-teams.md`) before considering the milestone's documentation complete.

### Finding 2 (nonblocking, unsupported test claim) — session-replacement widget re-attach is untested

`docs/native-teams-batch3b.md`'s "Remaining unverified" section states: *"Session replacement in
the TUI (the attach-per-UI-object path)... [is] covered offline (index.test.ts, team-modal.test.ts)
but not drivable through the tmux harness."* I searched both files for any test that changes
`activeCtx`/`ctx.ui` mid-session (the condition `teamWidgetUi !== activeCtx.ui` in
`index.ts:382`) and found none — no test in the whole `extensions/subagents` suite exercises
session replacement at all, for the widget or for the pre-existing `/agents` workspace. This
appears to be a pre-existing gap in the extension (not introduced by this milestone) that the
batch 3b doc incorrectly describes as already covered. By code inspection the re-attach path looks
correct (best-effort clear of the stale handle, fresh `teamWidgetSuppressed` computed from current
dialog/editor state on re-attach), but it is genuinely unverified. Recommend either adding a
regression test (construct a second fake `ExtensionContext` with a different `ui` object and call
`session_start`/whatever the real replacement hook is, then assert the widget clears the old UI
and installs on the new one) or correcting the doc's claim.

### Finding 3 (nonblocking, test gap explicitly requested by the review) — real Claude length-limit rejection on a composed prompt is untested

The plan review's "Verification gaps" section asked for a test asserting *"Claude length
validation rejects a composed prompt over the limit before any member starts."* No such test
exists: `extensions/subagents/index.test.ts` only exercises this ordering guarantee against a fake
backend (whose `validate` never enforces a length limit), and no `claude-code` test file
references teams at all (`grep -rn "team" extensions/claude-code/*.test.ts` → no matches). The
real-TUI harness's B2 check registers the real `claude-code` backend (only its `create` factory is
swapped for a fake worker) but does not send an oversized objective/task through it. By code
inspection the guarantee holds: `composeMemberPrompt`'s output becomes `spec.prompt` inside
`resolveMemberSpec` before `spawnBatch` ever calls `backend.validate(spec, ctx)`
(`index.ts:539-566`), and `claude-code/index.ts:13-14` throws on `spec.prompt.length >
MAX_CLAUDE_INPUT_CHARS`. Recommend a small `index.test.ts` addition: register the real
`registerClaudeCode` backend (as `dialog.test.ts` already does) and assert `team_create` with a
task near `MAX_CLAUDE_INPUT_CHARS` rejects with the real error and starts no worker.

## Concurrent-edit note

`docs/native-teams.md`'s "Shipping status" table was rewritten from "Pending (batch N)" wording to
"Landed" wording partway through this review (its mtime is newer than when I first read it). That
specific staleness — which this review had already independently identified by comparing the
doc's claims against the passing `--phase all` harness results — appears to have been fixed by
another worker concurrently with this review, not by this review. I re-read the file after
noticing the timestamp change and its current content is accurate against everything I verified.
`README.md` and `extensions/subagents/README.md` (Finding 1) were not touched by that concurrent
edit and remain stale as described above.

## Recommendation

Safe to tell the user the milestone is implemented and to `/reload` when they choose. Before
calling the milestone's *documentation* complete, fix or explicitly accept Finding 1 (README
discoverability); Findings 2 and 3 are test-coverage/claim-accuracy nitpicks worth a follow-up but
do not affect correctness or safety as verified.
