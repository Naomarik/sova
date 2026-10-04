Runs: 15 in docs/perf/data/2026-10-03-experiment. Medians across reps of each run's p50/p95; ms unless noted.

| variant | phase | reps | /api/sessions p50 | p95 | max | reload p50 | p95 | tail p50 | p95 | full p50 | p95 | ELD mean p50 | ELD max p95 | ELD max | load1 | cpu PSI some % | main thread % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ext | idle | 3 | 216 | 360 | 666 | 391 | 459 | 8.2 | 94.4 | 276 | 302 | 14.5 | 140 | 156 | 46.9 | 0.4 | 56.6 |
| ext | load | 3 | 3854 | 6503 | 7670 | 4151 | 5874 | 116 | 494 | 1784 | 3050 | 72.4 | 414 | 827 | 84.5 | 81.1 | 17.6 |
| nice0 | idle | 3 | 231 | 369 | 551 | 326 | 391 | 7.5 | 33.1 | 274 | 327 | 13.9 | 141 | 154 | 42.9 | 0.5 | 57.9 |
| nice0 | load | 3 | 3254 | 6592 | 7576 | 4411 | 5629 | 105 | 982 | 1823 | 2699 | 64.4 | 417 | 902 | 82.3 | 82.7 | 19.2 |
| nice10 | idle | 3 | 261 | 467 | 1219 | 465 | 485 | 12.1 | 114 | 310 | 359 | 15.3 | 143 | 294 | 43.2 | 0.7 | 56.5 |
| nice10 | load | 3 | 1082 | 1823 | 2389 | 1485 | 1841 | 46.5 | 365 | 757 | 1217 | 39.1 | 346 | 526 | 82.6 | 79.3 | 41.8 |
| weight-ext | idle | 3 | 195 | 304 | 468 | 280 | 308 | 6.8 | 24.1 | 219 | 281 | 13.2 | 137 | 157 | 42.2 | 0.7 | 56.4 |
| weight-ext | load | 3 | 669 | 1150 | 1379 | 883 | 1070 | 24.3 | 158 | 602 | 696 | 27.3 | 297 | 335 | 85.3 | 75.0 | 53.6 |
| weight | idle | 3 | 277 | 508 | 535 | 430 | 558 | 7.5 | 80.0 | 304 | 360 | 14.8 | 144 | 155 | 42.3 | 0.3 | 55.8 |
| weight | load | 3 | 3423 | 8165 | 9012 | 5252 | 8278 | 156 | 822 | 1734 | 3255 | 74.9 | 410 | 779 | 99.9 | 83.7 | 17.9 |

Per run (load phase): variant rep → /api/sessions p50/p95, reload p50/p95, ELD max p95, load1
- ext #1: 3854/6503 ms, reload 4428/5878 ms, ELD max p95 398 ms (7 lost reads), load1 86.5, failures 0
- ext #2: 4586/7670 ms, reload 4151/5874 ms, ELD max p95 439 ms (2 lost reads), load1 82.7, failures 0
- ext #3: 1724/3419 ms, reload 3385/4553 ms, ELD max p95 414 ms (4 lost reads), load1 84.5, failures 0
- nice0 #1: 3845/7576 ms, reload 4411/8296 ms, ELD max p95 417 ms (6 lost reads), load1 76.5, failures 0
- nice0 #2: 3254/6592 ms, reload 3971/4522 ms, ELD max p95 637 ms (3 lost reads), load1 84.5, failures 0
- nice0 #3: 2732/5644 ms, reload 4583/5629 ms, ELD max p95 285 ms (4 lost reads), load1 82.3, failures 0
- nice10 #1: 1082/1936 ms, reload 1485/1841 ms, ELD max p95 342 ms (1 lost reads), load1 82.6, failures 0
- nice10 #2: 1160/1823 ms, reload 1671/1964 ms, ELD max p95 407 ms (3 lost reads), load1 120, failures 0
- nice10 #3: 925/1507 ms, reload 959/1435 ms, ELD max p95 346 ms (2 lost reads), load1 82.5, failures 0
- weight-ext #1: 669/1062 ms, reload 909/1070 ms, ELD max p95 276 ms (1 lost reads), load1 87.7, failures 0
- weight-ext #2: 839/1150 ms, reload 672/947 ms, ELD max p95 297 ms (3 lost reads), load1 85.3, failures 0
- weight-ext #3: 643/1265 ms, reload 883/1146 ms, ELD max p95 301 ms (4 lost reads), load1 82.0, failures 0
- weight #1: 3423/8165 ms, reload 5339/8278 ms, ELD max p95 410 ms (3 lost reads), load1 83.7, failures 0
- weight #2: 4204/5456 ms, reload 5252/6443 ms, ELD max p95 321 ms (3 lost reads), load1 99.9, failures 0
- weight #3: 3281/9012 ms, reload 4539/8876 ms, ELD max p95 523 ms (2 lost reads), load1 101, failures 0
