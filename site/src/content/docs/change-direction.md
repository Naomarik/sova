---
title: Change direction
description: Rewind to before a message, regenerate a reply, fork from a reply, steer a running turn, and switch models mid-session.
group: Features
order: 14
---

A session doesn't have to go in a straight line. You can take back a message, run a reply again, branch off into a new session, redirect a turn while it runs, or move to another model, and keep the context you built.

## The actions under a message

Each message has a row of actions under it. Hover the message, tab into the row, or tap the message on a touch screen to show it.

| Under | Actions |
|---|---|
| Your message | Copy · Share · Rewind |
| A reply | Copy · Share · Regenerate · Fork |

When an action is off, it stays visible with its reason, such as "Stop the current turn first." A refusal from the server stays under the message it was about.

## Rewind

**Rewind** under one of your messages takes the session back to just before it. That message and every reply after it leave the branch, and its text comes back into the composer, ahead of any draft, so you can edit and send it again. Attached images aren't handed back.

It asks first: the first press shows "This message and every reply after it leave the branch. The session file keeps them." with **Rewind Here** and **Cancel**. Nothing is deleted; the session file still holds the turns you took back.

Rewind won't stop a running turn for you. It's off while a turn or a compaction runs, while the session is open in a terminal, and in a session you're only watching.

The same rewind is in two more places:

- **Undo last turn** in the composer's `+` menu goes back one message without leaving the composer.
- The session pane's **Timeline** lists your messages, each with its own Rewind. Type `/tree` in the composer to open it filtered to your messages.

## Regenerate

**Regenerate** under a reply runs that turn again. Sova rewinds to the message of yours that started the reply and sends it again, with its text and images, on the session's current model. Switch models first and regenerate to compare. The whole turn runs again, tools included, and your composer draft is left alone.

If you steered the turn partway, the steer is the message that started the later reply, so regenerating that reply sends the steer again. The confirm names the message it will send. A reply to a scheduled wake-up has no message of yours to send again, so Regenerate is off there.

## Fork from a reply

**Fork** ("Fork from here") opens a new session with the conversation up to and including that reply. Later messages and abandoned branches stay behind. The original session isn't changed, prompted, or told; no model is called to make the fork.

The fork has its own id and keeps the reply's model, thinking level, mode, sandbox, and worktree list. Worktrees are shared folders, not copies. Workers, teams, and scheduled wake-ups from the original don't carry over, though their messages are still there to read. The fork opens on the same Sova host as the original.

## Steer a running turn

While a turn runs, the composer's **Send** becomes **Steer**, and its placeholder reads "Steer the current turn…". What you send goes into the running turn at its next step, so you can correct course without stopping.

Until the agent takes it, your message shows as **Queued**, with a button to remove it. A removed message is discarded.

**Stop** ends the turn. Anything still queued comes back to the composer for you to edit or send again, and the transcript notes "Stopped by you at 1:43 PM." `Esc` doesn't stop a turn, so a stray key can't.

## Switch models mid-session

Press the model name at the left of the composer's foot, then **Model**, or press `Ctrl+P` (`⌘P` on a Mac). Pick a provider, then a model, or type to search across them. The same menu holds the **Thinking** levels for the current model.

- **Between turns.** A switch waits until the running turn finishes: "Model changes wait until this turn finishes."
- **It's this session's.** Once a session has your first message, a pick changes only that session. A pick in a brand-new session becomes the default for new sessions.
- **Only models you allow.** A model turned off in Settings → Models isn't listed.

When the switch lands, Sova says "Model changed to {model}." If it fails, a banner says why and that you're still on the previous model.

## Follow the work as it happens

Tool calls read as cards you can open, and edits and writes show as diffs, with their "+n −m" count on the closed card. See [Worktrees and changes](/docs/worktrees-and-changes/#reviewing-what-changed) for reading a whole session's changes as steps.
