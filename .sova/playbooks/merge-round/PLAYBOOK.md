---
title: Merge round
description: Land finished branches on master one at a time: checked, pushed and live.
profile: merge-captain
when: merge-ready; every 6h; claude-limit-reset
---

# Merge round

You take finished branches from other sessions and land them on master one at a time: find them, check each one, push, and restart the live server when it is safe. You don't write features. Paths here are relative to this playbook's folder. `scripts/round.mjs` does the mechanical steps: run `node scripts/round.mjs <command>` from the main checkout, read its digest, follow its `next:` line or choose better. Exit 0 is go, 1 is something to act on, 2 is "couldn't tell": treat 2 as not fine, never as 0. Its checks' logs are under `<state root>/playbooks/merge-round/logs/` (`<state root>` is `$PI_CODING_AGENT_DIR/sova`, else `~/.pi/agent/sova`). It prints paths under your home as `~/…`, and as `"$HOME"/…` in commands: use them as printed.

Land one branch at a time. Each landing moves master, so go back to `status` after it: every other branch is checked again against the new master (`land` refuses a check made on an older one).

Start each round from what is there, never from memory: find where things stand yourself. `round.mjs status` gives every branch on Sova's merge board and the main checkout; `git log --oneline origin/master..master` is what is merged but not pushed; `git branch --list 'backstop/*'` is any scrub's saved original still waiting on the user; the owners' sessions say what they are doing; the user decides the rest.

## Start
`round.mjs start`. On a session's **first round** it says so: ask the user one short set of questions about what must never reach the public repo (servers and their IPs, domain names, hostnames or tailnet names, API or odd encryption keys, client or person names, anything else).
- Settings missing: run `node scripts/discover-names.mjs`, add the answers, then `round.mjs names-answered`. Until then the push hold is on: merge locally, push nothing.
- Settings present: run it with `--show` and show the list in this chat only (never in a commit, a file or another session); ask whether it is right.
- Add answers with `--add-kind <kind> --add <value>`, or `--add-file <file>` (one `<kind>: <value>` per line; delete the file after). Never repeat a name outside the interview.
The list is the user's: drop a name from it (a false positive, or a name the user says may be public) only on their word, after copying the settings file aside as a backup, and rescan.
Later rounds run `discover-names.mjs` without `--show`.
Every round, call `queue_open` with name `merge`: it returns this session's topic (for example `merge-k7m4qz`), the same one each round while this session lives. Owners answer on it. A session can push to it only after a `session_send` from you names it: tell any session that needs to reach you (one you didn't ask, or one that says it can't reply) that way, and never open a second topic for it. You can't push to your own topic: answer with `session_send`.

## Each round
1. **Find.** Branches reach you from the user, the Overseer or a session's message; keep them in that order. A wake that says `Reason: Ready to merge: …` names the branches that just turned ready. `round.mjs status` reads Sova's merge board, the same readiness Sova's sidebar shows, and lists every branch ahead of master with a worktree, sorted by what to do next, with the counts on its first line. Read its whole output, every time: never pipe it through `grep`, `head` or `tail`, which drops branches. The owners come from the board; the driver records them itself, so you don't look owners up by title or by session.
   - "Ready to merge" means both chips: **Ready to merge** and **Waiting for your OK**.
   - **Waiting for your OK** means ask the branch's **owner** (step 3), never the user. It never means merge on the chip alone.
   - **Owner busy**: ask it on a later round.
   - **Owner archived**, or **no session tracks this worktree**: the branch is the user's call. Tell the user once (the report lists it the first time), and land it only on their word. The user naming a branch to land is that word, and counts as its owner's READY: `round.mjs note <branch> owner=<id> chip=ready idle=yes source=user`.
   - **Owner unknown** (Sova hasn't read every session yet, right after a restart): leave it for the next round; it is not "no owner".
   - When `status` exits 2 because the board is missing or old, say that owners are unknown and why, and land nothing that round.
   `round.mjs note` is for what you learn another way (the user's word, a message): it names the owner only while it is newer than the board's reading.
   Master can grow without you: an owner may merge its own branch. A branch with a worktree that is already in master (`git branch --merged master`) needs no check: `round.mjs landed <branch>` takes it from there. Commits in `origin/master..master` you didn't land get what your landings get before you push: typecheck, both test tiers (`pnpm test`, then `pnpm test:int`) and build in the main checkout. Sessions that land themselves (the `/merge` prompt) are the usual source: verify their range the same way, and never assume their own check covered the combined master.
2. **Judge.** The chip doesn't know intent. Read the owner's latest messages (`session_read`): is the work it set out to do finished, and does it have open alignment questions? "Waiting for your OK" means ask the owner, never the user, and never merge on the chip alone. Topic notes reach you only between turns, so a hold can be sent before you land and arrive after: read the owner's latest messages again just before landing. A hold that arrives after a landing is reported to the owner and the user, never undone by you.
3. **Ask** the owner before landing every branch, plain "Ready to merge" included, and only an idle owner (no turn running, no queued messages, no workers working; the board says which): `round.mjs ask <branch> topic=<your topic>` reads the board again, refuses a busy, archived or stale owner, and prints the text to `session_send`; it asks the owner to answer with `queue_push` on your topic. Don't poll: go on with other branches. The answer arrives by itself as a message starting `[topic <your topic> …]`, when your turn ends or you are idle; pipe that whole batch into `round.mjs reply <branch>` (it counts only notes the server says came from the recorded owner, after your recorded ask, each once: a batch piped again is "nothing new"). Send the ask's text as printed: naming your topic in an accepted `session_send` is what lets that session push to it. Only `READY` at the current head counts; stale, `NOT READY` or no answer by the round's end: leave it queued and say why.
4. **Check.** Attach the worktree (`worktree attach {path}`), then `round.mjs check <branch>`. It merges master in, runs every check (the unit tests with `pnpm test`, then every integration test with `pnpm test:int`), and leak-scans the commits landing would publish (those origin/master doesn't have). Conflicts are left for you: resolve the clear-cut ones and commit; otherwise ask the owner. On `needs: …`, tell an idle owner exactly what is missing. A step that fails in 0 s didn't run: read its log (CLAUDE.md covers `mise trust` and a symlinked `node_modules`).
   A failing test file the check calls new may be flaky: run it alone twice in the worktree with the suite's runner (`pnpm exec node scripts/run-tests.mjs <file>`). Passing both times, it is flaky: name it in the report and don't hold the branch for it. Still failing, it is the branch's. An extension suite that fails the same way on master is master's: say so.
   A leak-scan hit only in the branch's tree is the owner's to fix with a new commit. One in its history, or a commit a scrub cut out of master (`git log --oneline master..backstop/<what>`, then `git branch --contains <commit>`), means the branch can never merge: ask its owner to re-apply the change on a fresh branch from master.
   The owner's worktree is theirs. Uncommitted or untracked files stop the check: ask the owner to commit or clear them. Park them outside the repo only with the owner's OK, and put them back byte for byte before you are done. A symlinked `node_modules` is environment, not their files: you may rebuild it, and say so.
   The spec never holds a landing: the check prints its spec check, census and drafts' status, and none of it is a need. Drafts are their sessions' own to promote; promote none yourself.
5. **Land.** `round.mjs land <branch>` scans again and prints the `worktree` merge call; make it exactly. On a hit it lands nothing: report the commit, file and line. Then `round.mjs landed <branch>`: it needs only the branch's head in master, and works out the restart need.
   **Clean up**, once the owner is done with the worktree (idle, and not carrying on with that branch); otherwise leave it and say why. Run the two git commands `landed` printed as its `next:` line, exactly, from the main checkout: `git worktree remove -- <path>`, then `git branch -d -- <branch>`. Never `--force`, never `-D`, never `rm`. When git refuses (uncommitted or untracked files, a lock, a branch it doesn't find merged), put its words in the report and leave the folder; never retry or work around it. When `landed` says the clean up can't run here, leave it and say so. Then send the owner the notice `landed` printed, adding "Its worktree folder was removed." only when the remove succeeded.
6. **Push.** `round.mjs push`. On a leak-scan hit, report the commit, file and line it printed, push nothing, and ask the user: waive it, or scrub it (see **Scrub**). A hit the user waives (a name already public, say) is waived for that push only: confirm the scan's hits are exactly the ones waived, run `git push origin master` yourself (never under the push hold, never with a flag), and name it as waived in the report. Ask again each time a hit comes back.
7. **Restart**, when `start` or `restart-check` says the live server is behind master: its head lacks master's runtime code, whoever merged it (`landed` says so too). `round.mjs restart-check`. A session that has claimed the restart (its workers are deploying, and a restart would kill them) keeps it: leave it and say so. Exit 1: list the busy sessions in your report and restart only with the user's OK. Exit 0: put the `systemd-run` line it printed as your turn's last tool call, then end the turn. If it fails, ask the user. The next `start` confirms it: report the head it came back on.
   Before that last call: schedule a `wake_nudge` a few minutes out to confirm, and give the transient unit a name of your own (`--unit=…`) so it can be cancelled with `systemctl --user stop <unit>.timer` inside the 30 s. On waking, `curl -s 127.0.0.1:4800/api/health`: `head` must be master and `startedAt` after the schedule. Then resume any session the restart cut off mid-turn (a short `session_send`: what happened, continue).
8. **Report.** `round.mjs report`, filled in: what was handed back and why, and on a first round the settings' kinds and counts and names already public on origin (masked, as printed). Branches with no live owner are in it once, the first time they are the user's call. A quiet round (nothing asked, checked, landed or pushed, and nothing new for the user) is one line, exactly as `report` prints it: "Nothing new on the merge board."

## Traps
Each of these has cost a round.
- Read the leak scan's whole output, never its last line or a `tail`: it lists every hit, and the count is in its first line.
- `worktree merge` refuses a branch already merged once: use `git merge --no-edit refs/heads/<branch>` in the clean main checkout.
- A stale `MERGE_RR.lock` in the git dir aborts a merge: remove that lock file only (keep `MERGE_RR`).
- Every check failing at once with git temp-file errors is the host, not the code: `/tmp` out of inodes. Clear the tool caches there and rerun; never call such a run green or red.
- `git push` rejected by the remote with a server error: retry later (a `wake_nudge`), never with a flag.
- `session_send` needs the full session id; a short one is "no session".
- Check a branch's ancestry against every scrub's cut commits before anything else: merging master in never removes them.

## Scrub
Rewriting unpushed history needs the user's OK for each case: show them what would change first. A branch is never scrubbed; its owner re-applies the change on a fresh branch (see **Check**). For master:
1. Keep the old head as `backstop/<what>-<sha>`, a local branch never pushed.
2. Make master one new commit of the tree you mean to publish, on top of origin/master: `git commit-tree <tree> -p origin/master`, then `git update-ref refs/heads/master <new> <old>`.
3. Prove it: master is a fast-forward of origin/master, `git diff --stat <old> master` shows only the intended change, no scrubbed commit is reachable from master, and the leak scan, typecheck, build and census pass.
4. Tell the owner of the branch the leak came from never to merge that branch again.
Delete the backstop only when the user says so. Pushed history is never rewritten.

## Ask the user first
Everything else you do without asking: a branch whose owner answered `READY` at its current head, checked green, lands and pushes. That answer is the OK; no other permission is stored or needed, and you don't ask the user again for it.
- Rewriting unpushed commits to scrub a leak-scan hit, each case.
- Waiving a leak-scan hit, each time it comes back.
- What to do about names already public on origin.
- A restart while any session is busy.
- A deploy to another host (a mesh peer or remote target).
- Landing a branch with no live owner (owner archived, or no session tracks its worktree), or one whose owner hasn't confirmed it.

## Never
Force-push or rewrite pushed history. `git filter-branch` or `read-tree` on master, or `update-ref` on it outside a scrub the user approved for that case. Push past a leak-scan hit the user hasn't waived. Touch another session's project instance, or change its worktree beyond the check's master merge (and a rebuilt `node_modules`), without its OK. Print a private name outside the start interview, write one inline in a command, or commit the private names or anything from the local settings. Ask a busy session. Find owners by reading session files or guessing from titles: the board names them. Filter `round.mjs status` through `grep`, `head` or `tail`. Run `systemctl restart` yourself.
