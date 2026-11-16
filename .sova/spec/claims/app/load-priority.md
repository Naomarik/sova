# §app/load-priority — Agents' processes run below the server

The server keeps its own CPU priority, and the processes it starts on an agent's behalf run at a
lower one, in a slice with a smaller CPU share than the server's (§app.load-priority/cpu-share). A
worker's test suite or build that oversubscribes the machine then slows itself and its siblings,
not the session list, transcripts and live views. The measurements behind this are in
`docs/perf/2026-10-03-load-and-freezes.md` and `docs/perf/2026-11-16-server-freezes.md` (which
found the server's longest freezes under disk load were its own waits on the disk, not a lack of
CPU), and `docs/perf/RUNBOOK.md` re-runs them. No latency is promised: lower priority decides who
waits when the cores are all busy, and does nothing for work that is slow on an idle machine.

## §app.load-priority/workers — Workers and tool commands start lowered

In a session the server hosts, these start at the worker niceness, 10 unless configured, and
everything they start inherits it:

- every worker the subagents extension starts, pi or Claude Code, and every hidden chat (`/explain`, `/compact-handoff`, `/btw`): its chat process starts at the worker niceness, as a unit of its own (`Nice=`) or a detached session started at that niceness, and so does every later start of the same worker (a resume, a reopen after its idle stop, a crash continue, a code reload, a move to another login, a failover);
- every tool command: the agent's `bash` calls, sandboxed or not, and the user's own `!` commands;
- server-orchestrated recording controllers for a tour and their browser descendants (§app.tours/resources), which read the same worker niceness setting at launch;
- every background job (§app/background-jobs): a kept job keeps the niceness its command ran at, and a requested job starts at the worker niceness.

The server itself, and the commands it runs for its own views and bookkeeping (git, listings,
titles), keep the server's priority. Priority is only ever lowered: a process that already runs
at that niceness or above is left as it is, and a failure to lower it never stops the process from
starting. On Windows nothing is changed.

The worker niceness is `workerNice` in Sova's settings file `<agent dir>/sova/settings.json`: an
integer from 0 to 19, where 0 turns the lowering off; a missing or invalid value reads as 10. The
environment variable `SOVA_WORKER_NICE`, when it holds such a value in the server's environment,
takes its place. A worker reads it when it starts; the agent's `bash` reads it when the session's
runtime is built (or the sandbox is turned on or off), a `!` command when it runs.

pi outside Sova (the TUI) is unchanged: its tool commands keep its own priority.

## §app.load-priority/cpu-share — The server's CPU share beats the agents'

Niceness orders processes only inside one group; on Linux systemd first shares the CPU between
groups, and the server (in `app.slice`) and Sova's agents' slice `sova.slice` (the chats'
`sova-chats.slice`, the jobs' `sova-jobs.slice` and the project services' `sova-services.slice`)
are siblings at the same default weight of 100. So at every start, where the systemd user manager
answers and the server runs as Sova's installed service (its own unit, from `/proc/self/cgroup`, is
`sova.service` or `sova-runtime.service`), the server sets `sova.slice`'s `CPUWeight` to 20, a fifth of its siblings': when every core
is busy, the server's side gets the larger share and the agents share the rest. It is set for the
running system only (`systemctl --user set-property --runtime`), never written to a unit file: the
setting lasts until logout or reboot, even after Sova stops, and is set again at Sova's next start
only where systemd holds another weight. A
failure is logged and never stops the server or a chat from starting.

Every other server leaves the slice alone and makes no `systemctl` call: a dev, hermetic, test,
merge-copy or load-experiment server shares the machine's one `sova.slice` with the real one, so it
never touches it, whatever its environment says. The installed service leaves it alone too, with the
reason logged, on macOS, on a Linux where no user manager answers, where its chats or jobs run in
another slice (`SOVA_CHAT_SLICE`, `SOVA_JOBS_SLICE`) or as detached processes
(`SOVA_CHAT_DRIVER=detached`), where the server itself runs inside `sova.slice`, and with
`SOVA_AGENT_CPU=off`, which the hermetic dev server, the test runner and the servers tests start set
as well. It decides only who waits when the cores are all busy: no latency is promised.

## §app.load-priority/ceiling — A CPU ceiling for all agents together, off by default

Settings → General's **Agents' CPU · this computer** (§app.settings-dialog/general) can cap the CPU
all agents use together: "Agents may use at most N of M cores", M being this computer's cores. The
cap is `CPUQuota=N×100%` on `sova.slice`, so the chats, workers, tool commands, background jobs and
project services under it together never take more than N cores' worth of time, however idle the
rest of the machine is. The Sova server isn't limited. It is off by default, and nothing turns it
on but the user.

- **The section.** A switch, **Limit agents' CPU**, off by default, with the hint "Off by default.
  On, all agents together, with their background jobs and project services, may use at most the
  cores you set. The Sova server isn't limited." Turned on, it offers all but 2 of the cores (at least
  1), and a box **Agents may use at most [N] of M cores** takes a whole number from 1 to M. The
  switch saves when flipped and the box when its number is committed (Enter or leaving it), never per
  keystroke; neither is part of a form, so Save Changes neither stages nor writes them. A number out
  of range turns the box red with the rule's sentence ("Cores must be a whole number from 1 to M.")
  and saves nothing. A save is announced ("Agents
  may now use at most 6 of 8 cores.", "Agents may use every core again."); a failed switch flip goes
  back with a toast, and a failed number says so under the box.
- **Where it can't apply** (the cases §app.load-priority/cpu-share leaves the slice alone in), the
  switch is disabled and the hint says why in one sentence, and a change is refused with that reason
  and "Nothing changed.".
- **Kept and applied.** The ceiling is kept in `<state root>/agent-cpu.json` (`{"maxCores": N}`; no
  file is no ceiling, and a file without a whole number of at least 1 reads as none, with a warning
  in the log). A change sets systemd first, then the file; when systemd refuses, neither changes, and
  when the file can't be written, systemd is put back. Turning it off sets no quota and deletes the
  file. Like the weight it is set for the running system only, so the server sets the saved ceiling
  (or none) again at every start. When systemd holds something other than the saved ceiling (another
  program changed it), the section says so: "systemd holds {no ceiling | a ceiling of K cores} on the
  agents now. Sova puts your setting back when it next starts."
- **Only your click changes it.** `GET /api/settings/agent-cpu` answers whether it can apply and why
  not, the cores, the saved ceiling and the one systemd holds. `PUT` takes `{"maxCores": N | null}` and
  passes only on the user's own click in Sova's page (§app.access/your-click), whether it tightens,
  loosens or removes the ceiling: any other caller gets 403 and nothing changes.
- **By a card too.** Like every Sova-wide setting it can change by a Settings change card
  (§chat.create-mode/settings-cards), as `agents.cpu-ceiling`: a whole number of cores or `null` for
  none, taking effect at once. Its Apply sets it the way the section does, systemd first and then the
  file, and is refused with the same reason where it can't apply. When a card's Apply is put back (a
  later edit of the same card refused), systemd is set again to match the restored file.
