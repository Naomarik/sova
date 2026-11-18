Runs: 2 in docs/perf/data/2026-11-16-before. Medians across reps of each run's p50/p95; ms unless noted.

| variant | phase | reps | /api/sessions p50 | p95 | max | reload p50 | p95 | tail p50 | p95 | full p50 | p95 | ELD mean p50 | ELD max p95 | ELD max | load1 | cpu PSI some % | main thread % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| chats | idle | 2 | 260 | 2306 | 3703 | 787 | 1543 | 16.6 | 848 | 83.2 | 864 | – | – | – | 30.3 | 0.3 | 71.0 |
| chats | load | 2 | 1416 | 12743 | 12743 | 2763 | 10348 | 313 | 8979 | 387 | 8730 | – | – | – | 103 | 66.5 | 2.0 |

Freezes and health (2026-11-16 probes): stalls = the server's own stall records (main thread stopped >= 2 s; Bun's recorder), summed over reps; health slow = /api/health answers >= 2 s or failed, summed; latencies the median across reps of each run's percentile, ms.

| variant | phase | reps | stalls >= 2 s | longest stall | health p50 | p99 | max | health slow | sessions build p50 | p95 | approvals scan p50 | p95 | follow p50 | p95 | load1 | main thread % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| chats | idle | 2 | 1 | 2682 | 2.2 | 1808 | 2663 | 2 | 260 | 2306 | 1695 | 1854 | 11.7 | 1405 | 30.3 | 71.0 |
| chats | load | 2 | 6 | 8755 | 77.3 | 6350 | 6350 | 6 | 1416 | 12743 | 7253 | 10216 | 377 | 8078 | 103 | 2.0 |

Where the stalls were (every run, both phases): the sampled stacks' first Sova frame, samples (100 ms each)

- 576 readdirSync < listSubfolderInstructions server/deeper-context.ts:189
- 322 readdirSync < listSubfolderSkills server/subfolder-skills.ts:178
- 61 statSync < instructionFileIn server/deeper-context.ts:58
- 37 rmdirSync < folderResources server/harness/pi/resources.ts:28
- 25 rmdirSync < (anonymous) _modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/adapter.js:15
- 22 readFileSync < readOr server/spec-drafts-state.ts:459
- 20 readdirSync < loadSkillsFromDirInternal 5.7.3_ws@8.21.3/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js:135
- 15 existsSync < (anonymous) server/subfolder-skills.ts:173
- 12 mkdirSync < mkdirSync
- 8 join < instructionFileIn server/deeper-context.ts:56
- 7 readdirSync < readSessionJobs pi-config/extensions/subagents/job-store.ts:118
- 5 relative < inside server/approvals-lookup.ts:36

Per run (load phase): variant rep → /api/sessions p50/p95, reload p50/p95, ELD max p95, load1
- chats #1: –/– ms, reload –/– ms, ELD max p95 – ms (0 lost reads), load1 117, failures 0, stalls 0 (longest –), health p99 – max –
- chats #2: 1416/12743 ms, reload 2763/10348 ms, ELD max p95 – ms (0 lost reads), load1 103, failures 3, stalls 6 (longest 8755), health p99 6350 max 6350
