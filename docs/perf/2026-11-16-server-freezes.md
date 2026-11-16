# Server freezes under heavy agent load (2026-11-16)

**Result:** under the heaviest load measured (three chats each running a full unit-tier test run and
`tsc`, a disk-heavy job and six active chats on 4,748 sessions), the server's own stall recorder
counted **12 main-thread stalls of 2 s or more before the fixes, the longest 41 s, and 2 after, the
longest 8.2 s**. At idle it went from 5 stalls (up to 3.8 s) to none. `/api/health` p99 under load
fell from 6.2 s to 2.0 s (max 42 s → 8.8 s). Its median moved from 108 to 70 ms. Both remaining
stalls are in pi's own resource loader (`folderResources`). The al_1 target (no freeze ≥ 2 s,
health p99 ≤ 100 ms) is **not yet met** under load. At idle there are no stalls any more, but health
p99 is 185 ms (from 3.6 s), still above 100 ms.

Measured with `scripts/perf/load-experiment.mjs --runtime bun --variants chats` (docs/perf/RUNBOOK.md),
3 runs each, BEFORE = a `git archive` of `c66ac037` (the branch's base), AFTER = the worktree with
a2 (session-list job lookups), a3 (transcript reading, live records) and a4 (approvals folder scans)
as they stood at 19:11 UTC. Later loader changes are not measured; see **What is left**.
a5/a6 (the agents' CPU weight and ceiling) are not measured here: see **Not measured**.
Raw samples: `docs/perf/data/2026-11-16-before/`, `docs/perf/data/2026-11-16-after/`.

## What changed since 2026-10-03

docs/perf/2026-10-03-load-and-freezes.md concluded **"the server starved, it didn't block itself"**:
in a 60-minute trace no stall of its own making passed ~0.7 s, and the fix was priority (workers at
nice 10). That conclusion no longer holds, for three reasons:

1. **Chats left the server's cgroup.** Since 2026-10 each chat runs as its own unit in
   `sova.slice/sova-chats.slice` (`server/chat-runtime/supervisor.ts`), and its tool commands run at
   nice 10. The test suites that starved the server in October were its own children at nice 0. Now
   they are other cgroups' processes at a lower priority. CPU starvation is still there (PSI "some"
   70% under this load), but it is no longer the whole story.
2. **Seven times the sessions.** The October copy held 663 session files (585 MB). Today's holds
   4,748 (4.2 GB) plus 181 chats' background-job folders. Work done once per row or per folder,
   synchronously, on the main thread grew with it. The live stall log (`~/.pi/agent/sova/stalls/`,
   132 stalls of ≥ 2 s since 2026-11-12, median 3.4 s, longest 31 s) is mostly `readdirSync`
   (54% of leaf samples), and JSON parsing and `statSync` follow.
3. **Blocked, not starved.** The runtime is Bun now (October measured Node), and its stall
   recorder shows where the main thread stood. In the BEFORE runs, during an 80 s stall (seen twice
   in the pilot runs) and the 41 s one, the server's main thread used **0–6% of a core**: it sat in
   synchronous `readdirSync`/`statSync` calls of the approvals folder scan, waiting for a disk the
   disk stand-in kept busy. More CPU or a better priority can't shorten that. Only moving the I/O
   off the main thread, or doing less of it, can. That is what a2–a4 do.

## Method

- **Server:** `bun server/index.ts` on port 4867, `PI_CODING_AGENT_DIR=.cache/perf-agent`, which
  holds a copy of every real session (rsync in, never written back) and of
  `sova/background-jobs`, with dev:hermetic's switches and `SOVA_AGENT_CPU=off`. BEFORE ran from
  `.cache/baseline` (`git archive c66ac037`, node_modules linked in), AFTER from the worktree.
- **Load (variant `chats`):** started by the harness, outside the server, at nice +10 relative to
  it: three stand-ins each running `node scripts/run-tests.mjs --fresh` (the unit tier on Bun at
  half the cores) and `tsc --noEmit`, each restarted as it exits, plus a disk stand-in (256 MB
  written with an fsync every 32 MB, read back, deleted, then a stat walk of
  `node_modules/.pnpm`, in a loop). Six copied sessions get an entry appended every ~2 s, each
  followed by a `/ws/watch?tail=1` socket, plus one `/ws/watch?feed=sessions` socket.
- **Probes:** `/api/health` every 250 ms, `/api/sessions` (a fresh build of every row) every 1 s,
  the 10.9 MB session's tail every 2 s and full transcript every 3 s, a reload (four requests at
  once) every 10 s, `/api/folder-approvals?cwd=~/webapps/sova` every 5 s, and "follow" (append to the
  socket's next message).
- **Freezes:** the server's own stall recorder (`server/stall-recorder.ts`) logs every main-thread
  stall ≥ 2 s with 100 ms stack samples. A request or stall counts in every phase it was in flight
  in.
- **Phases:** idle 30 s, a 20 s ramp, load 60 s, then 20 s of cool-down; three runs each.

The machine was shared: other chats of this team ran tests at the same time. load1 was 61 at
idle and 101 under load in BEFORE, 40 and 87 in AFTER, on 32 cores. The difference favours AFTER a
little. It doesn't explain stalls that went from tens of seconds to none at idle. The harness ran
inside a sandbox at nice 10 (its servers too), without a user bus, so everything shared one cgroup.

## Results

Median across the 3 runs of each run's percentile; stalls and slow answers summed over the runs.
ms unless noted.

| | BEFORE idle | AFTER idle | BEFORE load | AFTER load |
|---|---|---|---|---|
| stalls ≥ 2 s (server's recorder) | 5 | **0** | 12 | **2** |
| longest stall | 3,805 | – | 41,097 | 8,224 |
| `/api/health` p50 | 3.8 | 1.9 | 108 | 70 |
| `/api/health` p99 | 3,636 | 185 | 6,189 | 2,037 |
| `/api/health` max | 4,825 | 646 | 42,433 | 8,797 |
| health answers ≥ 2 s | 5 | 0 | 12 | 5 |
| `/api/sessions` (fresh build) p50 | 389 | 221 | 4,713 | 1,259 |
| `/api/sessions` p95 | 4,467 | 368 | 30,613 | 4,409 |
| reload (4 requests) p50 / p95 | 434 / 2,529 | 234 / 252 | 16,938 / 26,018 | 3,023 / 4,549 |
| transcript tail p50 / p95 | 45 / 2,052 | 5 / 116 | 158 / 27,730 | 190 / 1,108 |
| full transcript p50 / p95 | 354 / 1,786 | 78 / 154 | 3,261 / 27,392 | 713 / 2,861 |
| approvals scan p50 / p95 | 1,745 / 3,735 | 71 / 114 | 13,900 / 27,644 | 488 / 1,244 |
| follow (append → socket) p50 / p95 | 22 / 2,893 | 1.5 / 103 | 420 / 28,200 | 137 / 1,542 |
| server main thread CPU | 74% | 68% | 34% | 50% |

**Where the stalls were** (100 ms stack samples, first Sova frame):

- BEFORE: 658 `readdirSync < listSubfolderInstructions` (server/deeper-context.ts:189), 526
  `readdirSync < listSubfolderSkills` (server/subfolder-skills.ts:178), 163 `statSync <
  instructionFileIn` (deeper-context.ts:58), 39 `existsSync` (subfolder-skills.ts:173): the
  approvals folder scan. Then pi's loader in `folderResources` (server/harness/pi/resources.ts:28:
  proper-lockfile's `mkdirSync`/`rmdirSync`, `loadSkillsFromDirInternal`, ~80), and 6 `readSessionJobs`.
- AFTER: only `folderResources` (pi's `DefaultResourceLoader`): 28+18 `rmdirSync` and 13
  `mkdirSync` of proper-lockfile's lock, 14 `readdirSync < loadSkillsFromDirInternal`, 6
  `readdirSync < homeClaudeSkillDirs` (server/skill-sources.ts:39), a few of pi's package-manager
  directory reads. The 8.2 s stall ran while `computeReadiness`, `buildSessions` and `GET
  /api/sessions` were in flight. Callers of `folderResources`: the approvals scan's kept read,
  `session-setup.ts:298` (`loaderLoadout`, reached from `waitingForSession`) and `design/skills.ts:57`.

No AFTER stall has a transcript frame (`parseJsonl`, `readBranch`), a `readLiveRecords` frame or a
`readSessionJobs` frame.

## What is left

1. **pi's resource loader on the main thread** (both AFTER stalls). It is synchronous pi code: a
   lock directory created and removed under the agent dir on every load, plus skill directory
   walks. In the measured build, a4 ran it at most once per checkout per 10 s, but several
   checkouts' background re-reads could run back to back in one turn. Under disk pressure that
   blocked for seconds. The next step is moving it off the main thread (a worker or child
   process, as `server/usage-helper` and `server/stall-recorder-worker.ts` do).

   **The measured AFTER predates two later loader changes** in the worktree:
   - `server/harness/pi/resources.ts`: `folderResources` gives pi its settings read once, without
     proper-lockfile's lock, so the lock's mkdir/rmdir cycles (43 of the 8.2 s stall's samples) are
     gone. This covers the approvals, session-setup and design-skills callers.
   - `server/folder-walk.ts`: background loader re-reads run one at a time, each in a turn of its
     own, so they can't chain into one block.

   They target exactly these two stalls but are **unmeasured**. The operator stopped further load
   runs because the experiment freezes the live Sova (below). What remains in a load is pi's
   synchronous skill `readdirSync` and YAML parsing, plus `homeClaudeSkillDirs`
   (server/skill-sources.ts:39). The session-setup and design callers aren't kept, so they run
   whenever their own caches miss.
2. **Health p99 ~2 s under load without a recorded stall.** The recorder only logs stalls of 2 s
   or more. The remaining slow answers are shorter pauses plus CPU contention (PSI "some" 70%+).
   a5 (the agents' slice at a lower CPUWeight than the server's) is aimed at the contention, and
   this experiment can't show its effect (below).

## The live server during the experiment

The live Sova (old code, `~/webapps/sova`) logged **36 stalls ≥ 2 s between 18:49 and 19:20 UTC**,
the windows of these runs, against 1 in the hour before. It was hit by the same load (the disk
stand-in and the test runs are machine-wide). Its stacks are **627 samples `readSessionJobs`**
(job-store.ts:118, the session list's per-row job lookup, a2), **183 `readLiveRecords`**
(server/live.ts:114, a3), then `cleanUpAfter` (background-jobs sweep, out of scope) and
`parseJsonl`. So the live server, which rebuilds its list far more often than the probes here, shows
the session-list and live-records chains that the hermetic copy reproduces only weakly (6
samples). That matches the read-only investigation's stall-log evidence, and it is what a2 and a3
remove. It also means a run of this experiment makes the user's Sova freeze while it runs. Run it
when nobody is using Sova.

## Not measured

- **a5/a6 (CPU weight, ceiling).** Measuring them needs the load under a slice whose CPUWeight is
  set, and a user bus. The harness runs sandboxed without one, and the rule is never to create or
  change systemd units on the real machine, `sova.slice` least of all. A run that can should put
  the stand-ins under a parent slice of the harness's own (e.g. `sova-perf-agents.slice`), never
  `sova.slice`. Every server the harness starts gets `SOVA_AGENT_CPU=off`.
- **The background-jobs sweep** (`cleanUpAfter`, ~6% of live samples): out of this round (q2).
- Event-loop delay below 2 s: Bun serves no V8 inspector, so the October ELD histogram is Node-only.

## Re-running

docs/perf/RUNBOOK.md, section 2026-11-16:

```sh
node scripts/perf/load-experiment.mjs --prepare --agent-dir "$PWD/.cache/perf-agent"
node scripts/perf/load-experiment.mjs --agent-dir "$PWD/.cache/perf-agent" --runtime bun \
  [--server-root .cache/baseline] --variants chats --reps 3 --standins 3 --mix test=1,tsc=1 \
  --disk 1 --chats 6 --out docs/perf/data/<name>
node scripts/perf/load-experiment.mjs --summarize docs/perf/data/<name>
node scripts/perf/load-experiment.mjs --cleanup
```

Pilot runs (older accounting: a sample filed by the phase it ended in, so a request stuck through
the whole load phase was lost; pilot 1 also without the background-jobs copy):
`docs/perf/data/2026-11-16-before-pilot*/`. They show the 80 s approvals-scan stall twice.
