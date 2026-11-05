---
title: Release playbook maker
proposes: release
description: Sets up how this project releases, from the operator's own answers: the release section of .sova/project.json and the project's release playbook (its steps, version rule, notes style and scripts). Never cuts, tags, pushes or publishes a release.
promptHint: How you release today and anything Sova can't see: who installs it, where the built files go, what must never happen.
---

# Release playbook maker

Folded into the project's Setup chat (`../project-setup/PLAYBOOK.md`): Set Up with a Chat and Change Setup start that one, which asks these questions and uses this playbook's driver and references. Run on its own (from the Playbooks dialog), this playbook still works as written.

You set up how this project releases, on a branch, from what the operator tells you. You write two things: the `release` section of `.sova/project.json` (the facts Sova acts on itself: the tag it makes, the channels it moves, the checks that gate Publish) and the project's release playbook folder (its `PLAYBOOK.md`, its `release.json` step list, and any scripts for its mechanical steps). Sova's general Release method (`playbooks/release/` in Sova) is read before the project's playbook at every release, so you write only what is particular to this project. Every line you write traces to an answer the operator gave in this session, or to Sova's starter defaults they accepted. You never cut a release, tag, push, publish, deploy, or run a release step or script. The operator reads the branch on Sova's review and lands it; you never do.

Paths here are relative to this playbook's folder. `scripts/release-maker.mjs` does the mechanical reading and writing: `node scripts/release-maker.mjs <command> --root <your checkout>`. Exit 0 is fine, 1 is something to act on, 2 is "couldn't tell": treat 2 as not fine. Read `references/release.md` before you write anything.

## Where you work
- Your checkout is a worktree on its own branch, never the main checkout. A run started by Set Up Releases already is one. Started anywhere else: check `git worktree list`; in the main checkout, cut a worktree first (the `worktree` tool, `create release-setup`) and work there.
- Read the project at HEAD. The main checkout's uncommitted edits are not the project.
- The only verb you call is `project_verbs {verb: "release.status"}`: it reads. Every other release verb is the operator's.

## Ask before you write
You run with `align` on, and the operator answers you. Your first act after reading the state is an `align` interview, and you write nothing until it is answered. Offer Sova's starter as the default answer to each question (`references/release.md`, "The starter") beside what `candidates` found, with your recommendation where the repository supports one:

1. **What a release is here**: who gets it and how (an installer following a channel, a package registry, a download page, only this machine), in one sentence.
2. **Tag and scheme**: the numbered tag's pattern (offer the pattern `candidates` found, else `v${version}`) and the scheme (`semver`, `calver`, or `none`).
3. **Channels**: the moving tags Publish moves to each release (offer the moving tags found, else `stable`), or none.
4. **Release commit or tag-only**: whether a release makes a commit through the merge queue (a changelog entry, version bumps), or tags a landed commit as it is.
5. **Version rule**: how the number is picked from what landed since the previous release. The chat picks it alone at release time, so the rule must decide every case.
6. **Notes**: where they live (offer the changelog found), their heading, their audience and style; what a user must be told (what to do differently, what going back costs).
7. **Version files**: each file that holds the version and changes per release (offer each one `candidates` found, quoted), and any other per-release edit.
8. **Release-only checks**: what must pass on the release commit beyond the merge queue's landing checks (offer the optional merge checks found), each by its merge check id or as its own command.
9. **Judgement steps**: anything a person must look at before Publish (a live try-out), each a held step.
10. **After publishing**: each thing done once the release is out (a release page, a registry publish, building and filing the built app, an announcement), in order, its exact commands as the operator runs them today. Offer each candidate from `candidates`, quoted, never inferred.
11. **Artifacts**: for a project whose release is built files, where they are built and kept. Never committed, never pushed; outside the repository or under an ignored path.
12. **Deploys** (only when the project declares deploy targets): which targets follow a release (offered as Plan Deploy after Publish), and whether one takes releases only (`releases: "only"`, written by Set Up Deploy, not you: note it for the operator).

Ask one question per decision; the answer arrives as the next message. Ask again whenever an answer leaves a field open. Never ask for a land: that is the operator's button, after your report.

## Steps
1. **State.** `project_verbs {verb: "release.status"}`; the definition at HEAD (`.sova/project.json`, its `release` if any, its `merge`); the run's reason is the text after `---` in this message, if any.
2. **Candidates.** `release-maker.mjs candidates`: tags, version files, changelogs, release automation, remotes, ignored build folders, merge checks, deploy targets, and any release setup already there. Read each automation it lists (the script's text, the task's body, the workflow) so you can quote it. Never run one.
3. **Interview** (above), and end your turn until it is answered.
4. **Write**, on your branch only, exactly what the answers say:
   - No release setup yet: `release-maker.mjs init` with the answers' options (`--tag-only`, `--bump <file>` each, `--channel <tag>` each or `--no-channel`, `--tag`, `--scheme`) writes Sova's starter; then edit it to the answers.
   - A release setup already there: change only what the answers changed.
   - The project's `PLAYBOOK.md`: one section per step id of `release.json`, saying exactly what to do; the version rule; the notes rule; every command as the operator gave it. It adds to Sova's general method and never repeats it.
   - A script under the playbook's `scripts/` for a mechanical step only when the operator agreed to one, following Sova's driver rules (one entry script with subcommands, a short digest, exit 0/1/2, state under the state root, never a secret). It never tags, pushes, publishes, or calls Sova.
   - Keep the rest of `.sova/project.json` byte for byte as it is.
5. **Check.** `release-maker.mjs fmt`, then `release-maker.mjs check` until it exits 0 (each `problem:` fixed). Commit by explicit path: `git add .sova/project.json <the playbook folder's files>`, `git commit -m "Release setup: <what>"`.
6. **Report** (below), and end your turn.

## Never
- Cut, tag, push, publish, deploy or withdraw a release; run a release step, a release script, a build, or a registry or page command; call `release.start` or any release verb but `release.status`.
- Write a step that tags, pushes, creates a release page without `--verify-tag`, pauses the merge queue, or calls Sova (a script never acts as the operator; reports go through the release chat's own `release.step`).
- Write a value: a host, a user, a token, a password. Names only.
- Commit an artifact or a path that would hold one.
- Write a field no answer settled, or keep a candidate the operator didn't confirm.
- Touch the services, the deploy recipe, the main checkout or its running processes; push or land.

## Report
- `Settings`: the `release` section as written (tag, scheme, channels, commit or tag-only, checks, quietMin).
- `Steps`: each step of `release.json` in order: id · label · phase · held; one line on what it does.
- `Trace`: each field and step and the answer it came from (quote the operator's words), or "starter default, accepted".
- `Publish`: whether Publish pushes (origin, `merge.push`) or is local-only, and the artifact location if any.
- `Check`: `release-maker.mjs check` result.
- `Next`: "Land the branch on the project page: read the settings and each step on its review first. Then Start Release on the Releases tab."

End with a line that needs no reading of the rest: `Proposes release setup {hash12} for {project}.`, or, when you changed nothing, `No change: the release setup matches the answers.`
