# Load experiment runbook (al_3, feat/load-priority; extended for al_1, feat/server-responsive)

Documented in docs/perf/2026-10-03-load-and-freezes.md and docs/perf/2026-11-16-server-freezes.md;
this file is how to re-run them. The 2026-11-16 batch (Bun, chats outside the server, freezes) is
first; the 2026-10-03 batch (Node, the load as the server's child) follows unchanged.

## 2026-11-16: freezes on Bun with chats outside the server

What it adds to the 2026-10-03 harness:

- `--runtime bun`: the server as the user runs it (`bun server/index.ts`, dev:hermetic's switches),
  in `--server-root <tree>` (default this tree). A BEFORE number for a branch: measure a `git
  archive` of its base, with node_modules linked in, while the branch's edits are in progress.
- `--variants chats`: the load starts outside the server (chats moved to `sova-chats.slice` in
  2026-10, so their tool commands are no longer the server's children): `--standins N` stand-ins
  (each its own `--mix`, e.g. `test=1,tsc=1`: a full unit-tier run, `node scripts/run-tests.mjs
  --fresh`, on Bun at half the cores, plus a `tsc --noEmit`), and one disk stand-in (`--disk N`
  workers: 256 MB written with fsyncs, read back, deleted, then a stat walk of node_modules/.pnpm),
  all at nice `--load-nice` (10, as a hosted chat's tool commands run) through `nice -n`.
- `--chats N`: N copied sessions get an entry appended every ~2 s (as N active chats write), each
  followed by a `/ws/watch?tail=1` socket, plus one `/ws/watch?feed=sessions` socket; the appended
  bytes are cut off when the run ends. `follow` = append to that socket's next message.
- Probes besides 2026-10-03's: `/api/health` every 250 ms (p50/p99; an answer >= 2 s or a failure is
  a freeze seen from outside), `/api/folder-approvals?cwd=<--approvals-cwd>` every 5 s (the
  approvals folder scan; default `~/webapps/sova`, read only).
- Freezes: the server's own stall recorder (`server/stall-recorder.ts`, Bun) writes every main-thread
  stall >= 2 s with its sampled stacks to `<agent dir>/sova/stalls/stalls.jsonl`; the harness takes
  this server's records, places each in the phase it began in, and the summary counts them and
  lists their stacks' first Sova frame.
- `GET /api/sessions` is a fresh build of every row (`listSessionsAfresh`), so its idle p50 is the
  session-list build time.

- Accounting: a request or a stall counts in every phase it was in flight in (the run's phase
  starts are in each `.meta.json`), and a request still unanswered when the run stops waiting is
  a failed sample. A freeze that starts in the ramp and outlasts the load phase is that phase's
  worst sample, not a phase with no samples.
- Every server it starts gets `SOVA_AGENT_CPU=off`: a tree with `server/agent-cpu.ts` would
  otherwise set CPUWeight (and a ceiling) on the machine's real `sova.slice` at start. The
  experiment never measures a5/a6 (the agents' CPU weight and ceiling): that needs the load under a
  parent slice of the harness's own (e.g. `sova-perf-agents.slice` with its own CPUWeight), never
  `sova.slice`, and a user bus.

Sandboxed workers: the bash tool runs at nice 10, so the harness logs its WARNING and the server
runs at nice 10 with the load at 19 (`nice -n` is relative); `<repo>/.agent` may be mounted read-only,
hence `--agent-dir .cache/perf-agent`. Without `systemd-run --user` everything shares one cgroup.
A run started as a background job sits in another pid namespace: `pgrep` from the chat doesn't
see its processes. Check with `ss -ltn | grep 4867` and the console log instead.

```sh
# Prepare a private agent dir with every real session copied in (rsync, ~10 s when warm).
node scripts/perf/load-experiment.mjs --prepare --agent-dir "$PWD/.cache/perf-agent"

# BEFORE: the base commit, archived (the branch's edits stay out of it).
mkdir -p .cache/baseline && git archive <base> | tar -x -C .cache/baseline \
  && ln -sfn "$PWD/node_modules" .cache/baseline/node_modules && git rev-parse <base> > .cache/baseline/.baseline-head
node scripts/perf/load-experiment.mjs --agent-dir "$PWD/.cache/perf-agent" --runtime bun \
  --server-root .cache/baseline --variants chats --reps 2 --standins 3 --mix test=1,tsc=1 --disk 1 \
  --chats 6 --out docs/perf/data/<date>-before > docs/perf/data/<date>-before.console.log 2>&1

# AFTER: the same on this tree (drop --server-root).
node scripts/perf/load-experiment.mjs --agent-dir "$PWD/.cache/perf-agent" --runtime bun \
  --variants chats --reps 2 --standins 3 --mix test=1,tsc=1 --disk 1 --chats 6 \
  --out docs/perf/data/<date>-after > docs/perf/data/<date>-after.console.log 2>&1

# Then clean up and check, as below (step 5).
node scripts/perf/load-experiment.mjs --cleanup
pgrep -af 'load-standin|disk-worker|run-tests.mjs|server/index.ts'   # must print nothing of ours
```

One run is about 3 min (start and warm-up ~45 s on 4,700 sessions, idle 30 s, ramp 20 s, load
60 s, stop, cool 20 s). The summary's second table, "Freezes and health", has the new numbers.

## 2026-10-03: the load as the server's child (Node)

For the orchestrator, who runs it from a session that can reach the user bus. The load-priority
worker (sandboxed) built the harness and dry-ran it at tiny load without systemd; it cannot run
`systemd-run --user`, so the scope variants have never run. Read step 2 before the long runs.

Timing with the verifier: the verifier measures latency in the transcript-slim worktree, and this
load would skew it. Message `verifier` before each batch (steps 2, 3, 4), wait for its go-ahead,
and tell it when the batch ends.

Harness: `scripts/perf/load-experiment.mjs` (orchestrator) and `scripts/perf/load-standin.mjs` (the
load: full `node --test` suites, `tsc --noEmit`, `vite build` into the repo's gitignored
`.cache/sova-perf/`, each restarted as it exits; never `~/.cache`, which inside the sandbox is a
private copy nobody else sees). Builtins only, no network, nothing written to `~/.pi`.

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

# 5. Clean up (also safe to run any time; it also removes <repo>/.cache/sova-perf), then verify
#    nothing is left.
node scripts/perf/load-experiment.mjs --cleanup
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
