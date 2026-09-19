# Review: native teams plan

Reviewer: Claude Fable 5.1 (`claude-fable-5-1`), high effort. Date: 2026-09-19.
Scope: `docs/native-teams-plan.md` checked against `extensions/subagents/{index,runner,modal,contracts,models}.ts`,
`extensions/claude-code/{index,runner,policy,permissions,models}.ts`, both READMEs, `docs/protocol-probes.md`,
the existing test suites, and the Pi docs `extensions.md`, `tui.md`, `sessions.md`, `session-format.md`
(read in full). No source was modified. No paid model task was run.

## Verdict

The plan is feasible as a first milestone and its boundaries are the right ones. Nothing in the
existing code prevents it. Three items must be decided or fixed in the plan before implementation
starts (see Blockers); the rest of this document gives the concrete seam, UI design, tool schema,
verification gaps, and a batch split with file ownership.

## Baseline (batch 0, step 3)

Recorded 2026-09-19 with the current uncommitted tree. The tree was being edited concurrently
during this review (`contracts.ts`, `modal.ts`, `runner.ts` and tests changed on disk at 00:18–00:19
local time, adding `Worker.isStopping?()`); the numbers below are from re-runs after those edits.
`SteerResult` did not change, so blocker 2 stands. Batch owners must re-baseline before starting.

| Command | Result |
| --- | --- |
| `extensions/subagents: node tests/run.mjs` | 167 pass, 0 fail (159 before the concurrent edits) |
| `extensions/claude-code: node tests/run.mjs` | 127 pass, 0 fail (119 before the concurrent edits) |
| `extensions/subagents: node tests/smoke.mjs` | PASS (real Pi loads extension, `/agents` registered) |
| `extensions/claude-code: node tests/smoke.mjs` | PASS (both load orders) |
| `extensions/claude-code: node tests/ui-permissions.mjs` | PASS |

No pre-existing failures. Smoke runs predate the concurrent edits by a few minutes; rerun them. `sessions` (in `~/.pi/agent/extensions/sessions`, outside this repo) consumes
`subagents:workers-snapshot`; its protocol must stay at version 1 and unchanged.

## Model resolution (batch 0, step 4)

Resolved through the runner's own `initialize` handshake (`discoverClaudeModels`; no user message, no
model task). Claude Code 2.1.277:

| CLI id | Resolves to | Efforts |
| --- | --- | --- |
| `default` | `claude-opus-5[1m]` | low, medium, high, xhigh, max |
| `opus[1m]` | `claude-opus-5[1m]` | low, medium, high, xhigh, max |
| `claude-fable-5-1[1m]` | `claude-fable-5-1` | low, medium, high, xhigh, max |
| `sonnet` | `claude-sonnet-5` | low, medium, high, xhigh, max |
| `haiku` | `claude-haiku-4-5-20251001` | none advertised |

So "Opus at high effort" is `model: "opus[1m]", effort: "high"` and resolves to Opus 5 with 1M context.
`validateClaudeModel` accepts the bracket form. The parent session default in `settings.json` is
`openai-codex/gpt-6-astra`; that is unrelated to worker models.

## Blockers (decide before batch 1)

1. **Single-overlay state in `index.ts` cannot host a second workspace.** The permission-dialog hiding
   that the plan wants to reuse is implemented with one slot: `modal`, `renderModal`, `closeModal`,
   `overlayHandle`, `overlayHidden`, `composingEditor`, `backendDialogs` and `syncOverlayVisibility`
   (`index.ts:195-310`). `openModal` (`index.ts:802`) returns early if `modal` is set and resets all of
   these in `finally`. A `/team` overlay opened alongside `/agents`, or opened via a copied set of
   variables, would either be covered by a Claude permission `confirm` (the exact bug the tokens
   prevent) or break `/agents` restoration. Resolution: generalize to one "active workspace" slot
   (one overlay at a time, `/team` closes `/agents` and vice versa, or refuses with a notice). This
   is a small refactor and must land in batch 1, before any team UI.

2. **The action-record states in the plan are not backed by the contract.** `SteerResult` is
   `{ ok, reason? }` (`runner.ts:144`). Neither runner distinguishes "accepted" from "queued": the Pi
   runner resolves on RPC acceptance, the Claude runner returns `ok: true` for a host-queued follow-up
   and only pushes a `system` transcript line "Follow-up queued in host". The plan's
   `requested/accepted/queued/unknown/failed` therefore cannot be honest for milestone 1. Use
   `requested → accepted-or-queued | failed | unknown` (unknown = caller cancelled, matching
   `agent_steer` wording). Extending `SteerResult` with `delivery: "accepted" | "queued"` touches
   `contracts.ts` and both runners and belongs to a later milestone.

3. **Prompt composition must be decided, because it changes what the worker receives.** If
   role/assignment/ownership are only metadata, the parent must repeat them in `prompt` and the UI
   shows declared scope the worker never saw. If the manager prepends a team header, the tool alters
   the model's prompt. Recommendation: prepend a short deterministic header (team name, objective,
   this member's role and owned paths, other members' roles and owned paths) and show it as the
   `task` transcript item. Composition must happen before `backend.validate` because Claude enforces
   `MAX_CLAUDE_INPUT_CHARS` on `spec.prompt` (`claude-code/index.ts:13`). Tests assert the exact header.

## Plan corrections and risks (non-blocking)

- **Wake fan-out.** Every settled member sends a `subagent-complete` follow-up that starts a parent
  turn when idle (`index.ts:336-380`). A six-member team wakes the parent six times, each a paid
  parent turn on `gpt-6-astra`. This is existing behavior, not an orchestrator, but the plan should
  say so and expose `wake` per member (default `true`, consistent with `agent_spawn`).
- **Claude default is `bypassPermissions`.** Team members edit the shared filesystem without prompts
  unless the member spec sets `backendOptions.permissionMode`. The plan's "no permission changes"
  is right; the docs batch must state that declared ownership is advisory and that `manual`/
  `acceptEdits` route prompts through the existing serialized queue.
- **Teams span run groups.** `Worker.groupId` is readonly and one `agent_spawn` batch is one group.
  `team_create` and each `team_add` produce separate groups. Label them `team_01 · <name>` so
  `/agents` cross-references, and do not try to make a team a group. `agent_kill { group }` stops a
  batch, not a team; a team-wide stop needs its own explicit path or per-member kills.
- **`count` in member specs.** Names get `-1`, `-2` suffixes (`index.ts:548`). A team role should be
  one member; reject `count` in team member specs rather than inventing role suffixes.
- **Persistence and branches.** Counters are restored from `getEntries()` (all entries), which is
  correct for ID reservation. Team records restored for display should come from
  `getBranch()`/`buildContextEntries()` so a `/tree` jump to another branch does not show teams from
  an abandoned path as if they belonged here. Restored members are always "unavailable (previous
  session)"; never look up a live worker by a restored ID.
- **Retention.** `pruneFinished` (`index.ts:212`) evicts finished workers beyond 50 and splices them
  out of groups. Team member records must hold the worker ID plus a snapshot of last known
  status/outcome, not the `Worker` object, so an evicted member still renders as "pruned".
- **Widget width.** `ctx.ui.setWidget(key, string[])` gives no width; use the component form
  `(tui, theme) => Component` and `truncateToWidth` in `render(width)` so a long objective never
  exceeds the terminal. Refresh rides on the existing 100ms `scheduleRefresh`; relative times will
  not tick without a timer, so show status words, not durations.
- **`/team <objective>` delivery.** Use `pi.sendMessage({ customType: "team-plan", display: true,
  content }, { deliverAs: "followUp", triggerTurn: true })` rather than `sendUserMessage`, so the
  instruction is visibly extension-origin and never throws while streaming. If the parent is not
  idle, notify that it was queued. Never trigger anything from a bare `/team`.
- **Mode guards.** `custom()` is TUI-only (`ctx.mode === "tui"`); the widget and notify work in TUI
  and RPC (`ctx.hasUI`). Mirror `openModal`'s guard.
- **Context percentages.** `AgentUsage.contextTokens` exists but no window size is known; the plan's
  refusal to show percentages is correct.
- **Redirect on Claude is interrupt + settle + replacement** with a 15s settlement deadline that
  fails closed by stopping the worker. The team UI's "redirect" must carry the same warning text the
  README uses; a redirect editor is not a chat box.

## Best minimal shared spawn seam

Today the batch pipeline lives inline in `agent_spawn.execute` (`index.ts:413-620`): parameter
shape checks → count/live-cap checks → per-spec validation and backend `prepare` → ID reservation
via `appendEntry` → factory loop with `committed`/`abandoned`/`earlySettled` → rollback with bounded
wait → commit (`groups.push`, `agents.push`, replay early settles, `refresh`). The tool-specific
parts are only the first step (agents-vs-prompt, shorthand mixing) and result formatting.

Extract, inside `registerSubagents`, one closure that both `agent_spawn` and the team tools call:

```ts
interface BatchRequest { specs: Spec[]; groupLabel?: string }
interface BatchResult { group: AgentGroup; workers: Worker[] }
// Validates everything before any factory runs; on failure rolls back and throws the same
// errors agent_spawn throws today; on success the group is committed and refreshed.
async function spawnBatch(ctx: ExtensionContext, request: BatchRequest, signal?: AbortSignal): Promise<BatchResult>
```

Keep `context(ctx)`, `signal.throwIfAborted()`, and the agents/prompt shape check in the tool.
`agent_spawn` becomes: shape checks → `spawnBatch` → existing result text. Team tools become:
compose member specs → `spawnBatch` → commit team membership from `result.workers` → persist.
Because `spawnBatch` only returns after `groups.push`/`agents.push`, "membership commits only after
successful worker creation" holds without new transaction code, and a thrown rollback leaves no
team entry. Do not export a manager object or move code to another file in batch 1; the closure
keeps `agents`, `groups`, `rollingBack`, `counter`, `groupCounter` private and the injected
`createRunner` test seam unchanged.

Second, smaller seam for direct controls, so UI and tools share one path:

```ts
async function steerWorker(id: string, message: string, mode: SteerMode | undefined, signal?: AbortSignal): Promise<SteerResult>
async function killWorker(id: string, reason: string): Promise<void>
```

Both call `findAgent` (exact IDs win; `ag_NN` never falls back to a name). The team action record
is written by the caller of `steerWorker`, so the tool path and the UI path record identically.

## UI integration design (permission overlays preserved)

- **One workspace slot.** Replace `modal: AgentsModal | undefined` with
  `workspace: { view: { invalidate(): void; dispose(): void }; kind: "agents" | "team" } | undefined`.
  `openModal` and the new `openTeam` both go through one `openWorkspace(ctx, kind, factory)` helper
  that owns the existing `ctx.ui.custom(..., { overlay: true, overlayOptions, onHandle })` call,
  `overlayHandle`, `overlayHidden`, `composingEditor`, and the `finally` reset. `syncOverlayVisibility`
  and the `BACKEND_DIALOG_EVENT` listener are untouched; they hide whichever workspace is open while
  any backend dialog token is open or an editor is composing, and focus it again afterwards. The
  three existing tests at `index.test.ts:312`, `:357`, `:572` must still pass unchanged; add the same
  three scenarios with `/team` open.
- **Editors.** Follow-up and redirect use the existing `steerAgent` host pattern: set
  `composingEditor = true`, `syncOverlayVisibility()`, `await ctx.ui.editor(title)`, restore in
  `finally` only if the same workspace is still open, then `steerWorker`. The `composing` re-entry
  guard stays. Title text names the member and the mode, and the redirect title carries
  "interrupts current task".
- **Stop confirmation.** Reuse the inline two-press pattern from `AgentsModal.armOrFire` with a 3s
  timeout, not `ctx.ui.confirm`. A confirm dialog would itself need hiding/restoring and adds a second
  overlay-ordering case. Team-wide stop, if included, is the same double press on the team header.
- **Team view component.** `TeamModal` in a new `team-modal.ts`, same contract as `AgentsModal`:
  `render(width): string[]` exactly `width` cells per line, fallback line below `MIN_LAYOUT_WIDTH`,
  `handleInput(data)`, `invalidate()`, `dispose()`, render-cache key covering every input. Panes:
  teams (left), members (middle: role, exact worker ID, status dot with failure awareness, owned
  paths on line 2), transcript (right, reusing the wrap cache design and `transcriptRevision`).
  Host interface:

  ```ts
  interface TeamHost {
    getTeams(): TeamView[];            // includes unavailable/pruned members with reason
    steerMember?(workerId: string, mode: SteerMode): void;
    stopMember(workerId: string): void;
    requestRender(): void; close(): void;
  }
  ```

  Reuse `inline`, `bodyText`, `relativeTime`, `pad`, `failedOutcome`, `dotFor` by exporting them from
  `modal.ts` (no behavior change) instead of copying; the modal tests already cover sanitization.
- **Widget.** `ctx.ui.setWidget("team", (tui, theme) => component)` above the editor, updated inside
  `refresh()`; cleared with `setWidget("team", undefined)` when no team has live members and in
  `session_shutdown`. Rows: team name, `N working · M idle · K failed`, then at most 4 member rows
  `role ag_NN status`, all truncated to `width`.
- **Keys.** Keep the `/agents` vocabulary (`Tab`/arrows, `j`/`k`, `PgUp`/`PgDn`, `Home`/`End`, `r`,
  `f`, `x x`, `Esc`/`q`) so the two workspaces feel like one tool.

## Recommended tool schema

Three small tools with strict `additionalProperties: false`, `StringEnum` for enums, all names
retained across upgrades like the `agent_*` tools:

```ts
const TeamMember = Type.Object({
  role: Nonempty,                                   // unique within the team
  prompt: Type.String({ minLength: 1 }),            // self-contained; header is prepended
  ownedPaths: Type.Optional(Type.Array(Nonempty)),  // declared scope, advisory
  backend: Type.Optional(Nonempty),                 // default from team.defaults, else "pi"
  model: Type.Optional(Type.String()),
  effort: Type.Optional(Effort),
  tools: Type.Optional(Type.Array(Nonempty)),
  systemPrompt: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  wake: Type.Optional(Type.Boolean()),
  backendOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });                 // no count, agentType, extensions, fork

team_create: { name: Nonempty, objective: Nonempty,
               defaults?: { backend?, model?, effort?, backendOptions? },
               members: Type.Array(TeamMember, { minItems: 1, maxItems: MAX_BATCH }) }
team_add:    { team: Nonempty /* exact team_NN */, members: Type.Array(TeamMember, { minItems: 1, maxItems: MAX_BATCH }) }
team_list:   { team?: Nonempty }
```

Results: `team_create`/`team_add` return `{ teamId, groupId, members: [{ workerId, role, backend, model }] }`
in `details` and the same text conventions as `agent_spawn` ("Task acceptance is asynchronous").
`team_list` returns declared scope beside actual status (`status`, `taskOutcome`, `processAlive`,
`available: boolean`, `reason` for pruned/previous-session members) and the bounded action history.
Steering and stopping stay on `agent_steer`/`agent_kill` with exact worker IDs; no `team_steer`.
`promptGuidelines` must name the tool ("Use team_create when…") and state that ownership is
advisory and that members wake the parent on completion.

## Verification gaps in the plan

- **Overlay hiding for the team workspace against the real Claude emitter.** `claude-code/dialog.test.ts`
  wires the real `registerClaudeCode` + `registerSubagents` and asserts the overlay is hidden when
  `confirm` runs. Add the same test with `/team` open, and one where `/team` is opened while a
  dialog token is already open (both handle orders, like `index.test.ts:572`).
- **Workspace exclusivity.** Opening `/team` while `/agents` is open and the reverse; shutdown while
  a team editor is open must not restore a stale overlay (mirror `index.test.ts:312`).
- **Atomic team batch.** A factory failure on the third member must leave no team, no `team-v1`
  entry, and still count rolled-back workers toward the live cap until closure (reuse the pattern at
  `index.test.ts:527` and `:1088`).
- **Pruned and restored members.** `team_list` and the view after `pruneFinished` evicts a member;
  after `session_start` with a `team-v1` entry and no live workers; and with a team entry on a
  different branch (must not appear).
- **Composed prompt.** Exact header content and ordering; Claude length validation rejects a composed
  prompt over the limit before any member starts.
- **`/team <objective>` while streaming** (queued, notified) and while idle (turn triggered); bare
  `/team` never sends anything.
- **Widget.** Exact-width lines at 30, 60, 120 columns; cleared when the last member finishes and on
  shutdown; no timers left running (unref'd or cleared).
- **Snapshot protocol unchanged.** `subagents:workers-snapshot` payloads are byte-identical for a
  team member and a plain worker (the `sessions` extension depends on it).
- **Live smoke (opt-in).** Two `haiku` members, `tools: []`, `effort: "low"`, `maxBudgetUsd: 0.5`,
  `wake: false`, in a temp cwd, modeled on `claude-code/tests/live-manager.mjs`; stops only its own
  workers. Everything else stays offline.
- **Interactive behavior that tests cannot prove** and must be recorded as unverified or checked by
  hand once: the hidden overlay really uncovers Pi's confirm dialog in a live terminal; keyboard
  focus returns to the workspace after the editor closes; widget placement above the editor.

## Bounded batch split with file ownership

Sequential unless stated. No batch touches `runner.ts`, `contracts.ts`, `models.ts`, or anything in
`extensions/claude-code/`. Existing uncommitted changes are the baseline and are not reformatted.

**Batch 1 — state and shared seam.** Owner A.
- Owns: `extensions/subagents/index.ts` (extract `spawnBatch`, `steerWorker`, `killWorker`;
  generalize the workspace slot to `openWorkspace`; register `team_create`/`team_add`/`team_list`;
  `team-v1` persistence and counter restore; `/team` command that only opens the workspace or
  reports "not yet available"), new `extensions/subagents/teams.ts` (pure state: team records,
  member snapshots, action history ring buffer, header composition, entry encode/decode, branch
  filtering), new `extensions/subagents/teams.test.ts`, additions to `index.test.ts`.
- Gate: new tests plus `node tests/run.mjs` in both extensions and both `smoke.mjs`; the three
  existing overlay tests unchanged.

**Batch 2 — workspace.** Owner B, after batch 1.
- Owns: new `extensions/subagents/team-modal.ts`, new `team-modal.test.ts`, `modal.ts` (export the
  shared helpers only), `modal.test.ts` (import updates if any), and one delimited region of
  `index.ts`: the `openTeam` call inside the `/team` handler and its `TeamHost` wiring. Owner A does
  not touch `index.ts` during batch 2.
- Gate: component tests (width, navigation, sanitization, confirm, retention), overlay tests with
  `/team` open, `dialog.test.ts` variant, full offline suites.

**Batch 3a — widget and docs.** Owner C, in parallel with batch 2.
- Owns: new `extensions/subagents/team-widget.ts` + `team-widget.test.ts` (pure render, no `index.ts`
  dependency), `extensions/subagents/README.md`, `README.md` (root), new `docs/native-teams.md`
  (session lifetime, advisory ownership, no peer transport, shared filesystem, wake fan-out, Claude
  permission defaults, model defaults).

**Batch 3b — wiring, `/team <objective>`, smoke.** Owner B, after 2 and 3a.
- Owns: `index.ts` (widget hookup in `refresh()` and shutdown; `/team <objective>` via
  `pi.sendMessage`), new `extensions/subagents/tests/team-smoke.mjs` (loading/shutdown offline;
  `--live` opt-in as above), `index.test.ts` additions.
- Gate: independent Opus review, fixes, complete suites, recorded commands and results, explicit
  list of unverified interactive behavior.

Rules for all batches: no `/reload` or commits while implementation workers run; each owner runs
only the suites for files they own plus the full offline suites before handing off; a batch that
needs a file it does not own stops and reports instead of editing it.

## Open decisions for the plan author

1. Accept the single-workspace rule (one of `/agents` or `/team` open at a time)?
2. Accept the reduced action states (`requested`, `accepted-or-queued`, `failed`, `unknown`)?
3. Accept header composition into member prompts (recommended) or metadata-only?
4. Include team-wide stop in milestone 1 (double press on team header) or defer?
