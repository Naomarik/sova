# §app/worker-restore — Workers across a restart
> Part of the Sova design spec · [overview](../design/overview.md)

A session's subagent workers are chat processes of their own (§app.chat-processes/workers). When the Sova server restarts (a deploy, `systemctl restart`, a crash), they keep running and their parent picks them back up. Until this surface, a session forgot workers that ended so: `agent_list` came back empty, the pane lost its rows and the
lifetime Σ restarted at zero. This surface makes a worker outlive its process **as a record**:
what it was, where its transcript is, what it spent. It does not make the process outlive the
restart. A restored worker is idle, and only an explicit resume starts it again.

It holds for **every backend and model**: pi workers on any provider (a Claude Code worker is
one, §app.subagents-pane/claude-code-workers), the claude-code workers recorded before it was, and
any backend registered later. Nothing here is specific to one of them; what differs per backend
is declared by that backend's adapter (§app.worker-restore/transcript-protocol).

## §app.worker-restore/worker-record — One durable record per worker

The parent session keeps a durable record of **every worker it starts**, on every backend and wherever its chat process runs. It lives in the parent's own session file as
`subagents-worker-manifest` custom entries (version `v: 1`), so it survives whatever the process
does. One fold reads it for every consumer, newest-wins per field and one worker id at a time. Only
those entries are read: the older `subagents-worker-registry` entries, once written for hosted workers, are not
read anywhere, so a session file that has only those shows no record for that worker.

- **What it holds**: the worker id, backend, group, name; the spawn spec (cwd, model, effort,
  task preview and length, wake, sandbox on/off, and the spec as given — including whether it ran
  on its worktree's own agent dir (`useWorktreeConfig`) — so a resume can re-apply
  it); team id, role and orchestrator flag when it is a team member; the **transcript
  reference** once known (a pi session file, or a Claude session id, or whatever the backend's
  adapter names); a **usage snapshot** with the time it was taken; when it last settled and was
  last resumed; the older Claude Code session a resume continued it from (`continuedFrom`, its
  backend and transcript reference, §app.worker-restore/resume); and, once it ends, its status,
  end time and error.
- **When it is written**: at spawn and at each new task (status running); when the backend
  first reports the transcript identity; at each settle (status waiting, with the usage snapshot
  as of that settle, the task's outcome, and the key of the run that settled (`settleKey`) and its final message's entry (`settleEntryId`), written with the settle's announcement, so a parent that picks a worker back up announces each settle once); at the end (done, error or killed; `lost` appears only in records a detached host wrote before workers became chat processes, and reads as interrupted); and at a resume, which clears the ended fields and records the status as waiting. Nothing else is
  appended per turn, so a busy worker does not grow the parent's file per message.
- **Readers ignore fields they don't know**, and refuse a record with a higher major version
  with a typed error rather than guessing at it.
- The record is the parent's, not the worker's. A worker's own session is never written by the
  parent or by Sova (§app.subagents-pane/transcript-view: read only), but for the one exception
  of a resume that continues an older Claude Code worker: the parent writes the new session's file
  with its header and first message before the worker opens it (§app.worker-restore/resume).

## §app.worker-restore/failure-reason — A worker that dies says why

When a worker's process dies and the worker ends with an error (§app.chat-processes/worker-crash: mid-run and not continued), the error its record keeps (§app.worker-restore/worker-record) and `agent_list` shows is "This worker's process stopped unexpectedly (exit N | signal S | it stopped answering)" followed by "Last output: …" with the last lines of its log: at most 20 lines and 2 KB, the newest kept. With no output it is the bare sentence. A Claude Code worker is a pi worker (§app.subagents-pane/claude-code-workers), so the same holds for it.

## §app.worker-restore/transcript-protocol — One transcript protocol, one adapter per backend

Everything that reads a worker's transcript goes through one backend-neutral protocol
(version 1), and each backend supplies an adapter for it. The consumers — restore, usage, the
parent's `agent_list`, Sova's pane and `#/agents` — never parse a backend's format themselves.

- **An adapter declares its capabilities up front**: whether it can read the transcript at
  all, whether usage is exact, tokens-only or none, whether it can split usage per model, whether
  it reports cost, whether it can produce transcript rows, and whether it can resume (native or
  none). A consumer checks the declaration first. A call outside it fails with a typed
  "unsupported capability" error naming the backend and the capability; it is never discovered
  by trying and catching.
- **An adapter locates without writing.** Finding a transcript never creates or touches a file.
- **A read returns one summary shape** for every backend: found or not (with a reason), size and
  time, model and effort, whether the last turn settled or was cut off, the last outcome and
  reply, compactions, the context fill of the last reply that measured it (`lastContextTokens`,
  §chat.context-window/last-reply's rule on the worker's own branch or main chain; `null` when a
  compaction followed it, absent before any such reply — an additive field, so the protocol stays
  version 1), and usage with its source (`transcript`, `snapshot` or `none`).
- **What each backend provides today.** pi: the transcript is the worker's session file; usage
  exact, with cost; resume native. claude-code (a worker that ran the Claude Code CLI's own tools, before
  Claude Code workers became pi workers): the transcript is the Claude session id, found by
  scanning `~/.claude/projects`; usage tokens-only, per model; resume none, so such a worker stays
  readable, and resuming it continues on Sova's tools in a new session (§app.worker-restore/resume).
  A backend with
  no transcript file declares `read: none`: its usage comes from the record's snapshot only, it
  cannot be resumed, and the pane says so rather than showing an empty transcript.

## §app.worker-restore/usage-from-transcripts — Usage rebuilt from transcripts

After a restart, a worker's usage is **not recounted** at all: what every Sova surface shows for
a worker, restored or running, is its spend in the usage ledger (§app.insights/usage-ledger),
recorded as each of its calls ended and kept on disk, so a restart changes no figure. Neither the
worker's transcript nor the record's usage snapshot is read for a figure Sova shows; the
snapshot stays in the record for the TUI's own views.

## §app.worker-restore/restore — Restored as idle entries, never restarted

When a session's runtime opens after a restart (or a reload, or a switch back to the session), it first picks up again every worker of its that still runs (§app.chat-processes/workers), and a waiting worker whose process stopped while idle is still a live, waiting worker. Each other worker its record names that no process runs (it died for good, an older server stopped it with itself, it ran before workers became chat processes, or the server no longer knows it) comes back as a **restored** entry:
listed by `agent_list`, shown in the pane and on `#/agents`, with no process behind it. Nothing
is started, nothing is sent, and nothing is announced to the parent agent. A restored worker is
settled: it takes no live slot, and a steer to it is refused with the way back (`agent_resume`,
or why it can't be resumed).

- **Which workers.** Records are read from **all branches** of the parent's file, because a
  worker started on an abandoned branch still ran. The list — rows in
  the pane, `agent_list`, `#/agents` — shows only the workers recorded on the **active branch**.
  Each worker counts once, and switching branches moves the list, never the Σ.
- **Status.** A worker that had **ended** before the restart keeps its recorded final status —
  Done, Failed or Stopped, with its end time. A worker that was **running** when the server died
  comes back **interrupted**: status `restored` with the time it was interrupted
  (`interruptedAt`: its last transcript activity or its last record, whichever is later), and its unfinished turn stays as the
  transcript left it. So does one recorded as lost or with no known state. A worker that was
  idle comes back `restored` with no interrupted time. The chip reads "Restored", or "Interrupted" (warn) when there is an interrupted time. None of them reads Working or Starting, pulses, or counts as working.
- **Resumable either way.** An ended worker and an interrupted one alike can be resumed on demand
  when its backend's adapter declares native resume, and an older native Claude Code worker too,
  which continues on Sova's tools in a new session (§app.worker-restore/resume).
- **Marked restored.** Each restored entry carries `restored`, whether it can be resumed
  (`resumable`: its adapter declares native resume, the record has a transcript reference, and
  the backend is loaded; or it is an older native Claude Code worker). `agent_list` says "restored" beside the status, and names
  the resume tool on each resumable worker or gives the reason it can't be resumed.
- **Spend.** A restored worker's tokens and cost, on every Sova surface, are its spend in the usage
  ledger (§app.worker-restore/usage-from-transcripts): never unavailable, never a snapshot.
- **One row, one label, hosted or not.** A restored team member's spend is in the Subagents row of
  the session pane's Usage tab. A restored or resumed worker is named by the model it **ran under**: its
  transcript's model, else its last snapshot's, else the model it was spawned with, and a Claude
  worker reads its catalog name (§app.claude-code-provider/model-names). So a Claude
  worker reads `Haiku 4.5` running, restored and resumed alike, whether the session is hosted by
  this server or only read from its file. A team whose members are all
  restored is not counted as active.
- **Transcripts stay readable.** The pane opens a restored worker's transcript from the record's
  reference exactly as it does a live one (`?path=` for a pi file, `?claude=` for a Claude
  session id).
- **The id counter continues.** A worker spawned after the restart gets the next id, never one a
  restored worker holds.

## §app.worker-restore/resume — Resume on demand

A restored worker starts again only when asked, one worker id at a time: by the parent agent's
`agent_resume {id}` tool, or by the `/agent-resume <id>` command. Sova's own buttons are gone (the
session pane and the Agents board have none); `POST /api/workers/resume`, which sends that
command, stays on the server with no caller in the app. It opens the parent chat when the server
holds none (one closed for being quiet, §app.chat-processes/idle-stop), as a send would, and never
answers "open the chat first". An archived parent is the exception: the request is refused with
"That session is archived; unarchive it first." and nothing starts (§chat.transcript/instant-open). There is **no automatic resume**, not at session open, not at the
next prompt, and not for team members.

- **Same worker.** It keeps its id, name, team membership and role, and continues its own transcript: its chat reopens its session file, a Claude Code worker included, through the same factory as a spawn (§app.chat-processes/workers). Its spawn
  spec is re-applied (cwd, model, effort, tools, system prompt, its worktree's agent dir), and the sandbox
  follows the **parent's current** state, exactly as at spawn (§chat.sandbox/workers), and so do the modes it is given: the parent's **current** worker
  modes, not the ones it first started with (§chat.mode-menu/workers). So does where it may start: its cwd must still be the session's
  cwd or inside an active tracked worktree of the current branch (§chat.worktrees/workers).
- **A team member rejoins its team.** Its team, kept as history since the restart, becomes live
  again, with a fresh identity in the team's kept mailbox: a member gets its team tools back and keeps its inbox, and an orchestrator keeps its roster and steer tools. Requests a member wrote while its parent was away are handled once the parent is back. What the restart destroyed stays gone: the team's create-time defaults, so a later `team_add` to that team applies none. Its teammates are not told.
- **It comes back idle** (`waiting`, the Idle chip). Resume sends no prompt and never continues the interrupted turn on
  its own. It never re-emits a completion, so the parent is not woken by a stale report. The
  parent gives it work with `agent_steer` or a team message, like any idle worker.
- **Usage continues** in the usage ledger: its new calls add records; nothing is counted twice.
- **A Claude Code worker from before Claude Code workers became pi workers continues on Sova's
  tools in a new session.** Its own Claude session can't be reopened (it ran the CLI's own tools),
  so resume starts it as a Claude Code worker of today (§app.subagents-pane/claude-code-workers) under the
  same id: same parent, group, team seat and role, cwd, model and effort; its Claude tool names
  map to Sova's and any without an equivalent are dropped (when none maps, it keeps `read`, so it can
  open its old transcript); of its `backendOptions` only
  `permissionMode` `plan` is kept. It comes back idle like any resume, in a new pi session whose
  first message, before anything else is sent, tells it that it continues an earlier Claude Code
  worker whose run ended, gives the old transcript's absolute path (read-only), its task, and the
  last 2,000 characters of its last answer. Its record then names the new session, and keeps the
  old Claude session as `continuedFrom`; the old transcript file is never changed or deleted. The
  tool answers "Resumed {id} ({name}) on Sova's tools in a new session {file}, continuing its
  Claude Code session {old file}; nothing was sent to it. Give it work with agent_steer."
- **Refusals are said, not guessed.** Resume answers with the reason and changes nothing for:
  a worker that is live (give it work with `agent_steer`), one already being resumed, an ID this
  session file has no record of, a cwd outside the session's cwd and its active worktrees, a backend whose adapter declares no resume or that is not
  loaded (an older Claude Code worker excepted, above), and a worker whose backend session was never recorded. When the reopen itself fails,
  or the worker isn't idle within 180 seconds, the restored entry stays as it was and the reason
  is returned.
- **What the parent sees.** The resumed worker is listed under its group as "· resumed". The
  tool answers "Resumed {id} ({name}) idle in its own {backend} session …; nothing was sent to
  it. Give it work with agent_steer."

## §app.worker-restore/claude-bridge-restart — The Claude Code main thread across a restart

A session whose own model runs on the claude-code provider (the bridge, not a worker) starts a
Claude CLI per launch, each under a session id derived from the pi session and a launch number.
The number used to live only in memory, so after a restart the bridge re-derived ids that
already existed on disk, and once more than its probe window of them existed, the next prompt
failed.

Before **every** launch, the bridge takes as its launch number the larger of its in-memory
count and one past the highest launch whose Claude record exists on disk
(`<Claude directory>/projects/<cwd-slug>/<id>.jsonl`, in the directory of the login the launch
runs on: an added login's own, `~/.claude` for `default`). The walk upward tolerates up to 32 missing records
in a row, because a failed launch can leave a gap. A restarted server therefore never collides
with its own earlier launches, however many there were. The collision probe (33 tries) stays as
a safety net. Nothing new is written to the pi session for this.

pi's transcript remains the truth. A restarted server, or a bridge whose idle child was closed,
picks up the chat's own last Claude session only through its resume record
(§app.claude-code-provider/continuity: saved after each turn that settled cleanly and in step,
`<agent dir>/claude-code/resume/<pi session id>.json`, and dropped once anything else is sent): the
same login, unchanged model, effort, system prompt, tools and cwd, and pi's history exactly the
recorded messages followed by one finished reply and new user messages. It resumes that record into
a new one (`--resume <id> --fork-session`, under the next launch's id) and sends only the new user
messages. In every other case (a record from mid-turn never exists, a login moved, a rewind or
compaction, a memory-mode chat, a CLI that fails to resume) it re-sends the history by folding, as
before, and the turn still completes.

Forks resume too, by two routes. A fork point names the parent's live CLI session id,
how many pi messages that session has heard, and their fingerprint; a bridge offers one only
while its CLI child is running, idle, in step with pi and has heard at least one message.

- **A background fork** (`/explain`'s, and the read-only fork `/compact-handoff` writes its note
  in) is a child process: when the parent's model runs on the claude-code provider, the parent's
  bridge hands the child its fork point in `PI_CLAUDE_CODE_FORK`.
- **A UI fork** ("Fork from here" on a Claude Code chat, §chat.session-fork/claude-resume) runs in
  the same process as its source: creating it seeds the bridge, in memory, with the source's fork
  point for the fork's pi session. The fork's first conversation turn takes that seed only if the
  source's CLI session still offers exactly that point (same CLI session, message count,
  fingerprint and cwd), so it resumes the source's live CLI session only while that session is
  still at the forked reply; a source that has moved on, stopped or relaunched since, or a seed a
  restart dropped, leaves the fork folding.

The fork's bridge tries the point once, for its first CLI launch, and resumes the parent's
record into a new one (`--resume <parent> --fork-session`), sending only the new user messages,
so its first request starts from the parent's cached prefix. It folds as before instead when the
cwd differs, when its transcript doesn't start with exactly that prefix, when what follows holds
a tool result or no user message, when the request is a one-shot (compaction or a branch
summary), or when the CLI fails to resume the record.
