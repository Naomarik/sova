# §mesh/links — Linked sessions across hosts
> Part of the Sova design spec · [overview](../design/overview.md)

A **link** joins two or more Sova-hosted sessions (pi or claude-code backend), each on its own
mesh host, into a remote team whose members can message each other and hand each other
files. A member is always a session its own host runs: never a remote target, never a TUI-live
session, never a worker's session, and never an Overseer, project-overseer, baton or other
organization's session (§app/baton, §app/project-overseer, §app.session-list/organizations). A
link with a member on a LAN pairing (§mesh/lan) joins only two hosts: the host making it and that
pairing (§mesh.links/host-names). A session is still driven only by the host whose disk holds
its file (§mesh/remote-sessions): every message and every file lands through the member's own
host. A link moves messages and the files its members offer (§mesh.links/offers), never session
files; sessions still never sync (§mesh/sync). While the mesh is off no link can exist, and nothing
here runs (§mesh.peers/off). A link works without ever moving a file: offers are something a member
does, never part of making or keeping a link.

## §mesh.links/record — A link is a durable record on every member host

- **What it is.** `{id, createdAt, createdBy, members[], endedAt?}`. The id is `lk_` plus random
  hex, minted by the creating host. A member is `{nodeId, sessionId, path}`: the host by its
  node identity as the host keeping the record knows it (its Tailscale node identity, or
  `lan:<pin>` for a LAN pairing; §mesh.links/host-names), the session by id, and its path on its
  own host, resolved when the link is made. A member host's peer id and label are never stored: they are looked up from this host's
  `peers.json` by node identity whenever they are used (a peer's id here can be changed). **One
  member per host**: a link never joins two sessions on the same host, and making one is refused.
- **Only link member sessions.** Every member must have been created as a link member session
  (§mesh.links/tools). Making a link with any other session is refused, naming that member and
  saying it was not created with the link tools, so to create a new session for it with `link`
  (§app.overseer/links-tools). Each host checks its own member: the host making the link checks
  its local member before anything is sent, and a member host refuses a new link's copy whose
  member on it is not one, which fails the whole link as any refused copy does (§app.overseer/links-tools).
  A host on an earlier build checks nothing here. The check is made only when a link is made: a
  link that already exists keeps its members, and a copy of a link the host already keeps is never
  refused for it.
- **Its own identity.** A host that doesn't know its own node identity (a phone that identifies
  callers by address, §mesh.peers/address-identity) learns it from the first member host that
  sends it a link, which names the recipient's identity as it knows it, or by asking any peer.
  Each peer's answer to that question is also kept, per peer, as the name that peer knows this
  host by (§mesh.links/host-names).
- **Where it lives.** Every member host keeps a copy of the same link, each naming the hosts in its
  own terms (§mesh.links/host-names), in `<stateRoot>/mesh-links.json`
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
  as unreachable here; the link is kept. Only a copy naming, in a LAN pairing's terms, a host this
  host doesn't know is refused when it arrives (§mesh.links/host-names).

## §mesh.links/host-names — A host is named the way each peer knows it

- **A host can have two names.** Its Tailscale node identity, which its tailnet peers know it by,
  and `lan:<its pin>` (§mesh.lan/identity), which every LAN pairing knows it by, whichever side
  dials (§mesh.lan/pairing). A host on a tailnet and on a LAN pairing has both. The name it keeps
  for itself is its listener's Tailscale identity when it has one, else the one it learnt
  (§mesh.links/record).
- **Each host keeps a link in its own terms.** Its copy names itself by the name it keeps for
  itself, and every other host by that host's node id in its own `peers.json`.
- **Sent in the receiver's terms.** When a host sends a member host a link's copy, a message or a
  file offer, it names itself by the name that host knows it by: what that host's whoami answered
  (kept per peer), else `lan:<pin>` to a LAN pairing and its Tailscale identity to a tailnet peer.
  Every other host is named as the sending host knows it. Something held in the outbox is named
  when it goes, so it carries the newest answer.
- **Any of its names is itself.** A host takes each of its own names, and every name a peer's
  whoami gave it, as itself; an id that names one of its peers is never itself. A link, message or
  offer that names it by any of them is kept under the name it keeps for itself, and records it
  wrote under another of its names (a link made before it joined a tailnet) are read and rewritten
  that way when it starts. A copy that names this host twice is refused. Who sent something is
  still only the listener's verified caller, never a name in the body.
- **A host it can't name is refused.** A link copy that names a host other than this one and the
  caller, which this host's `peers.json` doesn't list, is refused (not a member), never stored,
  when that host is named by a LAN id or the copy came from a LAN pairing: this host could neither
  reach that member nor tell who it is. A tailnet id is the host's own everywhere, so on a tailnet
  such a member is kept and shown as unreachable.
- **Links across a LAN pairing join two hosts.** A LAN pairing names only the hosts it pairs with,
  by their LAN names, so a link with a member on a LAN pairing has only two hosts: the host making
  it and that pairing (§app.overseer/links-tools).

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
  peer is final and is not retried. A link's copy held for a host that was down and refused once
  that host is back (its session is gone, it can't take the link) ends the link: the creating host
  ends it on every host, as `sova_unlink` does, and the link keeps why (`endedWhy`), which a member's
  link tools give when they refuse the ended link and `sova_links` shows. A host on a build without links answers not-found; that is
  final too, and never retried. The outbox survives restarts. A delivery (a link copy, an end, a
  message or an offer) to a peer this host's own grant withholds links from (§mesh.peers/grants)
  is refused at once, never held in the outbox, and that peer is not marked down.
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
  turn. Whether its reply asks something is never checked (§app.decisions/asks-user), so a
  question to the partner never puts the session in Needs you.
- It never passes through the web queue (§mesh.links/delivery), so it is never a queued row and
  Stop never hands it back.
- It is visible only in the Agents tab's linked-agents section (§mesh.links/agents-pane).

## §mesh.links/tools — The link tools

One pi-config extension, `link`, has seven tools, with a fixed schema, and only a **link member
session** gets them: a session created as one (§app.overseer/links-tools), which carries a marker
from its creation, before its first message. Every other session has none of them: an ordinary
chat, the Overseer and the other special sessions, a TUI session and a worker register no link
tool, and no profile or setting adds them. A link member has all seven from its first request; a
claude-code member gets the same tools through the provider's `mcp__sova__` bridge with no
separate copy, and a claude-code chat that is no member sees none there. The set is fixed when the
session's runtime starts and never changes because a link is made or ended, a message arrives or
the session is linked or unlinked, so a claude-code session's tool set never changes
mid-conversation.

**Sessions from before.** A session an earlier build hosted already declares the seven tools in its
transcript. It keeps them, unchanged, until its next compaction, and loses them at that
compaction, since a compaction already rebuilds the prompt cache (a claude-code session's CLI
restarts after one). A compaction while the session is in a live link keeps them until a later
compaction that finds it in none, and so does a compaction at which its host can't say. They are
never dropped at any other moment, and once dropped they never come back. A session that never
declared them never gets them this way.

- **`link_members`**: the links this session is in, and for each member its host, label, cwd,
  backend, whether its host is up and whether it is working or idle.
- **`link_send {to?, text}`**: deliver (§mesh.links/delivery). `to` is a member (by host, session
  id or label), several, or `all`; with two members it may be left out.
- **`link_inbox {limit?}`**: this session's inbox records, newest last.
- **`link_offer {paths, to?, dest?, exclude?, note?, link?}`**, **`link_accept {offer, dest}`**,
  **`link_decline {offer, reason?}`** and **`link_offers {}`**: file offers (§mesh.links/offers).

Each refuses, with a sentence saying so, when the session is in no link. When `link_send` or
`link_offer` is refused because the session's link has ended and that link keeps why
(§mesh.links/delivery), the sentence gives the reason the session's most recent such link ended. The tools talk only to
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

`POST /api/sessions/configure {path, model?, thinking?, mode?, minorModes?, subagent_profile?}`
sets any of a session's model, thinking level, mode, minor modes and subagent-profile ID pick,
opening its runtime on this host if it isn't
loaded. It is the same code the Overseer runs in-process for `sova_set_session`, as a route: the
same refusals (TUI-live, archived, mid-turn, subagents working, the model policy; an unknown mode
or minor mode, or an unknown subagent-profile id, refuses the whole call before anything changes).
A profile-only switch bypasses only the mid-turn and working-subagent gates: it affects later
turns and team actions, never running workers or the main model; TUI-live, archived, special-session
and foreign-writer refusals remain. A combined model/mode/profile configure keeps the normal busy
gates. It applies to that session only:
the saved default new sessions start from is never changed (§chat.model-menu/saved-default), and
the default mode moves only as §chat/mode-menu says. A mode or minor modes it sets are written into
the session as its `mode` entry even when they equal the default, as `sova_set_session` writes
them, so a later change to the default never moves it; a call that sets no mode writes none.
`subagent_profile` writes a separate hidden `{v: 1, profile}` entry, an ID reference, not a snapshot
(§chat.subagent-profiles/resolution). It is an ordinary `/api/` route, so a peer
reaches it on the peer listener (§mesh.peers/listener); that is how the Overseer configures a
session it created on a peer (§app.overseer/links-tools).

## §mesh.links/offers — File offers to members

A member can make a **file offer** to one member, several, or all of them with `link_offer`; a
recipient answers with `link_accept` or `link_decline`; `link_offers` shows every offer to and from
the session with each recipient's state. No human confirms anything, on either host.

- **The sender chooses exactly what goes.** `paths` are resolved against the sending session's
  cwd (`~` and absolute paths allowed), must exist, and are listed and sized before anything moves;
  the result names the offer (`of_` plus random hex), the file count and the bytes. There are no
  default exclusions: build output, `node_modules` and `.git` go when the sender names them. An
  optional `exclude` list is the sender's own choice: a pattern without `/` matches any path
  component (`node_modules`, `*.log`), one with `/` matches the path from the offered root's name
  (`proj/dist`); `*`, `?`, `**` and `[…]` work. What is listed is exactly what is packed, so the
  count the sender sees is the count that lands. No size cap. Symlinks travel as links and are
  never followed.
- **`dest` is a directory.** Each offered path lands at `dest/<its name>`, as `cp -r a b dest/`
  would put it. Two offered paths with the same name are refused, and so is `/`, which has none;
  nothing is renamed on arrival.
- **A worktree carries no history.** When an offered tree holds a `.git` that is a file whose
  `gitdir:` is absolute, or points outside the offered paths (a git worktree's pointer,
  §chat.worktrees/entry), the result and the offer message say so: the receiver gets no history,
  so offer the main checkout or a `git bundle`. A submodule whose `.git` points inside an offered
  superproject is not reported. It is never refused; the sender still decides what goes.
- **With `dest`, the accept is implicit.** Every recipient is already accepted, and each
  recipient's **host** checks `dest` and pulls the files into it at once, without a turn on the
  recipient; the recipient then gets one inbox record and one message saying what landed where, or
  why it failed. `dest` may be one directory for everyone or one per member, named as `to` names
  them; an unknown member refuses the whole offer before anything is written. This is the default
  the tool describes: name `dest` when you know it.
- **Without `dest`, the recipient decides.** Each recipient gets an offer message (it wakes like any
  link message) and answers `link_accept {offer, dest}` or `link_decline {offer, reason?}`. One
  recipient's answer never waits on another's. An unanswered offer expires after 24 hours. A
  recipient that can't take the message (open in a TUI, archived, its model off, busy, special) is
  refused for that offer, final, as a message would be (§mesh.links/delivery): a TUI session has
  no link tools, so it could never answer.
- **`dest` is the recipient host's.** `~` is that host's home (`~user` is refused), a relative path
  is under the member session's cwd, `..` is normalised and missing parents are created. Existing
  files are overwritten. Nothing else is checked, except that Sova's own state is never written:
  a `dest` inside Sova's state root or the sessions directory is refused, and so is a `dest` above
  one of them when an offered path would land in it (offering `.pi` into `~`).
- **A sandboxed session binds the server.** The server packs and unpacks on a session's behalf,
  so while the **sending** session's sandbox is on (§chat/sandbox) it refuses to pack any path that
  session's own tools couldn't read: an offered path that is hidden, or a tree that holds a hidden
  path the `exclude` list doesn't drop, named so the sender can exclude it. While a **receiving**
  session's sandbox is on, its host refuses, for that recipient, a `dest` its tools couldn't write
  (its writable roots include its tracked worktrees, §chat.worktrees/sandbox), and, before
  extracting, checks every path in the archive the same way, refusing on the first it couldn't
  write or that would be written through a link already on disk. The server resolves the same
  policy the sandbox extension does, from the session's own branch; when it can't, it refuses. With
  the sandbox off, nothing here is restricted. **Known limit:** the check before extraction and
  the extraction are two steps, so a sandboxed receiving agent that plants a symlink in `dest`
  between them could have the files written through it, outside its sandbox. Extracting inside the
  receiver's own sandbox would close this; it is not built.
- **Files land even when the session can't take a message.** A `dest` the sender named is applied
  while the recipient is mid-turn, unloaded or TUI-live; only the message about it waits for the
  member's next step, or, for a TUI-live member, is skipped and left in the inbox.
- **Notices are link messages.** The offer, the landing, a decline and the sender's wake are ordinary
  link messages with the usual tag, so they are classified, hidden and counted exactly as
  §mesh.links/transcript says; each is one inbox record, updated as the offer moves on.
- **The sender is woken once**, when every recipient has finished (done, declined, failed, refused,
  expired or cancelled) or at the first failure after an accept, whichever is first; each
  recipient's progress before that is an inbox record only. Refusals the offer already returned
  never wake it.
- **Ending the link cancels its open offers** on every member host: no further pull is served and
  every partial copy is deleted.
- **A host on an older build** answers an offer as it answers any unknown route; that recipient is
  refused for the offer as an old build, final, never retried, and the others go on.

## §mesh.links/transfer — Pack once, each recipient pulls

- **Pull, never push.** For a file offer, a recipient's host fetches the bytes from the sender's
  peer listener, and the sender serves only the fixed list the offer named, only to a host that is
  one of that offer's recipients and has accepted. A peer can't send bytes to a host that holds no
  offer for them.
- **Packed once, at offer time.** The sender packs the listed paths once, with the host's own `tar`
  and Node's built-in zstd, into a spool file under Sova's state root, and records its size and
  hash, whether or not anyone has accepted yet. Every recipient's pull streams that same file, so
  every recipient gets identical bytes, and several pulls run at once. A pull that arrives while
  packing is still running is told to come back. A host with no room to pack fails the offer with a
  sentence saying so; there is no spool limit and no other way to serve it. The spool is deleted
  when every recipient has finished, the offer expires or it is cancelled.
- **Resumable.** The recipient's host downloads into a partial file under its own state root; a
  pull cut off partway, or stalled for a minute, resumes from the byte it had received, including
  after either host restarts. A pull still moving at the 24-hour mark keeps going until an hour
  after its last byte.
- **Verified, then unpacked.** Nothing lands in `dest` until every byte has arrived and matches the
  sender's hash; a mismatch restarts the download once, then fails. The host then unpacks into
  `dest` and deletes the partial file. A failed unpack leaves whatever it wrote; offering again
  overwrites it.
- **A server-to-server stream.** The transfer is a GET between the two hosts' Sova servers, never
  through the page proxy, with no size limit.
- **Per-recipient result.** The recipient's host reports each step (accepted, unpacking, `done`
  with the bytes and the time, `failed` with the reason, declined, refused) back to the sender, or
  holds the report until the sender's host is up; the sender's copy of the offer holds every
  recipient's state and the bytes served to it, and each recipient's copy holds its own row.
- **A phone needs nothing extra.** The phone installer (§mesh/phone) already puts `tar` and `git`
  on a Termux host, and Node's zlib does the compression on every host, so a transfer, and using a
  received `.git` there, needs no install beyond Sova. A host without `tar` refuses to offer.

## §mesh.links/offer-rows — Offers in the Agents tab

The Agents tab's linked-agents section (§mesh.links/agents-pane) shows offers read-only.

- **A transfer chip on the member's row** for the newest unfinished offer with that member, either
  way: waiting for an answer, sending or receiving with the bytes so far out of the total, or
  unpacking. It sits beside the state chip.
- **Status rows in the thread**, among the messages by time: one per offer with its direction, the
  offered names, files, bytes, note and any worktree warning, and under it one line per recipient
  with its state (offered, accepted, pulling with progress, unpacking, landed, declined, failed,
  refused, expired or cancelled), bytes, `dest`, time and reason.
- **Live while it moves.** The chat socket pushes the change while a transfer runs, at most every
  two seconds, so the chip and the thread follow it without a reload.
