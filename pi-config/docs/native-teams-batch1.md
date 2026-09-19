# Native teams — batch 1: state and shared seams

Status: **complete**. 2026-09-19. Worker: Pi (ollama-cloud/kimi-k3, high). Scope per `docs/native-teams-plan-review.md`
batch 1: `extensions/subagents/index.ts`, `extensions/subagents/teams.ts` (new), `teams.test.ts` (new),
`index.test.ts` additions, this document. Nothing in `runner.ts`, `contracts.ts`, `modal.ts`, the Claude
extension or the READMEs was touched for this milestone. Peer changes (`Worker.isStopping?()`,
`subagents:workers-snapshot` v1, retention/rollback ownership) are preserved.

## What this batch delivers

- **Shared spawn seam.** `spawnBatch(ctx, { specs, groupLabel?, beforeCommit? }, signal)` inside
  `registerSubagents` is the single worker-creation path: whole-batch validation before any factory runs,
  durable ag_NN/run_NN reservation via `subagents-counters-v2` *before* processes start, factory loop,
  and bounded rollback (10s wait, abort-aware, ownership retained until `whenClosed`) that rethrows the same
  errors `agent_spawn` throws today. It returns only after `groups.push`/`agents.push`. Team tools pass a
  `beforeCommit` hook that appends the team entry and commits in-memory membership, so membership exists
  only for fully published batches; a thrown rollback leaves no team record and no `subagents-team-v1` entry.
  `agent_spawn` is unchanged semantically (shape checks → `spawnBatch` → same result text).
- **Shared control seams.** `steerWorker(worker, message, mode, signal, source)` and
  `killWorker(worker, reason, source)` are used by `agent_steer`/`agent_kill` and the `/agents` modal alike.
  Team members get a bounded action record (ring of 50 per team) through the same path; plain workers record
  nothing. States are `requested → accepted-or-queued | failed | unknown` (`unknown` = caller aborted);
  nothing claims delivery/execution beyond `SteerResult`.
- **Single workspace slot.** `openWorkspace(ctx, kind, factory)` owns the one overlay
  (`workspaceKind`/`workspaceView`/`renderWorkspace`/`closeWorkspace` plus the existing overlay handle,
  `overlayHidden`, `composingEditor`, backend-dialog hide/restore). Opening a second workspace of another
  kind is refused with a notice. `syncOverlayVisibility` and the `BACKEND_DIALOG_EVENT` listener are
  unchanged; the three pre-existing overlay tests (`index.test.ts` monitor/dialog cases) pass unmodified.
- **Team tools** (`team_create`, `team_add`, `team_list`; schemas below) plus **`/team`**, which in batch 1
  only reports "not yet available" for any arguments. It never calls `sendMessage`/`sendUserMessage` and
  never triggers a turn; the workspace is batch 2 and `/team <objective>` planning is batch 3.
- **Session semantics.** `session_start`: agent/group counters restore as before, then
  `teams.reserveCounter(getEntries())` (all branches; IDs are never reused, even on other branches), then
  `teams.restoreHistory(getBranch())` (displayed history follows the active branch only).
  `session_tree` re-restores history; session teams and their live members are untouched, and a history
  entry can never shadow a live team ID. Restored members are always `previous-session`/unavailable and are
  never looked up among live workers. Finished-worker retention snapshots last known status into the member
  record (`recordEviction`) so evicted members render as `pruned` with `PRUNED_REASON`.

## API

### Tools (strict `additionalProperties: false`, runtime twin in `checkTeamKeys`)

```
team_create { name, objective, defaults?: {backend?, model?, effort?, backendOptions?},
              members: TeamMember[1..8] }     → { teamId, groupId, members[{workerId, role, backend, model}] }
team_add    { team /* team_NN or unique name */, members: TeamMember[1..8] } → same details
team_list   { team? }                          → { teams: TeamView[] } + text roster/actions
TeamMember  { role /* unique in team, becomes the worker name */ , prompt, ownedPaths?,
              backend?, model?, effort?, tools?, systemPrompt?, cwd?, wake?, backendOptions? }
```

One role per member: `count`, `fork`, `extensions`, `agentType` are rejected with a pointer to `agent_spawn`.
Defaults apply only to members whose resolved backend equals `defaults.backend` (default `pi`); member
fields win; `backendOptions` merge shallowly. `team_add` reuses the team's create-time defaults, spawns an
independent run group labelled `team_NN · <name>`, refuses history teams ("history from an earlier session")
and enforces roles unique across committed and pending members (case/whitespace-normalized). Result text
uses `agent_spawn` conventions ("Task acceptance is asynchronous…") plus advisory-ownership/session-scope
notes.

### Prompt composition (review decision 3)

`composeMemberPrompt` prepends a deterministic header — `[Team assignment from the parent Pi session]`,
team id/name, objective, this role and declared ownership, other members' roles/ownership
("at team creation" / "when you joined"), and the advisory-not-a-lock / no-peer-messaging note — to
`spec.prompt` **inside** `prepareCreate`/`prepareAdd`, i.e. before `spawnBatch` runs backend
`validate`/`prepare`, so Claude's input-length limit applies to exactly what the worker receives. Dynamic
addition never rewrites existing members' context.

### Persistence (`subagents-team-v1`)

`{version:1, op:"create", team:{id,name,objective,createdAt}, members: PersistedMember[]}` and
`{version:1, op:"add", teamId, members}`; `PersistedMember =
{workerId, role, ownedPaths, backend, model?, groupId, addedAt}`. Decoding is strict (`decodeTeamEntry`
drops malformed entries whole). The create entry is appended after the worker-ID reservation entry and
before in-memory commit, all inside `spawnBatch.beforeCommit`, so failed batches persist nothing.

### `teams.ts` (pure state, no process/UI dependency)

`TeamStore` with `reserveCounter` / `restoreHistory(branch)` / `prepareCreate` / `prepareAdd` /
`createEntry` / `addEntry` / `commitCreate` / `commitAdd` / `find` (exact IDs never fall back to names) /
`recordAction` / `settleAction` / `recordEviction` / `teamOf` / `views(observe)` / `clear`. Bounds:
16 session teams, 16 history teams, 24 members/team (committed + pending), 50 actions/team,
64-char labels, 4000-char objective, 32 owned paths of 512 chars. `prepare*` APIs return reservations with
`release()` (called in `finally` by the tools) covering the async validate→commit gap against concurrent
duplicate names/roles; consumed IDs are never handed out again within the session. `views()` returns
detached copies with per-member `available`/`availability` (`retained` | `pruned` | `previous-session`),
`state` (`working | idle | failed | done | stopping | stopped | unavailable`, failure-aware idle) and
per-team counts; history teams never consult the live-worker observer.

## Fix made in this session (the reported failure)

`teams.test.ts` "add validation…" restored `team_01` history and then committed a session team **without**
`reserveCounter`, so the session team was also numbered `team_01`; `find` (exact-ID, history-first)
resolved `prepared.teamId` to the history team and threw the history refusal instead of the committed-role
uniqueness error. Minimal fix in the test (mirroring production order in `session_start`): reserve from the
branch before restoring it, making the session team `team_02`, plus a pinned assertion that session teams
never reuse IDs reserved from history. Both invariants are now genuinely exercised: history refusal
(unchanged implementation) and role uniqueness against committed and pending members (now actually
reached). No `teams.ts` behavior change was needed.

## Known gaps (by design, later batches)

- No team workspace/TUI yet (`TeamModal`, roster/transcript panes, host wiring) — batch 2.
- No compact team widget — batch 3a. No `/team <objective>` planning message — batch 3b.
- No team-wide stop; exact-member stop only (`agent_kill`, and later the workspace double-x).
- Action history is not a peer bus; no delivery/execution distinction beyond `accepted-or-queued`;
  `unknown` on caller abort.
- Create-time `defaults` live in memory only, matching the session-scoped boundary (after reload a team is
  read-only history, so `team_add` can never observe missing defaults).
- Workers-snapshot rows carry no team fields (protocol unchanged); `team_list` is the team-aware surface.
- Interactive-only behavior (real-terminal overlay uncovering, post-editor focus) is tracked in
  `docs/native-teams-verification.md` and its real-TUI harness; component coverage for rendering stays with
  batch 2/3 tests.

## Verification (exact commands and results, this tree)

| Command | Result |
| --- | --- |
| `cd extensions/subagents && node tests/run.mjs` | **202 pass, 0 fail** (was 195 pass + 1 fail on entry; +6 new index.test.ts team integration tests, 1 teams.test.ts fix) |
| `cd extensions/claude-code && node tests/run.mjs` | **127 pass, 0 fail** (unchanged) |
| `node tests/smoke.mjs` (subagents) | PASS |
| `node tests/smoke.mjs` (claude-code) | PASS |
| `node tests/ui-permissions.mjs` (claude-code) | PASS |
| `node tests/team-ui-smoke.mjs --phase agents` | PASS A0–A7, Z1 (real TUI; no regression from shared seams) |
| `node tests/team-ui-smoke.mjs --phase team` | B1 PASS (bare `/team` sends nothing), B2 PASS (team_create via shared path, composed header in worker task); B3 FAIL — widget is batch 3a, expected; harness stops there so B4–B10/B11 remain unexercised (batches 2/3) |
| `git diff --check` | clean |

New integration coverage in `index.test.ts`: composed header reaching backend `validate` before any factory;
team defaults applied only to matching backends (pi member stays on parent model/effort); exact result
details and group label cross-reference; exactly one persisted create entry after the counter reservation;
snapshot rows for team members byte-shaped identically to plain workers (no team fields);
shape/duplicate/option rejects starting nothing; mixed-backend validation atomicity; factory failure on
member 2 rolls back with no team/entry/group/wake and reserved `team_NN`/`ag_NN` never reused; shared live
cap counted before any start; `team_add` separate run group, roster-bearing joiner header, untouched
existing-member context, persisted add entry, duplicate-role and unknown-team rejects; history restore from
the active branch only (other-branch IDs reserved but hidden), read-only history refusal, `session_tree`
re-restore, live IDs never shadowed; bounded action records with exact text, non-members recording nothing,
pruned members showing last known status and staying exact-ID unavailable; `/team` sending nothing with and
without UI.

No commits, no `/reload`. Files outside my ownership that currently differ from HEAD are other workers'
in-flight baselines and were preserved.
