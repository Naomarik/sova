# §app/chat-processes — Chats in a process of their own

On Linux, a server started with `SOVA_CHAT_HOST=out` runs each ordinary chat in a process of its
own instead of inside the server. The process is a systemd transient user service in a slice of
its own, outside the server's service, so stopping or restarting the server does not stop it. The
switch is read once at start and is off by default. With it off, or on a host where it can't apply
(not Linux, no systemd user manager answering, the server on Node), every chat runs in the server's
process as before, and `GET /api/health` says which and why (§app.server-runtime/health).

An ordinary chat is any chat that isn't one of these, which stay in the server's process whatever
the switch says: the Overseer, a project overseer, a baton session, a worker's own session file,
and a chat whose profile grants powers. A link member or a fan-out member is ordinary. A chat the
server could not start in a process of its own (the unit didn't start or never answered) runs in
the server's process until the server restarts, and the server logs why; a chat that refuses to open
(another writer, a missing folder) is refused as before.

To the person, a chat in its own process is the same chat: the same transcript, composer, tools,
workers, dialogs and refusals. What differs is what survives a server restart
(§app.chat-processes/survives-restart) and what happens when the chat's own process dies
(§app.chat-processes/crash).

## §app.chat-processes/survives-restart — A server restart leaves the chat running

- **Nothing is stopped.** When the server stops, a chat in its own process is not aborted, its
  reply keeps streaming, its workers keep working, and its tools keep running. The server only
  says goodbye on the chat's socket. Its run is never recorded as cut off, so no "The Sova server
  restarted…" message follows (§app.overseer/auto-resume).
- **The next server takes it back.** At start, before it accepts any chat connection, the server
  finds the chat processes of its own state root that are still running and reconnects to each. A
  browser that reconnects meanwhile waits for that, never starting a second copy of the chat. Each
  chat process's live record counts as the server's own, so it never reads as a terminal holding
  the file.
- **Browsers carry on.** A pane that reconnects mid-reply shows the reply so far and keeps
  streaming it (§chat.transcript/streaming).
- **Dialogs stay open.** A question an extension asked stays open while no server is connected,
  and a pane that connects shows it again with the time it has left (§app.harness/session-open).
  When the server is back and nobody reconnects within a minute, the question is answered with its
  default, as when the last pane leaves.
- **Workspace commits.** The shutdown's last workspace commit takes what the files hold at that
  moment, whatever a running chat is still writing; the next commit takes the rest.

## §app.chat-processes/crash — When a chat's process dies

A chat process that dies (a crash, a kill by a signal, a non-zero exit, or a process that stops
answering and is stopped by the server) is reported once. A process stopped in order (its unit
stopped from outside, which it answers by closing the chat as it would for an archive) is not a
death: nothing is reported and nothing is resumed.

- **In the pane.** Each pane attached to it gets the error "This chat's process stopped
  unexpectedly (exit N | signal S | it stopped answering). Your messages are saved; it reopens when you reconnect.",
  followed by "Last output: …" with up to its last 3 log lines (at most 300 characters) when there
  are any, and its socket closes; the pane reconnects as it does after any error, and the chat
  opens in a new process.
- **Its last writes are the server's.** While the dead process still held the session file's writer
  lock and the file hasn't changed since it ended, what it wrote is the server's own write
  (§chat.transcript/own-writes-across-restart): the chat reopens for chat at once, never read-only
  as changed by a process Sova can't identify. Otherwise the 120-second rule applies.
- **Continue, once.** When it died with a run in flight, the chat gets one message, a few seconds
  later: "This chat's process stopped unexpectedly and cut off your last turn. Continue where you
  left off.", under the same rules and setting as a resume after a server restart
  (§app.overseer/auto-resume). A run that resume started and that is cut off again is not resumed a
  second time. A process that stopped because it was asked to (idle, archived, a code reload, the
  chat closing itself) is never resumed, and a server restart is never a death.

## §app.chat-processes/server-actions — Server actions from a chat process

A few tools an ordinary chat has act on the server's own state: `project_verbs` (a project's running
instances) and `queue_push` (a topic's queue). In a chat process each call of one is run by the
server, under an id of its own: a call the server is handed twice is run once. A call made while no
server is connected waits for one; when none comes within about a minute the tool answers "The Sova
server isn't answering, so this action didn't run. Try it again in a minute." A call the server was
handed and that the server stopped before answering is never sent again: the tool answers "The Sova
server restarted while this action ran, so its outcome is unknown. Check whether it took effect
before you try it again." Stopping the reply cancels the call on the server. The tools are declared
to the model as in the server's process, so the chat's prompt and tool list don't change. What else
the chat reads of the server (a project's instance note, a schedule's playbook, its linked agents,
the singleton check) is asked of the server when needed; while no server is connected it reads as
none.

## §app.chat-processes/wire — The chat process's socket

The server and a chat process talk over one unix socket per chat, in a directory only the user can
open (0700, the socket 0600), under the state root, or under the runtime directory when that path
would be too long for a socket. The chat process listens and the server dials. Each frame is a
4-byte big-endian length followed by that many bytes of UTF-8 JSON, one object with a type `t`. A
frame above 64 MiB, an empty one, or one that isn't such an object closes the link. Every
connection starts with the chat's `hello` (protocol, build, pid, state, last event number, highest
controller epoch). The server answers `control` with its epoch, which never goes down across
restarts; a lower or equal epoch on a second link is refused, a higher one replaces the link before
it, and a command carrying another epoch is refused unrun. Each side speaks protocol N and accepts
N-1. The kernel frames (hello, control, refuse, ping, drain, drained, exit, bye) never change, so
any server can drain any chat; every other frame is additive, and a frame of an unknown type is
ignored. Lifecycle events are numbered by the chat process and replayed from the last number the
server saw, or reported as a gap. Browser frames pass through as the chat serialised them. A session
file has one writer: a chat process, or the server for a chat in its own process, holds a lock on it
under the state root while the chat is open. A lock whose process is gone is taken over.

## §app.chat-processes/supervision — Who runs a chat's process

The server starts each chat it runs out of its process as a systemd transient user service named
`sova-chat-<state hash>-<session id>`, in `sova-chats.slice`, outside the server's own service. The
process is the server's own Bun running `server/chat-runtime/main.ts` from the repository root
(never the chat's own folder). Stopping it sends SIGTERM to the chat's process and, 30 s later,
SIGKILL to whatever is left of its unit (`KillMode=mixed`). There is no `Restart=`: systemd never
starts a chat again; the server decides.

- **Environment.** The chat's process gets the server's environment, minus the service manager's
  per-unit variables (`INVOCATION_ID`, `NOTIFY_SOCKET`, `LISTEN_*`, `WATCHDOG_*` and the like), `PWD`
  and `OLDPWD`, and the server's own `PORT` and `HOST`. On `PATH` come Sova's Bun first, then the
  directory of the Claude program the server resolved, then the server's `PATH`. It also gets
  `HOME`, `PI_CODING_AGENT_DIR` and the chat's own `SOVA_CHAT_*`. All of it is passed in a file only
  the user can read, never on a command line. A variable that file can't carry (a name that is no
  variable name, or a value on more than one line) is left out, and the server logs its name once.
- **Records and adoption.** Each chat is recorded under `<state root>/chats/registry/`. At a server
  start, before chat sockets are served, the server takes charge of the recorded chats whose unit is
  running. A recorded chat whose unit is gone is a death, and a unit with this server's prefix that
  no record names is stopped. Units of another state root are never touched.
- **Deaths, once.** A chat's process that ends without first saying it exits (an exit other than 0,
  a signal, or a unit that is gone) is reported exactly once: how it ended and its last 20 log lines
  go to `<state root>/chats/deaths.jsonl` and to the chat (§app.chat-processes/crash). A death the
  server recorded but could not deliver before it stopped is delivered at its next start. Exit 0
  without a stated cause reads as an operator stop, not a death. A process that ends, or doesn't answer in time,
  before it ever answered the server is a failed start, not a death: logged, never in the deaths log,
  and the chat opens in the server's process (§app/chat-processes).
- **One process per chat.** Starting a chat whose previous process is still exiting waits up to
  10 s for that process and the session's writer lock to go.
- **Claude programs.** Across all chat processes at most 4 idle Claude CLI children are kept
  (`SOVA_CHAT_CLAUDE_IDLE_MAX`). Beyond that, the one idle longest is let go, and a busy one never
  is; that chat's next turn resumes from its resume record (§app.claude-code-provider/continuity).
- **Tests.** `SOVA_CHAT_SLICE` names another slice, and `SOVA_CHAT_DRIVER=detached` runs chats as
  detached sessions instead of units. Neither is ever chosen on its own.

## §app.chat-processes/idle-stop — An idle chat process stops

A chat's process with nobody attached and nothing in flight (no reply, compaction, queued message,
open dialog, working worker or server action) is asked to close after 30 minutes like that
(`SOVA_CHAT_IDLE_MIN`, in minutes, fractions allowed; 0 is never). The chat checks again that it is
still quiet with nobody attached, and refuses otherwise, which restarts the clock. A chat that
accepts but has not exited 30 s later is stopped. An idle stop is not a death and never gets a
"continue". The chat stays closed until someone opens it, which starts a new process in under a
second. Idle workers end with the process and are restored as records (§app.worker-restore/restore).

## §app.chat-processes/code-pickup — Picking up new code

Each chat's process carries the build of the server that started it: the commit, plus a digest of
uncommitted changes when the tree is dirty (`SOVA_BUILD` overrides it for tests; an unknown build
means no badge). A chat whose build differs from the server's, both known, is on older code. It asks
to reload at a quiet moment: when nobody is attached, or after 5 minutes quiet. "Reload Now" asks at
once when the chat is quiet, else when its reply ends; working workers still hold it. Reloads run one
at a time. The server first starts a replacement process and waits up to 30 s for it to boot; only
then does it ask the old process to close. The old process refuses if it is no longer quiet; the
replacement is then stopped, and the reload is tried again later. On close, the chat reopens in the
replacement, and attached browsers reconnect with their draft kept. A reload never cuts off a reply.
When a replacement fails to boot, or the chat fails to open in it, the replacement is stopped and
no further automatic reload happens until the server restarts; "Reload Now" still tries. After a
failed boot the chat keeps its old process and shows the failure. After a failed open the old
process is already gone, so the chat opens in the server's process the next time it is opened, on
the server's own code, and shows no failure.

A chat running in its own process on older code than its server says so in its head: a muted
`On older code` chip (tooltip: "This chat keeps the code it started with until its next quiet
moment.") and a ghost `Reload Now` button beside it, in the chat's own head and in its workspace
pane's. On a chat head narrower than 720px the button is its refresh icon, a 44px target, with
its words as its name and tooltip, so the head's share and details buttons stay in view. Pressed while a reply runs, the button reads `Reloads after this reply` (`Reloads when its
workers finish` when only its workers are working) and the reload waits for that moment; it never
cuts a reply off. While the chat reloads, the chip reads `Reloading`; the pane then reconnects
quietly, the draft kept, and on the current code the chip and the button are gone. If the new code
fails to start, the chat keeps running on older code: the chip stays `On older code`, and a warning
banner over the thread says "Couldn't start this chat on new code." with "It keeps running on older
code." and the reason, and a `Try Again` button that asks again. A chat on its server's code, or
hosted in the server itself, shows none of this; a `Reload Now` that reaches a chat already on the
current code just clears the chip.
