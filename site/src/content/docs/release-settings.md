---
title: Release settings
description: How a project releases lives in its own files, the release section of .sova/project.json and the release playbook's step list, plus a Release Note you save on the Releases tab for the next release.
group: Features
order: 10.65
---

[Releases](/docs/releases/) have no tab in Settings. How a project releases is kept in two places
in the project itself, so everyone who works on it releases the same way, and changes to them land
through the [merge queue](/docs/merge-queue/) like any other change. The one setting kept outside
the project's files is the **Release Note**, for the next release only.

**Set Up Releases**, on the project's Releases tab, writes both for you: a chat reads the project,
asks how it releases, and proposes them on a branch you review and Land.

## The `release` section

The `release` section of the project's `.sova/project.json` holds only the facts Sova acts on
itself, so nothing a playbook says can change what Publish pushes. Sova reads it from the main
branch, never from your folder. Without the section, the project's releases aren't set up.

| Key | What it says | Default |
| --- | --- | --- |
| `playbook` | The folder of the project's release playbook. Required | |
| `tag` | The numbered tag's pattern, holding `${version}` once | `v${version}` |
| `scheme` | How a version is checked: `semver` (X.Y.Z), `calver` (YYYY.MM, an optional day and number) or `none` | `semver` |
| `channels` | Up to 3 moving tags Publish moves to the new release, such as `stable` | none |
| `commit` | `true`: the release makes a commit that lands through the queue. `false`: it tags the main branch as it stands, and commits nothing | `true` |
| `checks` | Up to 20 checks only a release runs, after the queue's usual ones: a merge check's id, or a check declared here | none |
| `quietMin` | Minutes without word from the release chat before Needs you says so, 5 to 1,440 | 30 |

No key names a remote. Publish pushes to `origin` when the project has one and its merge settings
don't turn pushing off; otherwise it tags on this computer only.

A file that doesn't read (an unknown key or a wrong value) stops every release until it's fixed, and
the Releases tab says what is wrong. A change counts from the next **Start Release**; a release
already started keeps what it began with.

## The playbook's steps

The playbook folder holds `release.json`, the release's steps in order, up to 30. Each step has an
id, a label (what the Releases tab calls it) and a phase:

- `prepare`: before the release checks. A step called `commit` makes the release commit, and is the
  last of them.
- `check`: after the checks passed and the release commit landed, before Publish, such as trying
  the release on your live server.
- `after`: after Publish, such as making the release page.
- `withdraw`: after a Withdraw.

A step marked `held` waits for your **Continue** on the Releases tab. Sova adds its own two steps,
the checks and Publish, in their places; a playbook can't declare them.

The rest of the playbook is instructions for the release chat. Sova's own release method comes
first, and the project's playbook adds what is particular to it and wins where they differ. Sova's
checks and Publish apply either way.

## Releases need Merge locally

A release lands its commit on the main branch and pushes it itself, so a project whose branches land
by pull request, merge request or a pushed branch can't release yet. Set how it lands to Merge
locally in [Settings → Merge Queue](/docs/merge-queue-settings/) first. While a release is open, this
computer's choice of how it lands can't change, and a save to the project's file waits until the
release is published or abandoned.

## The Release Note

**Release Note**, beside Start Release on the Releases tab, saves your instructions for the next
release, up to 4,000 characters, such as "Release as 0.10.1" or "skip the docs step". **Start
Release** sends it to the release chat as your instructions and then clears it. A version it names
wins over the playbook's own rule; it can skip or narrow a step, but never a check. It is kept on
this computer, not in the project's files.
