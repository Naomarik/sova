---
title: Context files and skills
description: One switch per context file and skill decides what a project's new chats load, one switch per group turns a whole group on or off, and the Context tab shows what a chat actually loaded.
group: Features
order: 17.5
---

## What a chat loads

A chat loads two kinds of things from the folders it works in:

- **Context files**: the instruction files pi reads (`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`):
  your own, the project's, those in the folders above it, and those in folders inside it as the
  agent reaches them.
- **Skills**: pi's skills, the Claude skill folders, and the skills of folders inside the project.

What each new chat loads is kept per project, or per folder for a chat outside any project, on this
computer. Claude Code chats follow the same switches.

## One switch per item

Each context file and skill is one row with its name, its size and one switch. On, new chats in the
project load it; off, they don't. A flip shows at once and is saved for the project, its worktrees
included. You find the rows in three places, and they all change together:

- a new chat's **System context** list, before its first message;
- the project page's **Settings** tab, on its **Context Files** and **Skills** cards, grouped by
  where each item comes from (the project, a folder inside it, **Above the project**, yours, the
  Claude folder);
- **Edit Folder List**, for a chat in a folder that isn't a project.

Chats already open keep what they loaded; only chats started afterwards change. While a flip on a
new chat's list is saving, its composer says "Saving…" just above the message box, and Send waits
for it, so a first message never goes out on the old list.

A skill's figure is its description, the part every chat carries; its main instruction file loads
only when the skill is used. Press the figure for both sizes. Skills only `/skill:name` runs are
listed apart, under **Slash commands**: they're never in the prompt until you type the command.

A skill is known by where it is, not by its name, so a project skill named like one of yours is a row
of its own, and a skill that moves counts as a new one.

## One switch per group

Each group has a switch too: on when every row in it is on, off when every row is off, and in the
middle when they differ. From off or the middle it turns every row on; from on, every row off. Right
after, a line under the group's heading says what it did ("Turned 6 skills off.") with **Undo**, which
puts every switch back exactly as it was. The line stays until the next change in that group.

## New and changed items

Settings → General has one Sova-wide switch, **New context files and skills start on**, on by
default.

- **On**: an item you haven't set loads in new chats. Nothing is marked.
- **Off**: an item you haven't set stays off and its row says **New**. The folded System context line
  of a new chat counts them ("2 new, off"). Nothing waits for them: flip the row on when you want it.
  Once a chat's first message goes in, the New items its open list showed count as left off.

An item whose content changed after you turned it on keeps loading, and its row says **Changed since
you turned it on** with **Accept Change**, which records the new content. For a skill, a change to
any file in its folder counts. A group switch never accepts a change for you.

### Each chat's list is fixed at its first message

When a chat sends its first message, what it may load is written into the chat. A later flip never
changes that chat, and neither does a restart. Its workers get exactly the same list.

A context file or skill found later, in a folder the agent reaches while it works, never loads while
it is off. A line in the transcript, which the model doesn't see, says "wasn't loaded: it is off for
this folder." with **Turn On**, which turns it on for the project and loads it at the agent's next
step in that folder.

## Who can decide

Anyone, a chat or a script included, can turn an item off. Only your own click on Sova's page can turn
one on, a group on, use Undo when it turns things back on, accept a change, or turn the Sova-wide
switch back on. A chat's project overseer can propose turning one on, on a Settings card you apply.
From another of your computers, the decision counts only when that computer can confirm it was your
click.

## A folder that isn't a project

A chat in a folder that isn't a project has the same two lists. Its setup card ends with "Kept for
this folder on this computer." and **Edit Folder List**, which opens them. The Overseer has a button
in its header for its own folder's list while new items start off ("2 new, off").

## Which skills were read

The session pane's **Context** tab shows what fills a chat's context window, and its **Skills
offered** line says which skills the chat has read. Each skill there also says what this chat loaded
from its folder since the latest compaction ("loaded ≈14k tokens from 5 files"), and its sheet lists
those files with their sizes. When the chat has workers, **Whose context** at
the top of the tab picks this chat, a worker, or **Everyone**.

**Everyone** lists every skill this chat and all of its workers opened, over the whole history and
not only the current window, most opened first. Each row has the skill's description, its size, and
how many times and in how many chats it was opened. Press a row for the chats that opened it, and
**Open Skill** for its text. A last section names the skills that were offered and nobody opened.
