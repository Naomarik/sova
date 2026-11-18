Runs: 3 in docs/perf/data/2026-11-16-after. Medians across reps of each run's p50/p95; ms unless noted.

| variant | phase | reps | /api/sessions p50 | p95 | max | reload p50 | p95 | tail p50 | p95 | full p50 | p95 | ELD mean p50 | ELD max p95 | ELD max | load1 | cpu PSI some % | main thread % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| chats | idle | 3 | 221 | 368 | 942 | 234 | 252 | 5.1 | 116 | 78.1 | 154 | – | – | – | 39.5 | 1.0 | 67.9 |
| chats | load | 3 | 1259 | 4409 | 10383 | 3023 | 4549 | 190 | 1108 | 713 | 2861 | – | – | – | 86.9 | 73.0 | 50.0 |

Freezes and health (2026-11-16 probes): stalls = the server's own stall records (main thread stopped >= 2 s; Bun's recorder), summed over reps; health slow = /api/health answers >= 2 s or failed, summed; latencies the median across reps of each run's percentile, ms.

| variant | phase | reps | stalls >= 2 s | longest stall | health p50 | p99 | max | health slow | sessions build p50 | p95 | approvals scan p50 | p95 | follow p50 | p95 | load1 | main thread % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| chats | idle | 3 | 0 | – | 1.9 | 185 | 646 | 0 | 221 | 368 | 70.8 | 114 | 1.5 | 103 | 39.5 | 67.9 |
| chats | load | 3 | 2 | 8224 | 70.2 | 2037 | 8797 | 5 | 1259 | 4409 | 488 | 1244 | 137 | 1542 | 86.9 | 50.0 |

Where the stalls were (every run, both phases): the sampled stacks' first Sova frame, samples (100 ms each)

- 28 rmdirSync < folderResources server/harness/pi/resources.ts:28
- 18 rmdirSync < (anonymous) _modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/adapter.js:15
- 14 readdirSync < loadSkillsFromDirInternal 5.7.3_ws@8.21.3/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js:135
- 13 mkdirSync < mkdirSync
- 6 readdirSync < homeClaudeSkillDirs server/skill-sources.ts:39
- 3 readdirSync < collectAutoExtensionEntries 8.21.3/node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js:421
- 3 readdirSync < collectSkillEntries 8.21.3/node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js:215
- 3 readdirSync < shippedExtensions server/harness/pi/own-code.ts:138
- 1 (anonymous) shared/row-counts.ts:28
- 1 resolve server/worker-sessions.ts:409
- 1 next node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/composer.js:138 < compose node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/composer.js:134
- 1 filter < loadExtensionPaths 8.21.3/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js:526

Per run (load phase): variant rep → /api/sessions p50/p95, reload p50/p95, ELD max p95, load1
- chats #1: 1259/3835 ms, reload 3023/4549 ms, ELD max p95 – ms (0 lost reads), load1 86.9, failures 0, stalls 1 (longest 2490), health p99 2121 max 3695
- chats #2: 1242/4409 ms, reload 1822/4257 ms, ELD max p95 – ms (0 lost reads), load1 79.8, failures 0, stalls 1 (longest 8224), health p99 2037 max 8797
- chats #3: 1291/5436 ms, reload 3269/6841 ms, ELD max p95 – ms (0 lost reads), load1 100, failures 0, stalls 0 (longest –), health p99 1611 max 2629
