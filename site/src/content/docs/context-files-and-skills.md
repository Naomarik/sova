---
title: Context files and skills
description: Decide which context files and skills a project's new chats load, turn on asking first so nothing new loads until you approve it, and see which skills a chat and its workers actually read.
group: Features
order: 17.5
---

## What a chat loads

A chat loads two kinds of things from the folders it works in:

- **Context files**: the instruction files pi reads (`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`):
  your own, the project's, those in the folders above it, and those in folders inside it as the
  agent reaches them.
- **Skills**: pi's skills, the Claude skill folders, and the skills of folders inside the project.

What each new chat loads is decided per project, or per folder for a chat outside any project, and
kept on this computer. Claude Code chats follow the same decisions.

## The default: everything but what you disallow

Out of the box, new chats load every context file and skill they're offered, as before. To keep one
out, open the project page's **Settings** tab and use its **Context Files** and **Skills** cards. Each
row has the item's name, where it comes from (the project, a folder inside it, **Above the
project**, or your own), and a chip that reads **Allowed** or **Disallowed**.

- **Disallow** keeps that item out of every new chat in the project, its worktrees included.
- **Allow** on a disallowed one lifts the Disallow again.

A click shows its new state at once and saves behind it; every row stays clickable while saves run.
A save that fails puts back only its own row, with a message, also when it hasn't answered in 90
seconds. Chats already open keep what they loaded; only new chats change.

A skill is known by where it is, not by its name, so a project skill named like one of yours is a row
of its own, and a skill that moves counts as a new one.

## Ask first

Settings → General has one switch, **Allow context files and skills without asking**, on by
default. Turn it off and nothing loads until you approve it:

- Every item you haven't decided reads **Waiting** and stays off.
- A row reads **Approved**, **Disallowed**, **Waiting** or **Changed**, with **Approve**,
  **Disallow** or **Re-approve** as its state allows.
- A new chat's setup card lists everything the chat could load, says "{n} to approve for this
  project." with **Review**, **Disallow All** and **Approve All**, and holds Send until nothing waits.
  You can still type; your draft is kept. A decision made in another tab or on the project page
  frees it at once. While a decision made on the card is still saving, Send waits and the composer
  says "Saving…"; the screen keeps its scroll position and open sections.
- An approved item whose content changes is marked **Changed since you approved**. It stays loaded,
  and **Re-approve** accepts the new content. For a skill, a change to any file in its folder counts.

The switch applies to every chat started after you flip it; a chat already under way keeps the mode
it started in. Turning asking on approves nothing by itself.

### Each chat's list is fixed at its first message

When a chat sends its first message, what it may load is written into the chat. Changing a card
later never changes that chat, and neither does a restart. Its workers get exactly the same list.

In a chat that started with asking on, a context file or skill found later, in a folder the agent
reaches while it works, never loads unless it was approved. A line in the transcript, which the
model doesn't see, says it wasn't loaded, with **Approve** and **Disallow**. An Approve there loads it
at the agent's next step in that folder.

### Chats nobody watches don't wait

The merge thread, reviewers, the Overseer, project overseers, scheduled automations and messages sent
by a script go ahead without waiting. With asking on, whatever waits simply stays off for them.

## Who can decide

Anyone, a chat or a script included, can disallow something or turn the switch off. Only your own
click on Sova's page can approve, turn a disallowed item back on, or turn the switch back on. A
chat's project overseer can propose an approval, on a Settings card you apply. From another of your
computers, the decision counts only when that computer can confirm it was your click.

## A folder that isn't a project

A chat in a folder that isn't a project has the same two lists. Its setup card ends with "Kept for
this folder on this computer." and **Edit Folder List**, which opens them. The Overseer has a button
in its header for its own folder's list while asking is on.

## Which skills were read

The session pane's **Context** tab shows what fills a chat's context window, and its **Skills
offered** line says which skills the chat has read. When the chat has workers, **Whose context** at
the top of the tab picks this chat, a worker, or **Everyone**.

**Everyone** lists every skill this chat and all of its workers opened, over the whole history and
not only the current window, most opened first. Each row has the skill's description, its size, and
how many times and in how many chats it was opened. Press a row for the chats that opened it, and
**Open Skill** for its text. A last section names the skills that were offered and nobody opened.
