---
title: Subagent profiles
description: A subagent profile is one named set of every model your subagents use. When a provider hits its usage limit, you switch the whole set at once instead of editing four screens.
group: Modes
subgroup: Major
order: 3
---

## What a profile holds

Most of the work in a session runs in subagents: Delegate's workers, team members, the spec
writer. A profile names the model for each of them:

- **Delegate routing**: a worker (backend · model · effort, plus an optional fallback) for each of
  Delegate's 4 work kinds: Planning & specs, Investigation, Routine implementation and Complex
  implementation. See [Delegate](/docs/modes/delegate/).
- **Teams**: the standing **coordinator** and **monitor** every new team gets, with the monitor's
  settings and the handover timeout, or none. Also a **members default**: the model a team member
  runs on when nobody named one.
- **Spec writer**: the worker that writes spec drafts while [spec](/docs/modes/spec/) is on, or
  none, when the session writes the spec itself.
- **Reviewer**: the worker that reviews alignments, only while
  [adversarial review](/docs/modes/align/review/) is switched on.

The chat's own model is not part of a profile. You can have as many profiles as you like, each with
a name you choose.

Subagent profiles are not the same thing as session profiles. Where Sova means these, it says
"Subagent profiles" or "Subagents".

## Off

**Off** is built in. It's always first in every list, and it can't be edited, renamed or deleted.
It configures nothing, so the agent picks every model:

- In Delegate, the agent still delegates and still sorts the work into the 4 kinds, but chooses
  each worker's backend, model and effort itself.
- Teams get no standing coordinator or monitor, and no members default.
- There is no spec writer: the session writes the spec itself.

## Which profile a chat uses

Each chat has its own pick. In order, a chat uses:

1. **its own pick**, made in its mode menu (or by the Overseer, or with `/mode subagents` in a
   terminal);
2. otherwise **this device's default**, read again each time, so a new default reaches the chat
   too;
3. and only when the profile library itself can't be read, the older settings files from before
   profiles.

A pick that names a deleted profile falls through to the default. A default that names no profile
reads as **Off**, and Sova says why where it shows the current profile.

The profile is read in both major modes: normal mode uses its teams and spec writer too. Only the
Delegate routing is Delegate's own.

A switch reaches the chat from its next turn and its next team action. A running team adds members
and starts successors under the chat's current profile; a worker that's already running keeps the
model it started with.

## Pick one in the mode menu

The mode menu's **Subagents · {profile}** row opens the picker in the same menu: a search field,
then **Off** and every profile. Each profile shows its **footprint**, the distinct models it routes
to, for example `Opus 5.5 · Fable 5.1 · Sonnet 5.5` (at most 3, then "+N"). Off reads "the agent
picks". Picking one switches **this chat only**.

Under the list:

- **Manage Profiles…** opens Settings → Subagents.
- **Save Current as Profile** asks for a name and saves what this chat uses now as a new profile. It
  isn't offered while the chat is on Off.

The menu's **Save as default** covers the profile too: it saves this chat's modes and its subagent
profile as what new sessions start from.

## Edit them in Settings → Subagents

Settings → **Subagents** is the one place these settings are edited: "Which models your subagents
use. A chat picks a profile in its mode menu; new chats start on the default."

- **The list** shows Off and every profile, each with its name, its footprint, and a **Default**
  chip on the one new sessions start from. A profile has **Edit**, **Duplicate**, **Delete** and
  **Make Default**; Off has only Make Default. The list's head has **New Profile** and **Save
  Current as Profile**. You can't delete the default: make another one the default first. A chat
  whose profile you delete follows the default.
- **The editor** has a section per part of the profile, each showing a one-line summary while
  closed: **Delegate routing** (open first), **Teams**, **Spec writer**, and **Reviewer** while
  adversarial review is on. Every worker is a row of Backend, Model and Effort, with **Add
  Fallback** and **Remove Fallback** on its head line.
- **Save Changes** saves the whole library at once. Unsaved edits are kept while you switch tabs, and
  closing the dialog over them asks first: "Your Subagents changes aren't saved."

Each section says once what happens without a fallback:

| Section | Without a fallback, when the primary can't run |
|---|---|
| Delegate routing | The agent asks you which model to use. |
| Teams | The team isn't created. |
| Spec writer | The session writes the spec itself. |
| Reviewer | The review is recorded incomplete. |

## After a usage limit

When a chat's turn ends on a usage limit, Sova reads which provider is exhausted from the error.
Under the error, a row offers one press: **Switch This Chat to {profile}**, naming the first profile
whose footprint uses no model from that provider. It switches this chat only. If no profile fits,
the row links to Settings → Subagents instead. Nothing switches by itself.

## Where they're stored

| File | What it is |
|---|---|
| `~/.pi/agent/subagent-profiles.json` | The library of profiles, shared with pi in the terminal |
| `~/.pi/agent/subagent-profiles-default.json` | This device's default profile |

With [Mesh](/mesh) on, the library syncs between your hosts like your other settings. The default
never syncs: each device keeps its own, just as each chat keeps its own pick.

The first time Sova finds no library, it makes one profile, **My setup**, from your earlier
Delegate, team and spec writer settings, and makes it the default.
