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
- Tests: `cd pi-config/extensions/worktrees && node --test state.test.ts git.test.ts spec.test.ts landing.test.ts served.test.ts && node tests/run.mjs`.

## What Sova relies on

- The session's `worktrees` custom entry: the tracked set, a whole snapshot, newest on the branch wins. Its
  `worktree-merge` extension message is the merge card. Sova reads both, and so does the subagents spawn gate.
- `state.ts` (builtins only): the entry, its fold and the merge card's details. `server/worktrees-state.ts`
  imports it, as do the server's worktree and readiness modules
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

- `landing.ts` (builtins only): the user's go-ahead typed in the branch's own chat, `<state root>/landing.json`
  (`by: "owner-chat"`, with `withoutSpecs` / `withoutReview` as said, and the drafts as they were,
  §chat.worktrees/landing-answers). `worktree land` writes it (only on the user's newest message, read by
  `typedGoAhead`, and never one a sent marker names, `newestUserMessage`, §chat.worktrees/land-own-word); Sova's
  merge queue reads each new record once and approves the branch at that commit (`server/merge-queue/ingest.ts`).
  Older records of other kinds stay readable. Only in a repo the merge queue serves: there `worktree merge` into the
  queue's target is refused; in any other repo `merge` into main is plain and `land` is that same plain merge, recording nothing.
- `setup-rule.ts` (builtins only): what makes a branch a setup branch (the pipeline sections of `.sova/project.json`,
  a required service, the release playbook folder), its one home: `server/merge-queue/setup-branch.ts` re-exports it
  for the land gate and trials. Unserved, `merge` and `land` refuse a setup branch (merged only from its Setup card,
  after a passing trial), and refuse when Git can't tell.
- `served.ts` (builtins only): `<state root>/merge-served.json`, which repos the merge queue serves (`{v: 1, at, roots:
  [{root, target}]}`), written by the server alone (`server/merge-queue/served.ts`, which imports its name and type from
  here) and read afresh by `merge` and `land`; every chat Sova starts has `SOVA_CHAT_STATE_ROOT` (server/chat-host.ts); neither that nor `SOVA_CHAT_SOCK` (a terminal): not served; the socket alone, or a file absent or damaged: served (fail closed).

`create <name>` runs `git worktree add -b feat/<name>` at `<parent of the main checkout>/.worktrees/<repo>-<name>`
(AGENTS.md's worktree rule) and tracks it, so workers may start there. The dev watcher doesn't watch this directory: an edit reaches a running server only at
its restart.

## When you change it, also update

- The entry or the merge card's details: the README and Sova's readers in the same branch.
- `git.ts`'s `reviewBase`, `mergedReviewBase` or `REVIEW_LIMITS`: show-changes' tests too
  (`cd pi-config/extensions/show-changes && node --test git.test.ts`) and `server/git-diff.test.ts`; the
  tool and the viewer must keep choosing the same base and limits.
- `landing.ts`'s file shape: the merge queue's reader (`server/merge-queue/ingest.ts`) in the same branch.
- `setup-rule.ts`: the merge queue's land gate and trials follow it (`server/merge-queue/setup-trial.test.ts`).
- `served.ts`'s file shape or name: its writer (`server/merge-queue/served.ts`) in the same branch.
- `spec.ts`: [modes/spec](../../modes/spec/overview.md) (its MODE.md row).
