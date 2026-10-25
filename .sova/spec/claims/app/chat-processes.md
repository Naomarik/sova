# §app/chat-processes — Chats in a process of their own

Every chat runs in a process of its own, outside the server: on Linux with a systemd user manager
answering, a transient user service in a slice of its own; elsewhere (macOS, a Linux without one),
a detached session the server records and supervises. Stopping or restarting the server does not
stop it. There is no switch, and `GET /api/health` says which of the two this server uses
(§app.server-runtime/health). Chat processes run on the server's own Bun. A server on Node runs
none: every chat open is refused with "Chats need Bun to run Sova's chat runtime", and the server
still serves everything else.

Every chat goes out. Workers and the hidden chats (`/btw`, `/explain`, a compaction's hand-off) are chat processes too (§app.chat-processes/workers), and a worker's own session file is never opened as a chat anywhere else. The Overseer, a project overseer, a baton session (its wrap-up included) and a chat whose profile grants
powers go out like any other (§app.chat-processes/special-kinds); a link member or a fan-out member
does too. The server never
runs a chat in its own process. A chat whose process can't start on the current code (it didn't
start, never answered, or the chat didn't open in it) starts again on the last code a chat process
booted and opened on (§app.chat-processes/code-generations), when that is another complete copy,
and shows the failure as a reload's does (§app.chat-processes/code-pickup); with no such copy, or
if that start fails too, the open is refused with the reason ("This chat's process didn't start:
…"), and the server logs why. A chat that refuses to open (another writer, a missing folder) is
refused as before.

To the person, a chat in its own process is the same chat: the same transcript, composer, tools,
workers, dialogs and refusals. What differs is what survives a server restart
(§app.chat-processes/survives-restart) and what happens when the chat's own process dies
(§app.chat-processes/crash).

## §app.chat-processes/survives-restart — A server restart leaves the chat running

- **Nothing is stopped.** When the server stops, a chat in its own process is not aborted, its
  reply keeps streaming, its workers keep working in processes of their own (§app.chat-processes/workers), and its tools keep running. The server only
  says goodbye on the chat's socket. Its run is never recorded as cut off, so no "The Sova server
  restarted…" message follows (§app.overseer/auto-resume).
- **The next server takes it back.** At start the server finds the chat processes of its own state
  root that are still running and reconnects to each. Opening a chat whose process is among them
  waits for its own take-back, never starting a second copy of the chat; a chat with no process
  left running opens at once, without waiting for the others. Each
  chat process's live record counts as the server's own from the server's start (before it
  answers any request, while it is still taking the chats back), through a reload's replacement,
  until the server has stopped, so a chat process never reads as a terminal holding its file (a
  session message, auto-resume and attention see it as the server's).
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
  as changed by a process Sova can't identify. This holds too for a death the next server finds when
  it starts, as long as when the process ended is known (systemd's journal says); where it isn't (the
  detached driver, macOS), only what the process recorded as its own counts, and a change after
  that falls under the 120-second rule. Otherwise the 120-second rule applies.
- **Continue, once.** When it died with a run in flight, the chat gets one message, a few seconds
  later: "This chat's process stopped unexpectedly and cut off your last turn. Continue where you
  left off.", under the same rules and setting as a resume after a server restart
  (§app.overseer/auto-resume). A server that stops before that message is sent leaves it to the next
  server, which sends it once it has taken back its chats. A run that resume started and that is cut off again is not resumed a
  second time. A process that stopped because it was asked to (idle, archived, a code reload, the
  chat closing itself) is never resumed, and a server restart is never a death.

## §app.chat-processes/server-actions — Server actions from a chat process

An ordinary chat receives `record_tour` and `show_tour` only while vis is on; align's Visuals alone does not enable either tool. A hand-off's already-reviewed, scoped `show_tour` is separate baseline context, never recording access (§app.tours/authoring).

A few tools act on the server's own state: `project_verbs` (a project's running instances) of an
ordinary chat, a worker or a team member (§app.project-services/callers), `queue_push` (a topic's queue), `offer` (a project's offer cards, §chat.offers/tool) and the tool-backed tour actions `record_tour` and `show_tour` (§app.tours/authoring); every tool of the Overseer, a project overseer and a
baton session, their file tools (`read`, `grep`, `find`, `ls`, `write`, `edit`) included; and a
powers chat's `queue_open`. Some of what a chat does without a tool acts on it too: a baton
composer's message (who sent it, and the statechart's note of it), saving the model or thinking a
special chat's composer chose, and a powers chat's `session_send`. In a chat process each call of
one is run by the server, under an id of its own: a call the server is handed twice is run once. A call made while no
server is connected waits for one; when none comes within about a minute the tool answers "The Sova
server isn't answering, so this action didn't run. Try it again in a minute." A call the server was
handed and that the server stopped before answering is never sent again: the tool answers "The Sova
server restarted while this action ran, so its outcome is unknown. Check whether it took effect
before you try it again." Stopping the reply cancels the call on the server. The tools are declared
to the model as if they ran in the chat, so the chat's prompt and tool list don't change. A baton
composer's message whose outcome is unknown fails with that sentence; a powers send whose outcome is
unknown keeps what it spent of its limits. What else an ordinary chat reads of the server (a project's
instance note, an offer button's outcome note, a schedule's playbook, its linked agents, the singleton check) is asked of the server
when needed; while no server is connected it reads as none. A special chat's run-start, compaction
and reply-end hooks, and a powers chat's reads (sessions, a transcript, an insight, whether a session
is busy, a project's root), wait for a server instead, and are asked again of the next one: after
about a minute with none, a special chat's run starts on the last prompt it had, without a run note,
and a powers read fails the tool with the "isn't answering" sentence, never an empty answer.

## §app.chat-processes/wire — The chat process's socket

The server and a chat process talk over one unix socket per chat, in a directory only the user can
open (0700, the socket 0600), under the state root, or, when that path would be too long for a
socket (with room for a reload replacement's suffix: at most 103 bytes on macOS, 107 on Linux),
under the runtime directory (the temp directory without one; `/private/tmp` on macOS). A chat
whose socket path fits neither is refused, never given a path cut short. The chat process listens and the server dials. Each frame is a
4-byte big-endian length followed by that many bytes of UTF-8 JSON, one object with a type `t`. A
frame above 64 MiB, an empty one, or one that isn't such an object closes the link. Every
connection starts with the chat's `hello` (protocol, build, pid, state, last event number, highest
controller epoch). A later `hello` on the same link says only that the chat's state changed: once
the link's `control` has come, whenever the chat's state differs from what the link's last `hello`
said, the link hears one `hello` with the state now, and never another for the same state. A link
opened while the chat boots thus hears exactly one `hello` saying ready, whether the boot ends
before that `control` arrives or after. The server answers `control` with its epoch, which never goes down across
restarts; a lower or equal epoch on a second link is refused, a higher one replaces the link before
it, and a command carrying another epoch is refused unrun. Each side speaks protocol N and accepts
N-1. The kernel frames (hello, control, refuse, ping, drain, drained, exit, bye) never change, so
any server can drain any chat; every other frame is additive, and a frame of an unknown type is
ignored. Lifecycle events are numbered by the chat process and replayed from the last number the
server saw, or reported as a gap. A link that ends without the chat saying it exits is dialed again
while the chat's process runs; one that ends within a second of being dialed again waits a second
before the next dial, so a link that keeps ending at once never spins. Browser frames pass through as the chat serialised them. A recorded chat process is taken
back only while its pid still runs `server/chat-runtime/main.ts` (read from `/proc` on Linux, from
`ps` on macOS), never a pid another program reused.

## §app.chat-processes/one-writer — One writer per session file

A session file has one writer: the chat process holds a lock on it under the state root while the
chat is open, naming its pid and start time (from `/proc` on Linux, `ps` on macOS). A lock whose
process is gone, or whose pid now belongs to a later process, is taken over. A lock is published
whole, never half-written; one left unreadable (by an older process that crashed while writing it)
is taken over once it is 10 s old, and refused as held before that. A lock its holder lets go of
while it is being taken is taken: the take is never refused as held by a lock that is gone.

## §app.chat-processes/supervision — Who runs a chat's process

Where the systemd user manager answers (Linux), the server starts each chat as a systemd transient
user service named `sova-chat-<state hash>-<session id>`, in `sova-chats.slice`, outside the
server's own service. Anywhere else (macOS, a Linux without one) it starts the chat in a session of
its own, detached from the server, recorded by pid and start time under `<state root>/chats/procs`
with its output in `<state root>/chats/logs`; it reads processes from `/proc` on Linux and from
`ps` on macOS, and a recorded pid whose start time differs is never taken for the chat. The choice
is made once at start and logged. The
process is the server's own Bun running `server/chat-runtime/main.ts` from its code generation's
copy, with that copy as its working directory (§app.chat-processes/code-generations; the checkout
itself only when no copy could be made, never the chat's own folder). Stopping it sends SIGTERM to the chat's process and, 30 s later,
SIGKILL to whatever is left of its unit (`KillMode=mixed`) or its session. There is no `Restart=`:
nothing but the server ever starts a chat again.

- **Environment.** The chat's process gets the server's environment, minus the service manager's
  per-unit variables (`INVOCATION_ID`, `NOTIFY_SOCKET`, `LISTEN_*`, `WATCHDOG_*` and the like), `PWD`
  and `OLDPWD`, and the server's own `PORT` and `HOST`. On `PATH` come Sova's Bun first, then the
  directory of the Claude program the server resolved, then the server's `PATH`. It also gets
  `HOME`, `PI_CODING_AGENT_DIR` and the chat's own `SOVA_CHAT_*` (among them the checkout's and the
  copies' places, `SOVA_CHAT_LIVE_ROOT` and `SOVA_CHAT_COPIES_ROOT`), and its own key,
  `SOVA_CALLER_KEY` (§app.command-audit/keys). A chat process's own
  variables (`SOVA_CHAT_SOCK`, `_PATH`, `_ID`, `_UNIT`, `_BUILD`, `_STATE_ROOT`, `_LIVE_ROOT`,
  `_COPIES_ROOT`, and `SOVA_CALLER_KEY`) are never passed on from the server's environment, and a server deletes them from
  its own at start, so a server started from a chat's tools never acts as that chat or its server. All of it is passed in a file only
  the user can read, never on a command line. A variable that file can't carry (a name that is no
  variable name, or a value on more than one line) is left out, and the server logs its name once.
- **No periodic collection.** A chat's process runs without Bun's periodic garbage collection timer
  (`BUN_GC_TIMER_DISABLE=1` in its environment), so an idle chat spends less CPU; its memory still
  comes back down after a big reply, through the collections its own allocations start. The
  process deletes that variable from its own environment as it starts, so the programs its tools
  run (a test runner, a hermetic server) keep their timer.
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
  and the chat starts on the last good code, or its open is refused (§app/chat-processes). In time
  means, for every chat, its socket answers within 10 s of the start and its `hello` says it is ready
  within 40 s after that: a start normally takes under a second, and the slowest measured under heavy
  load took 34 s. A chat that finished starting after its first `hello` (which said it was still
  starting) but before the server took control says it is ready at once, in a `hello` right after
  the server's `control`, exactly once: the server never waits out the limit for a chat that is
  ready, whether it is starting the chat or waiting for a reload's replacement
  (§app.chat-processes/code-pickup).
- **One process per chat.** Starting a chat whose previous process is still exiting waits up to
  10 s for that process and the session's writer lock to go.
- **Claude programs.** Across all chat processes at most 4 idle Claude CLI children are kept
  (`SOVA_CHAT_CLAUDE_IDLE_MAX`). Beyond that, the one idle longest is let go, and a busy one never
  is; that chat's next turn resumes from its resume record (§app.claude-code-provider/continuity).
- **Tests.** `SOVA_CHAT_SLICE` names another slice, and `SOVA_CHAT_DRIVER=detached` runs chats as
  detached sessions even where units could run.

## §app.chat-processes/idle-stop — An idle chat process stops

A chat's process with nothing in flight (no reply, compaction, queued message, open dialog,
working worker or server action) is asked to close after 30 minutes like that
(`SOVA_CHAT_IDLE_MIN`, in minutes, fractions allowed; 0 is never), whether or not a browser tab
has it open: an open tab doesn't keep it running. The chat checks again that it is still quiet,
and refuses otherwise, which restarts the clock. A chat that accepts but has not exited 30 s later
is stopped. That stop only ever reaches the process that accepted: a chat started again while it
closes (someone sent to it, say) waits, as for any previous process still exiting (up to 10 s,
§app.chat-processes/supervision), until that close is done, and its new process is never stopped
by it, under either driver. An idle stop is not a death and never gets a "continue". A tab that had it open keeps
its rows and draft and doesn't reconnect: its socket, a reconnect or a server restart never starts
the chat again; only something that needs the chat does, such as sending from that tab
(§chat.transcript/instant-open, "A chat closed while its tab is open"). The chat stays closed until
someone sends to it or acts on it, opens it (a click, a reload, every pane of a workspace), brings
its workspace tab to the front (§workspace.groups/layout-tabs), or another chat or the Overseer
sends it a message, which starts a new process; a jump in its Timeline or scrolling up for older
rows doesn't, they read the file (§chat.transcript/instant-open). Its `hello`
comes about 0.5 s after the socket opens for a 240 KB session and about 0.8 s for an 11 MB one
(median on a hermetic server, detached chats, 2026-10-13), while its saved rows already show
(§chat.transcript/instant-open). Its workers run on in their own processes; a waiting worker's process stops the same way, idle, and stays listed waiting (§app.chat-processes/workers).

With no server at all (Sova stopped for good, its chats left running), a chat's process that has
no server linked and nothing in flight, for the same idle time (as the last server set it), exits
by itself as an idle stop, so the next server reads its end as orderly: no death, no "continue". So
does a process started for a chat that never opened it (a server that stopped mid-start, or a
reload's replacement it never moved the chat into); such a process never touches the chat's record
of a run in flight, which belongs to the process that has the chat open.
A reply in flight or an open dialog keeps it running until that ends; a pane left attached when
the server went does not. To stop them at once instead, `bun scripts/stop-chats.ts [--agent-dir <dir>]` stops every chat
process the install's state root records, through its records and driver (never a process found by
name), each as an operator stop.

## §app.chat-processes/code-pickup — Picking up new code

Each chat's process runs its own unchangeable copy of the code its server started with, its code
generation (§app.chat-processes/code-generations), and carries that generation's id: the commit,
plus a digest of uncommitted changes and untracked files when the tree is dirty (`SOVA_BUILD`
overrides it for tests; an unknown build means no badge). A chat whose build differs from the server's, both known, is on older code. It asks
to reload at a quiet moment: when nobody is attached, or after 5 minutes quiet. "Reload Now" asks at
once when the chat is quiet, else when its reply ends. Its workers don't hold a reload: they run in
processes of their own, keep working through it and are reattached (§app.chat-processes/workers);
only a working worker of another backend, which runs inside the chat's process, still holds it. Reloads run one
at a time. The server first starts a replacement process and waits up to 30 s for it to boot; only
then does it ask the old process to close. The old process refuses if it is no longer quiet; the
replacement is then stopped, and the reload is tried again later. A reload the person asked for ("Reload Now")
that is refused this way (a reply started between the press and the close) stays asked for: the button
reads `Reloads after this reply` and the reload is asked for again the moment that reply ends, without
the 5-minute wait. On close, the chat reopens in the
replacement, and attached browsers reconnect with their draft kept. A reload never cuts off a reply.
When a replacement fails to boot, or the chat fails to open in it, the replacement is stopped and
no further automatic reload happens until the server restarts (the server's log names the new
code's id and the reason); "Reload Now" still tries. After a
failed boot the chat keeps its old process and shows the failure. After a failed open the old
process is already gone, so the chat starts again at once on the code it ran before and shows the
failure. A reload, and a failure it showed, belong to the server that ran it: when the server
restarts after a reload was asked for, before it began, in the middle of it or after it failed, the chat
shows the next server plain older code (never a `reloading` badge no server will finish) and asks
that server again by the rules above; a "Reload Now" still stands.

A chat running in its own process on older code than its server says so in its head: a muted
`On older code` chip (tooltip: "This chat keeps the code it started with until its next quiet
moment.") and a ghost `Reload Now` button beside it, in the chat's own head and in its workspace
pane's. On a chat head narrower than 720px the button is its refresh icon, a 44px target, with
its words as its name and tooltip, so the head's share and details buttons stay in view. Pressed while a reply runs, the button reads `Reloads after this reply` (`Reloads when its
workers finish` when only another backend's workers, which run inside the chat's process, are working) and the reload waits for that moment; it never
cuts a reply off. While the chat reloads, the chip reads `Reloading`; the pane then reconnects
quietly, the draft kept, and on the current code the chip and the button are gone. If the new code
fails to start, the chat keeps running on older code: the chip stays `On older code`, and a warning
banner over the thread says "Couldn't start this chat on new code." with "It keeps running on older
code." and the reason, and a `Try Again` button that asks again. A chat on its server's code, or
hosted in the server itself, shows none of this; a `Reload Now` that reaches a chat already on the
current code just clears the chip.

## §app.chat-processes/code-generations — A chat's own copy of the code

A server start copies its checkout's code, the tracked files and the untracked ones Git does not
ignore, to `<state root>/chats/code/<id>` (`SOVA_CHAT_CODE_ROOT` overrides the place), read-only,
or reuses the copy already there. The id is the commit, plus a digest of the uncommitted changes
and the untracked files when the tree has any (`SOVA_BUILD` overrides it for tests). Its
`node_modules` is one copy per lockfile, hardlinked from the checkout's where they share a
filesystem (else copied in full, and the server's log and `GET /api/health` say so), and shared by every copy with that
lockfile. Every chat process the server starts afterwards (a new chat, a reopen, a
reload's replacement, a worker, a hidden chat) runs that copy. A change to the checkout never
reaches a running chat process, not even when it rebuilds its session (a mode switch, a new
session, a fork); it reaches the chat only when the chat reloads onto a newer copy
(§app.chat-processes/code-pickup).

A deployed tree with no Git of its own (a `git archive` install stamped with `BUILD_COMMIT`: a VPS,
a phone, a container) is copied the same way, its id being the stamped commit: every file in the
tree except any `node_modules` (linked per lockfile as above), `.git`, the top-level `.bun`,
`.accept`, `dist` and `dist-share`, and anything inside the agent dir, the state root or the
copies root when they lie inside the tree, so no session, login or earlier copy goes into it.

Sova's own extensions load from the chat's copy: an extension the agent dir links into a Sova
checkout's `pi-config/`, or into another copy's, loads from the same place in the chat's copy, and
extensions switched off with /extensions stay off. A Sova extension added to the checkout after
the chat's copy was made is left out of that chat until it reloads onto newer code; the chat
process logs it. Installed packages, a project's own
extensions and a worktree's own agent dir load from where they are. A worker whose extension is
missing from its copy (renamed since its parent's copy was made) does not start, and says
"<file> is not in this chat's code (<id>); reload the parent chat". Settings, models, skills,
prompts, themes and the agent dir's other files are read live.

When the copy can't be made (a checkout whose Git fails, no space, no tree), chats run from the checkout as before;
the server logs why once, and `GET /api/health` says so (§app.server-runtime/health). Copies no
chat uses are removed at the server's start, after each run of reloads and every hour, once they
are 10 minutes old; the current copy, the last copy a chat started and opened on, and any copy a
chat or worker process still runs are always kept. A shared `node_modules` copy goes with the
last copy that uses it. No server removes copies under a place set with `SOVA_CHAT_CODE_ROOT`,
which several servers may share, unless `SOVA_CHAT_CODE_GC=on` says the place is that server's
alone (tests).

## §app.chat-processes/extension-loading — Extensions load as plain modules

A chat process loads Sova's own extensions (`pi-config/`) as plain modules, never through pi's
translating fallback: every package they import (pi-coding-agent, pi-ai, pi-tui, typebox) resolves
from the extensions in the chat's copy of the code to the very copy pi itself runs. So the
extensions share one instance of each file they have in common, and a chat's first open on a new
copy of the code (after a release, or after a reboot emptied the translation cache) is as quick as
a later one. Sova's own dependencies name pi-ai, pi-tui and typebox at exactly the versions its
pi-coding-agent depends on, so they move with every pi upgrade; a check fails when any of the four,
resolved from the copy's extensions, is another copy than pi's own (another version included), another
fails when an extension can't be imported without the fallback, and another when an extension loads
a pi package Sova's dependencies don't name. Installed npm and git packages resolve pi from their own
dependencies, with their own copies, and are outside these checks.

## §app.chat-processes/no-terminal-drawing — No terminal drawing code in a chat process

A chat process never loads pi's terminal drawing code: pi-tui's screen and components, pi's own
terminal components, its syntax highlighter and its markdown and diagram renderers are quiet
stand-ins there, which draw nothing and do nothing. Text measuring, truncation and wrapping, key
matching and the colour theme stay pi's own, since extensions use them for status text. Nothing a
person sees in Sova changes: an extension's terminal screens, widgets and footers were never shown
in Sova. The terminal pi, the server and every process other than a chat's load the real code.
A check fails when the stand-ins lack a name pi-tui exports, and another when pi adds, drops or
moves a file in the folders the stand-ins reach into, until a person classifies it as a stand-in or
kept. Tests log every call that reaches a stand-in; a chat process logs the first one that isn't a
construction, once.

## §app.chat-processes/special-kinds — The Overseer, project overseers and batons in a chat process

The Overseer, a project overseer and a baton session run in a chat process like any chat, with the
same prompt, tools, file tools, composer, refusals and transcript as in the server. What their
loadout is comes from the server as data at each open; their tools, file tools, prompts and run
notes stay the server's (§app.chat-processes/server-actions). A previous conversation that opens
read-only is refused before any process starts. An organization's statechart engine runs only in
the server: a chat process that tries to open one is refused.

- **Each run asks.** At each run's start the chat asks the server for that run's prompt and run
  note; a baton's also brings its abilities, its owner areas and who wrote what. A compaction's note
  and the Overseer's id check are asked the same way. With no server it waits up to a minute, then
  runs on the last prompt it had, without a run note.
- **What the run did reaches the server once.** A run's start, the person's message entering it, a
  card click ending, and the run's end reach the server in the order they happened, each before any
  tool call that comes after it, and each is kept by the chat until the server has it: one that a restart caught
  is told to the next server, and a repeat changes nothing (a card click writes its approval once; a
  baton reply is ended once). A baton's reply text reaches its share pages at most every 100 ms and
  not at all while no server is connected; the pages read the file again when they reconnect.
- **Not sent again.** A project overseer's look or a baton's wrap-up the server was running when it
  restarted is not sent again: its turn runs on in the chat's own process, and the restart records it
  as cut off (the look's reasons wait for the next look; a wrap-up can be tried again). A baton reply
  still running in its process after a restart is not ended by the server's start-up sweep; its own
  end ends it.
- **Within a tool call.** A server-run tool reads the chat's branch and file as they stood at the
  call, plus what it wrote since; what it writes into the chat and the subagent tools it calls run
  in the chat, inside that call.
- **When the process dies.** Its panes get the crash error (§app.chat-processes/crash), and it is
  never resumed. A baton reply it was writing is ended for the statechart, once, unless the operator
  was stopping it. A look it was running reports `stopped` with "The project overseer's process
  stopped unexpectedly."

## §app.chat-processes/server-messages — Messages the server sends a chat

A message the server sends a chat on its own (a brief, a look, a wrap-up, a resume after a restart
or a crash, a message from the Overseer to a project overseer) is accepted once: sent again after a
dropped link or a server restart, the chat answers it as it did the first time and starts no second
turn, and the turn it started can be waited for again for an hour. A command to a chat whose process
is reconnecting or being replaced by a reload waits up to 15 s for it before it fails as
unreachable; a chat whose process ended starts a new one at the next open.

## §app.chat-processes/workers — Workers and hidden chats in chat processes

Every worker a chat starts runs as a chat process of its own: an `agent_spawn` worker (Delegate's
included), a team member, coordinator, monitor or successor, and a resumed worker. So does every
hidden chat: `/explain`'s fork, a compaction's hand-off fork and `/btw`'s side thread. The server
starts each from the loadout its parent computed (model, effort, tools, extensions, flags, system
prompt, sandbox, remote target, modes, team identity, agent dir), with nothing of an ordinary chat
added (no profile, mode menu, memory, topics, links or session powers, and of the Sova-served tools
only `project_verbs` with its instance note, which a worker or team member gets and a hidden chat
doesn't, §app.project-services/callers), and
opens it the way it opens any chat. The parent never starts a worker's process and never talks to
it directly: the server passes it the parent's task, steers, follow-ups, aborts and stops, and
passes its events back. A worker never runs inside the server's process.

- **Where it runs.** Each runs as any chat does (§app.chat-processes/supervision): a transient unit
  of its own in the chats' slice, or a detached session the server records. A server restart leaves
  it running, and the next server takes it back. A worker whose process doesn't start fails to
  start with the reason ("The worker's process did not start: …"); it never falls back to another
  place. It is lowered to the worker niceness (§app.load-priority/workers).
  Workers run on the server's own Bun; on a server running on Node a start is refused with
  "Workers need Bun to run Sova's chat runtime". A chat
  outside Sova (pi on its own, with no worker host) starts no worker: a spawn fails with "A worker
  needs Sova's chat runtime".
- **A parent's reload keeps its workers.** A parent's reload, mode switch, crash or code reload
  never stops its workers. When the parent's chat opens again it reattaches every worker of its
  that still runs: `agent_list` and the pane show it with its live status, its transcript so far
  comes from its file, and a run that finished while the parent was away is announced to the parent
  once (waking it under the worker's `wake`), never twice and never lost. A steer sent after the
  reattach reaches the worker once. When a worker's run finishes and no parent chat picks it up
  within 10 seconds, the server opens the parent chat once so that it takes the report. A parent that
  doesn't open is tried again after 10, 30 and 90 seconds; the report counts as taken only once the
  parent opened, so one still not taken then is the next server's to deliver, if the worker is still running;
  otherwise the parent finds it when it next opens.
- **Across a server restart.** A task, steer, follow-up, abort or kill the parent sends while no
  server is connected waits for the next server, up to a minute, and is delivered once; after that
  it fails with "The Sova server isn't answering". The worker is never stopped for it: a steer or
  follow-up that fails so reports its delivery unknown (the server may have taken it before it
  stopped answering), is not sent again, and leaves the worker's current task as it was, with one
  error line in its transcript that says the message may not have been delivered and the worker
  was not stopped. The parent's view of each worker's events picks
  up where it left off. A start the server had recorded but not finished when it stopped (its
  process not yet open, or its first task not yet taken) is finished by the next server when the
  parent's start reaches it: the worker gets its first task exactly once, and the start reports
  success only once the task was taken.
- **A chat's own workers only.** A chat lists, steers, aborts, stops and follows only its own
  workers (worker ids repeat in every session): a start that names another parent session is
  refused, and any other request about another session's worker fails with "No worker chat <id> for
  this session." A worker whose task is not accepted when it starts is stopped, and the start fails
  with the reason.
- **Trust.** A worker trusts its project's local files as every Sova chat does.
- **Archiving or deleting the parent** stops its workers.
- **Idle workers.** A waiting worker's process stops after the idle-stop time like any chat's
  (§app.chat-processes/idle-stop). It is still listed waiting and still takes a live slot, and its
  next instruction reopens it in a new process, under its recorded loadout.
- **Team mailboxes are kept.** A team's mailbox lives under the parent session's teams directory
  and is kept across reloads and restarts: a reattached or resumed member keeps its inbox, requests a
  member wrote while its parent was away are handled once the parent is back, and pending wake
  nudges are kept, held or not, and fire after a reload.
- **Extension sources.** Each worker loads its usual extensions plus those `agent_spawn`'s `extensions` names. Every extension Sova ships, and every local path, loads with no install step. An outside `npm:` or `git:` source that isn't installed (or whose installed copy doesn't match its pinned version) is refused at spawn with one line: "<source> isn't installed: install it first (`pi install <source>`)".
- **Hidden chats.** An `/explain` or hand-off fork still running when its parent reloads is
  reattached and settles when it finishes; it reads interrupted only when its chat is gone (the
  server stopped it, or it died for good). `/btw`'s side thread survives a parent reload.
- **Not ordinary chats.** A worker's or hidden chat's session file stays out of the session list,
  is never opened as a chat anywhere else (the subagent-session refusal: a browser that opens one
  gets `"<title>" is a subagent's own session; act on the session that runs it.` as a permanent
  open failure, never retried), and its transcript stays readable.
- **Counted once.** Each model call of a worker or hidden chat, `/btw`'s included, is counted once,
  in the process that makes it, and attributed to its parent session and worker id, in the usage
  ledger and in the in-flight counts.


## §app.chat-processes/worker-crash — When a worker's process dies

A worker's or hidden chat's process that dies (a crash, a kill by a signal, a non-zero exit, or a
process that stops answering and is stopped by the server) with a run in flight, that run not
itself a resume, is reopened once in a new process where it ran before, and sent "This chat's
process stopped unexpectedly and cut off your last turn. Continue where you left off.", under the
same setting as a chat's crash resume (§app.overseer/auto-resume). Each decision is logged in the overseer's action
log as a chat's is (`auto_resume`, naming the worker's file, its parent's file and its worker id):
resumed, or why not (the setting off, already a resume, no run in flight, or the reopen failed). Its transcript in the parent
shows "Process stopped unexpectedly (…); continuing once", and it stays running. A worker that was
idle (no run in flight) goes idle again, as after an idle stop: its status stays waiting and its
next instruction starts it in a new process. Otherwise (the setting off, or it dies again in that
resumed run, or the reopen failed) it ends: its status is error, with the error "This
worker's process stopped unexpectedly (exit N | signal S | it stopped answering)" followed by
"Last output: …" with its log's last 20 lines, at most 2 KB, the newest kept. No second continue is
sent. Either way, an instruction the worker had accepted whose message it never ran goes with the
dead process, and is reported as never run (§app.chat-processes/worker-instructions).

A server restart is never a death, nor is a stop the server asked for (idle, a code reload, an
archive, a kill): nothing is reported and nothing is resumed.


## §app.chat-processes/worker-instructions — Which instruction started which reply

Every task, steer and follow-up a parent sends a worker carries a key of its own, and the worker's
chat keeps that key with the message all the way to the model: while Sova's queue holds it, when it
is handed over, and on the message the model is given. When that message starts the worker's reply
or enters the reply already running, the worker's events name its key, and the parent moves the
worker's current task, and the final answer it reports for that task, at exactly that instruction:
never at whatever reply starts next, never at another message with the same text. Two identical
instructions are two tasks, each starting at its own message. Events read again after a dropped
link (§app.chat-processes/workers) carry the same keys, and the task moves once.

- **Never unlabelled.** A keyed instruction is never handed to the model in the moment a reply is
  settling, where pi would run it later, outside the send that carried its key: it waits until that
  moment has passed, then goes, labelled.
- **Several in one step.** Instructions that land together (steers sent while the worker's reply
  runs reach it at its next step together) each name their own key. The worker's current task starts
  at the last of them, and the reply after them is that task's.
- **Accepted but never ran.** An instruction the worker accepted whose turn never started (Stop
  pressed while it was queued, the worker's process died, a message taken off the queue, a turn that
  failed before it began) is reported plainly: one line in the worker's transcript, "This
  instruction was accepted but never ran: <its first line>", and the same line in the error of the
  next report the parent gets. Each instruction that never ran gets its own line, in the order sent. When nothing else is running that report comes at once, with the
  outcome error; the parent never waits for a delivery that can't come.
- **Workers on older code.** A worker still running code from before these keys
  (§app.chat-processes/code-generations) has a feed that names no keys, and its parent tells which
  instruction started which reply as it did before: best-effort, from pi's queue and the message
  text.

## §app.chat-processes/boot-log — A chat's start leaves a trail

A chat process names each step of its start as it enters it, in two phases: starting, from its
launch until its `hello` says ready (loading the chat's code, setting up the model list, loading
the extensions, starting them in a trial session, closing that session), and opening, from the
server's `open` until its answer (reading the session file, its loadout, loading and starting the
extensions again). The steps are Sova's own; no extension is named. Workers and hidden chats start
and open the same way and leave the same trail. Only a chat process keeps it: the server's own
warm-up at its start logs and sends none of it.

- **A healthy start, one line per phase.** When a phase ends, the chat's log gets one line: the phase's time,
  each step's time and the processor time used, as `[chat-runtime] ready in 1.42 s (chat code
  0.61 s, model setup 0.09 s, …; cpu 1.1 s)` and `[chat-runtime] opened in 0.80 s (…)`. Nothing
  else is added.
- **A slow phase leaves its step behind.** Every 10 s while a phase lasts, the chat logs
  `[chat-runtime] still starting: <step> for N s (M s since start, cpu C s)` (`still opening:` while
  opening), so the last log lines kept when the chat is stopped (§app.chat-processes/supervision)
  name the step even when its process is killed.
- **Stopped while starting.** A chat process stopped (SIGTERM or SIGINT) in either phase logs the
  step it was in, how long it had been there, the time since its start, its processor time and, on
  Linux, the programs it had started and not yet seen end: each one's name, pid and how long it has
  run, at most 120 characters each and never its arguments. Its exit line says how long after the
  stop it exits.
- **The server hears the step.** The chat also sends the server each step as it enters it and at
  each 10 s beat, in a frame of its own (§app.chat-processes/wire). When the server stops waiting
  (40 s for the `hello` that says ready, 60 s for the open's answer; both as before), its log says
  `stuck in <step> for N s` and how long after the start the chat's socket first answered, and so
  does the detail recorded for a chat stopped for never saying ready; a chat on older code that
  reports no step reads `no step reported`. The error the person sees doesn't change.
- **Slow starts in the server's log.** A chat whose start, from its launch to its open's answer,
  took 5 s or more gets one line in the server's log with that time and the times to its first
  answer, to ready and to open; a faster start adds nothing there.
