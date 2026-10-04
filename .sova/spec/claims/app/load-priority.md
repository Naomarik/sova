# §app/load-priority — Agents' processes run below the server

The server keeps its own CPU priority, and the processes it starts on an agent's behalf run at a
lower one. A worker's test suite or build that oversubscribes the machine then slows itself and
its siblings, not the session list, transcripts and live views. The measurements behind this are
in `docs/perf/2026-10-03-load-and-freezes.md`, and `docs/perf/RUNBOOK.md` re-runs them. No latency
is promised: lower priority decides who waits when the cores are all busy, and does nothing for
work that is slow on an idle machine.

## §app.load-priority/workers — Workers and tool commands start lowered

In a session the server hosts, these start at the worker niceness, 10 unless configured, and
everything they start inherits it:

- every worker the subagents extension starts, pi or Claude Code, whether the server spawns it
  directly or through its detached host, and every later launch of the same worker (a resume, a
  move to another login, a failover);
- every tool command: the agent's `bash` calls, sandboxed or not, and the user's own `!` commands.

The server itself, and the commands it runs for its own views and bookkeeping (git, listings,
titles), keep the server's priority. Priority is only ever lowered: a process that already runs
at that niceness or above is left as it is, and a failure to lower it never stops the process from
starting. On Windows nothing is changed.

The worker niceness is `workerNice` in Sova's settings file `<agent dir>/sova/settings.json`: an
integer from 0 to 19, where 0 turns the lowering off; a missing or invalid value reads as 10. The
environment variable `SOVA_WORKER_NICE`, when it holds such a value in the server's environment,
takes its place. A worker reads it when it starts; the agent's `bash` reads it when the session's
runtime is built (or the sandbox is turned on or off), a `!` command when it runs.

pi outside Sova (the TUI) is unchanged: its workers and tool commands keep its own priority.
