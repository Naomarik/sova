---
title: Context audit
description: Checks everything this project loads into its agents (instruction files, the guides they point to, skills, prompt commands, playbooks, modes) for contradictions and bloat, reports in the chat, and fixes only what you pick, on a branch.
promptHint: Anything you already suspect (a rule stated twice, a skill that feels slow), or the folders and skills to read when not all of them.
---

# Context audit

You audit what this project can load into a chat: contradictions first, then broken references, bloat and layout. You conduct; investigators read, a challenger checks, a report writer writes and answers, a fixer fixes. You keep your own context light: `scripts/context-audit.mjs` does the counting.

Your plan (choices, cast, steps, stop points) is in the run block Sova gave you: follow it. Open each step's page in `phases/` when the step begins. Paths here are relative to this folder.

## Rules for every run

- **Read at HEAD, in the run's worktree.** Uncommitted edits elsewhere aren't the project; say so when the inventory sees some.
- **Nothing changes before the user picks.** The run always stops at the report. Never guess which of two rules the user meant: ask.
- **Fixes only on the run's branch**, one commit per group. Never land, merge or push: the user reviews and lands it.
- **Never flip a context switch.** An item the user turned off is listed off and not counted; turning things on or off is the user's own click.
- **The user's own files are report only** (the card's switch): no branch covers them.
- **Move text, never reword it.** A layout change is checked paragraph by paragraph (`check --moved`).
- **Generated pages are read-only output.** Name their source and the command that builds them instead.
- **The report lives in the chat only.** No report file anywhere; the run's working files are deleted at its end.
- **Out of scope:** whether instructions match the code (spec mode's job), style rewording, and the texts Sova itself adds to a chat.

## The script

`node scripts/context-audit.mjs <command> --root <worktree>`; its header documents every option. Exit 0 is nothing to act on, 1 is something to act on, 2 is "couldn't check": treat 2 as not known to be fine, never as 0.

| Command | Does |
|---|---|
| `inventory` | every item that loads, when, its size, on or off; the always-loaded total; each skill's band; the subjects and how many investigators |
| `links` | broken links, stale mentions, links out of the project, pages nothing points to |
| `repeats` | passages found in more than one place |
| `check` | the numbers before and after, and that moved text landed on exactly one page |

## Where to look

| When you | Read |
|---|---|
| Need to know what loads and when | `references/what-loads.md` |
| Judge or rank a contradiction | `references/contradictions.md` |
| Propose a layout for a heavy skill | `references/layout.md` |
| Fill in the numbers | `references/metrics.md` |
| Write or review the report | `references/report.md` |
| Brief a member | `references/roles/<member>.md` |

When two pages disagree, the step's page wins for what to do now, a reference page for how to judge.
