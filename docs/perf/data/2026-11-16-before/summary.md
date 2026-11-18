Runs: 3 in docs/perf/data/2026-11-16-before. Medians across reps of each run's p50/p95; ms unless noted.

| variant | phase | reps | /api/sessions p50 | p95 | max | reload p50 | p95 | tail p50 | p95 | full p50 | p95 | ELD mean p50 | ELD max p95 | ELD max | load1 | cpu PSI some % | main thread % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| chats | idle | 3 | 389 | 4467 | 5688 | 434 | 2529 | 45.2 | 2052 | 354 | 1786 | – | – | – | 61.3 | 14.3 | 74.0 |
| chats | load | 3 | 4713 | 30613 | 44362 | 16938 | 26018 | 158 | 27730 | 3261 | 27392 | – | – | – | 101 | 69.6 | 34.0 |

Freezes and health (2026-11-16 probes): stalls = the server's own stall records (main thread stopped >= 2 s; Bun's recorder), summed over reps; health slow = /api/health answers >= 2 s or failed, summed; latencies the median across reps of each run's percentile, ms.

| variant | phase | reps | stalls >= 2 s | longest stall | health p50 | p99 | max | health slow | sessions build p50 | p95 | approvals scan p50 | p95 | follow p50 | p95 | load1 | main thread % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| chats | idle | 3 | 5 | 3805 | 3.8 | 3636 | 4825 | 5 | 389 | 4467 | 1745 | 3735 | 22.4 | 2893 | 61.3 | 74.0 |
| chats | load | 3 | 12 | 41097 | 108 | 6189 | 42433 | 12 | 4713 | 30613 | 13900 | 27644 | 420 | 28200 | 101 | 34.0 |

Where the stalls were (every run, both phases): the sampled stacks' first Sova frame, samples (100 ms each)

- 658 readdirSync < listSubfolderInstructions server/deeper-context.ts:189
- 526 readdirSync < listSubfolderSkills server/subfolder-skills.ts:178
- 163 statSync < instructionFileIn server/deeper-context.ts:58
- 39 existsSync < (anonymous) server/subfolder-skills.ts:173
- 28 rmdirSync < folderResources server/harness/pi/resources.ts:28
- 21 rmdirSync < (anonymous) _modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/adapter.js:15
- 17 readdirSync < loadSkillsFromDirInternal 5.7.3_ws@8.21.3/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js:135
- 17 join < instructionFileIn server/deeper-context.ts:56
- 13 mkdirSync < mkdirSync
- 9 relative < inside server/approvals-lookup.ts:36
- 6 readdirSync < listFolder server/skill-fingerprint.ts:62
- 6 readdirSync < readSessionJobs pi-config/extensions/subagents/job-store.ts:118

Per run (load phase): variant rep → /api/sessions p50/p95, reload p50/p95, ELD max p95, load1
- chats #1: 17168/30613 ms, reload 16938/26018 ms, ELD max p95 – ms (0 lost reads), load1 101, failures 0, stalls 4 (longest 27619), health p99 3903 max 3903
- chats #2: 4713/44362 ms, reload 40556/41085 ms, ELD max p95 – ms (0 lost reads), load1 134, failures 1, stalls 2 (longest 41097), health p99 42433 max 42433
- chats #3: 2605/9640 ms, reload 2062/10010 ms, ELD max p95 – ms (0 lost reads), load1 93.4, failures 1, stalls 6 (longest 6163), health p99 6189 max 6189
