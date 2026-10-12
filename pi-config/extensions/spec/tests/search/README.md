# Topic search bench

A yardstick for ranked topic search in `sova-spec where`: does a search typed in a person's own
words list, near the top, the claim a builder on that ask should open first?

## The set

100 queries, 2–6 words but for `UniiChat` (one) and one of seven, fixed before any target was
labelled:

- 81 from real asks: the first user message of sessions in this repo, cut to the search a person
  would type, in their words (paraphrased where an ask named a person, a host or a client).
- 19 from commit subjects on `master` (commit subjects are written after the work, often in the
  spec's words, so they leak more: median 0.5 against 0.333 for asks).
- Always included: the two known failures, `summary tree` and `UniiChat`.

Each query names 1 primary target (the claim to open first) and up to 3 acceptable ones, judged
against the spec at commit `a9b87037`.

**Leak check** (`leak.mjs`): the fraction of a query's distinct stems (`text.mjs`, a small stemmer
of the judge's own, independent of any ranker) found in its primary target's title or `what` as
`toc` reports them. Whole set: median 0.4, mean 0.44; 13 queries share no stem at all with their
target (**vocabulary gap**), and results are split by it. Dev: median 0.333, 7 gap queries.

**Split.** Stratified by source (ask / commit) × leak band (0 / under 0.5 / 0.5 and up). Within a
stratum, queries sort by sha256 of their text (lowercased, whitespace collapsed) and alternate
dev, held-out, dev, …; the two known failures are pinned to dev. Dev: 52 queries in
`judgments.dev.json`. Held-out: 48, kept outside the repo and run once, by the reviewer, at the end.
Tune on dev only.

## Running it

```sh
node pi-config/extensions/spec/tests/search/bench.mjs                 # dev, the worktree's CLI
node pi-config/extensions/spec/tests/search/bench.mjs --cli <sova-spec.mjs> --label <name>
node pi-config/extensions/spec/tests/search/bench.mjs --set <judgments.json>   # aggregates only
node pi-config/extensions/spec/tests/search/leak.mjs                  # leak distribution of dev
```

Each query runs through the CLI as typed: `where summary tree --root <repo> --json`, the words as
separate arguments (`--quoted` passes them as one, for a CLI that refuses several). The ranking is
the ids of the answer's `lines`, in order, first appearance only, from one call (no `--all`, no
cursor). Scored on primary targets: R@1, R@3, MRR; R@3 any also counts acceptable targets. Bytes
of stdout and exit codes are reported beside them.

Each run writes `results/<dev|heldout>-<date>-<label>.md` and `.json`, never overwriting one.
A dev result lists every query; any other set's lists aggregates only.

## Baseline (`where` at `a9b87037`, dev)

| args | R@1 | R@3 | MRR | R@3 any | exit codes |
|---|---|---|---|---|---|
| unquoted words | 0% | 0% | 0.000 | 0% | 2×51 (refused: one path or token), 1×1 |
| one quoted argument | 0% | 0% | 0.000 | 0% | 1×52 (no match) |
