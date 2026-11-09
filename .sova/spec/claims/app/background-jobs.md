# §app/background-jobs — Background jobs
> Part of the Sova design spec · [overview](../design/overview.md)

A command a chat runs can leave something running: a test lab, a server, a long build. Sova keeps it
as a **background job**. A job runs outside the chat's process, so it outlives the chat's shutdown,
reload or crash and a Sova restart. It shows in the session pane, nothing lets it run forever, and
its end wakes the chat. One job is everything one command left behind, so a test lab with browsers
and Docker is one job. Chats still shut down after 30 quiet minutes and reload onto new code on
time with their jobs running: a job holds neither. Which machines and chats this covers is
§app.background-jobs/where.

## §app.background-jobs/keeping — Kept automatically

- **When.** When a chat's `bash` command returns and left something running, the chat moves it out
  of its own unit straight away, into a job unit `sova-job-<state hash>-…` in `sova-jobs.slice`, and
  records a job. Nobody asks for this and no server is needed. The chat and the model work as
  they did: `&`, `nohup` and `setsid` simply last now.
- **Whatever the command's outcome.** A command that failed, timed out or was cancelled, and left
  something running, leaves a job too.
- **Only that command's leftovers.** Commands can run side by side. A command still running is never
  moved and is never a job, and one command's return moves nothing of another's.
- **What isn't a job.** The chat's own helpers (the Claude program among them) go when the chat
  ends, as they always did. Your own `!` commands are not kept. A hidden chat (`/btw`, `/explain`, a
  handoff) keeps no job: what its commands leave running ends with it, as before.
- **What it survives.** An idle shutdown, a reload, a crash of the chat, and a stop or restart of
  Sova. A worker's job survives the same things of that worker and of its main chat.
- **The command's result says so.** It ends with `[Sova] This command left something running; it is
  kept as background job j1 and outlives this chat's shutdown, reload or crash. Its end will wake you
  unless this chat has reached its limit of 30 wakes without the user.`, then where its output goes
  (`Its output: <file>`) or that it has none (§app.background-jobs/output).

## §app.background-jobs/request — Asking Sova for a job

A confined worktree worker's background processes die when its command returns
(§chat.sandbox/limits), so nothing is left to keep. Such a worker uses the `background_job` tool
instead, which asks Sova to start the command as a job.

- **Same confinement.** The job runs under exactly the worker's confinement, so it and everything
  it starts can write only where the worker can. A write anywhere else fails with a permission
  error, and the job stays listed.
- **Same treatment.** It is listed, limited, stopped and reported like a kept job, and it stays out
  of the worker's process. Unlike a kept job it reports pass or fail, with its exit code.
- **Its output.** The tool's result names the job and the file its output goes to. It starts
  `[Sova] Started background job j1. It runs outside this chat, so it outlives this chat's shutdown,
  reload or crash, and its end will wake you with its exit code unless this chat has reached its
  limit of 30 wakes without the user.` and ends `Its output: <file>`.
- **Who may ask.** A write-only worker (§chat.worktrees/workers) and any chat that isn't fully
  sandboxed. In a fully sandboxed chat it is refused with `Background jobs aren't available in a
  sandboxed chat.` (§app.background-jobs/where). The tool is in the Shell group
  (§chat.profiles/model) and runs on the server (§app.chat-processes/server-actions).

## §app.background-jobs/limits — 5 jobs, 24 hours

- **5 at once per chat.** A job counts once however many processes it has, and an ended job doesn't
  count. A worker counts as a chat of its own.
- **Past 5, the job isn't kept.** It stays in the chat's unit, gets no row, no record and no end card,
  and ends at the chat's next shutdown or reload. The command's result says so: `This command left
  something running, but this chat already keeps 5 background jobs, so it wasn't kept. It will end
  at this chat's next shutdown or reload.` A `background_job` request past 5 is refused with the same
  reason and starts nothing.
- **24 hours each.** A job still running 24 hours after it was kept or started is stopped the way
  Stop stops it (§app.background-jobs/stopping), and its end card says it hit the time limit.

## §app.background-jobs/output — Where a job's output goes

- **Where the command wrote it.** A job's output stays in the file its command sent it to. Sova
  records that location and keeps no copy of its own.
- **A job with no output file is still kept, and flagged.** When no process of the job has its
  standard output or error on a file, and one of them still points at its command's closed output
  (a pipe no process of the job reads), it has nowhere to write: it doesn't die when the command
  returns, it dies the first time it writes, which for a quiet or slow job can be hours later, with
  that output lost. A job with a file on either is not flagged; its output is the first such file. The command's result and the job's end card both say so:
  `This job has no output file and will die the first time it writes.`
- **The standing instruction.** Chats are told to send a background command's output to a file.

## §app.background-jobs/end-card — A job's end wakes its chat

When a job ends, Sova records it and, unless Stop ended it, sends its chat a card, a message tagged
`[job j1]` (§chat.transcript/transcript-items).

- **What it says.** Which job ended, how long it ran, and where its output is. A kept job's card
  can't say whether it passed, so the chat reads the output and decides. A requested job's card says
  passed or failed, with its exit code. A card also says when the time limit stopped the job, or
  that it has no output (§app.background-jobs/output). Each job's lines end with when it ended,
  `Ended at <ISO time>.`, so the card's `ended HH:MM` is the job's end, not the card's arrival
  (§chat.transcript/transcript-items).
- **It brings the chat back.** A shut-down chat comes back as for a nudge, with the same bounded tries,
  and a worker through its main chat (§chat.wake-nudges/tries, §chat.wake-nudges/kinds). The card is
  kept until it is delivered. A chat that can't be brought back gets it when it next opens.
- **A busy chat** gets it after its current reply.
- **A worker's reply to it** is a report to its parent (§app.chat-processes/worker-reports).
- **Late, once.** If Sova was off when the job ended, the card arrives once, with the line
  `Late by {late} (Sova was not running).`
- **It counts toward the limit of 30.** Each card is one wake (§chat.wake-nudges/wake-limit), so a loop
  of job, wake and new job stops and waits for you. Past the limit the job is still recorded and no
  card is sent.
- **However soon it ends.** A job that exits wakes its chat even seconds after it was kept or
  started: there is no short-job exception.
- **Pressing Stop sends no wake.** Stop, or `session.job.stop`, costs no reply and starts nothing,
  neither a shut-down chat nor a stopped worker. It sends no card and doesn't count toward the limit
  of 30. The chat learns the job was stopped the next time it runs.
- **The time limit is not Stop.** A job the time limit ended still gets its card, and that card
  wakes the chat.
- **Archiving or deleting the chat, and stopping a worker,** send no card.

## §app.background-jobs/pane — Seeing and stopping jobs

- **The section.** While a chat has a job running, the session pane's Session tab shows a
  **Background jobs** section right after Worktrees (§app.subagents-pane/tabs), with one row per
  job: what is running, for how long, where its output goes (`No output file` when it has none),
  the worker it belongs to, if any, and a `Stop` button. A chat's workers' jobs show in this section
  too.
- **The marker.** A chat that has shut down with a job running shows a small `job running` marker in
  the session list (§app.session-list/content-rules). The session's summary carries the count as
  `jobsRunning`, only while its chat has shut down, and counts the chat's own jobs, not its workers'.
- **Stop needs no chat.** Stop works with the chat shut down, never starts it and sends it no wake
  (§app.background-jobs/end-card).
- **Scripts.** `session.job.list` and `session.job.stop` in the catalogue
  (§app.commands/catalogue) do the same.

## §app.background-jobs/stopping — What stops a job

Nothing runs forever.

- **Stop** gives a job 15 s to finish, then ends everything left in it. It wakes nothing
  (§app.background-jobs/end-card).
- **Archiving or deleting a chat** stops its jobs and those of its workers.
- **Stopping a worker** stops that worker's jobs. Its idle stop doesn't.
- **The time limit** stops a job after 24 hours (§app.background-jobs/limits).
- **`bun scripts/stop-chats.ts`** stops every job of the state root along with its chats.

## §app.background-jobs/machine-restart — A restart or logout ends jobs

A machine restart or a logout ends every job. Sova marks them as ended that way and tells each chat
once, in one card that names them all. It never starts a job again, because running half-finished
work twice is unsafe.

## §app.background-jobs/where — Which machines and chats

- **Linux with the systemd user manager:** everything above.
- **Macs, and Linux without that manager:** what a command leaves behind isn't kept. It keeps
  today's behaviour: it survives the chat's shutdown, but it isn't listed, limited or stopped, and
  nothing tells the chat when it ends. `background_job` starts nothing here and says why:
  `Background jobs need Linux with the systemd user manager, and Sova isn't running its chats under
  one here, so nothing was started.`
- **Fully sandboxed chats are unchanged.** In a chat with the sandbox On, and a worker confined under
  it, a background process dies when its command returns and `background_job` is refused, because
  its network runs through the chat and would stop with it. Only a write-only worker has a way to
  run a job.
- **A remote target's chat.** Its commands run on the target, so nothing is kept.
