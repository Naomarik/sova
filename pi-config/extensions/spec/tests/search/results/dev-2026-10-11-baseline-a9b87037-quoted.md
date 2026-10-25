# Topic search bench: baseline-a9b87037-quoted on dev

- date: 2026-10-11T08:03:04.042Z
- set: dev (`pi-config/extensions/spec/tests/search/judgments.dev.json`, targets judged at spec a9b87037)
- cli: `(outside the repo)/sova-spec.mjs` · repo HEAD a9b87037 · query passed as one quoted argument
- command: `node pi-config/extensions/spec/tests/search/bench.mjs --set dev --quoted`

| group | n | R@1 | R@3 | MRR | R@3 any | results (mean) | bytes mean / median / max | exit codes |
|---|---|---|---|---|---|---|---|---|
| all | 52 | 0.0% | 0.0% | 0.000 | 0.0% | 0 | 382 / 383 / 399 | 1×52 |
| vocabulary gap | 7 | 0.0% | 0.0% | 0.000 | 0.0% | 0 | 383 / 382 / 386 | 1×7 |
| word overlap | 45 | 0.0% | 0.0% | 0.000 | 0.0% | 0 | 382 / 383 / 399 | 1×45 |

## Queries

rank = rank of the first primary target (— absent); top = the first three ids listed.

| id | query | gap | exit | rank | rank any | results | bytes | top |
|---|---|---|---|---|---|---|---|---|
| a02 | git info in session detail |  | 1 | — | — | 0 | 382 |  |
| a04 | welcome message skills loaded | yes | 1 | — | — | 0 | 385 |  |
| a05 | new session card commit messages |  | 1 | — | — | 0 | 388 |  |
| a08 | collapse left menu thin rail |  | 1 | — | — | 0 | 384 |  |
| a09 | drag session to archive |  | 1 | — | — | 0 | 379 |  |
| a10 | favorites in model selector |  | 1 | — | — | 0 | 383 |  |
| a12 | usage panel redesign |  | 1 | — | — | 0 | 376 |  |
| a13 | topic count usage circle | yes | 1 | — | — | 0 | 380 |  |
| a15 | wake up nudge |  | 1 | — | — | 0 | 369 |  |
| a20 | team member cap |  | 1 | — | — | 0 | 371 |  |
| a21 | overseer model choice becomes default |  | 1 | — | — | 0 | 393 |  |
| a22 | save button grayed out until change |  | 1 | — | — | 0 | 391 |  |
| a28 | overseer boot sessions with minor modes |  | 1 | — | — | 0 | 395 |  |
| a33 | subagent pane nothing running |  | 1 | — | — | 0 | 385 |  |
| a35 | mesh out of sync resync button | yes | 1 | — | — | 0 | 386 |  |
| a36 | open questions bubble icon |  | 1 | — | — | 0 | 382 |  |
| a38 | page jank switching sessions |  | 1 | — | — | 0 | 384 |  |
| a41 | people send us files |  | 1 | — | — | 0 | 376 |  |
| a42 | playbooks in recent tab | yes | 1 | — | — | 0 | 379 |  |
| a45 | placeholder cut off mobile | yes | 1 | — | — | 0 | 382 |  |
| a48 | card choices per item |  | 1 | — | — | 0 | 377 |  |
| a54 | indent line under chevron | yes | 1 | — | — | 0 | 381 |  |
| a58 | timeline inputs only |  | 1 | — | — | 0 | 376 |  |
| a60 | remember scroll position switching sessions |  | 1 | — | — | 0 | 399 |  |
| a62 | mesh without tailnet LAN IP |  | 1 | — | — | 0 | 383 |  |
| a63 | overseer register a project |  | 1 | — | — | 0 | 383 |  |
| a64 | lift sandbox for subagents |  | 1 | — | — | 0 | 382 |  |
| a65 | rename sessions automatically button |  | 1 | — | — | 0 | 392 |  |
| a67 | session from different host stand out |  | 1 | — | — | 0 | 393 |  |
| a68 | scroll jumps down when settles |  | 1 | — | — | 0 | 386 |  |
| a69 | subscription usage velocity |  | 1 | — | — | 0 | 383 |  |
| a70 | drop to archive text changing |  | 1 | — | — | 0 | 385 |  |
| a72 | voice calibration cutting off |  | 1 | — | — | 0 | 385 |  |
| a78 | adversarial review settings toggle |  | 1 | — | — | 0 | 390 |  |
| a79 | keyboard comes up after send |  | 1 | — | — | 0 | 384 |  |
| a80 | mode menu stays open |  | 1 | — | — | 0 | 376 |  |
| a83 | UniiChat |  | 1 | — | — | 0 | 364 |  |
| a84 | summary tree |  | 1 | — | — | 0 | 368 |  |
| a90 | memory mode summary size |  | 1 | — | — | 0 | 380 |  |
| a92 | duplicate opus models |  | 1 | — | — | 0 | 377 |  |
| a93 | model effort levels wrong |  | 1 | — | — | 0 | 381 |  |
| a96 | merge captain misses merge ready |  | 1 | — | — | 0 | 388 |  |
| c01 | company hours |  | 1 | — | — | 0 | 369 |  |
| c03 | front door failover |  | 1 | — | — | 0 | 375 |  |
| c11 | markdown syntax highlighting replies |  | 1 | — | — | 0 | 392 |  |
| c13 | resource monitor memory scale | yes | 1 | — | — | 0 | 385 |  |
| c14 | group prompt all-or-nothing |  | 1 | — | — | 0 | 383 |  |
| c15 | timeline newest first |  | 1 | — | — | 0 | 377 |  |
| c16 | project page tabs |  | 1 | — | — | 0 | 373 |  |
| c19 | deploy rollback |  | 1 | — | — | 0 | 371 |  |
| c22 | transcript newest rows first |  | 1 | — | — | 0 | 384 |  |
| c26 | installer defaults to master |  | 1 | — | — | 0 | 384 |  |
