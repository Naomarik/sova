# The campaign folder

One folder per campaign, in the worktree's ignored cache: `<worktree>/.cache/ab/<campaign>/`. Nothing in it is ever committed. Every round is recorded the same way, so any campaign's charts read alike. The one thing a campaign keeps is its subject's record, outside this folder: `references/record.md`.

```
campaign.json            what the campaign measures (below)
cases.jsonl              the frozen cases, one per line
rounds/<n>/arms.json     the arms round n runs (round 0: master alone)
rounds/<n>/results/<arm>/<model>/<case>.json   one reply each (runner.mjs)
rounds/<n>/grades/<arm>/<model>/<case>.json    one verdict each (score.mjs)
rounds/<n>/blind/        replies for the grader, unlabelled; blind-key.json beside it, never shown to the grader
rounds/<n>/proposals/    the consultants' proposals
rounds/<n>/shots/<arm>/<model>/<case>.png      screenshots (shoot.mjs)
rounds/<n>/scores.json   the round's totals and each arm's prediction beside what it did; rounds/<n>/chart.md its chart
ledger.jsonl             one row per round: arms, what changed, pass rates, predictions, best arm, note
collage.png, collage.html
```

`<model>` folders are the model ref with its effort: `zai_glm-5.3@low`.

## campaign.json

```json
{
  "subject": "Do cheap models use the spec tool instead of grep?",
  "record": "spec-tool",
  "bars": "Every test model passes at least 90%, none below master",
  "testModels": [{ "model": "zai/glm-5.3", "effort": "low" }, { "model": "claude-code/claude-haiku-5-5", "effort": "low" }],
  "parallel": 2,
  "timeoutSec": 300
}
```

`record` is the name of the subject's record (lowercase letters, digits, dashes), from the run's choice The record.

## cases.jsonl

```json
{"id": "f01", "group": "fail", "prompt": "Where is the password reset email sent from?", "expect": "Uses the spec tool before any grep", "check": {"tool": "spec"}}
{"id": "p01", "group": "pass", "prompt": "...", "expect": "...", "check": {"all": [{"tool": "spec"}, {"maxTools": 6}]}}
{"id": "s01", "group": "sealed", "prompt": "...", "expect": "..."}
```

`group`: `fail` (fails on master today), `pass` (passes today: catches regressions), `sealed` (held back for the confirm run). `expect` is what a good reply does, in words, for the grader. `check` is optional; without one the grader judges. Give a case an id that isn't an ordinary word (`f01`, `arrow-labels`): the record's check refuses a case's id wherever it stands as a word.

### Checks

`{"contains": "text"}` (any case), `{"regex": "pattern", "flags": "i"}`, `{"tool": "name"}` (the reply called that tool), `{"maxTools": 6}`, `{"maxWords": 200}`, and `{"all": [...]}`, `{"any": [...]}`, `{"not": {...}}` to combine them. A run that errored always fails.

## arms.json

```json
{
  "A": { "label": "master", "baseline": true, "how": "sova", "url": "http://127.0.0.1:4813", "agentDir": "/abs/worktree/.agent", "cwd": "/abs/project", "base": "<commit>", "ref": "<commit>" },
  "B": { "label": "shorter tool text", "change": "Cuts the tool's description to its first rule", "base": "<commit>", "ref": "<commit>", "how": "sova", "url": "http://127.0.0.1:4814", "agentDir": "...", "cwd": "...",
         "problem": "greps before it asks the spec tool", "why": "The first rule is the only one a cheap model acts on", "expectFix": ["f01", "f02"], "mayBreak": ["p01"], "knobs": ["tool-description"] }
}
```

Master's arm has `base`, master's own commit, and `ref`, that commit plus the one that removes the record from the arm (`references/arms.md`).

A candidate arm carries its consultant's prediction (`references/record.md`, "A prediction"): `problem` (the failure it is aimed at, in general words: one of the record's problem names, or a new one), `why`, `expectFix` (case ids expected to turn from fail to pass) and `mayBreak` (case ids that might turn from pass to fail), plus `knobs`, what this cycle allowed. An id that isn't a case, or is a sealed case, is refused by the runner and the scorer (exit 3, naming it). An arm with no `expectFix` has stated no prediction, and every report says so.

`how` is `sova` (a fresh chat per case in that test copy of Sova; optional `mode`, `minorModes`), `command` (a shell command with `{model}`, `{effort}`, `{promptFile}`, `{case}`, `{arm}`; its stdout is the reply, or JSON `{"reply", "tools", "cost"}`) or `rescore` (`"from": <round>`, optional `"fromArm"`: no run, that round's replies re-judged). `references/arms.md` says when each fits.

## Predicted beside observed

`score.mjs total` compares each candidate arm with its base, case by case on each test model, and writes it as `prediction` on the arm in `scores.json`:

```json
{
  "stated": true, "problem": "...", "why": "...", "expectFix": ["f01", "f02"], "mayBreak": ["p01"],
  "base": { "round": 0, "arm": "A" },
  "compared":        { "n": 40, "base": 45, "arm": 72.5, "perModel": { "zai_glm-5.3@low": { "n": 20, "base": 40, "arm": 70 }, "claude-code_claude-haiku-5-5@low": { "n": 20, "base": 50, "arm": 75 } } },
  "fixedExpected":   { "n": 3, "ids": ["f01", "f02"], "perModel": { "zai_glm-5.3@low": 2, "claude-code_claude-haiku-5-5@low": 1 } },
  "notFixed":        { "n": 1, "ids": ["f02"], "perModel": { "claude-code_claude-haiku-5-5@low": 1 } },
  "fixedUnexpected": { "n": 1, "ids": ["f07"], "perModel": { "zai_glm-5.3@low": 1 } },
  "brokeExpected":   { "n": 0, "ids": [], "perModel": {} },
  "brokeUnexpected": { "n": 1, "ids": ["p04"], "perModel": { "zai_glm-5.3@low": 1 } },
  "missing":         { "n": 0, "ids": [], "perModel": {} }
}
```

- The base is the arm of an earlier round whose `ref` is this arm's `base`, else Round 0's master.
- A case on one test model is one count: `n` is how many, `ids` the cases it happened to, `perModel` the count per test model.
- `compared`: what both the arm and its base graded, and the pass rate (%) of each on exactly those; the record's pass rates come from it.
- `fixedExpected`: an `expectFix` case that failed on the base and passes on the arm; `notFixed`: one that still fails. `fixedUnexpected`: any other case that turned from fail to pass. `brokeExpected`: a `mayBreak` case that passed on the base and fails on the arm; `brokeUnexpected`: any other case that did. `missing`: graded on one side only, or named by the prediction and not run, so not compared.
- No verdict: nothing here says a prediction held or failed. The counts are read against the measured noise (`references/noise.md`), and the best arm is still picked by pass rate, then cost.
- Master's arm has no prediction, and a round run on the sealed cases writes none.

`chart.mjs` prints it as the table Predicted vs observed, one row per arm, under the round's chart. The ledger row keeps the counts without the ids.

## Blind grading

`score.mjs blind` writes each reply that has no check as `blind/<token>.json` (`prompt`, `expect`, `reply`) in a shuffled order, and keeps which is which in `blind-key.json`. The grader writes `blind/<token>.grade.json`: `{"pass": true, "why": "one line"}`. `score.mjs unblind` puts the verdicts back on their arms.

## The ledger

`score.mjs total` writes the round's row; running it again replaces that row. Round 0 is master. The best arm of a round is the highest pass rate over every test model, ties to the cheaper; `--winner` and `--note` record the main chat's own call. `chart.mjs` reads the ledger for master's column and the trend.
