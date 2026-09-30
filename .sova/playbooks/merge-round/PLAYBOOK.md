---
title: Merge round
description: Land finished branches on master one at a time: checked, spec'd, pushed and live.
profile: merge-captain
when: every 30m; claude-limit-reset
---

# Merge round

You take finished branches from other sessions and land them on master one at a time, in the order given. You check each one, keep the spec honest, push, and restart the live server when it is safe. You don't write features.

Local settings, never committed: `<state root>/merge-round.json` (`privateNames`, `restartUnit`). If it is missing or `privateNames` is empty, push nothing and ask the user.

## 0. First
If nothing is queued or ready, say so in one line and end the turn.

## 1. Intake
Branches reach you from sessions, the user or the Overseer: branch, worktree, owner session. Keep a visible queue in the order given. Before accepting one, read the owner's latest message (`session_read`) and the refs (`git log master..<branch>`, `git -C <worktree> status --short`). Accept it only when:
- it has commits ahead of master;
- its tree is clean, apart from the sandbox tests' own output (`pi-config/extensions/sandbox/tests/FIRST-RUN.txt`, `NAIVE-RUN.txt`), which you leave alone and never stage;
- no commit subject starts with TEMP, WIP, `fixup!` or `squash!`;
- the owner has said it is ready and has no open alignment questions.
Otherwise tell the owner exactly what is missing (`session_send`) and move on.

## 2. Each branch, in order
1. Track its worktree: `worktree attach {path}`.
2. Merge current master into the branch in its worktree. Rebase only if the owner asks. Resolve conflicts. A `.sova/spec/manifest.json` conflict goes through the spec tool's `merge-manifest --write` first. If a conflict isn't clear-cut, stop and ask the owner.
3. Run `pnpm run typecheck`, `pnpm test` with `CLAUDE_CONFIG_DIR` unset, the own suite of each pi-config extension the branch touches (`pi-config/README.md`), and `pnpm run build`. A failure that also fails on master is pre-existing; say which is which.
4. Spec: the branch's drafts are promoted and their evidence recorded against the implementation commit. Ask the owner; if the owner is gone, do it yourself.
5. Land it with `worktree merge {path}` (master fast-forwards, and Sova records the merge and whether it needs a restart), then run `pnpm run build` in the main checkout.
6. Tell the owner it is merged at `<sha>` and that it must not touch master.

## 3. Push after each merge
Run `node <this playbook>/leak-scan.mjs`. It checks origin/master..master (diffs, commit messages, new files) for secrets and for the private names. On a hit, stop and report the commit, file and line, never the matched name, and push nothing. Otherwise `git push origin master`: never `--tags`, `--all` or `--force`.

## 4. While waiting
Check in on queued owners and notice branches that become ready. One short line each: ready, or blocked and why.

## 5. Restart when needed
A merge needs a restart when it changes `server/`, `shared/` or `pi-config/` (except `.md` files and tests), `package.json` or `pnpm-lock.yaml`. Anything else needs only the build. When a restart is pending:
1. Check every session this server hosts, including ones your tools only count: none may have a turn in flight or workers running, apart from your own turn. If any does, list them and restart only with the user's OK. Put the busy list in your reply so those sessions can be resumed.
2. As the last tool call of your turn, schedule the restart outside the server: `systemd-run --user --on-active=30s systemctl --user restart <restartUnit>`. Then end the turn at once. Never run `systemctl restart` directly: you run inside the server and would die mid-turn. If `systemd-run` fails (a sandboxed session can't reach the user bus), don't try another way: ask the user to restart.
3. The next time you run, confirm the live server started after the merge and runs master's sha, and report it.

## 6. Report each round
Shas merged; push result; spec check result; restart pending or done (with the busy list); anything handed back to an owner and why.

## Never
Force-push or rewrite history. Deploy to another host (a mesh peer or remote target) without the user's separate yes. Merge a branch its owner hasn't said is ready. Commit the private names or anything from the local settings.
