# Review: ranked topic search for `where` (reviewer, 2026-10-11)

Independent checks on branch `feat/spec-search`. Code verified at 0b43feb9 (frozen ranker) and
b90392f2 (HEAD at review time, adds a heading label fix f5bbf841 and the builder's report). The spec
under `.sova/spec` is unchanged on the branch since a9b87037.

## 1. Leak gate (plan-review blocker b1): PASS, median 0.367

Recomputed over all 100 queries (dev 52 + held-out 48) with my own script, not the judge's
`leak.mjs`/`text.mjs`: the foldaidev `terms`/`stem`, against each primary target's heading plus the
full first sentence from the core's `titleOf`/`whatOf`.

| set | n | median | notes |
|---|---|---|---|
| whole | 100 | 0.367 | mean 0.427; 16 share no word with their target, 10 share all; 0 missing targets |
| dev | 52 | 0.333 | |
| held-out | 48 | 0.400 | |

The judge reports 0.4 for the whole set with its own stemmer; the two agree within stemmer noise.
**Is it "well under 0.5"?** Only moderately. 44/100 queries are at 0.5 or above, and commit-subject
queries have median 0.5. I passed it on the condition that results are also split by vocabulary gap
and by leak band. The judge added both splits (ed2c58bc), and the splits matter (see §4).

Provenance: 10/10 spot-checks traced. Commits 9b254389, bb872e28 and 72c07cd6 are in git log. Seven
asks match first user messages in `~/.pi/agent/sessions` on their cited dates. `summary tree` and
`UniiChat` are both in dev. Two notes, accepted by the judge, set unchanged: 2 of those 7 asks are
briefs written by a parent agent (wording closer to the spec's), and `summary tree` is sourced as the
mandated known failure.

## 2. Harness: PASS

`bench.mjs` spawns the real CLI with the words as separate argv. Against a clean a9b87037 core
(from `git archive`) it reproduces the committed baseline exactly:
- unquoted words: 0 on every metric; exit 2×51 (refused: one path or token) and 1×1 (`UniiChat`).
- one quoted argument: exit 1×52.

A non-dev run writes aggregates only, and the held-out file's path shows as "(outside the repo)".

## 3. Experiment log: no findings

LOG.md has about 50 attempts. Each is one generic change from the previous round's best (field
weights, K1, B, stemmer, hyphen/camel splits, pair bonus, floor). The selection rule was written
before the sweeps. No synonym lists or query-specific terms. Nothing under `core/` or `experiments/`
refers to the held-out set. The dense-embedding side trial ran outside the repo and does not ship.

## 4. Held-out: run once at 0b43feb9 (e108767a), judgments published after (a58fb54b)

Clean tree, unquoted words, default CLI. The held-out file was checked before publishing: no home
paths, secrets or personal names (sha256 ce20434e… unchanged by the copy).

| group | dev n | dev R@1 / R@3 / MRR / R@3-any | held-out n | held-out R@1 / R@3 / MRR / R@3-any |
|---|---|---|---|---|
| all | 52 | 42.3 / 59.6 / 0.532 / 71.2 | 48 | 41.7 / 64.6 / 0.552 / 77.1 |
| vocabulary gap | 7 | 14.3 / 42.9 / 0.274 / 57.1 | 6 | 0.0 / 16.7 / 0.056 / 50.0 |
| word overlap | 45 | 46.7 / 62.2 / 0.573 / 73.3 | 42 | 47.6 / 71.4 / 0.623 / 81.0 |
| leak under 0.5 | 28 | 14.3 / 32.1 / 0.272 / 53.6 | 27 | 18.5 / 48.1 / 0.365 / 70.4 |
| leak 0.5 and up | 24 | 75.0 / 91.7 / 0.837 / 91.7 | 21 | 71.4 / 85.7 / 0.792 / 85.7 |

Baseline (a9b87037) is 0 on every row. All 100 queries exit 0, with a mean answer of about 2.7 KB.
The ranking generalizes overall. The vocabulary-gap gain seen on dev did not carry over (1 of 6
held-out gap queries in the top 3). Most of the headline comes from queries that share words with
their target.

## 5. Shipped behaviour

| item | result | evidence |
|---|---|---|
| `where summary tree` | PASS | §chat.memory/tree is rank 1, exit 0 |
| `where UniiChat` | PASS | primary §chat.memory/types is rank 2 (§chat.memory/turn first; both memory claims); exit 0 |
| unquoted = quoted | PASS | identical JSON for `where summary tree` and `where 'summary tree'` |
| single real file uses path mode | PASS | `where.mjs`, `README.md`, `./mise.toml` give mode `path` with no topic rows; all 25 sampled `code` paths identical to a9b87037 |
| several words starting with a file | as specified | `where README.md tree` is a token/topic query |
| **existing exact-name results unchanged** | **FAIL** | see defect D1 |
| JSON additive | PASS | 110 queries: no key lost. Added: `topicTerms`, `topicNotice`, `counts.topic`, line `type: "topic"` with `score` and `matched`; `notShown`/`hint` now appear in more cases |
| topic rows labelled separately | PASS | own heading "TOPIC MATCHES: … (a word match, not a name match or a mapping)", `matched:` line, `topicNotice`; `notice` still speaks for names |
| `node --test --test-concurrency=4 tests/*.test.mjs` | PASS | 553 tests: 551 pass, 2 skipped, 0 fail (at b90392f2) |
| draft matches code | PASS | draft `where-topic`: §tools.spec/where-lookup and §tools/spec modified, §tools.spec/where-topic added. Prose matches the code: joined words, path precedence, fields, hyphen split, floor, ties by id, 3 kept places, exit rules. `draft check` introduces no findings |
| tests/replay | not run | as instructed |

### D1. Topic rows displace exact-name rows and flip complete answers to exit 1

I compared 80 backticked tokens from the spec, 25 `code` paths and 5 edge cases between a9b87037 and
0b43feb9. 84 are identical (name/path rows, counts, exit). All 26 that differ are token queries with
8 or more name matches:

- **10 complete answers became cut answers.** At a9b87037 they showed every match and exited 0; now
  they show 7 name rows and 3 topic rows, report `notShown` 1–3 and exit 1. The 10 tokens: `base.css`,
  `sova_project_overseer`, `no-store`, `not-found`, `device`, `instance`, `system`, `Stop`, `commands`,
  `tabs`.
- **16 already-cut answers** (more than 10 matches) now show 7 name rows instead of 10 (9 for
  `peers.json` and `disabled`, which have one topic row each).

Name order is always kept: the new name rows are a prefix of the old ones.

Reproduction:

```sh
git archive a9b87037 pi-config/extensions/spec/core | tar -x -C "$TMPDIR/bc"
node "$TMPDIR/bc/pi-config/extensions/spec/core/sova-spec.mjs" where base.css --root . --json | jq -c '[.counts,.shown,.exit]'
#   {"claims":9,"defines":3,"mentions":6}, 9, 0
node pi-config/extensions/spec/core/sova-spec.mjs where base.css --root . --json | jq -c '[.counts,.shown,.notShown,.exit]'
#   {"claims":9,"defines":3,"mentions":6,"topic":5}, 10, 4, 1   (7 name rows + 3 topic rows; 2 name rows cut)
```

This is deliberate, not an accident. `TOPIC_KEEP = 3` is written into the §tools.spec/where-topic
draft ("topic rows keep up to three places when name rows would fill all ten") and is tested. But it
contradicts the acceptance criterion "existing exact-name results unchanged", and an agent that
searched an exact name now gets exit 1 and has to page. The user should decide. Possible fixes:

- (a) topic rows fill only the places name rows leave free. Exact-name answers stay row-for-row and
  exit-for-exit as before, apart from the added keys.
- (b) keep places for topic rows only when the query has several words or found no name.

The dev and held-out scores don't depend on this: no query there has 8 or more name matches.

## Minor observations (not defects)

- Text line "as a topic: 32 more claim(s) match its words" says "more" even when there are 0 name rows.
- The `--all` hint for a topic query includes `--token` (`where 'summary tree' --token --all`). It
  works: `--token` doesn't suppress topic rows.
- Sandbox: `mise trust` fails because `~/.local/state` is read-only. Use
  `MISE_TRUSTED_CONFIG_PATHS=<worktree>`. `/tmp` and the handoffs folder are also read-only.

## Recheck after the D1 fix (3165c3c1, approved by the coordinator; HEAD f078bfdd)

- **D1: RESOLVED.** I reran the same 110-query comparison (80 tokens, 25 `code` paths, 5 edge cases) between a9b87037 and a core extracted at 3165c3c1: **110/110 identical** on name and path rows (types and ids), counts and exit. The only JSON changes are added keys (`topicTerms`, `topicNotice`, `counts.topic`, plus `notShown`/`hint` when topic rows are left out); no key lost. `where base.css` now shows 9 name rows + 1 topic row, `notShown` 4, exit 0, the same exit as a9b87037. The held-out set was not rerun.
- **Draft matches code: PASS.** The §tools.spec/where-topic sentence now says the name rows shown are the same ten as without topic search, and topic rows fill only the places name rows leave free. `where.mjs` drops `TOPIC_KEEP` (`names = min(name rows, 10)`). `draft check where-topic` introduces no findings. Evidence on all three ids is valid at 3165c3c1.
- **Tests: PASS.** 553 tests: 551 pass, 2 skipped, 0 fail.
- Unchanged: `where summary tree` gives §chat.memory/tree first, exit 0. `where UniiChat` gives §chat.memory/turn, then §chat.memory/types, exit 0. The dev bench is unchanged (R@1 42.3%, R@3 59.6%, MRR 0.532, R@3-any 71.2%, exit 0×52).

**Verdict: ready to land at f078bfdd** (code at 3165c3c1). Every verification item passes.

## Landing check at 1ecd9cf9 (after f432b58c, the master merge 72bf9f1c and the promotion)

1. Spec tests: PASS. 554 tests: 552 pass, 2 skipped, 0 fail.
2. Name lookups: PASS. The same 110 queries, comparing the a9b87037 core with the 1ecd9cf9 core, are 110/110 identical on name and path rows, counts and exit. This holds on the a9b87037 spec and tree (from `git archive`) and on the merged 1ecd9cf9 spec. No key lost.
3. Promotion: PASS. manifest.json has §tools.spec/where-topic (behavior, accepted/verified, requires §tools.spec/where-lookup, 6 code files); §tools.spec/where-lookup and §tools/spec are accepted/verified. claims/tools/spec.md carries the new section and the edited sentences. `draft status where-topic` shows all 3 ids `already-current`. `check` shows 144 warnings, no errors: 143 `requires-uninvestigated` and 1 `code-missing` (src/components/ProfilePlaybookCard.tsx for §chat.profiles/picker) that came from master (also absent on master), not from this branch.
4. `git status`: PASS, clean.

f432b58c (-tion/-sion words stay whole) leaves the dev bench unchanged when run on the a9b87037 spec: R@1 42.3%, R@3 59.6%, MRR 0.532, R@3-any 71.2%, vocabulary gap R@3 42.9% / MRR 0.274. Per-query primary ranks are identical. The only change is the order of two non-target rows in one query's top three, and mean bytes go 2653 → 2652. The held-out numbers above are for 0b43feb9. The shipped ranker differs from it by this stemmer change and by the D1 fix, and neither was measured on held-out (by design: that set ran once and is now public).
