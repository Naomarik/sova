---
title: Release (Sova)
description: Sova's own release: how its number is picked, its changelog entry, the places its version lives, the landing page's re-check, the optional Docs pages, the live try-out, and the GitHub release page. Read after Sova's general Release method; it wins where they differ, except Sova's gates.
---

# Release (Sova)

Sova's additions to the general Release method, which you read first. (Until a follow-up landing, once the live Sova runs the parser that knows them, Sova's `release` settings and its `site` deploy target wait in `project-sections.json` beside this file, not in `.sova/project.json`: Sova's releases are not set up before then.) The steps are `release.json` in this folder, in order. Sova's settings (`.sova/project.json` → `release`): tag `v${version}`, semantic versions, the one channel `stable`, a release commit. Publish (the operator's) makes `vX.Y.Z`, moves `stable` and pushes master, the tag and `stable` to GitHub in one atomic push; Withdraw moves `stable` back. You do neither, and never pause or resume the merge queue: the release freeze holds it.

Paths here are relative to this folder, except those that start at the repository root (`CHANGELOG.md`, `package.json`, `site/…`, `docs/…`), which are relative to the release worktree. Run every command from the release worktree; never from the main checkout (`~/webapps/sova`, the live tree) and never against it. `sova-release.mjs` is `scripts/sova-release.mjs` here: run it as `node .sova/playbooks/release/scripts/sova-release.mjs …`; its header lists every subcommand. The general method's `release.mjs` (`status`, `notes`) lives in Sova's own Release method folder.

## The scheme
- **Numbered tags never move.** `vX.Y.Z` is made once, by Publish, on the release commit. A bad release is withdrawn, never re-tagged.
- **`stable` is the one tag that moves.** The installer's default ref is `stable` in every commit, so the published install command, and every re-run of it, installs whatever `stable` points at; `SOVA_REF=vX.Y.Z` pins one release. Settings → Updates follows `stable` too. Only Publish and Withdraw move it.
- **The site is a deploy target, not a step.** The landing page and Docs are `site` on the project's Deploy card, shipped by the operator's Plan Deploy after Publish (it takes only a published release's commit). You never deploy it; your final reply reminds the operator.

## Version rule
Sova is 0.x. The previous release is `node .sova/playbooks/release/scripts/sova-release.mjs prev` (`vPREV`). A **patch** when everything since `vPREV` is a fix; a **minor** when anything adds a feature or changes what a user sees or must do; never a major while 0.x. The general method's `release.mjs status` suggests one from the commit subjects; read the merged branches yourself (`git log --merges --format=%s vPREV..HEAD`) before you take it. Pick it yourself, never ask; say why in the step's summary.

## Steps
- `version`: the number, by the rule above. Report it with `version=X.Y.Z`.
- `notes`: a new entry at the top of `CHANGELOG.md`, `## vX.Y.Z — YYYY-MM-DD`, the date you make the release commit (UTC). If an entry for `vX.Y.Z` already exists with a placeholder date, replace only the placeholder; never a second heading. Highlights by hand for someone who installed `vPREV`, grouped like the entries before it: read the general method's `release.mjs notes` material (first-parent subjects, merged branches, `spec: promote` subjects) at a high level; never paste a commit list. Name what a user must do differently, and end with what going back to `vPREV` costs when this release changed stored settings or sessions. Then send the same text with `release.notes` (Publish needs it; Sova puts it on the tag and the Releases tab). The `release-notes` check confirms the entry.
- `bump`: `sova-release.mjs bump --version X.Y.Z` sets `package.json`'s version (the Mesh page shows it), `release` in `site/src/data/site.ts` (the hero pill and its release-page link; `installRef` stays `"stable"`), each pinned `SOVA_REF=v…` example in `README.md`, `docs/` and `site/src/`, and each `vNEXT` there (a page that says "from vNEXT" about a feature this release ships). Run it with `--check` first and read what it will change. Nothing in the installer changes per release.
- `stamps`: re-check every claim on the landing page (`site/src/pages/index.astro`, and the components and data it renders) against the release worktree, as `site/README.md` "What to update" says. When every claim holds: `sova-release.mjs stamp landing --version X.Y.Z --rev <the commit you checked, short>`. A claim you could not check stays: fix it in its own commit, or leave the stamp and name the claim in the summary (`done`, "landing stamp left: …"). Never re-date the stamp over a claim you didn't check.
- `docs`: **skipped** unless the release's start reason (the text after `---` in the message that started you) asks for the Docs pages. When it does, follow `references/docs.md`: list the pages whose spec sources changed, fix each in its own commit, then report the step `held` with the list of pages changed and left stale; the operator reviews them and Continues. `docsVerified` changes only there. Skipped: name the affected pages in the skip's summary when `docs-drift.mjs` lists any.
- `commit`: one commit on the release branch, `git add` by explicit path (`CHANGELOG.md`, `package.json`, `site/src/data/site.ts` and each file `bump` changed; never `git add -A`), message `Release vX.Y.Z` with the session's attribution lines. Other changes the release carries (a docs page, a fix) stay in their own commits before it. Report it with `version=X.Y.Z`, `commit=<full sha>` and `branch=<the release branch>`, then end your turn: Sova queues it. After a fix for a failed check, make the release commit again only if its files changed, and report `commit` again with the new sha. Leave the entry's date as it is if Publish comes on a later day.

## Check (after Sova's checks passed)
- `try-live`: the release commit has landed on master, frozen there; the main checkout is on it. The live server picks it up only on a restart, which is the operator's: report the step `held`, summary "Ready for Apply on the Services tab, then a few minutes of use", and end your turn. Never restart the server yourself. When you are woken after their Continue, `sova-release.mjs live-check --commit <the release commit>` must exit 0 (the live server's `/api/health` head is the release commit); if it doesn't, say so in your reply: the operator's Continue already marked the step, and the fact is theirs to weigh before Publish.

## After publishing
- `release-page`: the GitHub release page, made only now that Publish pushed the tag:
  ```sh
  notes="${TMPDIR:-/tmp}/sova-release-notes-vX.Y.Z.md"
  node .sova/playbooks/release/scripts/sova-release.mjs notes-out --version X.Y.Z --out "$notes"
  gh release create vX.Y.Z --verify-tag --title "Sova vX.Y.Z" --notes-file "$notes" --latest
  rm "$notes"
  gh release view vX.Y.Z --json url,isLatest
  ```
  The notes file is throwaway, so it goes in the temp dir, never `~/.cache` (inside the sandbox that is a private copy nobody else sees).
  `--verify-tag` refuses when the tag isn't on GitHub: report `failed` with that, never make the tag. Done: `url=<the page>`. A project copy without `gh`'s login: `failed`, "gh is not logged in", for the operator.
- `outside-checks`: offer these, run none on your own, report the step `held` with the list; the operator says in the chat which to run (or Continues to skip them all), and you report what each showed in your final reply:
  - a clean install from the public command, after GitHub's cache of the raw script expires (5 minutes, or append `?nocache=<n>`), in fresh containers (Debian, Fedora, Alpine with `apk add bash`; git, curl, unzip and Node ≥ 22.19 installed): `curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/stable/scripts/install.sh | bash -s -- --no-service --no-app-entry`, then start `sova` and read `/api/health`: its `head` is the release commit. Never against this machine's real home;
  - an existing install updates: on a machine that installed `vPREV` by the public command, a re-run says "installed stable (<short sha>)";
  - after the operator's site deploy: the live landing shows `vX.Y.Z` in its pill, linking to the release page, and the `stable` install command; `/docs/install/` shows it too.

## After a Withdraw
- `release-page-withdrawn`: Sova already moved `stable` back to the previous release and gives you the reason. Then:
  ```sh
  gh release edit vX.Y.Z --latest=false
  gh release edit vPREV --latest
  ```
  (`vPREV` is the release `stable` points at now; skip the second line when it has no page.) Then add one line at the top of the bad release's page notes, through `gh release edit vX.Y.Z --notes-file <file>` with the page's current notes behind it: withdrawn, when, why, and what a user who goes back should expect from settings and sessions this release changed (read its notes for stored-format changes; whether to back up `~/.pi/agent/sova/` first). The numbered tag stays; anyone who pinned it keeps it. Done: `url=<the page>`. Remind the operator in your reply that the site's pill still names the withdrawn release until they redeploy `site` from `vPREV` (or leave it until the fix release).

## Release-only checks
`references/checks.md`: what each of the settings' `release.checks` runs and why. The site build is one of them; its deploy is not.

## Your final reply
The version and why, each step and how it ended, every Docs page changed or left stale, any landing claim left unchecked, any check found flaky, and two reminders for the operator: Plan Deploy of `site` for this release, and Settings → Updates on a copy that follows `stable`.
