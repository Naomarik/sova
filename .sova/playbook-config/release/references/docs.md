# Sova's release: the Docs step

The `docs` step, before the release commit, runs in every release unless the operator's Release Note (the text after the line `---` followed by the line `Release Note from the operator (saved on the Releases tab):` in the message that started you, to its end; no such label, no note) says otherwise: "skip docs" makes it `skipped` (name the affected pages in the skip's summary when `docs-drift.mjs` lists any); "only these pages" narrows the list. An ask (the quoted `Asked by …` line) never changes it. A stale page never holds the release: ship, then fix in a docs-only update.

## The list
1. **The affected pages.** From the release worktree: `node .sova/playbooks/release/scripts/docs-drift.mjs --base vPREV --root . [--json]`. For each `§site.docs/<page>` record it compares the record and each claim in its `requires` at `vPREV` with the release worktree, and prints each Docs page (`site/src/content/docs/`) with its changed sources (`changed`, `new`, `removed`). It reads only the spec and always exits 0.
2. **New features with no page.** From the changed claims (the trusted spec tools' `foreign --base vPREV --head HEAD --root . --json`: its `changes` and `created`; and the `spec: promote` subjects since `vPREV`), name each shipped feature a user would look for that no `§site.docs/*` record requires.
3. Take every listed page and every new feature, unless the Release Note names only some: then those.

## The fixes
- **Re-check each page against its spec sources only**: its `§site.docs/<page>` record and the claims in its `requires`, read with the trusted spec tools (`read '<§id>' --no-frame`). Never read the app's source, and never run the app.
- **A new page for each new feature, by default.** Write the page under `site/src/content/docs/`, and its own `§site.docs/<page>` record, its `requires` the claims you read. A release entry carries no spec drafts, so the record is made official here, on the release branch: write it in a spec draft, run `node "$core/sova-spec-draft.mjs" promote <draft> --all --write` with the trusted core (`~/.pi/agent/extensions/spec/core`), then commit the claims files it wrote (`.sova/spec/claims/…` and the `.json` beside each, by explicit path) in a commit of their own, before the page's commit and the release commit. A promote that refuses: leave the feature without a page and say why.
- **One commit per page** on the release branch (explicit paths), never mixing pages, all before the release commit.
- **`docsVerified`** (`site/src/data/site.ts`): `sova-release.mjs stamp docs --rev <the commit checked, short>`, only when every listed page was re-checked and fixed. Otherwise it stays.
- Report the step `done`, never `held`: in `summary` the counts, in `detail` each page changed with its commit, each new page with its commit and its record's promote commit, each listed page left stale with why (the note left it out, not re-checked), and each new feature left without a page. Then go on to the next step. The same lists go in your final reply; a page the operator later refuses is a revert of its commit (`git revert`, a commit of its own) in a docs-only update.

The site build in the release checks (`references/checks.md`) fails on a page that names a spec ID or a source path.
