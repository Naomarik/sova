---
title: Worktrees and changes
description: A session keeps track of the git worktrees it works in, and you read what changed as numbered steps.
group: Features
order: 10
---

A session keeps a list of the git worktrees it works in. You manage that list by asking the agent, workers start only where the list allows, and each merge the session makes shows up in the transcript as a card. When you want to see what changed, the agent lays the diff out as numbered steps in a read-only viewer.

It works the same in pi's terminal UI and in Sova. Worktrees and steps come from the `worktrees` and `show-changes` pi extensions, which the installer links.

## Ask the agent

There's no button and no command for worktrees: you ask the agent, and it uses its `worktree` tool. It can:

- **Create** a worktree on a new branch, `feat/<name>`. By default the folder is `.worktrees/<repo>-<name>` beside your main checkout, based on the commit your session's folder is on.
- **Attach** a worktree that already exists, including one another session created. It has to be the worktree's top folder.
- **Detach** a worktree. It's marked dropped and stays in the list as history. Nothing is deleted on disk.
- **Merge** a worktree's branch into its target, `master` (or `main` in a repository without `master`) unless you name another. Where the target is checked out, that checkout must have no uncommitted changes to tracked files. Git fast-forwards when it can and makes a merge commit when it can't. A conflict stops the merge and is reported, and nothing changes. Where the target isn't checked out, only a fast-forward is done.
- **List** the worktrees with their status.

Only the session's own agent has this tool. Workers and team members never do, and a session whose tools run on a remote target refuses it.

With the session's sandbox on, the agent asks you before it creates, attaches, or merges, naming the path and the branch. If you decline, nothing changes.

## Where workers may start

A worker may start only in the session's own folder (or a folder inside it), or inside one of the session's active worktrees. Any other folder is refused, and the refusal names the session's worktrees. This applies to single workers, team members, and resumed workers alike, on pi and on Claude Code.

A pi worker started inside a worktree writes only inside that worktree unless the session's sandbox is Off. Under Subagents only, the default, it can still read the rest of your machine, but its writes go only to the worktree and its own scratch space.

A fork of a session starts with the same worktree list. A worktree that came from another session says so in the Session tab.

## The Worktrees section

Open the session pane and its Session tab. Right after Repository, **Worktrees** lists every worktree the session tracks, dropped and merged ones included, with a count line such as "2 active · 1 merged". Each row names the branch and the folder, and has a status chip: Active, Dropped, or Merged "into master at 4ef9f18".

A worktree the session created or attached also gets a readiness chip, worked out from git with no model call:

| Chip | Means |
|---|---|
| Ready to merge | At least 1 commit ahead, and nothing below holds it back. |
| Waiting for your OK | Ready, and the session's last reply asks you something, like whether to merge. |
| In progress | A turn or a worker is running, it has 3 or more uncommitted files, it has no commits yet, it conflicts with its base, or the last test, typecheck, or build failed. |
| Blocked | The session waits on your answers to open questions. |
| Stale | Merged, but the folder has uncommitted changes and nothing is running. |

Under the chips, one line gives the reason in words, such as "Ready to merge · checks passed · 19 commits ahead" or "Conflicts with master · 17 files". It wraps on a phone instead of hiding behind a tooltip.

## A card for each merge

When the session merges a worktree, with the tool or with plain git during one of its turns, a **merge card** lands in the transcript. It shows the folder, the branch, the target branch, the resulting commit, how many commits and lines came in, and whether it was a fast-forward or a merge commit. A merge spotted after a turn says "seen after the turn". A merge another session made gets no card here, though the Session tab still shows that worktree as merged.

## Removing merged worktrees

Sova never removes a worktree on its own, and the `worktree` tool's merge leaves the folder in place. A new session's empty screen shows a line like "4 worktrees · 2 merged" for its repository, with a **Clean Up Merged** button when some can go.

The button checks first and shows you what goes and what stays, each kept folder with its reason: not merged, uncommitted files, a session still running there, and so on. Only the folders you confirmed are removed, and only if they're still safe to remove at that moment. Git removes them without force, so it refuses a folder that changed. A branch that git finds in your main branch is deleted too; the others keep their commits.

## Reviewing what changed

The **changes viewer** shows what a session changed on disk. It only reads: it never writes to your working tree and never runs a git command that changes anything. It opens from 3 places:

- The Session tab: **Review Changes** beside "Uncommitted changes" shows them against your last commit, and **Review Changes** on an active worktree's row shows its branch against where it started (or, once merged, what the merge brought in).
- A merge card's **Review Changes**, for what that merge brought in.
- The agent's `show_changes` card. Ask the agent to show you the changes and it opens the viewer instead of pasting a diff, and replies in a sentence or two.

### The change as steps

The viewer tells the diff as numbered steps. Every hunk lands in exactly one step, or under **Other changes**, which comes last. A hunk is never split between steps.

When the agent calls `show_changes`, it writes the steps itself: a title, an optional line on why, and which earlier steps each one builds on. It can't leave a hunk out. A diff with more than one hunk is refused without steps, and so are steps that leave a hunk unplaced; the refusal lists what's still missing so the agent can fix it in one retry.

Without the agent's steps, each turn that edited files is a step, titled from the message that started it. Edits made by hand or by another session go under Other changes.

### Reading the diff

The left pane holds a file tree above the steps; the right pane shows one file or one step. Pick a file to see its whole diff, with each hunk headed by the step that made it. Pick a step to see its hunks across files. You can mark a file **Viewed** while the viewer is open, and hide the left pane to give the diff the whole width.

- **Unified or Split.** Unified is the default. Split puts the old side beside the new one when the pane is wide enough.
- **Folds.** Unchanged lines between hunks fold to "⋯ Show n unchanged lines", which opens them in place.
- **Keys.** With the diff focused, `n` goes to the next hunk and `p` to the previous one.
- **Big files.** A file with more than 1,500 changed lines waits behind a **Load Diff** button.
- **On a phone.** The list and the diff become two views, with Back between them, and the diff is Unified.

Edits and writes in the transcript use the same diff: an `edit` or `write` tool card shows what it changed, with its "+n −m" count on the closed row.
