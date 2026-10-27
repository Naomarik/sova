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
- Tests: `cd pi-config/extensions/worktrees && node --test state.test.ts git.test.ts spec.test.ts landing.test.ts && node tests/run.mjs`.

## What Sova relies on

- The session's `worktrees` custom entry: the tracked set, a whole snapshot, newest on the branch wins. Its
  `worktree-merge` extension message is the merge card. Sova reads both, and so does the subagents spawn gate.
- `state.ts` (builtins only): the entry, its fold and the merge card's details. `server/worktrees-state.ts`
  imports it, as do the server's worktree, merge-board and readiness modules
  (`git grep -n "extensions/worktrees/" -- server`).
- `git.ts` (builtins only, git by argv): the extension's own "is this branch merged" probe, and the
  one review-base rule both diff engines share: `reviewBase(git, root, {head, branch, tracked})`
  (tracked base branch → master → main → origin/HEAD's branch, each skipped when it is the current
  branch or shares no history; a merged branch via `mergedReviewBase`; else the tracked created-from
  commit; else a refusal kind `detached | on-base-branch | no-history | no-base`) and
  `REVIEW_LIMITS` (git timeout, file cap, patch and untracked caps). `server/git-diff.ts` and
  show-changes' `git.ts` both import them (§chat.changes/endpoint, §chat.changes/show-changes-tool).
- `spec.ts`: when a merge is recorded, it adds the landing's spec warnings to the merge note (changed files no claim
  maps, draft records left behind, hand-resolved §, orphaned evidence), in any project with a spec, mode on or off.

- `landing.ts` (builtins only): the user's answers on a branch's Landing card, and their go-ahead typed in
  the branch's own chat, `<state root>/landing.json` (Land It, a typed go-ahead `by: "owner-chat"`, the
  captain's `go` `by: "captain-chat"`, or Not Yet per branch and commit, each with an optional `in`, the
  session it was given in: additive, §chat.worktrees/landing-answers). Sova writes it (a click on the owner's
  card or the captain's row, `server/session-offers.ts`), so does the driver's `go` (`recordCaptainGoAhead`),
  so does `worktree land` (only on the user's newest message, read by
  `typedGoAhead`), and the merge round's driver reads it (a typed one also wakes the captain's merge-ready
  schedule, `server/schedules.ts`), carrying an answer over
  clean master merges itself (`round.mjs` `cleanMergeParent`, `landingAnswerAt`). Nothing enforces it:
  `worktree merge` needs no go-ahead. `answerAt`'s newest-answer rule has a copy in the driver
  (`landingAnswer`), held equal by `server/merge-round-rules.test.ts`: change both together.

`create <name>` runs `git worktree add -b feat/<name>` at `<parent of the main checkout>/.worktrees/<repo>-<name>`
(AGENTS.md's worktree rule) and tracks it, so workers may start there. The dev watcher doesn't watch this directory: an edit reaches a running server only at
its restart.

## When you change it, also update

- The entry or the merge card's details: the README and Sova's readers in the same branch.
- `git.ts`'s `reviewBase`, `mergedReviewBase` or `REVIEW_LIMITS`: show-changes' tests too
  (`cd pi-config/extensions/show-changes && node --test git.test.ts`) and `server/git-diff.test.ts`; the
  tool and the viewer must keep choosing the same base and limits.
- `landing.ts`'s file shape: Sova's writers and readers above and
  `.sova/playbooks/merge-round/scripts/round.mjs` (its `parseLanding`) in the same branch.
- `spec.ts`: [modes/spec](../../modes/spec/overview.md) (its MODE.md row).
