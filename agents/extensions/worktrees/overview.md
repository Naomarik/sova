---
watches: ["pi-config/extensions/worktrees/**", "server/worktrees-state.ts", "server/git-diff.ts"]
alsoUpdate: ["pi-config/extensions/worktrees/README.md"]
---
# worktrees

The git worktrees a session works in: the parent agent's `worktree` tool (create, attach, detach, merge, list),
kept in the session's `worktrees` entry. Workers may start only in the session cwd or an active tracked worktree,
and each merge becomes a card.

## What lives here

- [`README.md`](../../../pi-config/extensions/worktrees/README.md).
- Tests: `cd pi-config/extensions/worktrees && node --test state.test.ts git.test.ts spec.test.ts && node tests/run.mjs`.

## What Sova relies on

- The session's `worktrees` custom entry: the tracked set, a whole snapshot, newest on the branch wins. Its
  `worktree-merge` extension message is the merge card. Sova reads both, and so does the subagents spawn gate.
- `state.ts` (builtins only): the entry, its fold and the merge card's details. `server/worktrees-state.ts`
  imports it, as do the server's worktree, merge-board and readiness modules
  (`git grep -n "extensions/worktrees/" -- server`).
- `git.ts` (builtins only, git by argv): the extension's own "is this branch merged" probe, and
  `mergedReviewBase`, the review base of an already merged branch. `server/git-diff.ts` imports it, and
  show-changes' `git.ts` shares it.
- `saved-sessions.ts` (builtins only, git by argv): the merge guard over saved sessions in a branch's history
  (§chat.saved-sessions/merge-guard). `mergeWorktree` runs it unless `allowSavedSessions`, which the tool passes only after the user
  confirms (`ctx.ui.confirm`, always; no UI or a decline merges nothing); Merge Branch
  (`server/project-worktrees.ts` `mergeBack`) imports the same scan and refusal.
- `spec.ts`: when a merge is recorded, it adds the landing's spec warnings to the merge note (changed files no claim
  maps, draft records left behind, hand-resolved §, orphaned evidence), in any project with a spec, mode on or off.

`create <name>` runs `git worktree add -b feat/<name>` at `<parent of the main checkout>/.worktrees/<repo>-<name>`
(AGENTS.md's worktree rule) and tracks it, so workers may start there. The dev watcher doesn't watch this directory: an edit reaches a running server only at
its restart.

## When you change it, also update

- The entry or the merge card's details: the README and Sova's readers in the same branch.
- `git.ts`'s `mergedReviewBase`: show-changes' tests too (`cd pi-config/extensions/show-changes && node --test git.test.ts`).
- `spec.ts`: [modes/spec](../../modes/spec/overview.md) (its MODE.md row).
- `saved-sessions.ts`'s marker: `shared/session-bundle.ts` SAVED_SESSION_MARKER and the merge round's
  `leak-scan.mjs` / `round.mjs` copies (a test pins the extension's to the split spelling).
