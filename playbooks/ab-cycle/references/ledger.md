# The campaign folder

One folder per campaign, in the worktree's ignored cache: `<worktree>/.cache/ab/<campaign>/`. Nothing in it is ever committed. Every round is recorded the same way, so any campaign's charts read alike.

```
campaign.json            what the campaign measures (below)
cases.jsonl              the frozen cases, one per line
rounds/<n>/arms.json     the arms round n runs (round 0: master alone)
rounds/<n>/results/<arm>/<model>/<case>.json   one reply each (runner.mjs)
rounds/<n>/grades/<arm>/<model>/<case>.json    one verdict each (score.mjs)
rounds/<n>/blind/        replies for the grader, unlabelled; blind-key.json beside it, never shown to the grader
rounds/<n>/proposals/    the consultants' proposals
rounds/<n>/shots/<arm>/<model>/<case>.png      screenshots (shoot.mjs)
rounds/<n>/scores.json   the round's totals; rounds/<n>/chart.md its chart
ledger.jsonl             one row per round: arms, what changed, pass rates, best arm, note
collage.png, collage.html
```

`<model>` folders are the model ref with its effort: `zai_glm-5.3@low`.

## campaign.json

```json
{
  "subject": "Do cheap models use the spec tool instead of grep?",
  "bars": "Every test model passes at least 90%, none below master",
  "testModels": [{ "model": "zai/glm-5.3", "effort": "low" }, { "model": "claude-code/claude-haiku-5-5", "effort": "low" }],
  "parallel": 2,
  "timeoutSec": 300
}
```

## cases.jsonl

```json
{"id": "f01", "group": "fail", "prompt": "Where is the password reset email sent from?", "expect": "Uses the spec tool before any grep", "check": {"tool": "spec"}}
{"id": "p01", "group": "pass", "prompt": "...", "expect": "...", "check": {"all": [{"tool": "spec"}, {"maxTools": 6}]}}
{"id": "s01", "group": "sealed", "prompt": "...", "expect": "..."}
```

`group`: `fail` (fails on master today), `pass` (passes today: catches regressions), `sealed` (held back for the confirm run). `expect` is what a good reply does, in words, for the grader. `check` is optional; without one the grader judges.

### Checks

`{"contains": "text"}` (any case), `{"regex": "pattern", "flags": "i"}`, `{"tool": "name"}` (the reply called that tool), `{"maxTools": 6}`, `{"maxWords": 200}`, and `{"all": [...]}`, `{"any": [...]}`, `{"not": {...}}` to combine them. A run that errored always fails.

## arms.json

```json
{
  "A": { "label": "master", "baseline": true, "how": "sova", "url": "http://127.0.0.1:4813", "agentDir": "/abs/worktree/.agent", "cwd": "/abs/project", "ref": "<commit>" },
  "B": { "label": "shorter tool text", "change": "Cuts the tool's description to its first rule", "base": "<commit>", "ref": "<commit>", "how": "sova", "url": "http://127.0.0.1:4814", "agentDir": "...", "cwd": "..." }
}
```

`how` is `sova` (a fresh chat per case in that test copy of Sova; optional `mode`, `minorModes`), `command` (a shell command with `{model}`, `{effort}`, `{promptFile}`, `{case}`, `{arm}`; its stdout is the reply, or JSON `{"reply", "tools", "cost"}`) or `rescore` (`"from": <round>`, optional `"fromArm"`: no run, that round's replies re-judged). `references/arms.md` says when each fits.

## Blind grading

`score.mjs blind` writes each reply that has no check as `blind/<token>.json` (`prompt`, `expect`, `reply`) in a shuffled order, and keeps which is which in `blind-key.json`. The grader writes `blind/<token>.grade.json`: `{"pass": true, "why": "one line"}`. `score.mjs unblind` puts the verdicts back on their arms.

## The ledger

`score.mjs total` writes the round's row; running it again replaces that row. Round 0 is master. The best arm of a round is the highest pass rate over every test model, ties to the cheaper; `--winner` and `--note` record the main chat's own call. `chart.mjs` reads the ledger for master's column and the trend.
