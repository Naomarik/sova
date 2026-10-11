# Topic search for `where`: builder's report

**Status: ready to land.** The ranker is wired into `where`, the spec change is drafted and agreed, the
tests pass, and everything is committed on `feat/spec-search`. The draft is not promoted and master is
not merged, as the coordinator asked. The user decides the merge.

## Winner (frozen at 0b43feb9; the `TOPIC` defaults in `core/topic.mjs`)

Field-weighted BM25 with K1 1.2 and B 0.75. Field weights: heading 4, first sentence 1, backticked
names 1, prose 2, and the area's heading 1 (for an H2). Words are split at hyphens and run through the
light suffix stemmer. Path-shaped names stay whole and unstemmed. A row scoring under 0.35 × the best
score is dropped, unless its heading holds every query word. There is no lede field and no phrase bonus.

## Numbers (bench `tests/search/bench.mjs`, unquoted words, one call)

| set / group | n | R@1 | R@3 | MRR | R@3 any |
|---|---|---|---|---|---|
| baseline a9b87037, dev (all) | 52 | 0 | 0 | 0.000 | 0 |
| dev, all | 52 | 42.3% | 59.6% | 0.532 | 71.2% |
| dev, vocabulary gap | 7 | 14.3% | 42.9% | 0.274 | 57.1% |
| dev, word overlap | 45 | 46.7% | 62.2% | 0.573 | 73.3% |
| dev, leak under 0.5 | 28 | 14.3% | 32.1% | 0.272 | 53.6% |
| dev, leak 0.5 and up | 24 | 75.0% | 91.7% | 0.837 | 91.7% |
| held-out, all (reviewer, one run at 0b43feb9) | 48 | 41.7% | 64.6% | 0.552 | 77.1% |
| held-out, vocabulary gap | 6 | 0.0% | 16.7% | 0.056 | 50.0% |
| held-out, leak under 0.5 | 27 | — | 48.1% | 0.365 | — |
| held-out, leak 0.5 and up | 21 | — | 85.7% | 0.792 | — |

On the baseline, unquoted words were refused (exit 2) and one quoted argument found nothing (exit 1).
Every dev and held-out query now exits 0. The mean answer is 2,653 B on dev.

The overall ranking generalizes from dev to held-out. The dev gain on vocabulary-gap queries (from the
hyphen split) did not carry over: held-out gap R@3 is 16.7%, but n = 6. The held-out judgments are now
public (a58fb54b), so any later change to the ranker is post-hoc.

## What each experiment changed (dev; every row is in LOG.md)

- **Port of the foldaidev weights, no lede:** MRR 0.451. **Adding the area lede:** 0.463.
- **Prose weight is the big lever** here, unlike foldaidev:
  - body 0 → MRR 0.374;
  - body 2 → 0.480;
  - body 3 and 4 lose.
- **Heading weight 4 stays:** 1, 2, 6 and 8 all lose. First-sentence, names and lede weights only move
  MRR within noise.
- **Hyphen split:** 0.507, the largest single tokenizer gain. Plural-only stemming, no stemming and
  camelCase parts are all within noise, so the light stemmer stays.
- **Area heading as a field:** 0.526. **Dropping the lede after that:** 0.532, the best MRR and R@1 in
  the log.
- **Adjacent-pair bonus:** 0.534. Not taken: it adds a constant and code for +0.002.
- **B 0.5:** R@3 rises to 65.4% but MRR falls to 0.528. **K1 0.9 or 2:** both lose. **Heading-holds-all
  ×1.5 or ×2:** no change.
- **Floor:**
  - 0.1, 0.2 and 0.35 keep every primary target found;
  - 0.5 loses one;
  - 0.35 was chosen because it lists fewer rows (about 100 B less per answer).

## Side trial: local embeddings (outside the repo; it cannot ship)

The trial reused foldaidev's installed transformers and its downloaded models, read-only and with no
network. The script is kept for the record as `embed-trial.mjs`.

- **Dense alone** reaches MRR 0.36–0.41 with MiniLM and bge-small. On vocabulary-gap queries it gets
  0–14% R@3.
- **RRF hybrids** reach MRR 0.489–0.519 and R@3-any up to 80.8% (MiniLM, w 0.5).

The lexical ranker wins MRR.

## How names and topics share the top 10

Name rows come first, then topic rows. The name rows shown are the same ten as before topic search;
topic rows fill only the places they leave free. (The first version saved 3 places for topic rows;
the review found that changed existing name answers, D1, and 3165c3c1 removed it. The dev numbers are
unchanged, since no dev or held-out query has 8 or more name matches.) A claim found by name is not repeated as a topic row. Topic rows left out are counted
in `notShown` and the `--all` hint, but they don't make the answer exit 1. Exit 0 means either kind
found a claim. Exit 1 means neither did, or a name row was cut, or the argument looked like a path to a
file that doesn't exist.

## Spec (draft `where-topic`, unpromoted)

- New: **§tools.spec/where-topic**, agreed by the user ("al_1 go-ahead") and labelled accepted/verified.
- Also updates **§tools.spec/where-lookup**:
  - several unquoted words are one token;
  - the token search continues into topic ranking;
  - neither kind finding a claim is exit 1;
  - the cut-list exit 1 rule excludes ranked topic rows.
- Also updates **§tools/spec**: `where` also ranks claims by the words of a topic.
- Evidence: `--commit 3165c3c1` on all three, valid. `check` reports only the 143 pre-existing
  `requires-uninvestigated`.
- Promote preview is clean: plan `94ae9039df04dee065b8df0c6022354848e7919b6f652cfce5a45644aad64baa`
  (`promote where-topic --id '§tools.spec/where-topic' --id '§tools.spec/where-lookup' --id '§tools/spec'`).
- **Master has moved** since the branch point a9b87037 (project-folder-sessions merges, with spec
  promotions). PROMOTE.md asks for `git merge master` before promoting; that is left for landing.
- The census read-first § were read. contents-view, context-packets, spec-map and frame need no change.
  The `packet*.test.mjs` edits only add `topic.mjs` to their shipped-core copy lists, so they are
  test-only, which is exempt.

## Tests

`cd pi-config/extensions/spec && node --test --test-concurrency=4 tests/*.test.mjs` → **551 pass, 0 fail**.
The replay suite was not run (it is the landing gate).

`where.test.mjs` now covers:
- the multi-word refusal is gone, and quoted and unquoted give the same rows;
- a topic-only hit exits 0 and no hit exits 1;
- topic rows have their own kind, heading, `topicNotice` and counts;
- no claim is repeated across name and topic rows;
- path mode is kept, and only a single argument is read as a file;
- ten name rows keep all ten places (exit 0), topic rows fill only free places, a cut name row exits 1
  and a cut topic row does not.

The census ranking path (`graph.mjs`'s weight) is untouched, and `census-rank.test.mjs` passes.

## Commits (feat/spec-search)

- 62e2aa94: checkpoint, topic rows wired in.
- 0b43feb9: frozen ranker, docs, LOG, side trial.
- f5bbf841: the topic heading names the area-heading field (no ranking change; dev numbers reproduce).
- 3165c3c1: review D1, name rows keep their top ten (dev numbers unchanged).

## Environment note

`mise trust` fails in this sandbox because `~/.local/state` is read-only. Node ran from its absolute
install path instead.
