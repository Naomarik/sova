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
  `team_msg` to `all` skips it and names it on the answer's skipped line. A direct `team_msg` or
  `team_steer` to it goes to its newest live successor, when it has one, and the sender is told
  (§app.teams/inbox); otherwise it fails saying it was ejected. `agent_resume` refuses it: an ejected worker holds no seat to come back to.
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

## §app.teams/inbox — Each member's inbox: queued, never refused or lost

Every team message and every Sova notice to a team member becomes an **item** in that member's
inbox. Sending never fails because the member is busy, starting, asleep or being replaced, and
no item disappears without its sender or the coordinator being told. Messages to the main chat
(the coordinator's `team_ask` and `team_report`, completions routed to the parent) are unchanged:
they join the main chat's own queue, which never refuses.

- **An item.** A one-line subject (at most 120 characters; the sender's `subject`, else the first
  non-blank line of the message, cut to 120), the message (at most 8,000 characters), an optional
  `urgent` mark, an optional `needsReply` mark (`team_msg` only; it makes the item a `question`),
  and an optional `replyTo`: the id of the item it answers, which must exist in the same main
  chat. Sova fills in the rest and the sender can never set or fake it: the id
  (`i_<n>`, unique and increasing across the whole main chat, never reused), who sent it (a
  member's role and worker ID, `main thread` or `Sova`, taken from where the request came from,
  never from its body), when, and its kind: `message`, `question`, `report`, `handover`,
  `notice` or `instruction`, and once addressed, who closed it (`closedBy`: the member, a reply,
  or `auto` for closed automatically; an addressed item without it reads as closed by the
  member). An item is open while it is new or read and has not been returned; an `instruction`
  item is never open.
- **Sending answers at once.** `team_msg` to one member, several or `all` replies as soon as the
  items are stored, without waiting for any member to take them: `Queued for <role> (<ag_NN>):
  item i_41`, one line per recipient. `all` is one copy for each live member (working, idle or
  starting), the sender excluded; members that have stopped or were ejected are skipped and named
  on one info line (`skipped (stopped): monitor (ag_29)`), never reported as a failure. When a
  recipient has more than 50 open items the queued line says so (`builder has 63 open items`).
  There is no cap on sending. The descriptions of `team_msg`, `team_ask` and `team_steer` say
  "At most 8,000 characters; for longer, write a file and send its path."
- **Waking the member.** An idle member's normal items are gathered for about 3 seconds, then it
  is woken once with one list; an urgent item wakes it at once. A busy member is never
  interrupted: on the pi backend (every team member today, Claude models included, which run as
  pi workers on the Claude Code provider) urgent items reach it at its next step, and normal
  items are listed once its current turn ends. On a backend with no next-step delivery, urgent
  items too wait for the turn's end. One wake is in flight per member; items that arrive meanwhile
  join the next list.
- **The list.** `[Team inbox: N new (k urgent) — team_inbox open <ids> to read, done <ids> to mark
  addressed]`, then at most 20 lines, urgent first, oldest first within each, each with the id,
  kind, sender and subject (`! i_42 notice from monitor — Wrap up: context 78%`), and `… and M
  more` past 20. **A member must open an item to see it:** the list never shows a message's text,
  whatever its length; an item listed before and still unopened is marked `unopened` on its line.
  The one exception is a list of exactly one item, which shows that item in full under its line
  and counts as opening it. Unopened items are listed again only when new ones arrive or a turn
  ends with new items waiting, never on a timer. The list ends with a **Still open** block of at
  most 5 lines (inside the 20-line cap, `… and M more` past 5) naming the items the member has
  opened and not closed, questions first (`i_7 question from writer — opened, not answered`),
  and a closing line telling it to handle each item and close it in the same step as the work
  (§app.teams/inbox-zero). Neither the block nor the reminder ever starts a wake of its own.
- **Reading and marking.** `team_inbox` takes `action`: `list` (the default: open items, or
  `limit` of the newest), `open` (up to 20 `ids`, shown in full, marking them read), `done` (up to
  20 `ids`, marking them addressed, with an optional one-line `note` of at most 200 characters)
  and `sent` (the status and note of items this member sent). Each item goes new → read →
  addressed (new → addressed directly too). `done` closes an item as closed by the member. A
  reply whose `replyTo` names an open item in the replier's own inbox, of any kind, marks that
  item addressed, closed by a reply, with the note `answered in i_<n>`. The results of `open` and
  `done` end with the member's count of open items left (`2 open left`). `sent` shows how each
  addressed item was closed: `closed by builder`, `answered in i_52` or `closed automatically`.
  The sender is never woken when a status changes. Only the main chat's
  extension writes an inbox: a member's `team_inbox` is a request the main chat serves, so a mark
  racing a new delivery never loses the new item.
- **Questions.** A member's `team_ask` to its routing coordinator (§teams.defaults/routing) is a
  `question` item; the coordinator answers with `team_msg` and `replyTo` set to it. A `team_msg`
  sent with `needsReply: true` is a `question` item too, so it waits for an answer like one.
  Sova's notices, the monitor's included, are never questions.
- **Direct instructions skip the list.** The main chat's messages to a member (`agent_steer`,
  answers to its questions, the `/team` workspace's follow-up and redirect), the coordinator's
  `team_steer`, and Sova's handover instructions ("finish your step and write your handover
  note", "your successor has started") are delivered in full right away. Each waits its turn
  behind a delivery already in progress to that member and is never refused for it; a redirect
  goes ahead of deliveries still queued, never ahead of the one in progress. A copy goes in the
  inbox as an `instruction` item, as history; it is never listed in a wake and never counted
  open. They are still refused for a member that is
  not live, restored or being stopped.
- **Sova's notices are items**, so none can be lost: end-of-task reports to the coordinator (a
  failed task is urgent), handover notices, "new members were added" notices, the monitor's
  `wrap-up`, `pause` and `resume` notices (urgent), `wake_nudge` fires and the rejoined monitor's
  resume check (urgent).
- **A starting member.** An item for a member that has not yet taken its first task is stored and
  listed after its first step.
- **A wake that fails** (the member's process did not start, or the delivery was refused) leaves
  its items stored and is retried after 5 s, 15 s and 60 s, then every 5 minutes, while the member
  is live. The first failure is recorded as a team action `wake retry`.
- **A replaced member.** An item (or a `team_steer`) to a member that has been succeeded
  (§teams.defaults/handover) goes to its newest live successor, and the sender's answer says so
  (`forwarded to builder-2 (ag_31)`); the item keeps its id and its original sender, and records
  whom it was first sent to. A message to a member that has ended while its successor is still
  starting is queued in its inbox, and the answer says the item moves to the successor; it moves
  once the successor starts, or is returned to its sender if none does. A `team_steer` in that
  window is refused, saying the successor is still starting: a direct instruction has no inbox to
  wait in.
  A message to a stopped or ejected member with no live or starting successor is refused, saying
  it stopped (or was ejected) and, for a stopped member, that `agent_resume` brings it back.
- **Moving and returning.** Every way a member ends counts as the end of its turn: when it is
  stopped, fails, is ejected, is found restored after a restart, or is retired by its successor,
  Sova first closes automatically every item it opened (with a turn record,
  §app.teams/inbox-zero) that is not a question, and only then
  moves or returns what is still open. Handled news is never returned as "not addressed" and never
  listed again to a successor. When a member is retired by its successor, its open items move to the
  successor, keeping their ids and senders, and are listed to it; a moved item leaves the old
  member's inbox and records whom it moved from, when and why; status lookups and `replyTo`
  follow the move. A member that ends with no successor (stopped, failed, ejected, or found
  restored after a restart) returns its open items to their senders, one "not addressed" notice per sender listing
  its items and why (an unanswered question always goes back); the
  items Sova sent go to the routing coordinator, or to the main chat when there is none. A
  return to the main chat is shown in its transcript and starts no turn. A resumed
  member (§app.worker-restore/resume) comes back with no open items: they were returned when it
  was found stopped, and its addressed history stays.
- **Kept on disk.** Each member's inbox is an append-only file under the main chat's team folder
  (`<agent dir>/sova/teams/<session>/mailbox/<team_id>/<ag_NN>/items.jsonl`), written only by the
  main chat's extension. A server restart, a chat reload or a member waking from sleep loses
  nothing: after a reload, live members with items not yet listed are woken again. Inboxes last
  as long as the main chat; compaction keeps every open item and the newest 2,000 addressed items
  per member.
- **Members on older code.** A member started before this change, or on a backend without team
  tools, cannot open an inbox: it keeps getting each message in full, on the same never-refused
  delivery.
- **Open counts.** `team_roster` and `team_list` show each member's open-item count
  (`3 open items`), with its oldest unanswered question and how long it has waited when it has
  one (`3 open items (1 question unanswered 20 min)`), and one team line: `Inbox: {n} open ·
  closed by members {m} · automatically {a}`. Sova's screens show each member's inbox
  (§app.subagents-pane/member-inbox).

## §app.teams/inbox-zero — Inbox zero: members close what they handle, Sova closes what they saw and forgot

Each member keeps its own inbox at zero, and Sova closes for it only what it has seen.

- **The norm.** Every member's standing instructions (helper, coordinator and monitor headers),
  the team tool descriptions and each wake list say: handle each item and close it in the same
  step as the work. A reply with `replyTo` closes the item; otherwise `team_inbox done` it with a
  short note on what you did. End each turn with nothing you have handled left open. They never
  present the safety net as a reason to skip closing, and they describe today's delivery (items
  queued in an inbox and listed in a wake), not "the parent session delivers it".
- **Seen means opened, in a turn.** An item counts as seen once the member opened it
  (`team_inbox open`, or the single item a wake showed in full). Sova records the member's turn
  in which it was seen, on disk with the read, so after a main-chat reload an item seen before it
  closes at the member's next turn end. A wake accepted after the member's turn ended but before Sova handled that
  end belongs to the next turn, never to the one that ended. An item shown by a wake whose turn
  Sova cannot place (one whose run had not begun before a main-chat reload) counts as not seen,
  even when the member ends, until the member opens it again.
- **The safety net.** When a member's turn ends, every item it saw in a turn that has ended and
  did not close is marked addressed, closed automatically, with the note `closed automatically:
  seen, not closed by <role>`. Never a question, never an `instruction`, never an item it has not
  opened (a listed subject is not seen), never a returned item. A member that stays busy keeps its
  items open: nothing closes before the turn that showed it has ended.
- **Items read before this change** have no turn record: they are never closed automatically.
  They stay open and are named in the Still open block until the member closes them.
- **Reports name what is left.** A member's end-of-task report to its coordinator, and the
  coordinator's own completion to the main chat, end with a line naming its open items after the
  safety net ran: `[Left open: i_7 question from writer (opened); i_9 report (unopened)]`, at
  most 10 items then `; … and N more`; none when nothing is open.

## §app.teams/inbox-gate — Open your inbox first

When a wake starts a member's turn (an idle member woken by its inbox) and its list names items
the member has not opened, every tool call other than `team_inbox`, `team_msg` and `team_ask` is
refused with `Open your inbox first (team_inbox open <ids>)`, naming those items, until the member
opens at least one item: an `open` naming an item the gate names, or any `open` that succeeds
(one that fails or names no item of its inbox does not count). Such a wake list says so in its
last line: `[Open your inbox first: team_inbox open <ids> — other tools are refused until you
open one]`. The gate never applies mid-turn (urgent items reaching a busy member at
its next step), never to a wake of exactly one item (it shows it in full), and never to a turn
started by anything else. Direct instructions (the main chat's `agent_steer`, the coordinator's
`team_steer`, Sova's handover instructions; kind `instruction`) never trigger it, and once one is
delivered nothing it asks for is refused: it lifts the gate for the rest of that turn. A member
that ends its turn without calling a tool cannot be stopped; that is an accepted limit.
