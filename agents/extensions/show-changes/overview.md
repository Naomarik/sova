---
watches: ["pi-config/extensions/show-changes/**", "src/lib/changes-steps.ts", "src/lib/changes-view.ts", "src/components/ChangesViewer.tsx"]
alsoUpdate: ["pi-config/extensions/show-changes/README.md"]
---
# show-changes

The read-only `show_changes` tool: it opens Sova's changes viewer on uncommitted work, a worktree branch or one
commit, optionally as agent-written steps. The browser imports its details check.

## What lives here

- [`README.md`](../../../pi-config/extensions/show-changes/README.md).
- Tests: `cd pi-config/extensions/show-changes && node --test details.test.ts git.test.ts coverage.test.ts && node tests/run.mjs`.

## What Sova relies on

- Each result's `details` `{v: 1, scope, title?, paths?, steps?}`, its scope named like `DiffScope` minus
  `sessionPath`. Sova reads it for the card that opens the changes viewer.
- `details.ts` (imports nothing): `SHOW_CHANGES_TOOL` and the strict check `normalizeShowChangesDetails`.
  `src/components/Thread.tsx` imports it at runtime; `src/lib/changes-view.ts` and
  `src/components/ChangesViewer.tsx` import only its types (`import type`, erased from the bundle). Vite bundles it
  for the browser, so it must import nothing at all.
- The tool refuses a diff of more than one hunk unless its steps place every hunk, with its own copy of the viewer's
  matching in `coverage.ts` (imports nothing). Sova places every hunk again when it draws the diff. The test
  `src/lib/show-changes-coverage.test.ts` imports `coverage.ts` to pin its matching to `src/lib/changes-steps.ts`'s.
- `git.ts` shares worktrees' `mergedReviewBase` (see [worktrees](../worktrees/overview.md)).

## When you change it, also update

- The details shape: `normalizeShowChangesDetails`, the README, and the web's reader in the same branch.
- Hunk matching in `coverage.ts` or `src/lib/changes-steps.ts`: the other one, then run
  `pnpm test -- src/lib/show-changes-coverage.test.ts`.
