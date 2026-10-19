# §app/events — Sova's event stream
> Part of the Sova design spec · [overview](../design/overview.md)

Sova tells a script what happens to its sessions on one read-only socket, `/ws/events`, on the
main listener: the same door, token and Host/Origin rules as the page's own sockets. Nothing on
screen changes. Each frame is one JSON object; the socket ignores anything a client sends.

## §app.events/names — What the stream says, and where each event comes from

- A frame of `type: "event"` carries `seq`, `at` (when this server recorded it, ms epoch) and a
  `name`: `session.created`, `session.removed`, `session.renamed`, `session.tagged`,
  `session.archived`, `turn.started`, `turn.ended` or `attention.changed`. Session and turn
  events name the session by `id` and `path`.
- `turn.started` and `turn.ended` with `source: "hosted"` come from the chats Sova runs: one
  `turn.started` when a run begins and one `turn.ended` when it settles, each exactly once per run.
- Every other session and turn event has `source: "observed"`: it is the difference between two
  reads of the session list, the reads the session feed already makes (§app.decisions/push), so
  a change that starts and ends between two reads is not seen and two renames between reads show
  once. Observed `turn.*` follow a terminal session's live record (working or waiting on a
  dialog, or not); a session Sova runs never gets an observed `turn.*`.
- `attention.changed` carries no session: Sova dropped its Needs you digest's memo (an
  organization, baton, outreach or project-services act, or a change in the list), so a reader of
  Needs you should read it again. It is a hint, never a list of every change, and comes at most
  once per 250 ms.
- A socket opened with `?with=command.ran` also gets one frame of `type: "command"`, `name:
  "command.ran"` for each row of Sova's record of who ran what, as it is recorded
  (§app.command-audit/record). These frames are live only: they carry no `seq`, are never kept
  or replayed, and a socket that didn't ask gets exactly what it got without them.

## §app.events/resume — Picking up where a script left off

- The first frame is `hello` with the stream's id (`stream`, new each time the server starts),
  the newest `seq` and the oldest one still kept.
- The server keeps the newest events, at most 1,000 of them and 1 MB of their text.
- `?stream=<id>&since=<seq>` resumes: every kept entry after `since`, in `seq` order, then live
  ones. A `gap` frame names seqs a socket will never get, and why: those no longer kept come
  first (`evicted`), and each time the stream started again after no one was listening it kept a
  one-seq `unobserved` gap at that point, so a resume across it learns that something may have
  happened unseen there. Within one stream, `seq` never goes backwards on a socket. A `stream` that isn't this
  server's gets a `gap` that says the server restarted, then every kept entry. A `since` without a
  `stream`, either one malformed, or a `since` past this stream's newest `seq` is refused with an
  `error` frame and the socket closes.

## §app.events/backpressure — A slow reader never slows Sova

- Each socket holds at most 256 events or 256 KB its client hasn't taken, beyond the 64 KB on
  their way out. Past that the oldest are dropped, and before the next event the socket gets one
  `gap` naming exactly the dropped `seq` range. A socket that stays full for 60 s is closed; its
  client can resume. A resume's replay is not held to that limit: it goes out whole, first, as the
  client takes it (what is kept already bounds it). A client may send nothing bigger than 4 KB: a
  bigger frame closes the socket.

## §app.events/idle — Nothing runs while no one listens

- With no subscriber, the stream reads nothing, listens to nothing and keeps no timer. The first
  subscriber starts it; it stops within 30 s of the last one leaving, so a script that reconnects
  within that time resumes with nothing missed.
- While it runs, it reads the session list only through the session feed's own reads: one more
  subscriber never adds a list read.

## §app.events/listeners — Only on this machine's own door

- The peer listener refuses `/ws/events` (404), as it does every socket but the chat and watch
  ones, and its classifier (§mesh.peers/grants) gives the path a need no grant meets, so a peer
  would still be refused if the listener ever reached more sockets. The share listener has no
  such socket.
