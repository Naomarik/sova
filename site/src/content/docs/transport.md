---
title: Transport a chat to another device
description: Copy or move a whole chat, with its code, unfinished changes and team, to another of your devices; follow it as it goes, and move it back.
group: Features
order: 14.3
---

**Transport…** sends a whole chat to another device of your [Mesh](https://github.com/Naomarik/sova/blob/master/docs/mesh.md):
its [home](/docs/chats-folder/), its code with every unfinished change, and its team. A **Copy**
leaves the original as it is. A **Move** hands the chat over and leaves a Moved row behind. The
original keeps working until the other device has shown the chat opens there, and the chat never
runs on two devices at once.

## Start one

**Transport…** is in a chat's ⋯ menu and on its session pane. Only your own click on this device's
page starts one: a chat, its workers, a script, an extension, the Overseer and another computer are
refused. Your click makes a one-time ticket for this chat and that device alone. The other device
still needs to grant this one sessions.

It is refused, with the reason, for a chat whose branch is in the merge queue, a chat from before
chat homes, a compressed chat, a chat already being transported or already moved, special chats
(the Overseer, a project overseer, an organization session, a helper's own chat, a chat open in a
terminal or running its tools on a remote target), and a device that is offline, needs an update or
doesn't grant this one sessions.

## The dialog

**Transport This Chat** asks **Move** or **Copy**, the **Device**, and the **Folder on that
device**, filled in with the project's folder there. It then lists, with sizes:

- **Travels**: the conversation and records, the code (its branch and unfinished changes,
  submodules included), the team (helpers, their conversations and inboxes) and scratch folders.
- **Private files git ignores**, each ticked; an unticked one stays here. Your choice is remembered
  per project and device. An untracked file over 50 MB is listed unticked until you tick it.
- **Stays here**: build output and dependencies, which are rebuilt there; share and preview links,
  which end; background jobs and running copies, which a Move stops at the switch.
- **That device still needs**: what the other device lacks (the project, its tools, its own values),
  which the Transport agent prepares, on the model you pick. When that device can't clone the
  project, it comes from this one, and the dialog says how much history that adds.

When helpers are working as you press Move, pick **Safe Transport** (the default: they wrap up and
go idle first) or **Interrupt and Move** (they stop at once and continue on arrival).

## Follow it

While it runs, the dialog lists its steps: Preparing the device, Waiting for helpers, Stopping jobs
and running copies, Packing, Sending, Checking, Opening. Each done step has a tick and the current
one a live dot; one that stopped shows why, with **Retry** and **Cancel**. While sending, a meter
shows how much has arrived, and once known the speed and the time left. The chat's own header shows
"Moving to {device}" with the current step, and opens the dialog.

## The Transport agent

The other device may need the project, its tools and dependencies, and its setup. Its own setup
checks run first; when something is missing, a Transport agent, a chat on that device, prepares it.
It gets the project only through its own build tools, never copies a download cache or a build folder
from elsewhere, and works in its own sandbox, never changing a folder on your PATH. What it needs from
you (a download, a command to run yourself, a file to bring) it asks on its card in the chat, with
**Open Agent Chat**. A project is prepared once per device.

## A Move

The team keeps working while the other device is prepared. Only the switch pauses it: helpers come
to rest, background jobs and running copies stop, the last changes are sent, and the chat opens
there. No prompt is sent during the switch. If the other device never confirms, the chat stays here.
On arrival the chat is told what moved and what was stopped; its running copies start again there,
and helpers that were working resume.

Here, the chat becomes an archived **Moved to {device}** row that opens it on that device. Its home
stays as a read-only safety copy. Each worktree that travelled is packed into it and removed here, so
the branch can't land from two devices; the main checkout, and a worktree another chat here still
uses, stay.

**Move Back** is offered for 7 days while the chat has had no new turn there: the chat runs here
again from its safety copy, its worktree included. After a turn there, **Copy Back** takes its place:
a new Copy from that device. After 7 days the safety copy is compressed, never removed.

## A Copy

A Copy is a new chat on the other device, with its own name and home, its code on a branch of its
own, and its whole team copied, idle. The original and its team carry on here untouched.
