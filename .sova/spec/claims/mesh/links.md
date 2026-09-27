# §mesh/links — Linked sessions across hosts
> Part of the Sova design spec · [overview](../design/overview.md)

A **link** joins two or more Sova-hosted sessions (pi or claude-code backend), each on its own
mesh host, into a remote team whose members can message each other and, later, hand each other
files. A member is always a session its own host runs: never a remote target, never a TUI-live
session, never a worker's session, and never an Overseer, project-overseer, baton or other
organization's session (§app/baton, §app/project-overseer, §app.session-list/organizations). A session is still driven only by the host whose disk holds
its file (§mesh/remote-sessions): every message and every file lands through the member's own
host. A link moves messages, never session files; sessions still never sync
(§mesh/sync). While the mesh is off no link can exist, and nothing here runs (§mesh.peers/off).
Moving files between members is a later stage, not built yet: a link works without it.

## §mesh.links/record — A link is a durable record on every member host

- **What it is.** `{id, createdAt, createdBy, members[], endedAt?}`. The id is `lk_` plus random
  hex, minted by the creating host. A member is `{nodeId, sessionId, path}`: the host by its
  Tailscale node identity, the session by id, and its path on its own host, resolved when the link
  is made. A member host's peer id and label are never stored: they are looked up from this host's
  `peers.json` by node identity whenever they are used (a peer's id here can be changed). **One
  member per host**: a link never joins two sessions on the same host, and making one is refused.
- **Its own identity.** A host that doesn't know its own node identity (a phone that identifies
  callers by address, §mesh.peers/address-identity) learns it from the first member host that
  sends it a link, which names the recipient's identity as it knows it, or by asking any peer.
- **Where it lives.** Every member host keeps the same record in `<stateRoot>/mesh-links.json`
  (`{version: 1, links: []}`, mode 0600, written atomically like `peers.json`); inboxes and the
  outbox live under `<stateRoot>/mesh-links/`. The creating host writes its copy and sends it to
  every other member host over the peer listener; a host that is down gets it from the creating
  host's outbox when it next comes up (§mesh.links/delivery). So a member can send while the
  creating host sleeps.
- **Fixed membership.** Members never change after creation. The only change is ending it:
  `endedAt`, set once, the earliest one wins, spread to every member host. An ended link stays
  listed as history; every tool refuses to use it. Archiving a member session ends every link it
  is in.
- **No live state.** A link is not a connection. It is idle whenever no message is in flight and
  its members are idle, and it needs nothing to be re-established: the next message is delivered
  if the member's host is up, or held until it is. It survives restarts of any host.
- **Unreachable, never dropped.** A member whose host is not in this host's `peers.json` is shown
  as unreachable here; the link is kept.

## §mesh.links/delivery — A message reaches the member through its own host

- **Path.** A sending session's tool call goes to its own host (never straight to a peer), and
  that host forwards to the member's host over the peer listener. The routes a session's tools
  call answer only on this host's own listener, never to a peer and never through the page proxy.
  Sender identity is never taken from a message body: on the peer route the sending host is the
  listener's verified caller, and the route serves only a `{caller, session}` pair that is a member
  of the link; locally, the sending session must be one this host holds and a member.
- **Into the member, the way a team message reaches a teammate.** The receiving host records
  the link message in the member's link inbox and hands it **straight to the member's agent** as a
  user message tagged `[link_msg <linkId> <messageId>] from <label> (<host>/<session>)`, followed
  by the text and a line naming `link_send` for a reply. A member whose runtime is not loaded is
  reopened first. An **idle** member starts a new turn with it; a **busy** member's agent gets it
  through the agent's own steering, never through the session's queue, and sees it at its next
  step without ending the turn it is in; a member that is compacting gets it once the compaction
  ends. A link message that starts a turn is a turn starting like any prompt: until its run
  begins, a message the user sends in that session is queued behind it
  (§chat.transcript/a-queued-message), never refused. A link message that arrives while a turn is
  starting (a message accepted, its run not yet begun) waits for that run to begin, then steers
  into it. It **never enters Sova's web queue**, the queue of messages the user typed: it is never a
  queued row, never counted or reordered with the user's messages, and Remove never reaches it.
  The ids in the tag are random, so text that merely quotes a tag is never classified as a link
  message.
- **The writing guards still hold.** Handing a message to the agent directly is still a write to
  the member's session, so it happens only while this host holds the runtime, never to a TUI-live
  file, never past a foreign writer (the same refusals as a prompt from the page), and the
  deferred opening appends are written first, as before any prompt.
- **Both backends.** It is a user-role message in the session's context, so a pi session's model
  reads it directly, and a claude-code session's bridge forwards it: the bridge sends the CLI every
  user-role message pi has appended since its last turn, steers and follow-ups included, after the
  pending tool results, as one message the CLI takes into its active turn. For a claude-code
  member "its next step" is therefore the next time the CLI hands a tool call back through pi, or
  the end of the CLI's turn if it makes none.
- **Refusals** go back to the sender as the result, never silently dropped: a TUI-live member, an
  archived member, a session another writer touched recently (the busy rule), a member whose model
  the model policy has turned off (§chat/model-menu; the message would otherwise be swallowed), an
  Overseer, project-overseer, baton or other organization's session, an ended link.
- **Stop takes back only the user's own queued messages.** A link message that hasn't reached the
  model yet when the user presses Stop is kept, never handed to the composer, and goes in at the
  member's next turn.
- **The result says what happened**, per recipient: `started` (an idle member began a turn),
  `delivered` (a busy member will see it at its next step), `outbox` (host offline), or `refused`
  with the reason. Acceptance is not proof the partner acted on it.
- **Inbox.** Each member host appends every message it delivers or sends for a member to that
  member's inbox, `<stateRoot>/mesh-links/<linkId>/<sessionId>.jsonl`, bounded to the newest 200
  records. The thread the Agents tab shows (§mesh.links/agents-pane) is these records merged.
- **Outbox for an offline host.** A send that can't reach the member's host (it is down or doesn't
  answer) goes to this host's `<stateRoot>/mesh-links/outbox.jsonl` and is retried when that peer
  comes up, and on a 60-second timer only while the outbox holds something. A refusal from the
  peer is final and is not retried. A host on a build without links answers not-found; that is
  final too, and never retried. The outbox survives restarts.
- **Outside the protocol fingerprint.** The link routes' bodies are not part of the protocol hash
  hosts compare (§mesh.peers/hello), so a later change to them never shows a host as `skewed`.

## §mesh.links/transcript — A link message is invisible in the main transcript

A link message is a real user entry in the member's session file, and the model sees it, but it is
not the user's message and the main transcript never shows it:

- The server classifies it by its tag as the transcript kind `link`, on reload and on the live
  path alike, and the main thread renders **nothing** for it: no row, no pill, no "You" bubble.
- It is **not counted** anywhere the thread counts rows it hides.
- It still starts a turn (the check for tool calls that may still be running, turn boundaries),
  but it is not one of the user's inputs: never in the inputs count, the Timeline or the rewind
  targets. Regenerating a reply to it is refused, as for a wake.
- It never titles the session, and session tags skip it (§app.decisions/session-tags), so a
  partner's words never become the session's topic.
- A turn it opened still counts as finished work the user hasn't seen, like any other finished
  turn, but it is **never "asks you"**: attention signals never ask whether such a turn asks the
  user (§app.decisions/attention-signals), so a question to the partner never puts the session in
  Needs you.
- It never passes through the web queue (§mesh.links/delivery), so it is never a queued row and
  Stop never hands it back.
- It is visible only in the Agents tab's linked-agents section (§mesh.links/agents-pane).

## §mesh.links/tools — The link tools

One pi-config extension, `link`, registers three tools at load, with a fixed schema, in every
session Sova hosts; a claude-code session gets the same tools through the provider's `mcp__sova__`
bridge with no separate copy. They never appear or disappear when a link is made or ended, so a
claude-code session's tool set never changes mid-conversation. Hosted by anything other than
Sova (a TUI), they are registered but inert; workers never get the tools' switch, and there they
are inert too.

- **`link_members`**: the links this session is in, and for each member its host, label, cwd,
  backend, whether its host is up and whether it is working or idle.
- **`link_send {to?, text}`**: deliver (§mesh.links/delivery). `to` is a member (by host, session
  id or label), several, or `all`; with two members it may be left out.
- **`link_inbox {limit?}`**: this session's inbox records, newest last.

Each refuses, with a sentence saying so, when the session is in no link. The tools talk only to
the session's own host, which does every peer hop; the extension knows nothing about the mesh.
While a session is linked, each run's prompt gets a short section that changes only when a link
is made or ended (partner names and ids, the tools; no live state such as up, down, working or
idle), since a change to it restarts a claude-code session's CLI.

## §mesh.links/agents-pane — "Remotely linked agents" in the Agents tab

Link traffic is shown in the session pane's Agents tab (§app/subagents-pane), never in the main
thread. After the team and subagent sections comes a section **Remotely linked agents**, present
only when there is at least one row. Section headings show whenever this section is present, and
the empty state never says "0 subagents" while it has rows.

- **One row per member on another host.** A linked member is not a worker: its row has its own
  type (`LinkedAgentInfo`, not `WorkerInfo`), no spawn model and no usage this host can total. The
  row shows the title, the host's label, the model, a state chip (**working**, pulsing; **idle**,
  with "as of" its last activity; **offline**, muted, when its host is down) and the number of
  messages from it not yet seen here.
- **The row opens two regions.** The thread between the members, both directions, oldest first,
  file offers and transfers as status rows; and below it the member's own transcript, read-only,
  through the proxy of the host serving the page, found by the member host's node identity; a
  host the serving host doesn't know shows as not reachable from here. A host that is down shows
  "host offline" and the thread as last known.
- **Where the rows come from.** The session's insight carries the links, and the chat socket
  pushes them again whenever a link message lands, so the section updates without waiting for the
  poll. A member's working/idle state and last activity come from its host's session-by-id route
  (§mesh.links/by-id), cached briefly; a failed hop reads as offline.
- **Scope.** A member session's pane lists only the links it is in. The Overseer's pane lists
  every link this host knows, each as its own group with all of its members; a local member's row
  opens that session. The Overseer is never a member, and its pane never sends into a link.
- The pane never sends either: the thread is read-only here.

## §mesh.links/by-id — Look a session up by id

`GET /api/sessions/by-id/:id` answers the `SessionSummary` of this host's session with that id, or
404, never cached (`no-store`), from the same index the session list reads. It is an ordinary
`/api/` route, so a peer reaches it on the peer listener and a page reaches a peer's through
`/peer/<id>/api/sessions/by-id/<id>`. `GET /api/sessions/summary?id=` already answers the same and
keeps doing so; `by-id` is the same answer at a path-shaped URL (a peer on an older build answers
only the former). Links use it to fill a member's path, to resolve a tool's `to`, and to poll a
member's state.

## §mesh.links/configure — Set a session's model and modes over REST

`POST /api/sessions/configure {path, model?, thinking?, mode?, minorModes?}` sets any of a
session's model, thinking level, mode and minor modes, opening its runtime on this host if it isn't
loaded. It is the same code the Overseer runs in-process for `sova_set_session`, as a route: the
same refusals (TUI-live, archived, mid-turn, subagents working, the model policy; an unknown mode
or minor mode refuses the whole call before anything changes), and it applies to that session only:
the saved default new sessions start from is never changed (§chat.model-menu/saved-default), and
the default mode moves only as §chat/mode-menu says. A mode or minor modes it sets are written into
the session as its `mode` entry even when they equal the default, as `sova_set_session` writes
them, so a later change to the default never moves it; a call that sets no mode writes none. It is an ordinary `/api/` route, so a peer
reaches it on the peer listener (§mesh.peers/listener); that is how the Overseer configures a
session it created on a peer (§app.overseer/links-tools).
