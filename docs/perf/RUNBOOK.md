# Load experiment runbook (al_3, feat/load-priority)

Documented in docs/perf/2026-10-03-load-and-freezes.md; this file is how to re-run it.

For the orchestrator, who runs it from a session that can reach the user bus. The load-priority
worker (sandboxed) built the harness and dry-ran it at tiny load without systemd; it cannot run
`systemd-run --user`, so the scope variants have never run. Read step 2 before the long runs.

Timing with the verifier: the verifier measures latency in the transcript-slim worktree, and this
load would skew it. Message `verifier` before each batch (steps 2, 3, 4), wait for its go-ahead,
and tell it when the batch ends.

Harness: `scripts/perf/load-experiment.mjs` (orchestrator) and `scripts/perf/load-standin.mjs` (the
load: full `node --test` suites, `tsc --noEmit`, `vite build` into `~/.cache/sova-perf/`, each
restarted as it exits). Builtins only, no network, nothing written to `~/.pi`.

## Ports and processes

- Hermetic server: `127.0.0.1:4867` (`--port`), inspector `127.0.0.1:9267` (`--inspect`). One run at
  a time; each run starts a fresh server and stops it.
- With systemd: every server runs in a transient scope `app.slice/sova-perf-srv-<run>.scope`
  (CPUWeight 100, or 1000 for the weight variants); the `ext` variants' load runs in
  `app.slice/sova-perf-load-<run>.scope`. Check one while it runs:
  `systemctl --user status 'sova-perf-*'` (the CGroup line) and
  `systemctl --user show 'sova-perf-srv-*' -p CPUWeight`.
  Otherwise the load is the server's own child (spawned inside it through the inspector), so it
  sits in the server's process group and scope like a real worker.
- Nothing touches `sova-runtime.service`, `~/.config/systemd`, `~/.pi` (sessions are read from it
  once, by rsync) or any real worktree.

## Commands, in order

Run them in the FOREGROUND from the worktree, in bash or zsh. If you background the harness in zsh,
run `setopt NO_BG_NICE` first: zsh starts `cmd &` at nice 5, every server would inherit it, and the
harness logs a WARNING line when its own nice isn't 0.

```sh
# From the repo root:

# 0. Preconditions: ports free, systemd scopes work, no leftovers.
ss -ltn | grep -E ':(4867|9267)\b' && echo "PORT TAKEN: stop here"
systemd-run --user --scope --quiet -- true && echo "scopes ok"
systemctl --user list-units --all 'sova-perf-*' --no-legend

# 1. Prepare (~1 min): builds .agent (scripts/hermetic-agent-dir.mjs; prints an unlock URL, ignore it)
#    and copies every real session in: rsync ~/.pi/agent/sessions/ -> .agent/sessions/ (minus live/).
node scripts/perf/load-experiment.mjs --prepare

# 2. Calibrate (~3 min): one nice-0 run. In its run.log, the "measuring load" line and the result
#    line give load1. The observed bursts were load 50-69 on 32 cores. If load1 stays under ~45
#    during the load phase, add a suite with --mix test=3,tsc=2,vite=1 in steps 3 and 4 (and say so).
node scripts/perf/load-experiment.mjs --variants nice0 --reps 1 --out docs/perf/data/2026-10-03-calibrate

# 3. The experiment (~45 min; 5 variants x 3 reps = 15 runs, order rotated each rep).
node scripts/perf/load-experiment.mjs --variants nice0,nice10,weight,ext,weight-ext --reps 3 \
  --out docs/perf/data/2026-10-03-experiment 2>&1 | tee docs/perf/data/2026-10-03-experiment.console.log

# 4. After the fix (~18 min; 6 runs): nice0 (master's behaviour) against fixed (the shipped code
#    path: subagents/priority.ts lowerPriority with the server's worker-nice reading, default 10).
node scripts/perf/load-experiment.mjs --variants nice0,fixed --reps 3 \
  --out docs/perf/data/2026-10-03-after 2>&1 | tee docs/perf/data/2026-10-03-after.console.log

# 5. Clean up (also safe to run any time), then verify nothing is left.
node scripts/perf/load-experiment.mjs --cleanup
rm -rf ~/.cache/sova-perf
systemctl --user list-units --type=scope --all 'sova-perf-*' --no-legend   # must print nothing
pgrep -af 'load-standin|load-experiment|--inspect=127.0.0.1:9267'          # must print nothing
ss -ltn | grep -E ':(4867|9267)\b'                                          # must print nothing
```

Variants: `nice0` load as the server's child at nice 0 (today); `nice10` the same, then
`os.setPriority(child.pid, 10)`; `fixed` the same, lowered by the shipped code; `weight` the server's
scope at CPUWeight=1000 with the load inside it as its child (what a unit drop-in gives against the
server's own workers); `ext` the server in a default scope, the load in a sibling scope (load from
outside the unit, e.g. TUI sessions); `weight-ext` the server's scope at CPUWeight=1000, the load in
a sibling scope (what the drop-in gives against outside load). Options: `--idle 30 --ramp 20
--load 60 --cool 20` (seconds), `--nice 10`, `--weight 1000`, `--mix test=2,tsc=2,vite=1`.

## Timing

One run is about 2.5-3 min: server start and warm-up ~15 s, idle 30 s, ramp 20 s, load 60 s, stop
a few seconds (up to 2 min if a full-transcript request is stuck under load), cool 20 s. Total for
steps 1-4: about 70 min. The machine is oversubscribed for ~80 s of each run (ramp and load phases),
so the live Sova will feel slow then.

## Analysis: medians and p95

The harness writes the summary itself when a batch ends, and `--summarize <dir>` rebuilds it from
the saved samples. For each run it takes, per phase (idle, load), the p50, p95 and max of every
probe's latency, the per-second event-loop delay (mean and max), load1, cpu PSI and the main
thread's CPU share. Then it reports, per variant and phase, the median of those per-run values
across reps, plus the worst max. Tables: `summary.md`; machine-readable: `summary.json`.

```sh
node scripts/perf/load-experiment.mjs --summarize docs/perf/data/2026-10-03-experiment
```

## Where results land

`docs/perf/data/<name>/` in the worktree (not .agent): `run.log`, per run
`<variant>-r<rep>-<id>.samples.jsonl` (every probe sample: `/api/sessions`, transcript tail, full
transcript of the 8.9 MB session 01a0f6e0, a simulated reload of four concurrent requests, and per
second event-loop delay, load1, cpu PSI and the server main thread's CPU), `.meta.json`,
`.server.log`, and at the end `summary.md` / `summary.json` (medians across reps of each run's p50
and p95). `node scripts/perf/load-experiment.mjs --summarize docs/perf/data/<name>` rebuilds the
summary from the samples, also for a partial run.

## Stopping

- Ctrl-C the harness: it SIGTERMs the current server and load, SIGKILLs them 3 s later, runs the
  cleanup and exits 130. The samples of finished runs stay; the interrupted run's are lost.
- If the harness itself was killed: `node scripts/perf/load-experiment.mjs --cleanup` stops every
  `sova-perf-*` scope and `fuser -k`s whatever holds 4867/9267. The load stand-in also exits on its
  own when its parent dies (1 s check) and after ramp+load+30 s at most.
- Check: `systemctl --user list-units --all 'sova-perf-*' --no-legend` is empty, and
  `pgrep -af 'load-standin|load-experiment|--inspect=127.0.0.1:9267'` prints nothing.

## Hand back

Tell the load-priority worker the `docs/perf/data/` directory names (and the console logs, the
calibration's load1, and anything odd such as the WARNING line or failed probes). It analyses them
and writes them up in docs/perf/2026-10-03-load-and-freezes.md.

## Optional: tests the sandbox couldn't run

These fail identically on the untouched base (HEAD 9ec41172) inside the worker's sandbox, which has
a read-only `~/.pi`, no nested bubblewrap and no user bus. They may pass from your session:

```sh
cd pi-config/extensions/subagents && node tests/smoke.mjs && node tests/team-smoke.mjs
cd pi-config/extensions/sandbox && node --test tests/*.unit.test.ts tests/unit/*.unit.test.ts && node tests/run.mjs
```

The code under test is commit 0abf30b2 on feat/load-priority.
