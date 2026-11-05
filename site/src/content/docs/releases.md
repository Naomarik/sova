---
title: Releases
description: Cut a numbered version of a project from its Releases tab. A release chat follows the project's release playbook; Sova holds the main branch, runs the release checks, and publishes only when you say so.
group: Features
order: 10.6
---

A **release** cuts and publishes a numbered version of a project, such as `v0.10.0`: a name others
install from, check for updates against, or read a release page for. Once it's public, a numbered
version is never moved or deleted. A release isn't a deploy: you can [deploy](#after-publish) a
release afterwards.

The work is split two ways. The project's **release playbook** does the work, step by step, in a
**release chat** Sova starts for it: it picks the number, writes the notes, makes the release
commit, and runs what comes after publishing. **Sova holds what can't be undone**: the main branch
while the release is open, the release checks, Publish and Withdraw.

## Set up releases

Releases are off until a project is set up for them. On the project page's **Releases** tab,
**Set Up Releases** starts a chat that reads the project (its version tags, the files that hold its
version, its changelog, its remotes and checks) and asks you how it releases: the version rule, the
notes, the channel, each step and who does it, the checks only a release runs, a live try-out, and
what happens after publishing. It then proposes a release playbook and a `release` section of the
project's `.sova/project.json` on a branch, which you review and **Land**. [Release
settings](/docs/release-settings/) says what each holds.

## Start a release

**Start Release** on the Releases tab opens the release chat in a worktree of its own. From then
until you publish or abandon, the project's [merge queue](/docs/merge-queue/) is frozen for the
release: only the release's own commit lands, nothing is pushed, and every other branch waits in
line ("waits for v0.10.0 to be published or abandoned").

**Release Note**, beside Start Release, saves your instructions for the next release ("Release as
0.10.1", "skip docs"), up to 4,000 characters. While a note is saved the tab shows it under its
head. Start Release stays one click: it sends the note to the release chat as your instructions,
then clears it, and a version it names wins over the playbook's own rule. When the Overseer, the
project's overseer or the Project Assistant asked for the release, the chat gets their reason too,
as background only: it never picks the version or skips a step. A started release shows the note it
got and who asked.

The tab lists the release's steps in order, each with its state (Waiting, Running, Done, Failed,
Skipped, **Held for you**) and the chat's one-line summary. Sova checks what it can see for itself,
such as that the version's tag doesn't exist yet or that the commit is on the release branch, and
where a report and a fact disagree, the fact wins. **Open Release Chat** opens the chat; it's an
ordinary chat you can talk to.

- **Held for you.** A step the playbook holds, such as trying the release on the live server,
  waits for your **Continue**.
- **Failed.** **Retry Step** runs it again.
- **Quiet.** When the release chat goes quiet for too long, Needs you says "No word from the release
  chat for {n} min".

## The release checks

The release commit goes through the merge queue first in line. It runs the project's usual checks,
then the checks the release settings add, and lands on the main branch **without a push**. A
failed check holds Publish: the chat fixes it with a new commit, or you abandon. Nothing overrides
a failed check.

## Publish

Once every step before it is done or skipped, the checks passed, the notes are written and the
version is set, the release reads **Ready to publish** and Needs you lists it. **Publish**, after a
confirm, does it all or nothing: it makes the numbered tag at the release commit with the notes as
its message, moves the channel (such as `stable`) to it, and pushes the main branch, the tag and the
channel to `origin` in one step. A project with no `origin` tags and moves its channel on this
machine only.

<!-- screen: release-publish | Publish's confirm on the Releases tab: what goes out to origin in one step, and that the numbered tag is never moved or deleted. -->

If Publish fails, every local change is put back, the release stays Ready, and the step reads
**Publish failed** with why. **Retry Publish** tries again. Publish lifts the freeze: the waiting
branches land and push as usual.

**Abandon Release** stops a release that isn't published. A release commit that already landed is
undone by a revert that lands through the queue, never by resetting anything; no tag is made.

## After publish

The release chat then runs the playbook's after-publish steps, such as making the release page.
One that fails is reported, and never undoes the publish.

For each deploy target the project declares, the release offers **Plan Deploy of {tag}**, which
plans that target at the release's commit. A deploy target can take releases only, refusing any
commit that isn't a published, not withdrawn, release. Each Deploy row says which release it runs.

## Withdraw

**Withdraw**, with a reason, takes back a published release. Its channel moves back to the newest
older release that isn't withdrawn, and Sova marks the release withdrawn where every copy can see
it. The numbered tag itself never moves and is never deleted, so anyone who pinned it keeps it. A
copy of Sova following that channel is told in Settings → Updates and offered to go back.
Deployed targets are not rolled back: that stays on the Deploy card.

## The overseer and the release power

A project overseer can release only with its **Release** power switched on. It may then start a
release, and publish one whose every check passed, after the project's waiting period, which you
can cancel from Needs you. It never overrides a failed check. The Project Assistant can only ask
you to release; its request shows in Needs you.

## The history

The Releases tab lists every numbered version, newest first, with its notes, whether it was
withdrawn, and which deploy targets run it. Its strip shows the latest release and how many
landings came since.

<!-- screen: releases-tab | A project's Releases tab with no release open: the latest release and the landings since, Release Note and Start Release, and the history of published releases. -->
