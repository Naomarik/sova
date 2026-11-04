# Sova's release: the optional Docs step

The `docs` step, before the release commit, and only when the release's start reason asks for the Docs pages. Otherwise the step is `skipped`. A stale page never holds the release: ship, then fix in a docs-only update.

## The list
1. **The affected pages.** From the release worktree: `node .sova/playbooks/release/scripts/docs-drift.mjs --base vPREV --root . [--json]`. For each `§site.docs/<page>` record it compares the record and each claim in its `requires` at `vPREV` with the release worktree, and prints each Docs page (`site/src/content/docs/`) with its changed sources (`changed`, `new`, `removed`). It reads only the spec and always exits 0.
2. **New features with no page.** From the changed claims (the trusted spec tools' `foreign --base vPREV --head HEAD --root . --json`: its `changes` and `created`; and the `spec: promote` subjects since `vPREV`), name each shipped feature a user would look for that no `§site.docs/*` record requires.
3. When the start reason asks only for some pages, take those; otherwise every listed page. A new feature gets a page only when the start reason names it.

## The fixes
- **Re-check each page against its spec sources only**: its `§site.docs/<page>` record and the claims in its `requires`, read with the trusted spec tools (`read '<§id>' --no-frame`). Never read the app's source, and never run the app. A new page for a named feature: its own `§site.docs/<page>` record through a spec draft, its sources the claims you read.
- **One commit per page** on the release branch (explicit paths), never mixing pages, all before the release commit.
- **`docsVerified`** (`site/src/data/site.ts`): `sova-release.mjs stamp docs --rev <the commit checked, short>`, only when every listed page was re-checked and fixed. Otherwise it stays.
- Report the step `held`: in `summary` the count, in `detail` each page changed with its commit, each listed page left stale with why (not asked for, not re-checked), and each new feature left without a page. End your turn. The operator reviews the page commits on the release branch and Continues; a page they refuse they say so in the chat: revert its commit (`git revert`, a commit of its own), undo the `docsVerified` stamp the same way, and list it as stale in your final reply.

The site build in the release checks (`references/checks.md`) fails on a page that names a spec ID or a source path.
