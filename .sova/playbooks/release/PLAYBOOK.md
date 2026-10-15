---
title: Release
description: Cut a numbered Sova release, then wait for the user's word to publish it and move stable.
---

# Release

You cut one numbered release of Sova, `vX.Y.Z`: prepare the release commit and its notes, run every check on it, put the live server on it, and then **stop**. Nothing reaches GitHub until the user says to publish. On that word you push the release commit, its numbered tag and the moved `stable` tag in one atomic push, publish the GitHub release page and deploy the site. Paths here are relative to this playbook's folder, except paths that start at the repository root (`scripts/`, `site/`, `CHANGELOG.md`, …), which are relative to the repository root. Run commands from the release worktree unless a step names the main checkout (`~/webapps/sova`, the live tree).

## The scheme
- **Numbered tags never move.** `vX.Y.Z` is annotated, created once on the release commit, and never re-pointed or deleted, even for a bad release.
- **`stable` is the one tag that moves.** It points at the newest release's commit. The installer's default ref is `stable` in every commit, so the published command (`…/Naomarik/sova/stable/scripts/install.sh`) and every re-run install whatever `stable` points at; `SOVA_REF=vX.Y.Z` pins one release. Moving `stable` is the only force-push allowed in this repository, and only as written here.
- **The release commit, `vX.Y.Z` and `stable` reach GitHub in one atomic push.** A release commit on GitHub's master without its tags would point the README and the site at a release that doesn't exist yet, and a moved `stable` without the commit would install a commit GitHub doesn't have.

## Read as you go
Read each detail file when the release reaches it, every release, never from memory:

| When | Read |
|---|---|
| Start: the version, the branch, the merge round paused | `references/prepare.md` |
| The per-release edits and the release commit | `references/prepare.md` |
| Optional, if the user opts in: the Docs pages whose spec sources changed | `references/docs.md` |
| The pre-release checks, then the live server on the release commit | `references/checks.md` |
| **Stop.** Then, on the user's word: push, release page, site, outside checks | `references/publish.md` |
| A bad release: move `stable` back | `references/rollback.md` |

## The order
1. Start (`references/prepare.md`): confirm the version with the user, ask them to pause the Merge round, make the release branch.
2. Per-release edits and the release commit (`references/prepare.md`).
   - Optional docs step (`references/docs.md`): list the Docs pages whose spec sources changed since `vPREV` and offer to update them; only on the user's yes, re-check them and give the fixes for review, one page per step. A stale page never holds the release.
3. Pre-release checks on the release commit, then the live server restarted onto it (`references/checks.md`).
4. **Stop.** Report to the user: the release commit, the checks and their results, the notes, every Docs page changed and every page left stale with why (`references/docs.md`), and what publishing will do. Wait for their explicit word to publish. "Looks good" about the notes is not that word; ask.
5. Publish (`references/publish.md`): the atomic push, the `ls-remote` check, the GitHub release page, the site deploy, then the optional outside checks the user may choose to run.

## Ask the user first
- The version number, at the start.
- Pausing the Merge round for the release, and resuming it afterwards.
- The restart of the live server onto the release commit while any session is busy.
- **Publishing.** Every step in `references/publish.md` waits for the user's explicit word, given after the stop at step 4. That word covers the push, the release page and the site deploy of this release, nothing more.
- Where the site is hosted and how to deploy it, the first time (record the answer in `site/README.md`, "Deploy").
- Whether to update the affected Docs pages in this release, and which new features get a page (`references/docs.md`); which page fixes to take.
- Any of the optional outside checks: the user decides whether to run them.
- Rolling back, each time.

## Never
- Land the release branch in master through the Merge round, or push master on its own, before `vX.Y.Z` and `stable` exist on GitHub. The release branch is published only by the atomic push in `references/publish.md`.
- Move or delete a numbered tag. Force-push anything but `refs/tags/stable`, and that only with `--force-with-lease` naming the value you read from GitHub (or the empty value, the first time).
- Push with `--tags`, `--all`, `--mirror`, or a bare `--force`.
- Publish, deploy the site or move `stable` before the user's word at step 4.
- Run `systemctl restart` yourself, except the delayed form AGENTS.md allows.
- Edit `docsVerified` in `site/src/data/site.ts` unless the user opted into the docs step and every listed page was re-checked and its fix accepted (`references/docs.md`).
