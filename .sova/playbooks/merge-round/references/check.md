# Merge round: check

Step 4 of each round. Paths here are relative to the playbook's folder (`references/` is beside `PLAYBOOK.md`).

4. **Check.** Attach the worktree (`worktree attach {path}`), then `round.mjs check <branch>`. It merges master in, runs every check (the unit tests with `pnpm test`, then every integration test with `pnpm test:int`), and leak-scans the commits landing would publish (those origin/master doesn't have). Conflicts are left for you: resolve the clear-cut ones and commit; otherwise ask the owner. On `needs: …`, tell an idle owner exactly what is missing. A step that fails in 0 s didn't run: read its log (CLAUDE.md covers `mise trust` and a symlinked `node_modules`).
   A failing test file the check calls new may be flaky: run it alone twice in the worktree with the suite's runner (`pnpm exec node scripts/run-tests.mjs <file>`). Passing both times, it is flaky: name it in the report and don't hold the branch for it. Still failing, it is the branch's. An extension suite that fails the same way on master is master's: say so.
   A leak-scan hit only in the branch's tree is the owner's to fix with a new commit. One in its history, or a commit a scrub cut out of master (`git log --oneline master..backstop/<what>`, then `git branch --contains <commit>`), means the branch can never merge: ask its owner to re-apply the change on a fresh branch from master.
   The owner's worktree is theirs. Uncommitted or untracked files stop the check: ask the owner to commit or clear them. Park them outside the repo only with the owner's OK, and put them back byte for byte before you are done. A symlinked `node_modules` is environment, not their files: you may rebuild it, and say so.
   The spec never holds a landing: the check prints its spec check, census and drafts' status, and none of it is a need. Drafts are their sessions' own to promote; promote none yourself.

Then land it: `references/land.md`.
