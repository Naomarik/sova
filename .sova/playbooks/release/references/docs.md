# Release: the optional docs step

Between step 2 and step 3, and only if the user opts in. It never runs on its own, and a stale page never holds the release: ship, then fix.

## The offer
1. **List the affected pages.** From the release worktree, with the release commit made: `node .sova/playbooks/release/scripts/docs-drift.mjs --base vPREV --root . [--json]`. It compares, for each `§site.docs/<page>` record, the record and each claim in its `requires` at `vPREV` against the release worktree, and prints each Docs page (`site/src/content/docs/`) with its changed sources (`changed`, `new`, `removed`). It reads only the spec and always exits 0.
2. **Name new features with no page.** From the changed claims (`node pi-config/extensions/spec/core/sova-spec.mjs foreign --base vPREV --head HEAD --root . --json`: its `changes` and `created`, which read the records in either layout; and the `spec: promote` subjects since `vPREV`), name each shipped feature a user would look for that no `§site.docs/*` record requires.
3. **Ask the user**, once, with both lists: update these pages in this release, and give which new features a page? No answer, or no: skip the step, and carry both lists to the report at step 4.

## On yes
- **Re-check each listed page against its spec sources only**: the page's `§site.docs/<page>` record and the claims in its `requires`, read with the trusted spec tools (`read '<§id>' --no-frame`). Never read `src/`, `server/` or `pi-config/`, and never run the app. A new page for a feature the user named: its own `§site.docs/<page>` record through a spec draft, its sources the claims you read.
- **Fix each page in its own commit** on the release branch (explicit paths), before the release commit is made again; never mix pages. Then run the site build (`references/checks.md` 5), which fails on a spec ID or a source path in a page.
- **The user reviews them as their own set**: one step per page in the changes viewer (`show_changes`), apart from the release's other changes, before publishing. The user takes all, some or none; revert each page they refuse (`git revert`, its own commit) and list it as stale.
- **`docsVerified`** (`site/src/data/site.ts`): set it to `{ ref: "vX.Y.Z", rev: <the commit checked, short>, date: <today> }` only when every listed page was re-checked and the user accepted every fix. Otherwise it stays.
- Then make the release commit again (`references/prepare.md`) and run the checks on it.

## The report (step 4)
Name every Docs page this release changed, and every listed page left stale with why (not offered, declined, refused at review, not re-checked), and each new feature left without a page. Those follow in a docs-only update after the release.
