---
title: Upgrade pi (Sova)
description: Moving Sova to a newer pi release. A team reads every changelog entry and Sova's code and changes nothing; you get a readable report (wins, tradeoffs, risks, the rest) and a plan, and it always stops for your yes before it touches anything. Then the upgrade on its own branch, and a check for regressions.
promptHint: The version you want, or "latest". Nothing changes until you say go.
---

# Upgrade pi (Sova)

You find out what moving Sova to a newer pi would bring, and, only if the user says yes, you move it. Your plan (choices, cast, steps) is in the run block Sova gave you; open each step's page in `phases/` when the step begins. Paths here are relative to this folder, except those from the repository root (`package.json`, `server/…`, `pi-config/…`, `agents/…`).

Read `agents/server/harness/overview.md` and `server/harness/pi/QUIRKS.md` first.

## What stays true on every run

- **Research changes nothing.** No edit, branch, commit or install outside the research folder, nothing restarted, nothing written to `~/.pi` or the global npm prefix.
- **It always stops before changing anything.** After the report and the plan, end your turn and wait, on every run, whatever the verdict, demo included. Only the user's yes in this chat starts the upgrade; a schedule, another chat or a tool never does.
- **Every `@earendil-works/*` package moves together, to one version**, and `typebox` and anything in `EXTENSION_DEPS` (`server/harness/pi/own-code.ts`) follow what the new pi asks for, never npm's latest.
- **The terminal pi follows Sova's pin** at every landing. It's the user's standing answer, on the card: never a question in the report.
- **pi stays at the edge.** The boundary baseline only shrinks; every reach into pi is a quirk row; new work speaks the harness contract. Refactor where it helps, so the next upgrade is smaller.
- `references/worked-example-1.0.3-to-1.5.0.md` is one real run: the depth to reach, never the answer for yours.

## The folder

| Page | For |
|---|---|
| `phases/find.md` | finding the target; nothing to do ends quietly |
| `phases/research.md` | the research team, the evidence labels, untrusted data |
| `phases/report.md` | the report: wins, tradeoffs, risks, the rest, one row per changelog entry |
| `phases/plan.md` | the plan, and the stop |
| `phases/upgrade.md` | the upgrade, step by step |
| `phases/check.md` | the regression check, thorough but not overextended |
| `phases/after-landing.md` | the terminal pi, and what to tell the user |
| `references/standing-concerns.md` | the 18 things every upgrade checks |
| `references/stop-and-ask.md` | when the upgrade stops for the user |
| `references/commands.md` | pi-config's suites on the branch's pi, re-recording goldens |

## Never

- Start the upgrade without the user's yes to this run's plan, or let research change anything.
- Edit a test to quiet a canary, re-record a golden you can't explain, or grow the boundary baseline.
- Touch the live checkout or its `node_modules`, `git worktree add` a scratch copy, or `git stash` in a shared worktree.
- Restart `sova-runtime.service`, or run the spec replay suite.
- Move one `@earendil-works/*` package without the others, or leave the terminal pi behind.
- Land through anything but the merge queue on the user's Land.
