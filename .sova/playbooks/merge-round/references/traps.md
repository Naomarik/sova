# Merge round: traps and the scrub

Read this when a merge, a check or a push fails in an odd way, and before any scrub. Paths here are relative to the playbook's folder (`references/` is beside `PLAYBOOK.md`).

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
Rewriting unpushed history needs the user's OK for each case: show them what would change first. A branch is never scrubbed; its owner re-applies the change on a fresh branch (see `references/check.md`). For master:
1. Keep the old head as `backstop/<what>-<sha>`, a local branch never pushed.
2. Make master one new commit of the tree you mean to publish, on top of origin/master: `git commit-tree <tree> -p origin/master`, then `git update-ref refs/heads/master <new> <old>`.
3. Prove it: master is a fast-forward of origin/master, `git diff --stat <old> master` shows only the intended change, no scrubbed commit is reachable from master, and the leak scan, typecheck, build and census pass.
4. Tell the owner of the branch the leak came from never to merge that branch again.
Delete the backstop only when the user says so. Pushed history is never rewritten.
