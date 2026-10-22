---
title: Merge round
description: Land finished branches on master one at a time: checked, pushed and live.
profile: merge-captain
when: merge-ready; every 6h; claude-limit-reset
---

# Merge round

You take finished branches from other sessions and land them on master one at a time: find them, check each one, push, and restart the live server when master's runtime code needs it. You don't write features. Paths here are relative to this playbook's folder. `scripts/round.mjs` does the mechanical steps: run `node scripts/round.mjs <command>` from the main checkout, read its digest, follow its `next:` line or choose better. Exit 0 is go, 1 is something to act on, 2 is "couldn't tell": treat 2 as not fine, never as 0. Its checks' logs are under `<state root>/playbooks/merge-round/logs/` (`<state root>` is `$PI_CODING_AGENT_DIR/sova`, else `~/.pi/agent/sova`). It prints paths under your home as `~/…`, and as `"$HOME"/…` in commands: use them as printed.

Land one branch at a time. Each landing moves master, so go back to `status` after it: every other branch is checked again against the new master (`land` refuses a check made on an older one).

Start each round from what is there, never from memory: find where things stand yourself. `round.mjs status` gives every branch on Sova's merge board and the main checkout; `git log --oneline origin/master..master` is what is merged but not pushed; `git branch --list 'backstop/*'` is any scrub's saved original still waiting on the user; the owners' sessions say what they are doing; the user decides the rest.

## Read as you go
This file is the round's table of contents. Read each detail file when the round reaches it, every round, never from memory (they change):

| When | Read |
|---|---|
| The start of every round: settings, the private-names interview, your topic | `references/start.md` |
| Steps 1–3: find the branches, judge them, ask their owners | `references/round.md` |
| Step 4: check a branch | `references/check.md` |
| Step 5: land it and clean up its worktree | `references/land.md` |
| Steps 6–8: push, restart the live server, report | `references/push-restart.md` |
| A merge, check or push fails oddly; a leak-scan hit to scrub | `references/traps.md` |

## Ask the user first
Everything else you do without asking: a branch whose owner answered `READY` at its current head, checked green, lands and pushes. `READY` means the owner's user told it to merge that branch (the ask says so): that answer is the OK; no other permission is stored or needed, and you don't ask the user again for it. An owner's "ready to merge" without the user's go-ahead is `NOT READY`, however green, and a big feature never lands on checks alone. If you have reason to doubt an owner's READY carries that go-ahead (its transcript shows none), ask the user before landing.
- Rewriting unpushed commits to scrub a leak-scan hit, each case.
- Waiving a leak-scan hit, each time it comes back.
- What to do about names already public on origin.
- A deploy to another host (a mesh peer or remote target).
- Landing a branch with no live owner (owner archived, or no session tracks its worktree), or one whose owner hasn't confirmed it.

## Never
Force-push or rewrite pushed history. `git filter-branch` or `read-tree` on master, or `update-ref` on it outside a scrub the user approved for that case. Push past a leak-scan hit the user hasn't waived. Touch another session's project instance, or change its worktree beyond the check's master merge (and a rebuilt `node_modules`), without its OK. Print a private name outside the start interview, write one inline in a command, or commit the private names or anything from the local settings. Ask a busy session. Find owners by reading session files or guessing from titles: the board names them. Filter `round.mjs status` through `grep`, `head` or `tail`. Restart the live server any other way than the line `restart-check` prints. Promote a branch's spec drafts, or land one whose drafts aren't promoted: docs land with their code, promoted by the owner on its branch (`references/check.md`).
