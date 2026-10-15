# Release: start, per-release edits, the release commit

Steps 1 and 2. Paths that start at `scripts/`, `site/`, `docs/` or a root file are relative to the repository root.

## 1. Start
- **The version.** The previous release is the newest numbered tag: `git tag --list 'v[0-9]*' --sort=-v:refname | head -n 1` (call it `vPREV`). Propose the next number (a patch for fixes only, a minor for features while Sova is 0.x) and confirm it with the user. Everything below writes it as `vX.Y.Z`, and `X.Y.Z` without the `v`.
- **`stable` on GitHub.** `git ls-remote origin 'refs/tags/stable' 'refs/tags/stable^{}'`. Nothing printed: this is the first release that moves it (v0.2.0 was). Otherwise its `^{}` line must be `vPREV`'s commit (`git rev-parse 'vPREV^{commit}'`); if it isn't, `stable` was rolled back or moved by hand: tell the user and wait.
- **Master is clean and published.** In the main checkout: `git status --porcelain` prints nothing, and `git fetch origin && git rev-parse master origin/master` prints the same commit twice. Uncommitted edits in the live tree block a release (AGENTS.md).
- **Pause the Merge round.** Ask the user to pause its schedule for the release, and if a merge captain session is live, tell it on its topic: "Release vX.Y.Z in progress: land nothing and push nothing until I say it is published." From step 3 on, the live tree's master holds the unpublished release commit, and the round's `git push origin master` would publish it without its tags. Resume it (the user does) only after step 5's push, or after the release is abandoned and master is back to `origin/master`.
- **The release branch.** A worktree of its own from master: `worktree create release-vX.Y.Z` (branch `feat/release-vX.Y.Z`), or `git worktree add ~/webapps/.worktrees/sova-release-vX.Y.Z -b feat/release-vX.Y.Z master`, then `mise trust` it and `pnpm install --frozen-lockfile`. If the merge board lists it and its owner is asked, the answer is `NOT READY: a release branch, published only by the release playbook`.

## 2. Per-release edits
Make these in the release worktree:
- **`CHANGELOG.md`**: a new entry at the top, `## vX.Y.Z — YYYY-MM-DD`, the date of the release commit (UTC). If an entry for `vX.Y.Z` already exists with the `RELEASE-DATE` placeholder (v0.2.0's did), replace only the placeholder with the date; never add a second `## vX.Y.Z` heading. Highlights written by hand for someone who installed `vPREV`, grouped like the entries before it: read `git log --oneline vPREV..HEAD`, the merged branches (`git log --merges --format=%s vPREV..HEAD`) and the `spec: promote` subjects at a high level; never paste a commit list. Name what a user must do differently, and end with what going back to `vPREV` costs when this release changed stored settings or sessions (`references/rollback.md`).
- **`package.json`**: `"version": "X.Y.Z"`. The Mesh page shows it for every host; nothing asserts it.
- **`site/src/data/site.ts`**: `release = "vX.Y.Z"` (the hero pill and its release-page link). `installRef` stays `"stable"`.
- **The landing's `verified` stamp** (`site/src/data/site.ts`): only after re-checking every claim on `site/src/pages/index.astro` (and the components and data it renders) against the release branch, as `site/README.md` "What to update" says: set `{ ref: "vX.Y.Z", rev: <the commit you checked, short>, date: <today> }`. A claim you could not check stays stale: name it in the report rather than re-dating the stamp.
- **`docsVerified`** is the Docs pages' stamp: change it only through the optional docs step (`references/docs.md`), after the user opted in and accepted every listed page. Otherwise leave it, and say so in the report.
- **Pinned-version examples**: `git grep -n 'SOVA_REF=v[0-9]' -- README.md docs site/src` and set each to `vX.Y.Z`.
- **Version-gated wording**: `git grep -n 'vNEXT'` and replace each with `vX.Y.Z` (a doc that says "from vNEXT or later" about a feature this release ships).
- Nothing in `scripts/install.sh` changes per release: its default is `stable` in every commit.

## The release commit
One commit on the release branch: `git add` the files above by explicit path (never `git add -A`), then `git commit -m "Release vX.Y.Z"` with the attribution lines the session uses. A release that also carries other changes (v0.2.0 carried the switch to `stable` itself) keeps them in their own commits before it. The commit you will tag is the release branch's head: `sha=$(git rev-parse HEAD)`. Use `"${sha}"` with braces in every command: in zsh, `$sha:r…` is a history modifier.

Leave the date as it is if the user's word to publish comes on a later day: it is the date of the release commit, and changing it now would change the commit the checks ran on.
