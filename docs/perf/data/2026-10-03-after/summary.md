Runs: 6 in docs/perf/data/2026-10-03-after. Medians across reps of each run's p50/p95; ms unless noted.

| variant | phase | reps | /api/sessions p50 | p95 | max | reload p50 | p95 | tail p50 | p95 | full p50 | p95 | ELD mean p50 | ELD max p95 | ELD max | load1 | cpu PSI some % | main thread % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fixed | idle | 3 | 239 | 372 | 607 | 366 | 435 | 12.1 | 89.4 | 296 | 346 | 15.1 | 144 | 152 | 38.9 | 0.5 | 55.3 |
| fixed | load | 3 | 860 | 1700 | 5372 | 1334 | 2159 | 35.3 | 344 | 690 | 877 | 38.4 | 337 | 975 | 81.2 | 78.2 | 43.8 |
| nice0 | idle | 3 | 202 | 360 | 452 | 308 | 348 | 7.8 | 132 | 259 | 304 | 13.7 | 136 | 151 | 39.7 | 0.4 | 56.9 |
| nice0 | load | 3 | 2877 | 5720 | 6394 | 4445 | 5568 | 195 | 915 | 1804 | 2855 | 63.7 | 564 | 926 | 84.0 | 81.1 | 19.6 |

Per run (load phase): variant rep → /api/sessions p50/p95, reload p50/p95, ELD max p95, load1
- fixed #1: 4171/5372 ms, reload 5264/5664 ms, ELD max p95 520 ms (6 lost reads), load1 81.2, failures 0
- fixed #2: 825/1656 ms, reload 1277/1856 ms, ELD max p95 337 ms (2 lost reads), load1 78.1, failures 0
- fixed #3: 860/1700 ms, reload 1334/2159 ms, ELD max p95 309 ms (6 lost reads), load1 84.3, failures 0
- nice0 #1: 2299/5720 ms, reload 4634/6039 ms, ELD max p95 705 ms (1 lost reads), load1 70.2, failures 0
- nice0 #2: 3062/6394 ms, reload 4363/5568 ms, ELD max p95 252 ms (8 lost reads), load1 86.1, failures 0
- nice0 #3: 2877/4898 ms, reload 4445/4747 ms, ELD max p95 564 ms (5 lost reads), load1 84.0, failures 0
