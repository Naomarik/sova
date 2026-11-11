---
title: Merge queue settings
description: Settings → Merge Queue shows every value a project's merge queue uses, says where each one lives, and changes the few you can change there. A change to the project's file is saved as one commit you confirm.
group: Features
order: 10.55
---

Every setting a project's [merge queue](/docs/merge-queue/) uses is on one tab: **Settings → Merge
Queue**. **Queue Settings** on a project's Merge Queue tab opens it already on that project; opened
any other way, it shows the first project, and the picker in its head switches to another. The
project's own Settings tab has a **Merge queue** row too, which opens the same place.

<!-- screen: settings-merge-queue | Settings → Merge Queue for one project: the Landing, Checks, Before the checks, Review and Merge thread groups, each row tagged Project file, This computer or Set by Sova. -->

## Where each value lives

Each row carries a tag that says where its value is kept:

- **Project file**: the `merge` section of the project's `.sova/project.json`, shared with everyone
  who uses Sova on that repository.
- **This computer**: kept only here, for that project.
- **Set by Sova**: fixed by Sova, shown so you know it. These never change here.

The project-file values are read from the main branch's newest commit ("From master at {sha}"),
never from your project folder, because that is what the queue uses. When the folder's copy of the
file differs from the main branch's, a line says so.

## The groups

- **Landing**: how a branch lands, the branch it lands into, whether to push after each landing
  (only when it merges locally), whether private names are set up (their count, never the
  names), and **Delete branches when cleaning up**, off by default: off, automatic cleanup removes a
  landed branch's folder and keeps the branch; on, it removes the branch too, and its last commit
  stays restorable.
- **Checks**: how many always run and how many only when the merge thread picks them, then each
  check with its time limit, whether it reruns failed files, and when it runs. **Reuse passes from
  identical code**, on by default: a test file that already passed on exactly this code isn't run
  again, and a few are re-checked at each landing; reruns and releases always run in full. And the
  longest a check may run, 30 minutes.
- **Before the checks**: the setup steps and the install step, and that a failed setup is tried
  again once after 60 seconds.
- **Review**: whether each landing is reviewed, the review's instructions, its model, and its time
  limit (20 minutes, tried twice, then the queue pauses).
- **Merge thread**: its model, its instructions (Sova's method first, then the project's own), and
  when it starts a fresh chat.
- **Request**, on a project that lands by pull or merge request: the instructions for writing it.
- **Where it checks**: where the merge copy lives.

<!-- screen: settings-merge-queue-checks | Settings → Merge Queue, further down: each check with its time limit, whether it reruns failed files and when it runs, each tagged Project file. -->

**Open Folder** on an instructions row shows that folder's files in place, as they are on the main
branch, and opens a file to read. It only reads; nothing in it runs.

## What you can change here

- **How it lands**: Merge locally (the default), Pull request on GitHub, Merge request on GitLab, or
  Push branch only. Sova suggests one from the project's `origin`, and changes nothing until you
  pick. When you pick another, you choose where to keep it: **This computer only** or **Project
  file**. This computer's choice wins over the file's, and **Clear Override** removes it.
- **The review and merge-thread models**, kept on this computer. Until you pick one, each uses the
  model new chats use. A change applies from the next review or the next fresh merge thread; one
  already running keeps its model.
- **Push after each landing**, on or off.
- **Review each landing**, on or off.
- Each check's **time limit** (at most 30 minutes), whether it **reruns failed files**, and whether it
  runs **every time** or **only when picked**.
- **Reuse passes from identical code**, on or off.
- **Delete branches when cleaning up**, on or off, in the project's file. It applies from the next
  cleanup, and the confirm says so.

Everything else only reads here: the check commands, setup, install and the instruction folders.
Change those in a branch, and Land it, so the queue tests the change.

## Saving a change

A value kept on this computer saves as you pick it, with no commit.

A change to the project's file is gathered on the tab first ("2 changes to the project file.", with
**Discard Changes**), then **Save to master…** asks you to confirm, listing each change. It is saved
as one commit straight onto the main branch, which changes only those values in the file. It applies
from the next landing, isn't checked first, and goes to `origin` with the next landing.

- **It never cuts into a run.** While a branch is being checked, the button reads **Save When It
  Finishes**, and the save waits for that branch, with **Cancel Save**. It also waits while a
  [release](/docs/releases/) is open.
- **An uncommitted edit blocks it.** While the project folder's copy of the file has an edit you
  haven't committed, the project-file controls are greyed out: commit or discard it first. Other
  uncommitted tracked files, or a merge in progress there, refuse the save too.
- **Nothing is dropped silently.** Your gathered changes stay when you switch to another Settings
  tab. Closing Settings, or switching the tab's project, over them asks first.
- **A project that lands on its host** (by request, or by pushing a branch) gets the change as a
  request or a pushed branch of its own instead of a commit, and it applies once that is merged.

A project the queue doesn't serve yet shows what setting it up changes here instead of the groups,
with **Set Up with a Chat**, which closes Settings and opens the project's Setup chat.
