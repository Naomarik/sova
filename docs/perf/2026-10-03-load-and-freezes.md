# Load and freezes: keeping Sova responsive while workers fill the machine (2026-10-03)

**Result:** when worker load lowered to nice 10 oversubscribes the machine, Sova's `GET /api/sessions`
is about 3x faster than with the same load at nice 0 (median p50 3.3 s → 1.1 s, p95 6.6 s → 1.8 s), and
a simulated reload takes 1.5 s instead of 4.4 s. A `CPUWeight=1000` on the server's cgroup helps only
against load from outside it (p50 3.9 s → 0.7 s). Against the server's own child processes it does
nothing (3.4 s), which is why both changes are needed. The shipped code reproduces the nice-10 result
(p50 0.83-0.86 s against 2.9 s for nice 0 in the after-fix batch). The orchestrator ran the experiment
by hand from `docs/perf/RUNBOOK.md`; the raw samples are in `docs/perf/data/`.

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

The runs took place on 2026-10-03 between 18:05 and 19:10 UTC, on a 32-core Linux machine (EEVDF
scheduler, cgroup v2 with the cpu controller in the user manager). The harness ran in its own unit
at nice 0. Calibration with the default mix (two `node --test` suites, two `tsc`, one `vite build`)
reached load1 76.5, so the load phases ran at load1 76-120 with cpu PSI "some" at 75-84%. That is a
little above the observed bursts (50-69). The machine was not otherwise idle: other sessions kept
load1 near 40 during the idle phases, but PSI stayed under 1%, so idle numbers are clean.

**Experiment** (`docs/perf/data/2026-10-03-experiment/summary.md`; 3 reps per variant, the median
across reps of each run's p50 and p95, in ms):

| variant | /api/sessions p50 | p95 | reload p50 | p95 | transcript tail p50 | p95 | full transcript p50 | p95 | server main thread CPU | ELD mean | ELD max p95 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| any, idle | 195-277 | 304-508 | 280-465 | 308-558 | 7-12 | 24-114 | 219-310 | 281-360 | 56% | 13-15 | 137-144 |
| nice0, load | 3254 | 6592 | 4411 | 5629 | 105 | 982 | 1823 | 2699 | 19% | 64 | 417 |
| nice10, load | **1082** | **1823** | **1485** | **1841** | 47 | 365 | 757 | 1217 | 42% | 39 | 346 |
| weight, load | 3423 | 8165 | 5252 | 8278 | 156 | 822 | 1734 | 3255 | 18% | 75 | 410 |
| ext, load | 3854 | 6503 | 4151 | 5874 | 116 | 494 | 1784 | 3050 | 18% | 72 | 414 |
| weight-ext, load | **669** | **1150** | **883** | **1070** | 24 | 158 | 602 | 696 | 54% | 27 | 297 |

(ELD: event-loop delay per one-second window, mean and max, in ms. "reload": four requests sent at
once, timed until the last one answered.)

**After the fix** (`docs/perf/data/2026-10-03-after/`; nice0 against `fixed`, the shipped code path):

| variant | /api/sessions p50 | p95 | reload p50 | p95 | main thread CPU |
|---|---|---|---|---|---|
| nice0, load (3 reps) | 2877 | 5720 | 4445 | 5568 | 20% |
| fixed, load (reps 2 and 3) | 825 / 860 | 1656 / 1700 | 1277 / 1334 | 1856 / 2159 | 44% |
| fixed, load (rep 1, discounted) | 4171 | 5372 | 5264 | 5664 | 19% |

With rep 1 included, the batch summary reads fixed 860/1700 (median of the three runs).

Rep 1 of `fixed` is a harness artifact, and I've left it out:
- Its idle phase was clean (PSI 0.8%), and its stand-in reported nice 10.
- During its load phase, though, the server's main thread got 19% of a core, exactly the nice-0
  share. Reps 2 and 3 got 44%.
- Cause: the `fixed` variant compiled `priority.ts` (31 ms cold, the first time any server
  compiled it) after spawning the stand-in. The stand-in starts its first commands within 18 ms,
  so that rep's first test suites started at nice 0 and stayed there for their whole run.
- Reps 2 and 3 hit tsx's transform cache, so they lowered in time.
- The product loads the module before it spawns, so the race doesn't exist there. The harness
  now does the same.
- No port clash with the verifier's brief server on :4867: every run's server log shows its own server bound and serving, with no EADDRINUSE.

**End-to-end check of the shipped code.** On a sandboxed hermetic server running at nice 0, a fresh
zai/glm-5.3 session ran a `bash` call: its shell and its `node` child both reported nice 10. The
session then spawned a pi worker through `agent_spawn`, and the worker's own `bash` reported nice
10. The worker process carries no Sova hook and adds no prefix, so that value is the worker's
inherited niceness.

**Event-loop sampler.** The first summaries showed "ELD max p95 –" and "ELD max 0.0" for most
load runs. The cause was in the harness, not in Sova:
- About 5% of the one-second reads failed with the inspector error "Promise was collected", at
  idle as well as under load and in every variant.
- The harness had started sending `awaitPromise: true` on every `Runtime.evaluate`. For the
  `fixed` variant's async spawn it was needed, but on a plain value V8 still wraps the result in a
  promise, and that promise can be collected first.
- The failed reads came back as empty samples, and an empty value poisoned the percentile sort.
- Fixes: the harness now asks for `awaitPromise` only on the async call and records a failed read
  as `eld-error`, and the summary drops non-numeric samples and counts them ("lost reads").
- Resummarized, the existing data loses 1-8 reads out of ~57 per run. The losses aren't tied to
  any phase or variant, so the ELD columns above are valid. A smoke run after the fix lost none.

## Conclusions

1. **Starvation is the cause, and priority fixes it.**
   - The same load at nice 10 instead of nice 0 cuts `/api/sessions` p50 and reload time about
     3x, and p95 about 3.6x.
   - The server's main thread gets 42-44% of a core instead of 19%.
   - The worst listing in a 60 s load phase falls from ~7.6 s to ~2.4 s.
   - This confirms f1 and f6: the server never blocked, it waited for a core.
2. **Priority narrows the gap but doesn't close it.**
   - Under nice-10 load the server is still about 4x slower than idle.
   - Other nice-0 work on the machine still competes. Every probe is a chain of awaits through the
     libuv threadpool, git child processes and the kernel, and each of those waits for a core too.
   - The remaining amplifiers (forks of the 1.3 GB server, transcript size) are being tackled
     separately (feat/idle-cpu, feat/transcript-slim).
3. **q1, CPUWeight.**
   - `weight` (CPUWeight=1000, load inside the server's cgroup) is no better than nice0 (p50
     3.4 s), because a cgroup weight only divides CPU between sibling cgroups (f7).
   - `weight-ext` (load in a sibling cgroup) is the best variant measured: p50 0.67 s against 3.9 s
     for `ext`.
   - So the drop-in protects the server from load outside its unit (TUI sessions, terminals,
     other services), and nice protects it from its own workers. They complement each other.
   - On this data the orchestrator applied `CPUWeight=1000` to sova-runtime.service with
     `systemctl --user set-property`, no restart needed.
4. **Shipped (a9):** in a session Sova hosts, every worker the subagents extension starts (pi or
   Claude Code, direct or through its detached host, every relaunch) and every tool command (the
   agent's `bash`, sandboxed or not, and the user's `!` commands) starts at nice 10.
   - The server keeps its own priority.
   - Configure it with `workerNice` (0-19, 0 = off) in `<agent dir>/sova/settings.json`, or with
     `SOVA_WORKER_NICE` in the server's environment. Spec: §app.load-priority/workers.
   - pi outside Sova (the TUI) is unchanged.
   - Code: `pi-config/extensions/subagents/priority.ts` (builtins only) and
     `server/process-priority.ts`. Claude Code and the sandbox reach it through hooks the server
     installs.
5. **Shipped (a2):** `pnpm test`, `pnpm run typecheck` and `pnpm run build` run through
   `scripts/nice.mjs`.
   - It lowers itself to nice 10 (`SOVA_SCRIPT_NICE` overrides it, 0 = unchanged).
   - Where priority can't be lowered (Windows), it runs the command unchanged.

## Re-running

See `docs/perf/RUNBOOK.md`:

```sh
node scripts/perf/load-experiment.mjs --prepare
node scripts/perf/load-experiment.mjs --variants nice0,nice10,weight,ext,weight-ext --reps 3 --out docs/perf/data/<name>
node scripts/perf/load-experiment.mjs --summarize docs/perf/data/<name>
node scripts/perf/load-experiment.mjs --cleanup
```

Without `systemd-run --user`, only nice0, nice10 and fixed can run.
