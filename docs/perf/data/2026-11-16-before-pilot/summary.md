Runs: 2 in docs/perf/data/2026-11-16-before. Medians across reps of each run's p50/p95; ms unless noted.

| variant | phase | reps | /api/sessions p50 | p95 | max | reload p50 | p95 | tail p50 | p95 | full p50 | p95 | ELD mean p50 | ELD max p95 | ELD max | load1 | cpu PSI some % | main thread % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| chats | idle | 2 | 337 | 2161 | 3022 | 453 | 2226 | 62.1 | 994 | 142 | 899 | – | – | – | 20.6 | 3.6 | 76.1 |
| chats | load | 2 | 927 | 12129 | 12129 | 2574 | 30243 | 102 | 4821 | 2153 | 26007 | – | – | – | 97.8 | 65.0 | 2.0 |

Freezes and health (2026-11-16 probes): stalls = the server's own stall records (main thread stopped >= 2 s; Bun's recorder), summed over reps; health slow = /api/health answers >= 2 s or failed, summed; latencies the median across reps of each run's percentile, ms.

| variant | phase | reps | stalls >= 2 s | longest stall | health p50 | p99 | max | health slow | sessions build p50 | p95 | approvals scan p50 | p95 | follow p50 | p95 | load1 | main thread % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| chats | idle | 2 | 5 | 80379 | 2.3 | 1952 | 3353 | 3 | 337 | 2161 | 1918 | 2092 | 7.6 | 1539 | 20.6 | 76.1 |
| chats | load | 2 | 4 | 29761 | 89.1 | 5807 | 5807 | 5 | 927 | 12129 | 6773 | 26774 | 402 | 26274 | 97.8 | 2.0 |

Where the stalls were (every run, both phases): the sampled stacks' first Sova frame, samples (100 ms each)

- 707 readdirSync < listSubfolderInstructions server/deeper-context.ts:189
- 375 readdirSync < listSubfolderSkills server/subfolder-skills.ts:178
- 79 statSync < instructionFileIn server/deeper-context.ts:58
- 42 rmdirSync < folderResources server/harness/pi/resources.ts:28
- 33 rmdirSync < (anonymous) _modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/adapter.js:15
- 33 readdirSync < loadSkillsFromDirInternal 5.7.3_ws@8.21.3/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js:135
- 31 readFileSync < readOr server/spec-drafts-state.ts:459
- 23 existsSync < (anonymous) server/subfolder-skills.ts:173
- 15 mkdirSync < mkdirSync
- 8 join < instructionFileIn server/deeper-context.ts:56
- 5 readdirSync < shippedExtensions server/harness/pi/own-code.ts:138
- 4 join < (anonymous) server/subfolder-skills.ts:173

Per run (load phase): variant rep → /api/sessions p50/p95, reload p50/p95, ELD max p95, load1
- chats #1: –/– ms, reload –/– ms, ELD max p95 – ms (0 lost reads), load1 101, failures 0, stalls 0 (longest –), health p99 – max –
- chats #2: 927/12129 ms, reload 2574/30243 ms, ELD max p95 – ms (0 lost reads), load1 97.8, failures 1, stalls 4 (longest 29761), health p99 5807 max 5807
