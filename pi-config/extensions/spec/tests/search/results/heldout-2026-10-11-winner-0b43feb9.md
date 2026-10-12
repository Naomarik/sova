# Topic search bench: winner-0b43feb9 on heldout

- date: 2026-10-11T08:32:55.255Z
- set: heldout (`(outside the repo)/judgments.heldout.json`, targets judged at spec a9b87037)
- cli: `pi-config/extensions/spec/core/sova-spec.mjs` · repo HEAD 0b43feb9 · query passed as unquoted words
- command: `node pi-config/extensions/spec/tests/search/bench.mjs --set <path>`

| group | n | R@1 | R@3 | MRR | R@3 any | results (mean) | bytes mean / median / max | exit codes |
|---|---|---|---|---|---|---|---|---|
| all | 48 | 41.7% | 64.6% | 0.552 | 77.1% | 9.6 | 2677 / 2757 / 3028 | 0×48 |
| vocabulary gap | 6 | 0.0% | 16.7% | 0.056 | 50.0% | 10 | 2763 / 2797 / 2875 | 0×6 |
| word overlap | 42 | 47.6% | 71.4% | 0.623 | 81.0% | 9.5 | 2665 / 2755 / 3028 | 0×42 |
| leak under 0.5 | 27 | 18.5% | 48.1% | 0.365 | 70.4% | 9.7 | 2727 / 2814 / 3028 | 0×27 |
| leak 0.5 and up | 21 | 71.4% | 85.7% | 0.792 | 85.7% | 9.4 | 2612 / 2720 / 2877 | 0×21 |
