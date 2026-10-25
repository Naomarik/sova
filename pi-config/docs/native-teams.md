# Native teams in Pi

A **team** is a named group of background workers with one unique role each, a
shared objective and declared ownership, created and coordinated by the parent
Pi session through the `team_create`, `team_add` and `team_list` tools and the
native `/team` workspace and compact status widget. Teams reuse the existing subagents manager and runners — the same
validation, caps, rollback, permission prompts and shutdown behavior as
`agent_spawn`. There is no separate process manager and no tmux automation.
Members can message each other and ask the operator questions, and one member
can be flagged as the team's orchestrator, but every such action is mediated
by the parent extension ("Member messaging" below); no member ever gets a
direct channel into another process or the power to create or stop workers.

This document is the user-facing reference for milestone 1 (`docs/native-teams-plan.md`),
now landed through batch 3b.

## Shipping status

Milestone 1 is **landed and verified** through batches 1, 2, 3a and 3b:

| Feature | Status |
| --- | --- |
| `team_create`, `team_add`, `team_list` tools | **Landed** |
| Prompt header composition (team/objective/role/ownership into each member's task) | **Landed** |
| Session scoping, history restore, pruned/unavailable members, bounded action records | **Landed** |
| `/team` command and native workspace (roster, transcript, follow-up/redirect editors, stop confirmation) | **Landed** |
| Team status widget (`extensions/subagents/team-widget.ts`, `setWidget` key `team`) | **Landed and wired** |
| `/team <objective>` parent planning message | **Landed** |
| Team loading/shutdown smoke, opt-in live smoke (`tests/team-smoke.mjs`) | **Landed** |
| Real-TUI verification of `/team` (`tests/team-ui-smoke.mjs --phase team`) | **Pass** (A0–A7 and B1–B11) |


## Concepts

- **Team**: an explicit record with stable ID (`team_NN`), unique name,
  objective and creation time. Created by the parent model (or by you asking
  for it) via `team_create`.
- **Member**: one worker per role. The role is unique per team
  (case/whitespace-insensitive, across committed *and* concurrently pending
  additions) and becomes the worker's display name. Members are referenced by
  exact worker IDs (`ag_NN`); an ID never falls back to a name, and numeric
  IDs are never reused.
- **Declared ownership** (`ownedPaths`): advisory coordination metadata,
  prepended into the member's own prompt and shown in `team_list`. It is **not
  a filesystem lock** — every member shares the same working tree.
- **Session scope**: teams belong to their parent session; their members are
  chat processes that outlive a reload of it (details in "Session lifetime" below).

## Quick start

Ask the parent agent for a team, e.g. *"create a team to refactor the auth
module: a builder, a reviewer, and a test writer, with clear ownership"*. The
parent calls something like:

```json
{
  "name": "auth-refactor",
  "objective": "Refactor src/auth without breaking the public API",
  "defaults": { "backend": "claude-code", "model": "opus[1m]", "effort": "high" },
  "members": [
    { "role": "builder",  "prompt": "…", "ownedPaths": ["src/auth"] },
    { "role": "reviewer", "prompt": "…", "ownedPaths": [] },
    { "role": "tests",    "prompt": "…", "ownedPaths": ["test/auth"] }
  ]
}
```

`team_create` returns immediately with exact IDs
(`teamId`, `groupId`, `members[].workerId`) — task acceptance is
asynchronous; startup failures surface in status, not in the return value.
Inspect with `team_list`; steer/stop members with `agent_steer`/`agent_kill`;
open `/agents` to watch the run group (teams also appear there as runs labeled
`team_NN · <name>`), or open the native `/team` workspace.

## The `/team` command

- **Bare `/team`** opens the native team workspace — team selector, roster and
  selected-member activity/transcript. It never sends anything to the model.
- **Workspace behavior:** `/team` shares one workspace slot with `/agents`
  (only one overlay is open at a time; opening the other kind asks you to
  close the first). Keys follow the `/agents` vocabulary (`Tab`/arrows,
  `j`/`k`, `PgUp`/`PgDn`, `Home`/`End`, `r` redirect, `f` follow-up, `x x`
  stop with a two-press inline confirmation, `Esc`/`q` close).
- **`/team <objective>`** queues one extension-origin planning message
  (`customType: "team-plan"`, `display: true`, `deliverAs: "followUp"`,
  `triggerTurn: true`) so the parent plans the team with the `team_*` tools. If
  the parent is busy, the message is queued and you are told so. The objective
  is sanitized and capped at 4000 characters.

## Tools

All three tools are strict (`additionalProperties: false`, with a runtime twin
check), keep their names across upgrades, and go through the same spawn and
control path as the `agent_*` tools.

### `team_create`

```text
team_create {
  name,                                    // unique, ≤ 64 chars, single line
  objective,                               // ≤ 4000 chars; detail belongs in files you reference
  defaults?: { backend?, model?, effort?, backendOptions? },
  members: TeamMember[1..8]
}
TeamMember {
  role,                                    // unique in team; becomes the worker name
  prompt,                                  // self-contained; the team header is prepended
  ownedPaths?,                             // ≤ 32 entries, ≤ 512 chars each, single line
  orchestrator?,                           // true: sibling-scoped team_roster/team_steer; pi or claude-code backend
  backend?, model?, effort?, tools?, systemPrompt?, cwd?, wake?, backendOptions?,
  extensions?                              // agent_spawn's rules; loaded beside the team tools
}
```

- One role per member: `count`, `fork` and `agentType` are rejected in plain
  words that name the setting: `count` with "one member per role", `fork` and
  `agentType` with a pointer to `agent_spawn` (which stays the tool for ad hoc
  workers and those options). Any other unknown setting is refused the same
  way, never dropped. A member takes `extensions` by `agent_spawn`'s rules.
- `members` given as a JSON string of a list of objects is read as that list.
  A missing role, prompt, name or objective is refused, never filled in. These
  checks run before pi's schema check, so no refusal is in the schema's words.
- **Atomicity:** the whole batch is validated before any worker starts; a
  failure on any member rolls the batch back (bounded 10s wait, workers stay
  owned until termination is confirmed, consumed IDs are never reused) and
  leaves **no** team, no persisted entry and no run group.
- **Defaults** apply only to members whose resolved backend equals
  `defaults.backend` (default `pi`); member fields win; `backendOptions` merge
  shallowly (member keys win).
- `orchestrator: true` is rejected for any backend other than `pi` (the
  orchestrator tools are a Pi extension); the flag is persisted with the
  member and shown by `team_list`/`team_roster` as `(orchestrator)`.
- Result details: `{ teamId, groupId, members: [{ workerId, role, backend, model, orchestrator? }] }`.

### `team_add`

```text
team_add { team /* team_NN or unique team name */, members: TeamMember[1..8] }
```

- Adds members to a team created **in this session**, spawning an independent
  run group labeled `team_NN · <name>` (teams deliberately span run groups;
  `agent_kill { group }` stops one batch, not the whole team).
- Reuses the team's create-time defaults.
- Refuses history teams ("history from an earlier session").
- New members see the current roster in their header; **existing members are
  not re-informed** about the addition.

### `team_list`

```text
team_list { team? }                        // omit for all teams
```

Shows, per team: ID, name, session/history origin, objective, per-state
counts; per member: exact worker ID, role, backend, model,
state (`working | idle | failed | done | stopping | stopped | unavailable`)
with live `status`/`taskOutcome` when retained or last-known status when
pruned, declared ownership, error text, and the exact reason for unavailable
members; plus the last 10 control actions with their honest states. Output is
capped like all tools (50KB/2000 lines, with a full-snapshot path).

### What each member actually sees (prompt composition)

Before backend validation — so backend input-length limits apply to exactly
what the worker receives — the parent prepends a deterministic header to the
member's `prompt`:

```text
[Team assignment from the parent Pi session]
Team: <name> (<team_NN>)
Objective: <objective>
Your role: <role>
Your declared ownership: <paths or "none declared">
Other members at team creation (or "when you joined"): <roles and ownership, orchestrators marked>
Declared ownership is advisory coordination, not a lock: …
<coordination paragraph, one of three>

[Your task]
<prompt>
```

The coordination paragraph states exactly what that worker really has:

- **Pi member:** `team_msg`, `team_inbox`, `team_ask` are described; "you
  cannot spawn, add or stop workers … the parent session remains the
  authority; your final answer is your report."
- **Pi orchestrator:** the above plus `team_roster` and `team_steer`, with the
  reminder that acceptance is not execution and that its final answer is the
  team's report.
- **Claude member / orchestrator:** the same two paragraphs as the Pi variants,
  preceded by one line naming the real call names, since the tools come from
  the `team` MCP server: `mcp__team__team_msg`, `mcp__team__team_inbox`,
  `mcp__team__team_ask` (plus `mcp__team__team_roster`, `mcp__team__team_steer`
  for an orchestrator).
- **Any other backend:** messages may arrive as new instructions; there is no
  tool to reply, so anything for teammates goes in the final answer.

The header never promises a tool the worker lacks.

## Coordination: follow-ups, redirects, stops

Use the existing tools with exact worker IDs:

- `agent_steer { id, message, mode? }` — `mode: "followUp"` queues work after
  the current task; `mode: "redirect"` changes the current task (Pi's normal
  steering; on Claude it is interrupt → settle → replacement with a 15s
  settlement deadline that fails closed by stopping the worker). Idle
  (`waiting`) members start a fresh task.
- `agent_kill { id }` — stops exactly that member and waits for termination.
  Team-wide stop is intentionally deferred; stops are exact-member only. The
  workspace's `x x` confirmation also stops only the selected exact member.

Every steer/stop of a team member is recorded in a bounded action history (50
per team, shown by `team_list`) with these states — and nothing stronger:

| State | Meaning |
| --- | --- |
| `requested` | the request was recorded |
| `accepted-or-queued` | the backend accepted it **or** queued it locally; the two are not distinguishable |
| `failed` | refused, with the reason |
| `unknown` | the caller stopped waiting (cancelled); delivery is unknown |

Acknowledgment never means executed or completed; worker status/outcome in
`team_list`/`agent_list` remains authoritative. The action history is a
control audit trail; mediated member actions are recorded in it too, with
sources `member` / `orchestrator` and kinds `message` / `question` / `steer` /
`followUp` / `redirect`.

## Member messaging, orchestrators and operator questions

Every member gets an identity in `PI_SUBAGENTS_TEAM_MEMBER` (team, worker ID,
role, orchestrator flag, private mailbox directory) and a mailbox directory.
Pi members load `extensions/subagents/member.ts` among their listed extensions
and get the identity in their environment. Claude members get the same tools from
`extensions/subagents/member-mcp.ts`, a dependency-free stdio MCP server the
Claude CLI launches from a per-worker `mcp.json` (`--mcp-config`, under
`--strict-mcp-config`); the identity is in that server entry's `env`, and the
tools appear to Claude as `mcp__team__<tool>`. Both files register nothing
without a valid identity, never import the manager, and expose only:

| Tool | Who | Effect (performed by the parent extension) |
| --- | --- | --- |
| `team_msg { to, message, subject?, urgent?, replyTo? }` | any member | an item in each recipient's inbox (`to` = sibling role, `ag_NN`, or `all` = every live sibling), answered at once with its id; the recipient is woken with a short list (idle: after ~3 s, urgent at once; busy: urgent at its next step, the rest when its turn ends); a succeeded recipient's successor gets it |
| `team_inbox { action?, ids?, note?, limit? }` | any member | the member's inbox, served by the parent (its only writer): `list` open items, `open` ids in full, `done` ids (addressed, optional note), `sent` (status of what it sent) |
| `team_ask { question, subject? }` | any member | in a coordinated team, a `question` item for the coordinator (answered with `team_msg` `replyTo`); otherwise a displayed `team-question` message in the parent session (`followUp`, `triggerTurn: true`); the parent answers with `agent_steer { id, message }` |
| `team_roster {}` | orchestrator | live roster of its own team, states, ownership, recent actions |
| `team_steer { to, message, mode? }` | orchestrator | `agent_steer`-equivalent for one sibling of its own team; `[Instruction from orchestrator …]` prefix; delivered in full on the sibling's serial delivery lane (never refused for being busy) |

Transport: request files in the member's own directory under the parent
session's mailbox root (kept across reloads); the parent polls (250ms), takes the sender's identity from the
directory, validates scope (same team, not itself, orchestrator-only powers)
and answers with a response file the tool waits for (45s cap; a timeout reports
"may still be handled", never success). Orchestrators cannot add or stop
members and nothing reaches outside their team: adding and stopping remain
parent-only (`team_add`, `agent_kill`), so depth stays capped.

Claude permission modes and the MCP tools: under the default
`bypassPermissions` nothing prompts. Under `acceptEdits`, `manual`, `dontAsk`
or `plan` the Claude runner appends an `mcp__team` rule to `--allowedTools`
(after any operator-supplied rules) so the member's own team tools are never
prompted for or denied; every other tool keeps the chosen policy. The
`mcp.json` is a 0600 file in the worker's private temp directory and is
removed when the worker closes.

## The team widget

A compact status block above the editor (Pi's `setWidget` component form, key
`team`), installed and refreshed by the subagents extension:

```text
◆ auth-refactor (team_01) · 1 working · 1 idle · 1 failed
  ● builder [claude-code] ag_01 · working · claude-opus-5[1m] · owns: src/auth
  ◐ reviewer [claude-code] ag_02 · idle · sonnet
  ✗ tests [pi] ag_03 · failed/error · error: vitest exited 1
session-scoped teams · ownership is advisory, not a lock
```

Guarantees, enforced by `team-widget.test.ts`:

- Every rendered line is **exactly the terminal width** (ellipsis-truncated,
  space-padded) at any width, verified at 1–120 columns; a long name, model or
  error can never overflow.
- Status words only: **no durations and no context-window percentages** —
  per-model window sizes are unknown, so percentages would be invented.
- Per-state dots match the `/agents` monitor (`●` working, `◐` idle/steerable,
  `✗` failed, `✓` done, `◌` stopping, `⊘` stopped, `○` unavailable) and are
  failure-aware: an idle-looking member with a failed task shows `failed`, not
  `idle`.
- Most informative rows first (working, idle, failed, then terminal states),
  stably; bounded to 2 teams and 4 member rows by default, with exact
  `… +N more` overflow rows.
- Pruned members render as `unavailable (pruned, last done/success)`; history
  teams collapse to one row (`N members — workers stopped with their session
  (history only, never live)`) instead of enumerating dead workers.
- Torn-down members leave the widget: a `stopped` (killed) member, or one
  pruned with last status `killed`, gets no row and no header count, and a
  session team whose members are all torn down disappears entirely (the widget
  is removed if nothing else remains). This covers every teardown path
  (`agent_kill` of a run, group or member, and `/team` stop). A crashed worker
  is `failed`, not torn down, and stays visible, as do `stopping` members until
  their process closes. `team_list` and `/team` still report stopped members
  and torn-down teams.
- The widget owns **no timers or polling**: the host pushes fresh snapshots
  through the existing 100ms-throttled refresh, and removes the widget when no
  teams remain and on shutdown.

## Session lifetime, persistence and retention

- **Teams are session-scoped; their members are not tied to the parent's
  process.** A reload, a session switch or the parent's crash leaves every
  member running in its own chat process; the next manager of that session
  reattaches to it, and its team becomes live again. Every chat, worker and team
  member runs in a process of its own, so a server restart never ends them either.
  The mailbox, each member's inbox (`items.jsonl`) and pending nudges are
  kept beside the team's handover notes. After a reload every inbox is folded
  from disk: live members are woken for items never listed, and a member found
  ended first closes automatically what it opened and didn't close (never a
  question), then returns its open items to their senders ("not addressed"; Sova's own
  to the coordinator, the main thread's to the main chat as a `team-notice`
  message that starts no turn). At a handover the retired member's opened items
  close the same way and its other open items move to its successor, keeping their ids.
- **History is per branch.** On session start, team entries
  (`subagents-team-v1`, versioned create/add operations) restore from the
  **active branch only**; a `/tree` jump re-restores. History teams are
  read-only: `team_list` shows them for context, `team_add` refuses them, and
  their members always render `unavailable (previous session)` — restored IDs
  are never matched against live workers.
- **IDs are never reused.** Team/worker/run counters reserve from *all*
  session entries (including abandoned branches), so `team_04`/`ag_07` in old
  conversation content can never be retargeted to an unrelated new team or
  worker.
- **Retention.** Only the 50 most recent finished workers are retained by the
  manager. When a finished team member is evicted, its team record keeps a
  snapshot of the last known status/outcome and renders as
  `unavailable (pruned, last …)`; the member explicitly stays
  unavailable-by-ID rather than being dropped.
- Create-time `defaults` live in memory only: after a reload a team made live
  again by a reattached or resumed member has none, so a later `team_add`
  applies none.

## Limits (all enforced, all explicit)

| Limit | Value |
| --- | --- |
| Session teams / history teams | 16 / 16 |
| Members per team (incl. finished and pending) | 24 |
| Members per `team_create`/`team_add` call | no limit of its own (bounded by the two rows around it) |
| Live workers total (shared with `agent_spawn`; idle workers, coordinator and monitor included) | 24 |
| Retained finished workers | 50 |
| Recorded actions per team | 50 (ring; last 10 shown) |
| Team name / role length | 64 chars, single line, no control characters |
| Objective | 4000 chars |
| Declared paths | 32 × 512 chars, single line |
| Action/error previews | 200 / 500 chars |

## Wake behavior (and its cost)

Each member has `wake` (default `true`, same as `agent_spawn`): when it
settles while the parent is idle, it posts its result and **starts a parent
turn** — which costs tokens on the parent model. A six-member team can wake
the parent six times. Set `wake: false` per member to deliver results with
your next turn instead (use `agent_wait` when you need them sooner). This is
the existing wake mechanism, not an orchestrator loop.

## Model, effort and permission defaults

- **Pi members** (the default backend): inherit the parent session's model and
  thinking level unless the member (or matching team `defaults`) sets
  `model`/`effort`; models must exist in the session registry —
  `agent_models` resolves exact IDs. Team `defaults` never leak Claude-native
  options onto Pi members (or vice versa): they apply only to members on the
  matching backend.
- **Claude members** (`backend: "claude-code"`, with the Claude extension
  installed): Claude-native model/effort IDs (e.g. `sonnet`, `opus[1m]`,
  effort `low`–`max`; `haiku` has no effort). Claude starts fresh — it does
  not inherit Pi's model, effort, tools or history.
- **Claude permission default is `bypassPermissions`: members edit the shared
  filesystem without prompting.** Set `backendOptions.permissionMode` to
  `manual`, `acceptEdits`, `dontAsk` or `plan` for a restrictive policy;
  `manual`/`acceptEdits` prompts route through the existing serialized
  permission queue and stay visible over any workspace overlay. A redirect on
  Claude interrupts the current task (see above). Teams change nothing about
  permission behavior — they only declare advisory ownership.
- **Shared filesystem.** All members work in one checkout. Declared ownership
  tells each member what to avoid, but nothing blocks conflicting edits.
  Coordinate genuinely conflicting files through separate tasks or sequential
  follow-ups, not parallel members.

- **Standing roles fall back at runtime.** A coordinated team's coordinator or
  monitor whose turn fails because its model ran out of usage (credits,
  quota, a monthly, weekly or 5-hour limit, a failed sign-in; one shared
  classifier, `../extensions/provider-limits/usage-out.ts`), or that fails 3
  turns in a row of any kind, while it runs its role's primary, is stopped,
  its seat released, and its successor starts at once on the role's fallback
  through the main chat's replacement path. A single 429 rate limit doesn't
  switch. The model is marked out for an hour (`subagents-dead-tuple-v1`,
  replayed after a reload), so new teams, the members default and later
  successors skip it; the team that switched stays on its fallback. With no
  fallback a monitor is stopped and a coordinator is reported, each once.

## Verification

Offline suites and checks (run in this tree):

```sh
cd extensions/subagents && node tests/run.mjs     # offline suite incl. teams + team widget
cd extensions/claude-code && node tests/run.mjs   # Claude extension regression suite
git diff --check                                   # whitespace/patch hygiene
```

Loading/shutdown and real-TUI smoke (see `docs/native-teams-verification.md`):

```sh
cd extensions/subagents && node tests/smoke.mjs                       # real Pi loads extension
cd extensions/claude-code && node tests/smoke.mjs
cd extensions/subagents && node tests/team-ui-smoke.mjs --phase all # real-TUI /agents + /team regression
cd extensions/subagents && node tests/team-smoke.mjs                    # loading/shutdown + offline wiring
cd extensions/subagents && node tests/team-smoke.mjs --live             # opt-in tiny Claude live smoke
```

Latest recorded results: subagents offline **306 pass / 0 fail** (including
`mailbox.test.ts`, `member.test.ts`, `member-mcp.test.ts` and the mediation
tests in `index.test.ts`); Claude extension offline **129 pass / 0 fail**
(including the `mcp.json` launch tests in `runner.test.ts`); all extension smoke/UI checks and
real-TUI `/team` phases pass; `--live` passed with one bounded haiku member.
Interactive-only behavior the harness cannot prove is tracked in
`docs/native-teams-verification.md` and `docs/native-teams-batch3b.md`.

## Later milestones (explicitly not this one)

A supervisor process for durable teams, reconnect and crash recovery;
dependency scheduling and actual context-window management; team-wide stop.
(Member tools for Claude Code workers shipped as the `member-mcp.ts` MCP
server described above.) See `docs/native-teams-plan.md` and
`docs/native-teams-plan-review.md`.
