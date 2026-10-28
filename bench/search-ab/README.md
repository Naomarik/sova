# bench/search-ab

An offline A/B of the Overseer's conversation search (`searchSessions` in
`server/overseer-roundup.ts`) against a ranked BM25F candidate. Tooling only: nothing in Sova
imports this folder. The protocol, metrics and decision rule are in [plan.md](plan.md), written
before the candidate; [results/](results/) holds totals only.

Private data never enters the repo. The frozen session copy lives in the worktree's gitignored
`.cache/search-ab/agent/` (`--copy`, `SEARCH_AB_COPY`); queries, labels, grades, the manifest and
per-query ranks live in the private folder (`--private`, `SEARCH_AB_PRIVATE`, default
`~/.pi/agent/sova/research/search-ab`).

```sh
bun bench/search-ab/freeze.ts      # manifest, offline listing, project list (private folder)
bun bench/search-ab/mine.ts        # query sets and labels, frozen (refuses to overwrite without --force)
bun bench/search-ab/bench.ts       # instrument check, dev runs, sweeps, results/dev-*.md
bun bench/search-ab/bench.ts --tune-false # the false-answer sweep alone (dev, bm25f), held-out constants
bun bench/search-ab/bench.ts --label      # grade the held-out pool (blind, resumable)
bun bench/search-ab/bench.ts --heldout    # held-out scoring, once, after every grade is in
```

`--out <dir>` sends the dev run's private outputs (instrument check, per-query runs, sweeps,
held-out constants) somewhere other than the private folder, e.g. when that folder is read-only.

Copy the sessions before `freeze.ts` with `cp -a --reflink=always` (never a link), after
`node scripts/hermetic-agent-dir.mjs --copied-sessions` when the copy sits in an agent dir a hermetic
server may host. Unit tests (synthetic sessions only): `pnpm test -- bench/search-ab/search-ab.test.ts`.
