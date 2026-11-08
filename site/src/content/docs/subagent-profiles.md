---
title: Profiles
description: A profile is one named setup for a chat, in two parts: how a chat starts, and every model it and its helpers use. When a provider hits its usage limit, you switch a chat's whole Models part at once.
group: Features
order: 16
---

## Two parts

A profile is one named setup for a chat, in two parts:

- **When a Chat Starts**: the mode and add-on modes a chat starts in, which of the default tools it
  loses, which session powers it gains, One at a time, a first message, and whether the Overseer
  may start it. This part is fixed once the chat's first message is sent. You can still change the
  modes in the chat's mode menu.
- **Models**: the chat's own model and effort, and the models of its helpers. A chat can switch this
  part at any time, all at once.

The Models part holds:

- **This chat**: the model and effort the chat itself runs on. Without one, a chat keeps its own
  model.
- **Delegate**: a worker (backend · model · effort, plus an optional fallback) for each of
  Delegate's 4 work kinds: Planning, Investigation, Routine and Complex. See
  [Delegate](/docs/modes/delegate/).
- **Teams**: the models of the **coordinator** and **monitor** every new team gets from Sova, with
  the monitor's settings and the handover timeout, or none, when both run on the chat's own model.
  Also a **members default**: the model a team member runs on when nobody named one.
- **Review**: the **spec writer**, the worker that writes spec drafts while
  [spec](/docs/modes/spec/) is on (or none, when the session writes the spec itself), and the
  **reviewer**, which reviews alignments while [adversarial review](/docs/modes/align/review/) is
  switched on.
- **Alignment**: optionally, the [align](/docs/modes/align/) eagerness, writing style and Visuals
  for chats on this profile, in place of this computer's own align settings.

A profile never turns on a project's own [project mode](/docs/modes/project-modes/). You can have
as many profiles as you like, each with a name you choose.

## Off

**Off** is built in. It's always first in every list, and it can't be edited, renamed or deleted.
It sets nothing in either part: a chat on it keeps its own model and modes, and the agent picks
every worker:

- In Delegate, the agent still delegates and still sorts the work into the 4 kinds, but chooses
  each worker's backend, model and effort itself.
- Teams still get their coordinator and monitor, on the chat's own model with Sova's built-in
  settings, and no members default.
- There is no spec writer: the session writes the spec itself.

## One default

Each computer has one **default profile**, and it decides everything a new chat starts with: both
parts. A new chat's empty screen opens with the default picked, its card marked **Default**;
picking another card is for that chat only. A project's coding sessions and any chat the Overseer
starts without naming a profile start on the default too (a project's own coding model, where it
sets one, is still that session's model). Off can be the default.

Choose it with **Make Default** in Settings → Profiles, or **Make {name} the Default** in a chat's
mode menu. Nothing else moves it. The default stays on this computer: with [Mesh](/mesh) on, your
profiles sync to your other devices, but each keeps its own default.

## Switch a chat's profile

The mode menu's **Profile · {name}** row opens a picker: Off, then every profile the chat can use,
each with its **footprint**, the distinct models it uses with the chat's own first, for example
`Opus 5.5 + GPT-6.1 Sol` (at most 3, then "+N"). Off reads "Keeps the chat's own model".

Picking one switches **this chat's whole Models part**, at any time, before or after its first
message: its own model and effort, its helpers and its alignment settings. Its tools, session powers
and modes stay as they are.

- **All or nothing.** Sova checks the new model first, as a model pick in the composer is checked:
  it exists here, Settings → Models allows it, and this computer has credentials for it. If not,
  nothing switches and the menu says why. A chat is never left with its helpers on one profile and
  its own model on another.
- **During a reply**, the switch waits until the reply ends. A line above the composer says so,
  with **Cancel Switch**. Once it applies, the line says "This chat and its helpers are on {name}."
- **Across backends.** A chat can switch between a Claude Code model and an OpenAI Codex or pi model
  and keep the same conversation.
- From the next turn and team action on, the chat and every new worker use the new profile; a
  worker that's already running keeps the model it started with.

Under the list, **Manage Profiles…** opens Settings → Profiles on this chat's profile, and **Save
Current as Profile** saves what this chat uses now as a new profile of yours. The menu's footer has
**Make {name} the Default**, and, while this chat's model or modes differ from its profile,
**Update {name}**, which saves them into the profile.

## "(edited)"

Choosing another model for a chat in the composer keeps its profile picked and marks it edited:
the mode menu then reads, for example, **Claude (edited)**. It reads so while the chat runs a model
other than the one its profile sets; choosing that model again, or picking the profile again, clears
it. An edit changes only the chat's own model: its helpers, the profile and the default stay as they
are.

## Edit them in Settings → Profiles

**Settings → Profiles** is the one place profiles are listed and edited, both parts; there is no
Subagents tab. The list has **New Profile**, then **Yours**, **This project** and **Built in** (Off),
each row with its name and footprint, and a **Default** chip on the default.

A profile's editor has its name, **Make Default** (or the Default chip), and two tabs:

- **Models**, first: **Set All To**, which changes every model row at once and keeps each row's
  effort, then a compact row per role (This chat, Delegate, Teams, Review) and Alignment. Each row
  expands to the rest of its controls: backend, fallback, and for the coordinator and monitor their
  instructions, thresholds and handover. If another profile shares these models, it says "Also used
  by {name}": an edit changes it for both.
- **When a Chat Starts**: Mode, Add-ons, Tools, Session powers, One at a time, the first message and
  whether the Overseer may start it.

**Save Changes** saves it. A change to Models reaches every chat on that profile from its next turn;
a change to When a Chat Starts reaches new chats. Your profiles also have **Duplicate**, **Delete**
(not for the default) and **Hide From Picker**. A project's profiles are files in the project,
read-only here; one that asks for session powers or Overseer starts needs your **Approve Profile**
first.

Each worker without a fallback says what happens when its model can't run:

| Role | Without a fallback, when the primary can't run |
|---|---|
| Delegate | The agent asks you which model to use. |
| Teams | The coordinator or monitor runs on the chat's own model, and the team's start says so. With one, a coordinator or monitor whose primary runs out of usage while the team runs moves to it. |
| Spec writer | The session writes the spec itself. |
| Reviewer | The review is recorded incomplete. |

## After a usage limit

When a chat's turn ends on a usage limit, Sova reads which provider is exhausted from the error, and
judges the model the chat was actually running, even when it was edited away from its profile's.
Under the error, a row says "{model} is at its usage limit." (and when it resets, only when the
provider said so) and offers up to two presses, **Switch This Chat to {profile}**, for your first
profiles that use no model from that provider, the chat's own model included. Pressing one switches
the chat's Models part, as a pick in the menu does. A worker's failure inside the thread, or an error
that isn't a usage limit, shows no row. If no profile fits, the row links to Settings → Profiles
instead. Nothing switches by itself.

## The Overseer

The [Overseer](/docs/overseer/) can list your profiles, start a session on one, and switch a chat's
Models part. Switching never changes a chat's tools or powers, and no Overseer call changes your
default. It can start a profile with a When a Chat Starts part only when that profile allows the
Overseer to start it.

## Where they're stored

Each profile is saved as two linked halves, so an older Sova and pi in the terminal keep reading
them as before:

| File | What it holds |
|---|---|
| `session-profiles.json` | Your profiles' When a Chat Starts part and the chat's own model |
| `subagent-profiles.json` | Their helpers and alignment settings, shared with pi in the terminal |
| `default-profile.json` | This computer's default profile; never synced |

A project's profiles are files in its `.sova/profiles/` folder. The file format is in the
repository's `docs/profiles.md`.
