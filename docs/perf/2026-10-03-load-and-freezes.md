# Load and freezes: keeping Sova responsive while workers fill the machine (2026-10-03)

**Status: the method, harness and fix are written; the experiment's numbers are pending.** The
experiment needs `systemd-run --user`, which the sandboxed worker that wrote this can't reach, so
the orchestrator runs it (`docs/perf/RUNBOOK.md`). The Results and
Conclusions sections get filled in from `docs/perf/data/`.

## Symptom

During long coding sessions, reloading Sova sometimes took about 20 s and the UI felt frozen.

## Diagnosis (60-minute read-only trace of the live server, 2026-10-03)

- **The server starved. It didn't block itself.** In 60 minutes, no event-loop stall of its own
  making lasted longer than ~0.7 s, and memory didn't grow (V8 heap 420-780 MB, no trend, GC 1-2% of
  a core).
- **The machine was oversubscribed.** Workers ran full `node --test` suites, sometimes two at once
  and each using up to 19 cores, plus `tsc` and `vite` builds. That pushed the load average to 50-69
  on 32 cores (cpu PSI "some" 50-75%), all at nice 0. During those bursts the server's single JS
  thread got about 30-40% of a core while it was runnable. Event-loop delay went up to 100-500 ms per
  second, and `GET /api/sessions` took 6, 13, 19 and 27 s (80-250 ms when calm). A reload sends
  several such requests at once, so ~20 s is what you'd expect.
- **Mechanism.** The test processes never block Sova's thread. They compete for cores, so the
  scheduler time-slices the server's one thread and every await takes longer in wall time.
- **Why the unit's CPUWeight alone can't fix it.** The workers that ran those suites are the
  server's own children, in `sova-runtime.service`'s cgroup at nice 0. A cgroup weight only divides
  CPU between sibling cgroups, so it can't protect the server from its own workers. Inside one cgroup,
  niceness does that job. An unprivileged process may lower its children's priority (never raise it),
  and their descendants inherit it, on Linux and macOS alike.
- **Amplifiers** (tracked separately): every git spawn forks the 1.3 GB server on its main thread,
  ~9 ms calm and 25-60 ms under load (feat/idle-cpu targets readiness `git status`, 56% of spawns).
  Transcript responses were ~4x their session file (feat/transcript-slim).

## Method

`scripts/perf/load-experiment.mjs` runs a hermetic server on port 4867 (inspector 9267) over a
`.agent` that holds a copy of every real session (663 files, 585 MB, rsynced in, never written
back). Each run goes like this:

1. Start a fresh server and warm its caches (three listings, one tail and one full transcript).
2. Probe continuously from outside. `GET /api/sessions` runs sequentially with a 1 s gap. The
   transcript of the 8.9 MB session 01a0f6e0 (a 35.8 MB response on master) is fetched as its tail
   (`tail=1`, the chat hello) every 2 s and in full every 3 s. Every 10 s a simulated reload sends
   four requests at once: the list twice, the tail and the light pane.
3. Measure inside the server through the inspector: a `monitorEventLoopDelay` histogram (10 ms
   resolution), read and reset every second.
4. Sample the system every second: load1, `/proc/pressure/cpu` some avg10, and the server main
   thread's CPU share.
5. Phases: idle 30 s, then the load starts, then a 20 s ramp, a 60 s measured load phase, a stop,
   and a 20 s cool-down.

The load is `scripts/perf/load-standin.mjs`, a stand-in for a worker. By default it keeps two full
`node --test` suites (package.json's test command), two `tsc --noEmit` and one `vite build` running,
restarting each as soon as it exits. For the in-cgroup variants the server itself spawns it (through
the inspector), so the load is the server's child, in its process group and cgroup, as real workers
are.

| variant | load placement | load priority | server |
|---|---|---|---|
| nice0 | server's child | nice 0 (master today) | default scope |
| nice10 | server's child | `os.setPriority(pid, 10)` after spawn | default scope |
| fixed | server's child | the shipped code (`lowerPriority`, the server's worker-nice setting) | default scope |
| weight | server's child, so inside the weighted scope | nice 0 | scope `CPUWeight=1000` |
| ext | sibling scope | nice 0 | default scope |
| weight-ext | sibling scope | nice 0 | scope `CPUWeight=1000` |

Each variant runs 3 times, and the order rotates each rep so drift in machine load spreads evenly.
Reported numbers: per run, p50/p95/max of each probe in each phase, then the median across reps.

## Results

_Pending: filled in from `docs/perf/data/2026-10-03-experiment/summary.md` and
`docs/perf/data/2026-10-03-after/summary.md`._

## Conclusions

_Pending the numbers._ What the fix does whatever they show:

- **a9, the fix:** in a session Sova hosts, every worker the subagents extension starts (pi or
  Claude Code, direct or through its detached host, every relaunch) and every tool command (the
  agent's `bash`, sandboxed or not, and the user's `!` commands) starts at nice 10.
  - The server keeps its own priority.
  - Configure it with `workerNice` (0-19, 0 = off) in `<agent dir>/sova/settings.json`, or with
    `SOVA_WORKER_NICE` in the server's environment. Spec: §app.load-priority/workers.
  - pi outside Sova (the TUI) is unchanged.
  - Code: `pi-config/extensions/subagents/priority.ts` (builtins only) and
    `server/process-priority.ts`.
- **a2:** `pnpm test`, `pnpm run typecheck` and `pnpm run build` run through `scripts/nice.mjs`, which
  lowers itself to nice 10 (`SOVA_SCRIPT_NICE` overrides it, 0 = unchanged) and runs the command
  unchanged where priority can't be lowered (Windows).
- **q1** (`CPUWeight=1000` drop-in for sova-runtime.service): decided from the weight and
  weight-ext rows.

## Re-running

See `docs/perf/RUNBOOK.md`:

```sh
node scripts/perf/load-experiment.mjs --prepare
node scripts/perf/load-experiment.mjs --variants nice0,nice10,weight,ext,weight-ext --reps 3 --out docs/perf/data/<name>
node scripts/perf/load-experiment.mjs --summarize docs/perf/data/<name>
node scripts/perf/load-experiment.mjs --cleanup
```

Without `systemd-run --user`, only nice0, nice10 and fixed can run.
