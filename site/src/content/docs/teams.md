---
title: Teams
description: A team is a group of workers with one shared objective, one role each, and an inbox each. Members message each other by role, a coordinator speaks for them, and a monitor watches their context and your usage.
group: Features
order: 9
---

## Get a team

Ask for one. In [Delegate](/docs/modes/delegate/), "have a team build it" is enough: when you ask
for a team, the agent always starts a real one (with its `team_create` tool), never separate
workers it calls a team. Without being asked, it starts a team when parts of the work depend on each
other: they change the same files or interfaces at the same time, or one member builds while another
checks. Independent parts go to separate workers instead.

Teams aren't Delegate's alone: the agent can start one in any major mode.

A team starts with:

- **a name and a shared objective**, which every member is given;
- **one role per member**, such as `api`, `web` or `checker`, each with its own task;
- **declared ownership**: the files or folders each member owns. Every member is told what it owns
  and what each teammate owns. It's a plan, not a lock: members share one folder, and they keep
  out of each other's paths unless their task says otherwise.

Members start together or not at all: every member is checked first, and if one can't start, none
keeps running. A chat runs at most 24 workers at once, idle ones and a team's coordinator and
monitor included, and a team seats at most 24 members.

## How members talk

Each member gets team tools of its own:

| Tool | What it does |
|---|---|
| `team_msg` | Sends a message to a teammate by role, or to `all`. It can be marked urgent, or as needing a reply, and a reply names the message it answers. |
| `team_inbox` | Lists the member's open items, opens them, and marks them done with a short note. |
| `team_ask` | Asks a question up the line: to the coordinator, or to your chat when the team has none. |

This is what makes a team more than a set of workers. Members settle things between themselves,
without every exchange going through your chat:

- the `web` member asks the `api` member what an endpoint returns, and gets the answer from the
  member that wrote it;
- two members that share an interface agree on it before either builds against it;
- a checker sends its failures to the builder, the builder fixes them and asks for another run, and
  they go back and forth until it passes.

### Every member has an inbox

Every message becomes an item in the recipient's inbox, so sending never fails because a teammate
is busy, starting or being replaced:

- **An idle member** is woken within seconds with a list of what's new, by subject. It opens the
  items it needs.
- **A busy member** is never interrupted: it sees new items when its turn ends. An **urgent** item
  reaches it at its next step instead.
- **A question** (a `team_ask`, or a message marked as needing a reply) waits for an answer, and is
  never closed for the member.
- **A replaced member's** messages go to its successor, and the sender is told.

Members keep their inbox at zero: each closes an item in the same step as the work it asked for.
An item a member opened and forgot is closed for it when its turn ends. When
a member stops with items still open, they go back to whoever sent them, so nothing disappears
unanswered.

Inboxes are kept on disk with the main chat, so a server restart or a chat reload loses nothing.

## The coordinator

Your [subagent profile](/docs/subagent-profiles/)'s **Teams** section can give every new team a
**coordinator**: a member that builds nothing and keeps the team moving.

- **It sees the whole team.** It's given every member's assignment, and its roster shows each
  member's state, how full its context is and how many items it has open.
- **It steers by role.** It can redirect a member's current task, or queue a follow-up, with
  `team_steer`. It never invents work, and never cancels what your chat assigned.
- **It answers the team's questions.** A member's `team_ask` goes to the coordinator, and its
  answer comes back as a reply.
- **It's the one voice back to your chat.** Members' results go to the coordinator, not to you.
  It sends milestones and concerns with `team_report`, which ask nothing of you and start no turn,
  and asks your chat with `team_ask` when the team needs something only it can decide. Its own
  result reaches your chat too, and starts a turn there only once no member is still working.
- **It hands members over.** When a member is running out of context before its work is done, the
  coordinator starts a **successor** (`team_succeed`). The old member writes a handover note first;
  the successor starts from that note and inherits its open items and its instructions, and the old
  member is stopped once the successor takes over. The coordinator can hand itself over the same way.

If the coordinator ends with no successor, its team reports to your chat directly, so a team is
never left with nobody to talk to. Your chat can start a replacement coordinator.

A team started under **Off**, or with the coordinator turned off, has none: each member's result
and questions come to your chat.

## The monitor

A coordinated team can also get a **monitor**, set in the same Teams section. It runs on a timer
and can't reach your chat; it tells the coordinator, and the members it's about.

- **Context.** A member whose context passes the profile's threshold is told to wrap up, write its
  handover note and end its turn, and the coordinator is told so it can start a successor.
- **Usage.** With usage checking on, when a provider the team uses hits its limit, the monitor has
  the coordinator pause the team: everyone wraps up and goes idle. After the limit resets, it
  resumes the team. An early resume is refused.
- **An idle team costs nothing.** While no member is working and the team isn't paused, the
  monitor's checks wait.

## Watch a team

- The composer's row counts the team, such as "2 of 5 team members working". Press it, or type
  `/agents`, to open the Session detail pane: one row per member, under its role, with an
  `{n} open` count when it has open items.
- A member's view has two tabs: **Transcript**, and **Inbox**, where you read every item it got, who
  sent it, whether it's new, read or addressed, and the note it left. It's read-only: nothing you
  do there sends or marks anything.
- The **Agents** page shows each session's teams as chips, and a chip opens that session's pane.

Your chat can still steer any member directly, and the coordinator's view of that member's
assignment includes what your chat sent.
