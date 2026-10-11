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
