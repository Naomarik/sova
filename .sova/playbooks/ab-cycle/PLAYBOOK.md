---
title: A/B cycle
description: Make a prompt, tool or instruction work better on cheap test models: a fixed baseline on master, then cycles of one strong consultant's fix, a run of every test model, a score and a chart, until a stop rule or your word.
promptHint: What fails and where you saw it (paste a chat's path), what may change (tool text, mode text, instructions, tool code), and the test models.
---

# A/B cycle

You conduct an A/B campaign: master is the fixed baseline, each cycle tries one change against it on cheap test models, and every round is recorded the same way and shown as a chart. You keep your own context light: helpers do the reading, running and scoring, and the scripts in this folder do the counting.

Your plan (choices, cast, steps, stop points, cycle settings) is in the run block Sova gave you: follow it. Open each step's page in `phases/` when the step begins. Paths here are relative to this folder.

## Rules for every campaign

- **Master is Round 0, run once.** Reuse its results when the campaign folder already has them. Every chart keeps it as its first column.
- **One change per arm per cycle**, and the fewest words that fix it: a reduction of the instructions beats an addition. Generic fixes only: never a note aimed at one test case.
- **Cheap test models, with their provider.** `zai/glm-5.3` is the ZAI subscription, not Ollama's GLM. A test model that can't run stops the round: never swap it for another.
- **The winner becomes the next cycle's base**; the losing change is reverted. The campaign's ledger records it.
- **Experiment, never lands.** Every arm commit's message ends with `(experiment, never lands)`. Landing a winner is separate work, after the last stop point, on the user's word.
- **Test data stays out of Git.** The campaign folder is `<worktree>/.cache/ab/<campaign>/`: cases, replies, scores, charts and screenshots live there, never committed.
- **Show what you measure before you run it.** The first stop shows a sample chart from `scripts/chart.mjs --sample` and the acceptance bars.
- **Usage is part of the run.** Stop and say so when a provider nears the "warn me at" share, or a sign-in is missing where a helper runs.

## The campaign folder and scripts

`references/ledger.md` is the folder's layout and every file's shape. The scripts (Node, no installs) do the mechanical part:

| Script | Does |
|---|---|
| `scripts/runner.mjs` | runs every case on every test model in every arm of a round, resumable |
| `scripts/score.mjs` | checks, blinds and unblinds, and totals a round (pass rate, cost, time) into its scores and the ledger |
| `scripts/chart.mjs` | the round's chart and table, as a Sova `vis` block, master first |
| `scripts/shoot.mjs` | screenshots of each arm's replies, for the collage |
| `scripts/collage.mjs` | one image: each arm side by side per cycle |

`references/arms.md` says how an arm is made (its own worktree and test copy of Sova, a prompt variant file, or a re-score of saved replies). `references/noise.md` is the noise and copy-effect check. `references/cost.md` prices a round.

## When you stop

At every stop point: the chart, the ledger's rows so far, what changed and what you recommend, then end your turn and wait. The last report adds the collage and the cost table, and offers: land the winner (separate work, spec drafts first), another cycle, or park it with its branches listed.
