# §app/teams — Teams
> Part of the Sova design spec · [overview](../design/overview.md)

Teams are the subagents extension's coordinated worker groups (`team_create`, `team_add`,
`team_list`, `team_eject`; `pi-config/extensions/subagents/`): one unique role per member,
declared advisory ownership, and a roster persisted in the parent session as
`subagents-team-v1` custom entries. Sova reads that roster (§app.insights/team-cards,
§app.subagents-pane/worker-rows); the extension owns every rule below.

## §app.teams/seats — Seats, team_eject and restore

- **A team seats 24 members.** Every recorded member holds a seat, finished ones included,
  until it is ejected; a pending addition holds one too. A `team_add` that would pass 24 is
  refused before any worker starts, and the refusal names the members that can be ejected
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
