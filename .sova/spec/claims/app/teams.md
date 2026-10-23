# §app/teams — Teams
> Part of the Sova design spec · [overview](../design/overview.md)

Teams are the subagents extension's coordinated worker groups (`team_create`, `team_add`,
`team_list`, `team_eject`, `team_succeed`; `pi-config/extensions/subagents/`): one unique role per member,
declared advisory ownership, and a roster persisted in the parent session as
`subagents-team-v1` custom entries. Sova reads that roster (§app.insights/team-cards,
§app.subagents-pane/worker-rows); the extension owns every rule below.

## §app.teams/requests — How team and helper requests are read

This covers `team_create`, `team_add` and `agent_spawn`.

- **No per-request limit.** A call may ask for any number of members or agents, and an agent's
  `count` has no cap of its own. A request is bounded only by the chat's running limit
  (§app.teams/running-limit) and, for a team, its 24 seats (§app.teams/seats). It still starts all
  or nothing: every worker is checked before any starts, and a failure stops every one it started.
- **A list given as text.** `members` or `agents` given as a JSON string whose parse is a list of
  plain objects is read as that list; nothing else about the call changes. Any other string is
  refused, saying it must be a list of member (or agent) objects.
- **Shared settings beside `agents`.** In `agent_spawn`, `backend`, `model`, `effort`, `cwd`,
  `wake`, `tools`, `systemPrompt`, `backendOptions`, `extensions` and `useWorktreeConfig` given
  beside `agents` apply to every agent that leaves that setting out. If any agent sets it to a
  different value, the call is refused, naming the setting and those agents (`agents[i]`).
  `name`, `count`, `fork` and `agentType` beside `agents` stay refused, saying to put them inside
  each agent.
- **A shared prompt.** A `prompt` beside `agents` is every agent's prompt only when no agent has
  its own; otherwise the call is refused.
- **Never guessed.** A missing role, task, team name or objective is refused, never filled in.
- **What a member takes.** A member takes `role`, `prompt`, `ownedPaths`, `orchestrator`,
  `backend`, `model`, `effort`, `tools`, `systemPrompt`, `cwd`, `wake`, `backendOptions` and
  `extensions`. Its `extensions` follow `agent_spawn`'s rules (a path, or an installed `npm:` or
  `git:` source; never the subagents extension itself) and load beside its team tools. `count`,
  `fork`, `agentType` and any unknown setting are refused, naming the setting and how to get what
  it asks for (one member per role; `agent_spawn` for `fork` or `agentType`); nothing is dropped
  silently. `defaults` takes `backend`, `model`, `effort`, `backendOptions`, `coordinator` and
  `monitor`; any other key is refused, naming it.
- **Sova's words.** These refusals are plain sentences of Sova's own that name the setting, given
  before the tool's schema check, never the schema's "schema is false" or "must be object".
- **Said up front.** The descriptions of `team_create`, `team_add` and `agent_spawn`, and the
  `/team` planning text, state every limit before a call: no per-request limit; 24 running workers
  per chat, idle ones and a team's coordinator and monitor included; 24 seats per team; members
  must be a list; which member settings are refused; and that only the coordinator hands a member
  over to a successor, or the main chat once no coordinator is live.

## §app.teams/running-limit — The running-workers limit and its refusal

- **24 per chat.** A chat may have at most 24 workers live at once. Every worker that has not
  ended counts: working, idle (waiting), starting or stopping, team members, a team's
  coordinator and monitor, and workers still being stopped after a failed start.
- **Checked first.** A request that would pass it is refused before any worker starts. Sova never
  stops a worker to make room.
- **The refusal.** It says how many workers the request needs, how many are live, how many more
  fit and how many to stop with `agent_kill`, and names each idle worker (ID and name) as the
  first to stop, or says none is idle. The count is worded for the caller: `team_create` names the
  members asked for and the coordinator or monitor Sova adds; `team_add` and `agent_spawn` count
  only the members or agents they start; a successor or a resume counts its one worker.

## §app.teams/seats — Seats, team_eject and restore

- **A team seats 24 members.** Every recorded member holds a seat, finished ones included,
  until it is ejected; a pending addition holds one too. A `team_create` that would pass 24, the
  coordinator and monitor Sova adds included, is refused before any worker starts, naming both
  counts. A `team_add` that would pass 24 is refused before any worker starts, and the refusal names the members that can be ejected
  (every member not ejected whose worker is not working, idle or stopping), or, when there are
  none, says to stop one with `agent_kill` first.
- **`team_eject { team, member }`** releases a seat. `team` is a team ID or unique name;
  `member` is an exact worker ID (`ag_NN`) or a role. It is a parent tool only: members and
  orchestrators never get it, as a pi extension tool or over MCP. It refuses, and changes
  nothing, for:
  - a team restored from history (read-only), in the same words as `team_add`'s refusal;
  - an unknown team or member;
  - a member already ejected (the refusal gives when);
  - a member whose worker is still working (starting included), idle or stopping — stop it
    with `agent_kill` first.
- **Persisted first.** A successful eject appends
  `{ version: 1, op: "eject", teamId, workerId, at }` to the same `subagents-team-v1` stream,
  then marks the member, then records one team action of kind `eject` (source `parent`). The
  answer names the member, the time and how many of the 24 seats are taken.
- **Roles stay reserved.** An ejected member keeps its role, worker ID, transcript and action
  history; its role can never be given to another member of that team.
- **An ejected member is out of the team's traffic.** It is left out of the state counts, which
  count seated members only; `team_list` and `team_roster` add `N ejected` beside them and end
  its line with `· ejected {UTC time}`. New members' headers leave it out of "Other members". A
  `team_msg` to `all` skips it, and a direct `team_msg` or `team_steer` to it fails saying it was
  ejected. `agent_resume` refuses it: an ejected worker holds no seat to come back to.
- **TUI.** The `/team` status widget hides an ejected member the way it hides a stopped one; a
  team whose members are all ejected or stopped leaves the widget. The `/team` workspace keeps
  the row and marks it `· ejected` after its state; its roster title counts `N ejected` apart.
- **Across reload and restart.** The restore fold replays eject entries in branch order (the
  first eject of a member stands; one for an unknown team or member is ignored), and counts only
  seated members against the cap, so a member added after an eject is kept even when the team
  has recorded more than 24 members in all. A malformed eject entry is ignored, never partially
  adopted. An adopted history team keeps its released seats. Sova's insights decode the same
  entry into `TeamMember.ejectedAt` (`shared/protocol.ts`).

## §app.teams/wait-completion — A settle agent_wait returned is not sent again

This holds for every subagent worker, teamed or not. A worker settle that an `agent_wait` returns
is not also sent to the parent as a `subagent-complete` message; a settle no wait returned still
is.

- **Returned.** While the parent's agent run is in progress, a settle routed to the parent is
  held rather than sent. If an `agent_wait` in that run returns the worker still settled (all
  settled, timed out or cancelled), its text carries that settle's summary, so the held message
  is dropped, whether the worker settled before or during the wait. The toast, the worker's
  record and its status are unchanged.
- **Timing.** A held settle no wait returned is sent where the run would otherwise stop, with its
  wake. It continues the same run, as before. A `wake: false` settle reaches the context at the
  next turn end, as before. A settle while the parent is idle is sent at once.
- **Stopped.** If the run is aborted, held settles go into the transcript without starting a turn.
- **Not returned.** If the worker started a new task before the wait returned (a queued steer),
  the held settle is sent as before, with its wake, where the run would stop. Overlapping waits on one worker release it only
  when the last one finishes; a settle that any of them returned is never sent.
- **Only the parent's copy.** A team member's completion routed to its coordinator
  (§teams.defaults/routing) still reaches the coordinator; only a `subagent-complete` to the
  parent is ever held.
