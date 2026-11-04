---
title: Create
description: Create is the major mode for configuring and extending Sova. It does everything Delegate does, and it knows every supported way to make Sova yours.
group: Modes
subgroup: Major
order: 3
---

## What it is

Create is the third major mode. Pick **create** in a chat's mode menu and say what you want to happen.
You don't need to know which setting does it or where that setting is kept: the chat works that out
and makes the change.

It starts from what you need, not from a setting. It asks what you want to happen, then offers the
ways that fit, recommended first, each with what it reaches, who approves it and when it appears.

## Everything Delegate does

A chat in Create works as a chat in [Delegate](/docs/modes/delegate/) does: the same 4 kinds of work,
the same routes, workers and teams, and the same rule that the chat orchestrates and checks instead of
doing the work itself.

Create has no settings of its own. The Subagents picker and every profile are Delegate's, and
moving a chat between Delegate and Create keeps its subagent profile. **Configure Create**, the gear
on Create's row, opens the same Settings → Subagents as Delegate's gear. The [strict](/docs/modes/#strict)
flag does the same in both: while it's on, the chat has no `edit` or `write` tool and every file
change goes through a worker.

A worker gets nothing of a major mode, so the chat reads what it needs and puts it in the worker's
brief.

## What it won't change

**Create never changes Sova's own code.** It offers only supported ways of configuring or extending
Sova: nothing in Sova's own folder, its bundled extensions or the folder it runs from. A file in your
agent folder that is a link into Sova's own folder counts as Sova's, so Create offers a way that
lives in your own folder instead.

In a chat on Sova's own project it changes only the project settings it could change on any other
project, by the same cards and Land.

When nothing supported can do what you asked, it says so plainly and names the nearest ways.

No tool stops a file write a chat chooses to make. Cards touch settings files only and refuse
anything else; the rest of this section is the mode's instructions, and it is as strong as the model
following them.

## The table of contents

Create knows 19 topics in 6 groups. Before it acts on a topic it opens that topic's entry, which says,
for each thing the topic covers, what can change, where it lives, who approves it, how it goes live
and how to check it. An entry is complete on its own, so it works from any project. It holds only
what has landed in the copy of Sova the chat runs.

| Group | Topic | Covers |
|---|---|---|
| Make it yours | appearance | Colours, type and how this browser shows Sova |
| | models | Which models you can use, what new chats start on, and the sign-ins behind them |
| | workers | Which models your workers and teams run on, and named worker personas |
| Teach your chats | instructions | Standing rules every chat in a folder, or on this computer, follows |
| | skills | Recipes a chat loads when relevant, and reusable slash commands |
| | modes | What new chats start in, how planning behaves, and modes your project ships |
| | profiles | Named kinds of chat, what each may and may not do |
| Give them new abilities | tools | A new tool for the agent to call, and how it gets approved |
| | extensions | Your own page, buttons and cards inside Sova |
| | pi-extensions | Add-ons that change what a chat can do, from a file or a package |
| | scripts | Drive Sova from your own program, and follow what happens |
| Keep it safe | safety | What agents may touch, and who approves what |
| Run your project | project | How your project runs, tests, shares and ships |
| | landing | What must pass before a branch reaches your project, and how it lands |
| | automation | Recipes you run by hand, or that run by themselves |
| | cards | Buttons, cards and drawings that are your project's own |
| | overseers | How the Overseers and the Project Assistant watch, act and hold back |
| Reach you and others | attention | How Sova tells you things, and what it writes for you |
| | computers | Your other computers, public links, and this computer's setup |

[Extending Sova](/docs/extending/) lists the same topics with a guide or a screen for each.

## Where you can use it

Create is offered in any of your own chats, in any project and in any folder. What it can do depends
on where the chat is.

| Where the chat is | Topics about this computer | Topics about the project |
|---|---|---|
| A project with a merge queue | Work | Work, by card and Land |
| A project with no merge queue | Work | A worker works in a worktree and you merge when ready. Create says what's missing and offers **Initialize** |
| A folder that isn't a project | Work | Create says what's missing and offers **Add as Project** |
| A folder that isn't in Git | Work | Create says project changes are made by hand |

Gathering chats can't use Create, and their mode menu has no Create row. The Overseer, a Project
Overseer, the Project Assistant and a merge thread have no mode switch at all.

A chat that can do less still offers Create, and says so in its first reply after the switch, before
it offers anything. With the sandbox on, that means writing files on this computer, reaching Sova's
commands and running project tools. On a remote machine, it means project modes and cards.

## Card, Land or your OK

Create makes each change one of three ways, and tells you which before it starts.

**A card** holds a change to settings. Create prepares a Settings change card and you press **Apply**:
each setting in plain words with its before and after, where it lands, each grant marked with what
it allows, and the exact file changes. The card stands under the chat's reply. A project's card also
waits on the project page's Settings tab; a Sova-wide card has only the chat that prepared it. **Apply
and Approve** and **Dismiss** work as they do on the Project Overseer's cards.

Create only prepares. It has no way to apply a card and none to undo one, and even a change that only
narrows waits for your Apply.

A card can hold:

- **Project settings**, when the change is one settings file.
- **Sova-wide settings**: everything Sova keeps for itself or for this computer, those with no screen
  included, such as a custom provider, the image fallback, a remote target, the sandbox policy, worker
  priority or a summary timeout.
- **Merge queue settings**: what Settings → Merge Queue saves, such as pushing, review and each check's
  limits. Apply there is a save, with its commit and its waits: while a branch is checking, the card
  reads "Saves when the current branch finishes." Check commands, the install step, the target and the
  kits go by Land. First setup is yours, on the Merge Queue tab.

**Land** carries everything else in a project: anything spanning several files, and what a card can't
carry (a mode's helper files, card types, drawing kinds, automation files, skills, rules, add-ons). A
change to how the project runs goes by Land too when the project has checks, even as one file, because
a card lands with no checks and Land runs them. A worker makes the change on a branch in a worktree,
and the branch lands when you press Land, like any other. Create never lands one. With no merge queue the
branch is yours to merge, and with no Git the change is made by hand.

**Your OK** covers files on your computer that aren't settings: themes, personal skills, add-ons,
rules and personas. Create shows the path and the whole change, then waits. Only your own message in
that chat counts. Then the chat writes the file, or under strict a worker outside any worktree does.

## What only you do

- **Apply** is your own click, on Sova's page. No message to a chat stands for it.
- **Land** is yours, as for every branch.
- **Sign-ins and keys** never pass through Create. No card, file or message of Create's carries one.
  Provider sign-ins stay in a terminal: Create names the command and you run it. A key you paste into
  a Create chat isn't used, and Create says how to sign in instead.
- **What a browser keeps for itself** (theme choice, type, text size, recent count) is out of Sova's
  reach, so Create names the screen.
- **Moving a project's folder and archiving it** stay yours, on the project page.

## Choosing it

Create is chosen per chat, from that chat's mode menu. Switching to Create turns [align](/docs/modes/align/)
on and moves no other minor mode. Align is an ordinary minor mode from then on: you can turn it
off in Create, and leaving Create leaves it as it is.

**No default holds Create.** Save as default in a Create chat saves the chat's last normal or Delegate
choice, with its strict flag, minor modes and subagent profile. A chat that has been in no other mode
saves normal. Nothing else can name it either: a profile, a playbook or schedule through a profile, an
automation and both Overseers are refused, and nothing is created or changed. So it never spreads to
your other computers as a default.

## New tools

For a new tool, Create recommends a [project tool](/docs/modes/project-modes/): a project mode's tool
asks before it turns on and stops if its files change. It goes by Land, and then you approve it in
the mode menu.

When you ask for a tool in every chat, it offers an [add-on](/docs/extending/add-ons/) in your own
folder, and says plainly that an add-on asks nothing and runs with full access. It doesn't offer
add-ons kept in a project's folder, which run in every chat in that folder with no approval.

MCP isn't supported in Sova chats yet, so Create says so and offers a project tool.

Before you agree to a Sova extension, Create says you must keep its backend running, because Sova never
starts it, and that it has full access inside the page. It offers a theme, a card or a project tool
first when one would do.

## When a change shows

After a change, Create says when it appears and how to check it: a new chat, a reload, a restart, or
Land. It never promises anything sooner. An add-on reaches new chats, or an open chat at its next
reload. A project's offers, profiles and playbooks count once they're on its main branch.

When a change reaches your other computers by sync, Create says so before your OK, and the card says so
before Apply.

## How the entries stay complete

Every new thing you can configure gets an entry, in the same change that adds it. A check fails Sova's
build when an item in one of its own lists has no entry: Settings tabs, project settings, powers,
modes, screen places, commands and environment settings.

The check holds only where Sova keeps a list. It can't see a new control inside an existing tab, or a
new file. Those rest on the rule and on whoever reviews the change.
