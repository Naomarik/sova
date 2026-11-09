---
title: Sova extensions
description: Add an extension from a folder in Settings → Extensions, review what it runs before anything is on, and see each one's state, program and log.
group: Extending
order: 25.5
---

A Sova extension is something you add to Sova from a folder on this computer: a page of its own, a
program that runs beside Sova, and what it adds to Sova's screens and chats, in any mix. Sova shows
its page and its cards, runs its program, and knows nothing about what it does. Settings →
Extensions is where you add, approve and manage them. To build one, see
[Make Sova yours](https://github.com/Naomarik/sova/blob/master/docs/customization.md#sova-extensions)
in the repository.

## Add one

A folder is an extension when it holds a description file, `sova-extension.json`, at its root. Press
**Add Extension** and browse to the folder. Each folder you pass is read at once: it either names the
extension, with **Review**, or says plainly why it can't be used, such as no description file, a file
that isn't JSON, or an id another folder already has. Sova points at the folder and never copies,
moves or changes it.

**The review** comes before anything is on. It names the exact program, and says it runs as you with
no sandbox; that the extension's page runs on Sova's own address and can do what you can; its cards,
commands and what it offers the Overseer; which version of Sova's extension rules it needs; and what
was left out and why. Nothing runs until **Install and Turn On**. Cancel changes nothing.

## What each row says

Each extension has one row, with its name, its folder and one state:

| State | Means | The row offers |
|---|---|---|
| **Not Usable** | Its entry or description can't be used; the row says why. Nothing runs. | Remove |
| **Folder Not Found** | Its folder is gone. Its program is stopped. | Choose Folder, Remove |
| **Needs a Newer Sova** | It needs newer extension rules than this Sova has. Nothing runs. | Restart Sova or Open Updates, Remove |
| **Waiting for You** | Not approved. Nothing runs. | Review, Remove |
| **Changed** | Its code changed since you approved it. Its program goes on with the old code; its page and views are off. | Review, View Log, Remove |
| **Off** | Turned off. | the switch, Remove |
| **Stopped** | On, and its program exited or stopped answering; the row says which. | the switch, Start, View Log, Remove |
| **Starting** | On, and its program hasn't answered yet. | the switch, View Log, Remove |
| **Running** | On, and its program answers, or it has none. | the switch, Restart Program, View Log, Remove |

Everything on the tab applies at once, without the dialog's Save. **Remove** asks first, with **Also
delete its data**, unticked.

## Approval follows the code

Approval covers the exact entry and every file of the extension's code. Within about 3 seconds of an
edit to its code, the row reads **Changed** and its page stops being served; its program keeps
running the old code until it stops, and won't start again until you approve. Its data and logs never
ask again: data belongs in the folder Sova gives the program, or a `data` folder at the top of the
extension.

An entry added or edited outside this tab reads **Waiting for You** and runs nothing until you
review it. Extensions you already had when you first started this version were approved once as they
stood.

Only your own click on this page adds, approves, turns on or off and removes an extension. A chat, a
script, another computer or an extension itself is refused.

## The program

When an extension names a program, Sova starts it, watches it and keeps its log, on your approval.
It runs from the extension's folder as you, with no sandbox, on a port Sova gives it, with a data
folder of its own and a key of its own; Sova's token isn't given to it. A program that fails is
started again, at most 5 times in a minute, then it stays Stopped until you press **Start**.
**View Log** shows its last lines.

The program keeps running when Sova restarts or stops. One that stopped at a crash or a reboot comes
back when Sova starts, not by itself at login.

## A guest with a name badge

An extension can hear what happens, show things, ask you with a card and say things to a chat, always
under its own name. A message it sends shows **From an extension** with its name, and it can never act
as you: it can't send your messages, answer your alignment questions, approve anything or turn a
project mode on.

## Other computers

Extensions on your other computers show in a group of their own, **Not Installed Here**, with the
computer's name and no actions. Through another computer the tab is read-only: open Sova on the
computer an extension belongs to.
