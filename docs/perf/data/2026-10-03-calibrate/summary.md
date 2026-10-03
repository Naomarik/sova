Runs: 1 in docs/perf/data/2026-10-03-calibrate. Medians across reps of each run's p50/p95; ms unless noted.

| variant | phase | reps | /api/sessions p50 | p95 | max | reload p50 | p95 | tail p50 | p95 | full p50 | p95 | ELD mean p50 | ELD max p95 | ELD max | load1 | cpu PSI some % | main thread % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| nice0 | idle | 1 | 186 | 435 | 498 | 376 | 389 | 7.7 | 109 | 261 | 380 | 13.5 | 132 | 142 | 4.8 | 0.0 | 56.9 |
| nice0 | load | 1 | 3590 | 5046 | 5046 | 3756 | 5906 | 119 | 1062 | 2068 | 3076 | 61.2 | 276 | 889 | 76.5 | 83.5 | 18.4 |

Per run (load phase): variant rep → /api/sessions p50/p95, reload p50/p95, ELD max p95, load1
- nice0 #1: 3590/5046 ms, reload 3756/5906 ms, ELD max p95 276 ms (6 lost reads), load1 76.5, failures 0
