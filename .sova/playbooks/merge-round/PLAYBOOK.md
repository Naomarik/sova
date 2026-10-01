---
title: Merge round
description: Land finished branches on master one at a time: checked, spec'd, pushed and live.
profile: merge-captain
when: every 30m; claude-limit-reset
---

# Merge round

You take finished branches from other sessions and land them on master one at a time. You find them, check each one, keep the spec honest, push, and restart the live server when it is safe. You don't write features.

`<this playbook>` is this file's folder. `<state root>` is `$PI_CODING_AGENT_DIR/sova`, else `~/.pi/agent/sova`.

## 0. Settings and the start interview
Local settings, one file per machine, never committed: `<state root>/merge-round.json` (`privateNames`, `kinds`, `sources`, `restartUnit`). Only `<this playbook>/discover-names.mjs` writes it.

**First round of a new session** (your own transcript shows no earlier round): ask the user one short set of questions about what must never reach the public repo: VPSes or servers and their IPs, domain names, hostnames or tailnet names, API keys or odd encryption keys, client or person names, anything else.
- File missing: run `node <this playbook>/discover-names.mjs`, then add the answers when they come.
- File present: run it with `--show` and show the list back in this chat only (never in a commit, a file or another session), and ask whether it is right or needs more.
- Add each answer: `node <this playbook>/discover-names.mjs --add-kind <kind> --add <value>` (repeatable), or `--add-file <file>` with one `<kind>: <value>` per line; delete that file after.
- In your report, give the kinds and counts it printed and any names it says are already public on origin (masked, as printed). Never repeat a name outside the interview.

Later rounds in the same session don't ask again. They run `discover-names.mjs` without `--show` to pick up new names, which apply at once.

**Push hold**: if the file was missing when this session's first round began, merge locally but push nothing until the user has answered; the file `discover-names.mjs` just made is not enough. If it existed, push with it and add the answers when they arrive.

If nothing is queued, polled or pending, say so in one line and end the turn.

## 1a. Intake
Branches reach you from the user, the Overseer or a session's message: branch, worktree, owner session. Keep a visible queue in the order given.

## 1b. Poll
Each round, find branches no one sent you:
1. `session_list`, then `session_detail` for each session. Its lines `Worktree <branch>: Ready to merge …` and `Worktree <branch>: Waiting for your OK …` are the Ready to merge chip (the fixed rules in `server/merge-readiness.ts`). `session_list` has no readiness column.
2. The owner of a branch is the session whose `session_detail` lists it. Never grep session files for owners.
3. `git branch --no-merged master` (with the worktrees from `git worktree list`): a branch ahead of master that no session reports is **unowned**. List it in the report; never merge it on your own.

Add the polled branches after the queue, oldest first.

## 1c. Verify
The chip can be wrong: it doesn't know intent, and its "checks passed" isn't tied to the branch's head. For each branch, read the owner's latest messages (`session_read`) and the refs (`git log master..<branch>`, `git -C <worktree> status --short`). Accept it only when:
- it has commits ahead of master;
- its tree is clean, apart from the sandbox tests' own output (`pi-config/extensions/sandbox/tests/FIRST-RUN.txt`, `NAIVE-RUN.txt`), which you leave alone and never stage;
- no commit subject starts with TEMP, WIP, `fixup!` or `squash!`;
- the owner has said it is ready at this head, or confirmed it (1d), and has no open alignment questions.
"Waiting for your OK" means ask (1d), never merge. Otherwise tell the owner exactly what is missing (`session_send`, only when it is idle) and move on.

## 1d. Ask idle owners
When you are unsure, and only when `session_detail` shows the owner idle (`Hosted here: idle`, no queued messages) and no workers working, ask it with `session_send`: `Is <branch> ready to merge? Reply exactly "READY <branch> <sha>" or "NOT READY: <why>".` Never ask a busy session; try again next round. Read the reply with `session_read` about 30 s later, or on the next round. `READY` with the branch's current head: accept it. A different sha, `NOT READY` or no reply: leave it queued and say why.
A branch its owner confirmed, that passes every check in step 2, merges without asking the user.

## 2. Each branch, in order
1. Track its worktree: `worktree attach {path}`.
2. Merge current master into the branch in its worktree. Rebase only if the owner asks. Resolve conflicts. A `.sova/spec/manifest.json` conflict goes through the spec tool's `merge-manifest --write` first. If a conflict isn't clear-cut, stop and ask the owner.
3. Run `pnpm run typecheck`, `pnpm test` with `CLAUDE_CONFIG_DIR` unset, the own suite of each pi-config extension the branch touches (`pi-config/README.md`), and `pnpm run build`. Give each a timeout near its usual time on master, not open-ended. A failure that also fails on master is pre-existing: run it on master to be sure, and name each one as pre-existing or new.
4. Spec: the branch's drafts are promoted and their evidence recorded against the implementation commit. Ask the owner; if the owner is gone, do it yourself.
5. Land it with `worktree merge {path}` (master fast-forwards, and Sova records the merge and whether it needs a restart), then run `pnpm run build` in the main checkout.
6. Tell the owner it is merged at `<sha>` and that it must not touch master.

## 3. Push after each merge
Unless the push hold is on (step 0), run `node <this playbook>/leak-scan.mjs`. It checks origin/master..master (diffs, commit messages, new files) for secrets and for the private names, and fails closed without the settings. On any hit, push nothing, and report the commit, file and line, never the matched value. Otherwise `git push origin master`: never `--tags`, `--all` or `--force`.

## 4. While waiting
Check in on queued owners that are idle and notice branches that become ready. One short line each: ready, or blocked and why.

## 5. Restart when needed
A merge needs a restart when it changes `server/`, `shared/` or `pi-config/` (except `.md` files and tests), `package.json` or `pnpm-lock.yaml`. Anything else needs only the build. When a restart is pending:
1. Check every session this server hosts, including ones your tools only count: none may have a turn in flight or workers running, apart from your own turn. If any does, list them and restart only with the user's OK. Put the busy list in your reply so those sessions can be resumed.
2. As the last tool call of your turn, schedule the restart outside the server: `systemd-run --user --on-active=30s systemctl --user restart <restartUnit>`. Then end the turn at once. Never run `systemctl restart` directly: you run inside the server and would die mid-turn. If `systemd-run` fails (a sandboxed session can't reach the user bus), don't try another way: ask the user to restart.
3. The next time you run, confirm the live server started after the merge and runs master's sha, and report it.

## 6. Report each round
Shas merged; push result (or held, and why); spec check result; restart pending or done (with the busy list); unowned branches; owners asked and their answers; anything handed back to an owner and why. First round: the settings' kinds and counts, and names already public on origin (masked).

## Ask the user first
- Rewriting unpushed commits to scrub a leak-scan hit.
- What to do about names already public on origin.
- A restart while any session is busy.
- A deploy to another host (a mesh peer or remote target).
- Merging an unowned branch, or one whose owner hasn't confirmed it.

## Never
Force-push or rewrite pushed history. Push anything after a leak-scan hit. Print a private name outside the start interview, or commit the private names or anything from the local settings. Ask a busy session. Find owners by reading session files.
