---
title: Memory
description: With memory on, a cheap model folds the chat into one-line summaries the agent works from and opens back up word for word, so a chat can outgrow its context.
group: Modes
subgroup: Minor
order: 8.5
---

## What memory does

Memory is a minor mode that lets a chat outgrow its context. A cheap model, the **summarizer**,
folds each message into a one-line summary. Recent lines cover one message each, and older lines
merge in pairs into lines that cover more. The agent works from those lines, and opens any of them
back down to the original message, whole, with its `zoom` tool.

Only what the model is sent changes. The transcript you read never does, so turning memory off
gives the model the chat's full history back, from its next turn.

Memory is Sova's own and runs in Sova's server. It has nothing to do with Claude Code's own
auto-memory, which Sova always keeps off.

## Turn it on

Memory is the last row of the mode menu's minor modes, after codemode (see
[How modes work](/docs/modes/)). Toggle it like the others, in either major mode and whatever the
chat's model. The row is there only in a chat whose runtime can run memory. While memory is on, the
row's detail line names the type, such as "UniiChat — by Victor Taelin".

A switch sends the model no note. It changes the history the model is sent from the next turn, and
adds two tools: `zoom` and `date`.

## Two types

Each chat uses one of two types, and keeps its own:

- **UniiChat**, by Victor Taelin ([his design](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)):
  one chat that never ends. Every message is kept and summarized. Each turn sends the model a short
  guide, the lines for the whole chat before the turn, then the turn itself whole. The lines grow to
  the chat's size, 128 KB by default, then merge down to half of it. A UniiChat chat never compacts:
  `/compact` answers "Memory (UniiChat) is on: this chat doesn't compact; the model works from its
  memory."
- **Zoomable compaction**, Sova's: the chat runs as it would without memory, while every message is
  summarized in the background. When the chat compacts, whether by itself, by `/compact` or by a
  hand-off, the compacted part becomes summary lines the model can open, instead of a one-off
  summary. The recent part stays as it was. Its size is the size of those lines, 32 KB by default.

Sova's UniiChat adapts Taelin's design and keeps its name and credit. Its guide tells the model the
lines are an index, not the record, and to open a line before it reaches for any other tool. It also
shows a session id whole where the line's own messages make that certain, since summaries tend to
shorten ids.

## The Memory type panel

The chevron at the right end of the memory row, **Memory type**, swaps the menu for a panel with a
Back button:

- **Type**: one row per type, with its name, its author and a one-line description. UniiChat's
  **Read the design ↗** under it opens Taelin's write-up in a new tab.
- **Summary size**: a list of suggested sizes, with this chat's size checked and the type's own
  default marked **default**. A UniiChat size reads as the range the lines keep, such as "64–128 KB"
  for 128. A zoomable size reads as the size the compacted lines get, such as "32 KB".

A pick applies to this chat only and keeps the panel open. The foot says so: "This chat only. Kept
while memory is off." The type and size survive a reload, a rewind and a server restart.

**Save as default** in the menu saves the chat's type and size with its modes, and reads
**Already the default** only when they match too. Each new chat starts from that default, and before
you've saved one, from UniiChat at 128 KB.

## Recalling a line

The agent has two tools while memory is on:

- `zoom` opens a line into the two lines it was made from, and a single message's line into the
  message itself, whole, tool results included.
- `date` gives a message's date and time.

Each call is a tool row in the transcript, folded to what it opened: "Recalled messages 40–47",
"Recalled message 40", "Date of message 40".

## While it works

- **Updating memory…**: before a UniiChat turn's first request, the turn waits up to 20 seconds for
  the newest messages' summaries, and the composer says so. After that it goes on anyway, and a line
  that isn't summarized yet tells the model to zoom it. Merges never hold up a turn.
- **Preparing memory**: turning memory on in a chat that already has messages summarizes them in the
  background ("Preparing memory: 120 of 480 messages"). Until that's done, turns go out as they would
  without memory.
- **A problem**: when the summarizer can't run, the composer's status row shows why, as a button that
  opens Settings → Memory. A failed summary is tried again at the next message.

Rewinding or forking keeps memory right: summaries of messages that are no longer on the branch are
dropped, and a fork takes a copy of the summaries that still match it. Turning memory off keeps the
summaries, so turning it back on only summarizes what came after. Archiving or deleting the chat
deletes them.

## The Memory outline

The Session pane's Session tab ends in a read-only **Memory** section with the lines the model sees
now, oldest first. It shows while memory is on, or while it's off with lines kept from before.

- Its heading names the type, the line count and the size against the chat's, such as
  "UniiChat · 312 lines · 96 KB of 128 KB".
- Each line shows its messages ("40–47", or "12" for one) and its text. **Open messages 40–47**
  shows the two lines under it, down to single messages, with each message's kind, time and text.
- **Show in transcript** jumps to the line's first message.

Nothing in the outline changes memory.

## Settings → Memory

Settings → Memory picks the summarizer: a backend, model and effort, with an optional fallback.
The default is Claude Code's Haiku 5.5 at low effort, with no fallback. With the fallback off,
summaries wait while the primary can't run. A change applies from each chat's next summary, and
waits for Save Changes like the rest of Settings.

The **?** beside the heading opens **How memory works**: a tab per type, in a few plain sentences
with two small drawings each, and what the summary size and the summarizer's model trade off.

The summarizer makes one-off model calls, never a session. They go through this device's model
policy, run on this machine's Claude login, and count as the chat's own spend.

The type and size new chats start from aren't set here. They come from the mode menu's Save as
default.

## Where memory can't be on

- **The terminal.** pi's terminal UI can turn memory off, but never on: `/mode memory on` and
  `pi --minor memory` are refused, and the palette has no memory row. A terminal session that starts
  from a default with memory on drops it. A Sova chat later opened in a terminal keeps memory in its
  saved mode, but nothing runs it there.
- **Workers.** A worker never gets memory: it starts fresh from its brief.
- **Coding sessions.** Neither Overseer can start or set a coding session with memory, and a coding
  session that names no minor modes starts without it, even when your default has it on.
- **Session profiles.** A session profile that names memory is refused.

## The Overseers

The Overseer and each project overseer have no mode menu. Each has a memory switch of its own
instead: a button in its composer foot that reads **memory**, with a check while it's on and a clock
while it's off. The Overseer's sits just before Quick Actions, and a project overseer's at the right
end. It opens the same rows as the Memory type panel, with a **memory** row to turn it on or off. A
pick applies from that overseer's next turn.

An overseer's memory is **on by default**, UniiChat at 128 KB, whatever default you saved for
ordinary chats. Switched off, it stays off until someone switches it on again, and Clear keeps the
choice. An overseer that already has history is prepared in the background, like any chat. The
coding sessions an overseer starts never get memory.
