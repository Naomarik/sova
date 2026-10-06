# Codemode and model turns on zai/glm-5.3 (2026-10-06)

Does the `codemode` minor mode (pi 1.0's `codemode` tool, branch `feat/pi-1.0` at `09cd100b`) cut the
number of model turns on a small multi-file read-only task? Three arms, 6 runs each, interleaved, all on
`zai/glm-5.3` (thinking `medium`), every run graded against a fixed answer key.

| arm | n | turns | top-level tool calls | calls inside scripts | input tok k (incl. cache) | uncached input k | output tok | cost $ | wall s | correct |
|---|---|---|---|---|---|---|---|---|---|---|
| off | 6 | 5 / 5.3 | 11.5 / 11.3 | 0 / 0 | 74.8 / 78.8 | 3.7 / 5.7 | 1607 / 1600 | 0.0308 / 0.0341 | 41.9 / 42.2 | 6/6 |
| on | 6 | 5.5 / 5.5 | 9.5 / 9.5 | 0 / 0 | 86.8 / 86.3 | 3.8 / 3.9 | 1786 / 1780 | 0.0347 / 0.0347 | 39.9 / 40.9 | 6/6 |
| hint | 6 | 4.5 / 4.3 | 3.5 / 4.3 | 19.5 / 21 | 72.1 / 72.3 | 6.2 / 6.7 | 4456 / 5005 | 0.0442 / 0.0485 | 70.2 / 81.9 | 6/6 |

Each cell: median / mean. `off`: codemode off. `on`: codemode on, the same prompt. `hint`: codemode on, and
the prompt ends with "Use the codemode tool for this: one script can read and search many files at once."

Per run (turns · top-level calls · nested calls · wall s):

| # | off | on | hint |
|---|---|---|---|
| 1 | 5 · 12 · 0 · 38.1 | 5 · 5 · 0 · 39.5 | 5 · 5 · 22 · 48.2 |
| 2 | 5 · 11 · 0 · 43.6 | 5 · 4 · 0 · 37.3 | 5 · 4 · 40 · 63.6 |
| 3 | 7 · 17 · 0 · 53.8 | 6 · 13 · 0 · 40.3 | 3 · 2 · 30 · 76.9 |
| 4 | 5 · 6 · 0 · 48.5 | 5 · 7 · 0 · 47.0 | 4 · 3 · 15 · 52.5 |
| 5 | 5 · 15 · 0 · 40.2 | 6 · 16 · 0 · 37.9 | 6 · 10 · 17 · 116.7 |
| 6 | 5 · 7 · 0 · 28.8 | 6 · 12 · 0 · 43.5 | 3 · 2 · 2 · 133.5 |

## Findings

- **With codemode merely on, glm-5.3 never used it**: 0 codemode calls in 6 `on` runs (and 1 smoke run). The
  tool was declared before the prompt in every run (`codemodeDeclared: true`). The `on` arm's turns,
  calls and wall time match `off` within noise. The tool's description and prompt lines add 888 tokens to
  every request (first request 14,077 vs 13,189); the `on` arm's larger total input (median 86.8k vs
  74.8k) is mostly its extra half-turn re-sending the context.
- **Asked to use it, the model saves about one turn of five** (median 4.5 vs 5; best runs 3 turns) and
  makes far fewer top-level calls (median 3.5 vs 11.5), moving 2–40 calls into scripts. glm-5.3 already
  batches 7–10 parallel `read`s per turn without codemode, so for this task the baseline is already near
  the floor (one turn to list, one or two to read, one to check config, one to answer).
- **Fewer turns did not mean faster or cheaper.** `hint` runs took 1.7× the median wall time and 2.8× the
  output tokens (the model writes parsers in JS: script bodies of 0.4–4 KB, with `reasoning` up to 7.5k
  tokens in a run), and cost ~45% more. Total input was slightly lower (fewer turns re-sending the
  context), not enough to offset output.
- Accuracy was 18/18 in all arms, so the task didn't separate them on correctness.

## Method

Driver: `scripts/codemode-exp/run.mjs` (README beside it); raw per-run JSON and the summary:
`docs/perf/data/codemode-turns/`. Rerun: `node scripts/codemode-exp/run.mjs --port <p> --agent <dir> --runs 6`.

- Server: this branch, `scripts/start-server.sh` (Bun) on port 4814, hermetic agent dir built by
  `scripts/hermetic-agent-dir.mjs`, `auth.json` with only zai. Default mode `normal`, no other minor on.
- Fixture: 17 files the script writes fresh per run (14 JS sources over `src/{api,auth,jobs,lib,util}`, 2
  config JSONs, `package.json`). Key: 8 caller functions (including an arrow function and a class
  method), 12 `legacyLog(` call sites, distractors `legacyLogger(` and a comment naming `legacyLog`, the
  unused key `archiveAfterDays`. The model ends with an `ANSWER` block (callers / total / unused_key);
  correct = exact caller set, total and key.
- Per run: new web session (`POST /api/sessions`, cwd = the fixture), `set_model zai/glm-5.3` over
  `/ws/chat`, `POST /api/mode?path=` with `minorModes` `[]` or `["codemode"]`, then the one prompt. Wall time
  is prompt sent → `run.settled`. Metrics come from the session JSONL after the prompt: turns = assistant
  messages, top-level calls = their `toolCall` parts, nested = the codemode results' `details.calls`,
  tokens = assistant `usage` summed (`input` is uncached input; "incl. cache" adds `cacheRead`/`cacheWrite`),
  cost = pi's own `usage.cost`. Sessions archived after each run.
- Order: run i rotates which arm goes first (off/on/hint, on/hint/off, …). Runs 06:22–06:39 UTC; no
  errors, no retries.

## Caveats

- One small task, one model, n=6 per arm: the turn difference (≈1) is the size of the run-to-run spread.
  The task is wide (many independent reads) but shallow. A task with dependent steps, many more
  files, or large outputs to filter is where folding work into a script should pay more, and it wasn't
  tested here.
- The fixture lives under `$TMPDIR` rather than this repo: pi loads every `AGENTS.md`/`CLAUDE.md` from the
  cwd up to `/`, and inside the repo Sova's `CLAUDE.md` (~16k tokens) would have joined every prompt.
- The `hint` arm changes the prompt, so it measures "codemode when the model uses it", not the minor mode
  as a user would turn it on. That glm-5.3 ignores the tool unprompted is itself the main result for the
  `on` arm; other models (Claude, GPT) may pick it up unprompted and weren't measured.
- The first run of the batch (01-off) had a cold provider cache (16.5k uncached input vs ~3.7k after),
  which inflates `off`'s mean uncached input; medians are unaffected.
- zai's request limit (5 in flight) wasn't a factor: runs were sequential.
