# §app/worker-restore — Workers across a restart
> Part of the Sova design spec · [overview](../design/overview.md)

A session's subagent workers are child processes of the runtime that hosts the session. When
the Sova server restarts (a deploy, `systemctl restart`, a crash), those processes die, and until
now the session forgot them: `agent_list` came back empty, the pane lost its rows and the
lifetime Σ restarted at zero. This surface makes a worker outlive its process **as a record**:
what it was, where its transcript is, what it spent. It does not make the process outlive the
restart. A restored worker is idle, and only an explicit resume starts it again.

It holds for **every backend and model**: pi workers on any provider, claude-code workers, and
any backend registered later. Nothing here is specific to one of them; what differs per backend
is declared by that backend's adapter (§app.worker-restore/transcript-protocol).

## §app.worker-restore/worker-record — One durable record per worker

The parent session keeps a durable record of **every worker it starts**, on every backend and
under every worker transport (inline or hosted). It lives in the parent's own session file as
`subagents-worker-manifest` custom entries (version `v: 1`), so it survives whatever the process
does. One fold reads it for every consumer, newest-wins per field and one worker id at a time. The
same fold also reads the older `subagents-worker-registry` entries, which were written only for
hosted workers before this change.

- **What it holds**: the worker id, backend, group, name; the spawn spec (cwd, model, effort,
  task preview and length, wake, sandbox on/off, and the spec as given, so a resume can re-apply
  it); team id, role and orchestrator flag when it is a team member; the **transcript
  reference** once known (a pi session file, or a Claude session id, or whatever the backend's
  adapter names); a **usage snapshot** with the time it was taken; when it last settled and was
  last resumed; and, once it ends, its status, end time and error.
- **When it is written**: at spawn and at each new task (status running); when the backend
  first reports the transcript identity; at each settle (status waiting, with the usage snapshot
  as of that settle and the task's outcome); at the end (done, error, killed, or lost when a hosted
  worker's host died mid-turn); and at a resume, which clears the ended fields and records the status as waiting. Nothing else is
  appended per turn, so a busy worker does not grow the parent's file per message.
- **Readers ignore fields they don't know**, and refuse a record with a higher major version
  with a typed error rather than guessing at it.
- The record is the parent's, not the worker's. A worker's own session is never written by the
  parent or by Sova (§app.subagents-pane/transcript-view: read only).

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
  reply, compactions, and usage with its source (`transcript`, `snapshot` or `none`).
- **What each backend provides today.** pi: the transcript is the worker's session file; usage
  exact, with cost; resume native. claude-code: the transcript is the Claude session id, found
  by scanning `~/.claude/projects`; usage tokens-only, per model; resume native. A backend with
  no transcript file declares `read: none`: its usage comes from the record's snapshot only, it
  cannot be resumed, and the pane says so rather than showing an empty transcript.

## §app.worker-restore/usage-from-transcripts — Usage rebuilt from transcripts

After a restart, a worker's usage is **recounted from its transcript**, which is the canonical
source; the record's snapshot is the fallback when the backend cannot read one.

- **What counts** is everything the worker spent, once:
  - pi: every assistant reply's usage and every `usage` entry (cache-warm calls included),
    deduplicated by entry id, counting only entries after the worker's own
    `subagents-worker-session` marker, so a forked worker never counts the parent history it was
    started with. Cost is exact.
  - claude-code: every assistant line's usage, deduplicated by message id, **including
    its nested agents** (its own Task agents are its spend), whether they are logged inline as
    sidechains or in their own files beside the session (`<session id>/subagents/*.jsonl`). The transcript carries no cost, so
    a Claude worker's cost after a restart is the **last snapshot's**, and every place that shows
    it says "as of {HH:MM}", the time of that snapshot. A worker with no snapshot shows no cost.
- **It can differ from what the pane showed before the restart.** The live count and the
  rebuilt one follow different policies (a live pi count leaves out cache-warm entries; a live
  Claude count is the process's own cumulative figure), and the rebuilt one is the one kept.

## §app.worker-restore/restore — Restored as idle entries, never restarted

When a session's runtime opens after a restart (or a reload, or a switch back to the session)
and its record names workers that no process runs, each comes back as a **restored** entry:
listed by `agent_list`, shown in the pane and on `#/agents`, with no process behind it. Nothing
is started, nothing is sent, and nothing is announced to the parent agent. A restored worker is
settled: it takes no live slot, and a steer to it is refused with the way back (`agent_resume`,
or why it can't be resumed).

- **Which workers.** Records are read from **all branches** of the parent's file, because the
  spend on an abandoned branch was still spent: the lifetime Σ counts them. The list — rows in
  the pane, `agent_list`, `#/agents` — shows only the workers recorded on the **active branch**.
  Each worker counts once, and switching branches moves the list, never the Σ.
- **Status.** A worker that had **ended** before the restart keeps its recorded final status —
  Done, Failed or Stopped, with its end time. A worker that was **running** when the server died
  comes back **interrupted**: status `restored` with the time it was interrupted
  (`interruptedAt`: its last transcript activity or its last record, whichever is later), and its unfinished turn stays as the
  transcript left it. So does one recorded as lost or with no known state. A worker that was
  idle comes back `restored` with no interrupted time. The chip reads "Restored", or "Interrupted" (warn) when there is an interrupted time. None of them reads Working or Starting, pulses, or counts as working.
- **Resumable either way.** An ended worker and an interrupted one alike can be resumed on demand
  when its backend's adapter declares native resume (§app.worker-restore/resume).
- **Marked restored.** Each restored entry carries `restored`, whether it can be resumed
  (`resumable`: its adapter declares native resume, the record has a transcript reference, and
  the backend is loaded), and where its usage came from (`usageSource`: `transcript`, `snapshot` or
  none) with the snapshot's time. `agent_list` says "restored" beside the status, and names
  the resume tool on each resumable worker or gives the reason it can't be resumed.
- **Usage that can't be read is unavailable, never 0.** A worker whose transcript can't be read
  and that has no snapshot shows "usage unavailable" where its tokens would be. The session tab's
  usage names the workers its totals leave out ("Usage unavailable for ag_04: we couldn't read its
  transcript, so the totals above leave it out."). A cost with any snapshot part carries the time of
  its **oldest** snapshot, the stalest part. In the usage table, such a cost reads `$0.41*`: a
  muted `*` whose `title` is "As of {HH:MM}", and one note under the table, "* Cost as of {HH:MM},
  the last report before the restart." (several times: "21:08 and 22:25"). The row stays one line,
  and the Model, Where and Cost cells never wrap. The Subagent lifetime line keeps the time
  inline: "$0.41 as of {HH:MM}".
- **One row, one label, hosted or not.** A restored team member's spend is a Team row in the
  session tab's usage. A restored or resumed worker is named by the model it **ran under**: its
  transcript's model, else its last snapshot's, else the model it was spawned with. So a Claude
  worker reads `haiku-4.5` running, restored and resumed alike, whether the session is hosted by
  this server or only read from its file. On `#/agents`, a team whose members are all
  restored is counted "· {n} restored" beside the Teams head, not as active.
- **Transcripts stay readable.** The pane opens a restored worker's transcript from the record's
  reference exactly as it does a live one (`?path=` for a pi file, `?claude=` for a Claude
  session id).
- **The id counter continues.** A worker spawned after the restart gets the next id, never one a
  restored worker holds.

## §app.worker-restore/resume — Resume on demand

A restored worker starts again only when asked, one worker id at a time: by the parent agent's
`agent_resume {id}` tool, by the `/agent-resume <id>` command, or by the pane's **Resume Worker**
button (§app.subagents-pane/transcript-view), which Sova sends as that command through
`POST /api/workers/resume`. There is **no automatic resume**, not at session open, not at the
next prompt, and not for team members.

- **Same worker.** It keeps its id, name, team membership and role, and continues its own
  transcript: a pi worker reopens its session file; a claude-code worker resumes its Claude
  session by id (`--resume`, never a new `--session-id`). Its spawn spec is re-applied (cwd,
  model, effort, tools, system prompt, MCP servers), and the sandbox follows the **parent's
  current** state, exactly as at spawn (§chat.sandbox/workers), as are its permission mode and
  settings.
- **A team member rejoins its team.** Its team, kept as history since the restart, becomes live
  again, and its mailbox is re-created with a fresh identity: a pi member gets its team tools
  back, a claude-code member its `team` MCP server, and an orchestrator keeps its roster and
  steer tools. What the restart destroyed stays gone: earlier inbox contents and pending requests
  (the inline transport's mailbox was a temporary directory), and the team's create-time
  defaults, so a later `team_add` to that team applies none. Its teammates are not told.
- **It comes back idle** (`waiting`, the Idle chip). Resume sends no prompt and never continues the interrupted turn on
  its own. It never re-emits a completion, so the parent is not woken by a stale report. The
  parent gives it work with `agent_steer` or a team message, like any idle worker.
- **Usage continues** from the rebuilt total; nothing is counted twice.
- **Refusals are said, not guessed.** Resume answers with the reason and changes nothing for:
  a worker that is live (give it work with `agent_steer`), one already being resumed, an ID this
  session file has no record of, a backend whose adapter declares no resume or that is not
  loaded, and a worker whose backend session was never recorded. When the reopen itself fails,
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
(`~/.claude/projects/<cwd-slug>/<id>.jsonl`). The walk upward tolerates up to 32 missing records
in a row, because a failed launch can leave a gap. A restarted server therefore never collides
with its own earlier launches, however many there were. The collision probe (33 tries) stays as
a safety net. Nothing new is written to the pi
session for this, and the bridge still never resumes a Claude session: pi's transcript remains
the truth, re-sent by folding as before.
