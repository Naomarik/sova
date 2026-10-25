# Topic search tuning log (dev set only)

Every attempt on the dev set, in the order run, failures included. One change at a time from the
row named in the note. Run with `node pi-config/extensions/spec/tests/search/experiments/run.mjs --name <attempt> --cfg '<json>'`
(the bench in `../bench.mjs`, through a scratch copy of the core with the constants overridden; the
row's `commit · core` is the repository HEAD and a hash of the copied `topic.mjs` + `where.mjs`, which may be uncommitted).

Columns: R@1, R@3, MRR and R@3-any over all dev queries; R@3 / MRR for the vocabulary-gap and
word-overlap groups; mean answer bytes. The held-out set is never run here.

| attempt | cfg (over the TOPIC defaults) | R@1 % | R@3 % | MRR | R@3 any % | gap R@3 / MRR | overlap R@3 / MRR | bytes | commit · core | note |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline-a9b87037 | (name lookup only, no topic) | 0.0 | 0.0 | 0.000 | 0.0 | 0.0 / 0.000 | 0.0 / 0.000 | — | a9b87037 | judge's baseline: unquoted words exit 2 ×51; quoted exit 1 ×52, 0 results |
| port-foldaidev | `{"weights":{"lede":0}}` | 30.8 | 53.8 | 0.451 | 63.5 | 0.0 / 0.077 | 62.2 / 0.509 | 2675 | e20cf636 · a2f6493f | foldaidev weights mapped: title 4, what/names/body 1, no lede |
| lede-1 | `{}` | 32.7 | 57.7 | 0.463 | 69.2 | 28.6 / 0.111 | 62.2 / 0.517 | 2689 | e20cf636 · a2f6493f | port-foldaidev + area lede weight 1 (the TOPIC defaults) |
| lede-1-rerun | `{}` | 32.7 | 57.7 | 0.463 | 69.2 | 28.6 / 0.111 | 62.2 / 0.517 | 2689 | 62e2aa94 · a2f6493f | lede-1 re-run after the restart (per-query ranks lost); same core → must match |
| body-0 | `{"weights":{"body":0}}` | 23.1 | 50.0 | 0.374 | 61.5 | 0.0 / 0.000 | 57.8 / 0.432 | 2576 | 62e2aa94 · a2f6493f | from lede-1: body excluded |
| title-1 | `{"weights":{"title":1}}` | 28.8 | 50.0 | 0.417 | 59.6 | 28.6 / 0.196 | 53.3 / 0.451 | 2750 | 62e2aa94 · a2f6493f | from lede-1: title weight 4→1 |
| what-2 | `{"weights":{"what":2}}` | 32.7 | 59.6 | 0.459 | 69.2 | 14.3 / 0.071 | 66.7 / 0.520 | 2679 | 62e2aa94 · a2f6493f | from lede-1: what 1→2 |
| body-0.5 | `{"weights":{"body":0.5}}` | 32.7 | 53.8 | 0.451 | 65.4 | 0.0 / 0.057 | 62.2 / 0.512 | 2642 | 62e2aa94 · a2f6493f | from lede-1: body 1→0.5 |
| names-0 | `{"weights":{"names":0}}` | 28.8 | 51.9 | 0.435 | 65.4 | 14.3 / 0.092 | 57.8 / 0.489 | 2713 | 62e2aa94 · a2f6493f | from lede-1: backticked names excluded |
| title-2 | `{"weights":{"title":2}}` | 34.6 | 51.9 | 0.463 | 65.4 | 28.6 / 0.179 | 55.6 / 0.508 | 2736 | 62e2aa94 · a2f6493f | from lede-1: title 4→2 |
| body-2 | `{"weights":{"body":2}}` | 34.6 | 59.6 | 0.480 | 69.2 | 28.6 / 0.175 | 64.4 / 0.527 | 2755 | 62e2aa94 · a2f6493f | from lede-1: body 1→2 |
| names-2 | `{"weights":{"names":2}}` | 32.7 | 53.8 | 0.450 | 63.5 | 14.3 / 0.107 | 60.0 / 0.504 | 2688 | 62e2aa94 · a2f6493f | from lede-1: names 1→2 |
| title-6 | `{"weights":{"title":6}}` | 26.9 | 51.9 | 0.422 | 63.5 | 0.0 / 0.057 | 60.0 / 0.478 | 2644 | 62e2aa94 · a2f6493f | from lede-1: title 4→6 |
| what-0 | `{"weights":{"what":0}}` | 30.8 | 55.8 | 0.451 | 65.4 | 28.6 / 0.161 | 60.0 / 0.497 | 2709 | 62e2aa94 · a2f6493f | from lede-1: first sentence excluded |
| lede-0.5 | `{"weights":{"lede":0.5}}` | 30.8 | 53.8 | 0.452 | 65.4 | 14.3 / 0.101 | 60.0 / 0.506 | 2684 | 62e2aa94 · a2f6493f | from lede-1: lede 1→0.5 |
| title-8 | `{"weights":{"title":8}}` | 25.0 | 53.8 | 0.409 | 63.5 | 0.0 / 0.041 | 62.2 / 0.467 | 2636 | 62e2aa94 · a2f6493f | from lede-1: title 4→8 |
| b2-body-3 | `{"weights":{"body":3}}` | 30.8 | 53.8 | 0.464 | 69.2 | 28.6 / 0.207 | 57.8 / 0.504 | 2758 | 62e2aa94 · a2f6493f | from body-2: body 2→3 |
| b2-stem-plural | `{"weights":{"body":2},"stem":"plural"}` | 34.6 | 55.8 | 0.473 | 71.2 | 28.6 / 0.139 | 60.0 / 0.525 | 2742 | 62e2aa94 · a2f6493f | from body-2: stemmer plural-only |
| b2-title-5 | `{"weights":{"body":2,"title":5}}` | 32.7 | 55.8 | 0.476 | 67.3 | 28.6 / 0.169 | 60.0 / 0.523 | 2742 | 62e2aa94 · a2f6493f | from body-2: title 4→5 |
| b2-stem-none | `{"weights":{"body":2},"stem":"none"}` | 36.5 | 57.7 | 0.483 | 71.2 | 28.6 / 0.235 | 62.2 / 0.522 | 2729 | 62e2aa94 · a2f6493f | from body-2: no stemming |
| b2-areatitle-1 | `{"weights":{"body":2,"areaTitle":1}}` | 38.5 | 55.8 | 0.495 | 69.2 | 28.6 / 0.190 | 60.0 / 0.542 | 2752 | 62e2aa94 · a2f6493f | from body-2: add area title field, weight 1 |
| b2-body-4 | `{"weights":{"body":4}}` | 28.8 | 51.9 | 0.450 | 65.4 | 28.6 / 0.279 | 55.6 / 0.476 | 2761 | 62e2aa94 · a2f6493f | from body-2: body 2→4 |
| b2-hyphen | `{"weights":{"body":2},"hyphen":true}` | 36.5 | 61.5 | 0.507 | 71.2 | 42.9 / 0.202 | 64.4 / 0.554 | 2762 | 62e2aa94 · a2f6493f | from body-2: hyphenated words split |
| b2-areatitle-2 | `{"weights":{"body":2,"areaTitle":2}}` | 38.5 | 53.8 | 0.490 | 67.3 | 42.9 / 0.202 | 55.6 / 0.535 | 2749 | 62e2aa94 · a2f6493f | from body-2: area title weight 2 |
| b2-lede-2 | `{"weights":{"body":2,"lede":2}}` | 38.5 | 51.9 | 0.495 | 61.5 | 28.6 / 0.271 | 55.6 / 0.529 | 2750 | 62e2aa94 · a2f6493f | from body-2: lede 1→2 |
| b2-what-2 | `{"weights":{"body":2,"what":2}}` | 34.6 | 61.5 | 0.486 | 71.2 | 28.6 / 0.163 | 66.7 / 0.536 | 2741 | 62e2aa94 · a2f6493f | from body-2: what 1→2 |
| b2-title-3 | `{"weights":{"body":2,"title":3}}` | 32.7 | 57.7 | 0.482 | 69.2 | 28.6 / 0.214 | 62.2 / 0.524 | 2758 | 62e2aa94 · a2f6493f | from body-2: title 4→3 |
| b2-camel | `{"weights":{"body":2},"camel":true}` | 36.5 | 57.7 | 0.493 | 71.2 | 28.6 / 0.175 | 62.2 / 0.542 | 2754 | 62e2aa94 · a2f6493f | from body-2: camelCase parts added |
| h-areatitle-1 | `{"weights":{"body":2,"areaTitle":1},"hyphen":true}` | 40.4 | 59.6 | 0.526 | 71.2 | 42.9 / 0.226 | 62.2 / 0.572 | 2761 | 62e2aa94 · a2f6493f | from b2-hyphen: + area title 1 |
| h-b-0.5 | `{"weights":{"body":2},"hyphen":true,"b":0.5}` | 36.5 | 63.5 | 0.514 | 73.1 | 42.9 / 0.298 | 66.7 / 0.548 | 2765 | 62e2aa94 · a2f6493f | from b2-hyphen: B 0.75→0.5 |
| h-phrase-0.5 | `{"weights":{"body":2},"hyphen":true,"phrase":0.5}` | 38.5 | 61.5 | 0.527 | 71.2 | 42.9 / 0.298 | 64.4 / 0.562 | 2766 | 62e2aa94 · a2f6493f | from b2-hyphen: adjacent-pair bonus 0.5 |
| h-b-0.9 | `{"weights":{"body":2},"hyphen":true,"b":0.9}` | 36.5 | 61.5 | 0.502 | 71.2 | 42.9 / 0.202 | 64.4 / 0.548 | 2751 | 62e2aa94 · a2f6493f | from b2-hyphen: B 0.75→0.9 |
| h-camel | `{"weights":{"body":2},"hyphen":true,"camel":true}` | 36.5 | 61.5 | 0.507 | 73.1 | 42.9 / 0.202 | 64.4 / 0.555 | 2764 | 62e2aa94 · a2f6493f | from b2-hyphen: + camelCase parts |
| h-phrase-1 | `{"weights":{"body":2},"hyphen":true,"phrase":1}` | 38.5 | 63.5 | 0.526 | 75.0 | 42.9 / 0.298 | 66.7 / 0.562 | 2753 | 62e2aa94 · a2f6493f | from b2-hyphen: adjacent-pair bonus 1 |
| h-k1-0.9 | `{"weights":{"body":2},"hyphen":true,"k1":0.9}` | 36.5 | 63.5 | 0.512 | 73.1 | 42.9 / 0.202 | 66.7 / 0.560 | 2768 | 62e2aa94 · a2f6493f | from b2-hyphen: K1 1.2→0.9 |
| h-what-2 | `{"weights":{"body":2,"what":2},"hyphen":true}` | 32.7 | 63.5 | 0.486 | 73.1 | 42.9 / 0.190 | 66.7 / 0.532 | 2756 | 62e2aa94 · a2f6493f | from b2-hyphen: what 1→2 |
| h-titleall-1.5 | `{"weights":{"body":2},"hyphen":true,"titleAll":1.5}` | 36.5 | 61.5 | 0.507 | 71.2 | 42.9 / 0.202 | 64.4 / 0.554 | 2762 | 62e2aa94 · a2f6493f | from b2-hyphen: heading holding every query word ×1.5 |
| h-k1-2 | `{"weights":{"body":2},"hyphen":true,"k1":2}` | 36.5 | 59.6 | 0.499 | 71.2 | 42.9 / 0.274 | 62.2 / 0.534 | 2746 | 62e2aa94 · a2f6493f | from b2-hyphen: K1 1.2→2 |
| h-stem-none | `{"weights":{"body":2},"hyphen":true,"stem":"none"}` | 38.5 | 61.5 | 0.507 | 73.1 | 42.9 / 0.259 | 64.4 / 0.546 | 2739 | 62e2aa94 · a2f6493f | from b2-hyphen: no stemming |
| h-titleall-2 | `{"weights":{"body":2},"hyphen":true,"titleAll":2}` | 36.5 | 61.5 | 0.507 | 71.2 | 42.9 / 0.202 | 64.4 / 0.554 | 2743 | 62e2aa94 · a2f6493f | from b2-hyphen: heading-all ×2 |
| a-lede-0 | `{"weights":{"body":2,"areaTitle":1,"lede":0},"hyphen":true}` | 42.3 | 59.6 | 0.532 | 71.2 | 42.9 / 0.274 | 62.2 / 0.573 | 2739 | 62e2aa94 · a2f6493f | from h-areatitle-1: lede dropped (area title instead?) |
| a-b-0.5 | `{"weights":{"body":2,"areaTitle":1},"hyphen":true,"b":0.5}` | 38.5 | 65.4 | 0.528 | 76.9 | 42.9 / 0.321 | 68.9 / 0.560 | 2765 | 62e2aa94 · a2f6493f | from h-areatitle-1: B 0.5 |
| a-phrase-0.5 | `{"weights":{"body":2,"areaTitle":1},"hyphen":true,"phrase":0.5}` | 34.6 | 59.6 | 0.504 | 73.1 | 42.9 / 0.226 | 62.2 / 0.547 | 2764 | 62e2aa94 · a2f6493f | from h-areatitle-1: + pair bonus 0.5 |
| a-areatitle-2 | `{"weights":{"body":2,"areaTitle":2},"hyphen":true}` | 38.5 | 59.6 | 0.512 | 73.1 | 42.9 / 0.226 | 62.2 / 0.556 | 2762 | 62e2aa94 · a2f6493f | from h-areatitle-1: area title 1→2 |
| a-k1-0.9 | `{"weights":{"body":2,"areaTitle":1},"hyphen":true,"k1":0.9}` | 38.5 | 61.5 | 0.518 | 71.2 | 42.9 / 0.226 | 64.4 / 0.563 | 2764 | 62e2aa94 · a2f6493f | from h-areatitle-1: K1 0.9 |
| a-phrase-1 | `{"weights":{"body":2,"areaTitle":1},"hyphen":true,"phrase":1}` | 40.4 | 61.5 | 0.534 | 75.0 | 42.9 / 0.298 | 64.4 / 0.570 | 2748 | 62e2aa94 · a2f6493f | from h-areatitle-1: + pair bonus 1 |
| l0-b-0.5 | `{"weights":{"body":2,"areaTitle":1,"lede":0},"hyphen":true,"b":0.5}` | 40.4 | 61.5 | 0.527 | 75.0 | 42.9 / 0.274 | 64.4 / 0.566 | 2745 | 62e2aa94 · a2f6493f | from a-lede-0: B 0.5 |
| l0-phrase-1 | `{"weights":{"body":2,"areaTitle":1,"lede":0},"hyphen":true,"phrase":1}` | 40.4 | 61.5 | 0.526 | 75.0 | 42.9 / 0.298 | 64.4 / 0.561 | 2734 | 62e2aa94 · a2f6493f | from a-lede-0: + pair bonus 1 |
| l0-b-0.5-phrase-1 | `{"weights":{"body":2,"areaTitle":1,"lede":0},"hyphen":true,"b":0.5,"phrase":1}` | 38.5 | 61.5 | 0.518 | 75.0 | 42.9 / 0.298 | 64.4 / 0.552 | 2739 | 62e2aa94 · a2f6493f | from a-lede-0: B 0.5 + pair bonus 1 (two changes, combining the two best singles) |
| l0-floor-0.5 | `{"weights":{"body":2,"areaTitle":1,"lede":0},"hyphen":true,"floor":0.5}` | 42.3 | 59.6 | 0.528 | 71.2 | 42.9 / 0.238 | 62.2 / 0.573 | 2375 | 62e2aa94 · a2f6493f | from a-lede-0: floor 0.2→0.5 |
| l0-floor-0.1 | `{"weights":{"body":2,"areaTitle":1,"lede":0},"hyphen":true,"floor":0.1}` | 42.3 | 59.6 | 0.532 | 71.2 | 42.9 / 0.274 | 62.2 / 0.573 | 2757 | 62e2aa94 · a2f6493f | from a-lede-0: floor 0.2→0.1 |
| l0-floor-0.35 | `{"weights":{"body":2,"areaTitle":1,"lede":0},"hyphen":true,"floor":0.35}` | 42.3 | 59.6 | 0.532 | 71.2 | 42.9 / 0.274 | 62.2 / 0.573 | 2653 | 62e2aa94 · a2f6493f | from a-lede-0: floor 0.2→0.35 |
| frozen-defaults | `{}` | 42.3 | 59.6 | 0.532 | 71.2 | 42.9 / 0.274 | 62.2 / 0.573 | 2653 | 62e2aa94 · b4f9a021 | losing switches removed from topic.mjs, winner as TOPIC defaults (= l0-floor-0.35); must reproduce it |

## Selection

Rule, fixed before the sweeps: MRR first; within one query of each other (about 0.02 MRR), the higher R@3,
then the fewer constants and the less code. Each round started from the round's best single change.

1. Port (foldaidev weights mapped onto spec fields): MRR 0.451. Adding the area lede: 0.463.
2. Field weights: prose is not noise here — body 0 drops MRR to 0.374, body 2 lifts it to 0.480. Title 4
   stays (1, 2, 6, 8 all lose); what, names and lede weights move it within noise.
3. From body 2: splitting hyphenated words wins (0.507, gap R@3 28.6 → 42.9 %); no stemming, plural-only
   stemming and camelCase parts are within noise, so the light stemmer stays.
4. From hyphen split: the area heading as a field 0.526, the adjacent-pair bonus 0.527, B 0.5 0.514
   (R@3 63.5); the heading-holds-all factor changes nothing.
5. From area heading 1: dropping the lede 0.532 (best MRR and R@1 of the log), the pair bonus 0.534 (one
   more constant and code for +0.002: not taken), B 0.5 0.528 with R@3 65.4.
6. From lede dropped: B 0.5 and the pair bonus each and together within noise or worse. Floor: 0.1 and
   0.35 keep every primary found at 0.2; 0.5 loses one; 0.35 shows fewer rows (−100 B mean).

**Frozen winner** (`core/topic.mjs` TOPIC; reproduced as `frozen-defaults` after the losing switches
were removed): K1 1.2, B 0.75, weights heading 4 · first sentence 1 · backticked names 1 · prose 2 ·
area heading 1 (no lede), words split at hyphens, the light stemmer, floor 0.35 (a heading holding every
query word survives it). Dev: R@1 42.3 %, R@3 59.6 %, MRR 0.532, R@3-any 71.2 % (baseline 0 on all).

## Side trial: local embeddings (for the record only; cannot ship)

Run from a scratch dir outside the repo with foldaidev's installed `@huggingface/transformers` and
already-downloaded q8 ONNX models, read-only, remote models disallowed. Units: every claim and area;
head = heading + first sentence; chunks = head plus 1,000-character prose windows (max cosine). The
query is the dev query as typed (bge-small with its retrieval prefix). Scored as the bench scores
(first 10 ids). Hybrid = reciprocal-rank fusion of the lexical topic rows with the dense top 100.

| candidate | R@1 % | R@3 % | MRR | R@3 any % | gap R@3 / MRR |
|---|---|---|---|---|---|
| lexical (shipped TOPIC, topic rows only) | 42.3 | 59.6 | 0.532 | 71.2 | 42.9 / 0.274 |
| dense minilm head (title + first sentence) | 28.8 | 48.1 | 0.391 | 57.7 | 0.0 / 0.000 |
| dense minilm chunks (max over head and 1000-char prose windows) | 28.8 | 44.2 | 0.407 | 53.8 | 0.0 / 0.038 |
| hybrid RRF lexical + minilm chunks, w=1, k=60 | 32.7 | 61.5 | 0.497 | 76.9 | 28.6 / 0.179 |
| hybrid RRF lexical + minilm chunks, w=0.5, k=60 | 30.8 | 65.4 | 0.489 | 80.8 | 42.9 / 0.211 |
| dense bge-small head (title + first sentence) | 28.8 | 42.3 | 0.361 | 50.0 | 0.0 / 0.000 |
| dense bge-small chunks (max over head and 1000-char prose windows) | 26.9 | 42.3 | 0.385 | 55.8 | 14.3 / 0.161 |
| hybrid RRF lexical + bge-small chunks, w=1, k=60 | 38.5 | 57.7 | 0.511 | 75.0 | 42.9 / 0.267 |
| hybrid RRF lexical + bge-small chunks, w=0.5, k=60 | 38.5 | 59.6 | 0.519 | 75.0 | 42.9 / 0.219 |

Reading: dense alone loses to the lexical ranker everywhere (MRR 0.36–0.41 vs 0.532), including on the
vocabulary-gap queries it was expected to help (gap R@3 0–14 %). Fusion lifts R@3-any (up to 80.8 %) and
R@3 (65.4 % at w 0.5 with MiniLM) but lowers MRR and R@1 — the same shape foldaidev measured. Not a reason
to add a 700 MB dependency to Sova, which the user ruled out anyway.
| stem-tion-kept | `{}` | 42.3 | 59.6 | 0.532 | 71.2 | 42.9 / 0.274 | 62.2 / 0.573 | 2652 | 31275f8e · 56bf32a3 | F1 (diff review): -tion/-sion no longer stripped, so -ed/-ing forms of one word land on one term (mentioned=mention). From frozen-defaults / 3165c3c1. |
| stem-fixpoint | `{}` | 42.3 | 59.6 | 0.532 | 71.2 | 42.9 / 0.274 | 62.2 / 0.573 | 2652 | 31275f8e · 9ba5313c | F1 alternative: the old one-pass stripper looped to a fixpoint (-tion still stripped; stops under 3 letters), for comparison with stem-tion-kept |

## After the freeze: the word-ending fix (diff review F1)

The one-pass stripper cut -tion/-sion, so `mention` → `men` while `mentioned` → `mention` (and `caption`
→ `cap`, colliding with `caps`). Two fixes were run on dev through the CLI (rows `stem-tion-kept` and
`stem-fixpoint` above): keeping -tion/-sion whole, and looping the old stripper to a fixpoint. Both tie
the frozen ranker exactly on dev (R@1 42.3 %, R@3 59.6 %, MRR 0.532, R@3-any 71.2 %, every group equal).
**Kept: -tion/-sion stay whole** — it unifies a word's forms (mentioned = mention) without the
fixpoint's collisions (`caption` = `cap`), and adds no loop. For the record only, the published
(no longer held out) set with the fix: R@1 41.7 %, R@3 64.6 %, MRR 0.552, R@3-any 77.1 % (48 queries;
leak under 0.5 MRR 0.366, leak 0.5 and up 0.792), the same as its one held-out run at 0b43feb9. Not used to tune.
