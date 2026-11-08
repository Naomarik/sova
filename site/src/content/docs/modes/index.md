---
title: How modes work
description: Each chat has one major mode and any set of minor modes. You switch them per chat from the composer, and a switch applies from that chat's next message.
group: Modes
order: 1
---

## Major and minor

The **major mode** is one of three:

- **[normal](/docs/modes/normal/)**: Pi as usual. The agent does the work itself.
- **delegate**: Orchestrate: route planning, investigation and implementation to workers by
  profile. See [Delegate](/docs/modes/delegate/).
- **create**: Configure and extend Sova: everything Delegate does, plus every way to make Sova yours.
  See [Create](/docs/modes/create/).

**Minor modes** are independent switches. Any set can be on at once, in any major mode:

| Minor mode | What it adds | Reaches workers |
|---|---|---|
| [align](/docs/modes/align/) | The agent agrees with you on what to build before building it, and records each agreement as an alignment. | No |
| [spec](/docs/modes/spec/) | The agent works from the project's spec: it reads the claims a task touches, and proposes changes in drafts. | Yes |
| [vis](/docs/modes/vis/) | The agent can draw small diagrams and charts in its replies. | No |
| [memory](/docs/modes/memory/) | A cheap model folds the chat's messages into one-line summaries, and the model opens any of them back to the original message with its `zoom` tool, so a chat can outgrow its context. The transcript you read never changes. Only Sova's mode menu turns it on. | No |

A project can also ship minor modes of its own, with instructions and its own command-line tools,
in its `.sova/minor-modes/` folder. Chats in that project list them in their own group, and none is
ever on until you turn it on. See [Project modes](/docs/modes/project-modes/).

Both kinds are **per chat**. Each chat keeps its own modes, saved in that chat's session file, so
they survive a reload or a server restart. Switching one chat never moves another chat.

## Switch in the web app

The mode switch sits at the right end of the composer foot, after the model. It shows the chat's
modes as icons: one for the major mode (normal shows a sliders icon), one for each minor mode that is
on, and, for each project mode that is on, its first letter in a rounded square. Where the composer
is at least 620px wide, the names follow the icons, for example `delegate · align`; hover it for the
full wording. When the foot is too tight, the icons fold to the first one and a count, such as
"+3", before the model's name loses a letter. The menu's rows carry the same icons, so the menu is
the legend. Until Sova knows the chat's mode it shows the sliders icon alone.

Press it to open the menu. It has these groups:

- **Major mode**: normal, delegate and create, each with its one-line description. Picking one switches
  the chat and keeps the menu open. Delegate's row has a gear, **Configure Delegate**, that opens Settings → Profiles without
  switching anything, so you can set Delegate up before you turn it on. Create's row has the same
  gear, **Configure Create**, since Create shares Delegate's settings. A gathering chat has no Create row.
- **Minor modes**: align, spec, vis and memory, each with its description. Toggling one
  keeps the menu open, so you can set several. Spec's row has a gear too, **Configure Spec**, that
  opens Settings → Profiles at its spec writer section. Memory is the last row, listed only in a
  chat whose runtime can run it; its row has a chevron, **Memory type**, that opens a panel to
  choose the chat's [memory type](#memory).
- **This project · {name}**, only in a chat whose project has [project modes](/docs/modes/project-modes/):
  one row per mode, with its description and, when it applies, its state, such as **Asks before
  turning on** for a mode with tools, commands or hooks you haven't approved. A mode turned on
  by the Overseer, or with an earlier approval that wasn't yours, whose hooks wait for you
  has an **Approve Hooks** button beside its row.
- **Your modes**: your own personal modes, from `~/.pi/agent/sova/minor-modes/`, in every chat that
  offers project modes, in every project. They work exactly like project modes, and one approval
  holds in every project. One with the same id as a project's mode replaces it in that chat, and its
  row says so.
- **Profile**: one row, **Profile · {name}**, that opens the picker for this chat's
  [profile](/docs/subagent-profiles/).

The menu's foot reads `strict: off` (or `on`), then "A switch here is this chat's own. New sessions
start from the default." Beside it is the **Save as default** button.

The menu works from the keyboard: arrow keys move between rows, Enter or Space picks or toggles,
Escape closes, and Tab reaches Save as default.

## When a switch applies

A switch reaches **that chat only**, **from its next message**. There is no reload and no new
chat, and the chat's running workers keep running.

- **During a turn**, the running turn keeps the old mode, and so do messages you queue during it.
  The menu says so: **Applies after this turn.** Your next message follows the new mode.
- **Switching to Create** also turns align on, in the same step. A chat still on code older than Create
  can't take the switch: it fails with its reason, and the mode stays as it was.
- **A chat that can't switch** shows **This chat can't switch.** in its menu, for example when
  another program wrote its session. The chat is left as it was; **Save as default** still works.

Switching a minor mode in the middle of a chat doesn't rewrite the instructions the model already
has (except align in Delegate or Create, which changes one paragraph of Delegate's instructions). The change reaches the model as a hidden note with its next message, which you don't see in
the transcript. This keeps the model provider's prompt cache, so a toggle doesn't re-send the whole
conversation. Turning **align** or **vis** on or off does change the agent's tools:
align adds its `align` tool and vis its drawing tools. A project mode
with tools adds or removes its own tools the same way. **memory** sends no note at all: it changes
the history the model is sent from the next turn, and adds its `zoom` and `date` tools.

Each switch is recorded in the session. It draws nothing in the thread, but it shows in the Session
pane's Changes and as a marker on the Timeline.

## This chat, and the default for new chats

`~/.pi/agent/mode.json` holds the **default for new sessions**. A chat that has never switched
follows it; its first switch pins that chat to its own modes from then on.

**A switch never changes the default**, not even in a brand-new chat. The default moves only when
you ask for exactly that: **Save as default** in the menu. It makes this chat's major mode, strict flag, minor modes and
  subagent profile what new sessions start from, with its memory type. Project modes are
  never part of the default, and neither is Create: in a Create chat it saves the chat's last normal or
  Delegate choice. It reads **Already the default**, and can't be pressed, when all of
  these already match.

A saved default reaches new sessions from their next start. It also
reaches any session that has never switched, the next time it starts or reopens. Chats that have
switched keep their own modes.

## Typed in a chat

The same switches can be typed in a chat's composer. Sova answers them itself: they never reach the
model, and each does exactly what the menu's same switch does, with the same refusals and markers.

| Command | What it does |
|---|---|
| `/mode normal`, `/mode delegate`, `/mode create` | Switch this chat's major mode |
| `/mode align`, `/mode vis on`, `/mode spec off` | Toggle a minor mode, or set it on or off. `/mode memory on` is refused: memory is turned on from the mode menu |
| `/mode project:<id>`, `/mode project:<id> on`, `/mode project:<id> off` | Toggle one of the project's [project modes](/docs/modes/project-modes/) or one of your personal modes, or set it on or off. One with tools, commands or hooks turns on only if you already approved that exact version in the mode menu: typing never approves |
| `/mode strict on`, `/mode strict off` | Set this chat's [strict](#strict) flag |
| `/mode subagents <profile>`, `/mode subagents off` | Pick this chat's subagent profile, by id or name |
| `/align on`, `/align off` | Turn align on or off |
| `/review plan`, `/review implementation` | Ask for an [adversarial review](/docs/modes/align/review/) |

Anything else, bare `/mode`, `/mode status` and `/mode default` included, switches nothing and
answers with the usage line.

## pi's terminal

A pi terminal session has no modes from Sova: no Delegate or Create, no align, spec, vis, memory,
project or personal modes, and no mode palette, shortcuts or launch flags. A session's saved modes
stay in its file, so a session you opened in a terminal has them again when Sova opens it. While
Settings → Experimental's switch below is still there, the older mode extension may still load in a
terminal as it did, with nothing promised.

## Who runs the modes

Settings → Experimental has one switch, **Sova runs chat modes**, on by default: Sova runs every
chat's modes itself, built-in, project and personal ones. Turned off, the older pi mode extension
runs them as it did before this release, and personal modes aren't offered. A flip reaches each open
chat at its next quiet moment, and the model sees the same instructions and tools either way.

## What workers get

A worker is not a chat. It has no mode menu, and its parent chat's major mode never reaches it.
Of the minor modes, only those that are meant for workers reach them: **spec**, and each project
mode whose file says `workers: yes`. A worker gets at most 8 modes, built-in and project together.

- **spec** reaches every worker the chat starts while spec is on: pi or Claude Code, local or
  remote, alone or in a team (a team's monitor excepted). The worker gets the spec guide and a
  short note: its brief is its go-ahead, it works in the draft its brief names, and the parent
  promotes. See [Spec](/docs/modes/spec/).
- **align** doesn't: aligning is a conversation with you, and a worker doesn't have one.
- **vis** doesn't: drawings are for you, and a worker's replies are read by its parent.
- **memory** doesn't: it is the chat's own memory of its conversation, and a worker starts fresh
  from its brief.
- A **project mode** does when its file says `workers: yes`: the worker gets the chat's copy of it,
  with its tools if it can run commands. See [Project modes](/docs/modes/project-modes/#workers).

A worker gets the modes its parent has **when it starts**. A later switch in the chat doesn't reach
a running worker; a resumed worker takes the parent's current modes. The worker's view in the
Subagents pane shows what it was given as a small chip beside its status, such as `spec`, with a
project mode by its id.

## strict

Strict is a flag for Delegate and Create. While a chat is in either with strict on, the agent loses its
`edit` and `write` tools. Only those two go: `bash`
and every other tool stay, and the agent's instructions read the same either way.

- It is **per session** and **off by default**. Set it by typing `/mode strict on` or
  `/mode strict off` in the chat.
- The web mode menu shows it read-only in its foot, `strict: off` or `strict: on`. Save as default
  saves it with the rest of the chat's modes.
- In normal mode the flag is kept and does nothing. Switching to Delegate or Create applies it.
- Sova never sets it: a switch from the menu can't carry it, and project coding sessions never set
  it. Workers are never strict.

## memory

Memory lets a chat outgrow its context. A cheap model, the summarizer, folds each message into a
one-line summary, and older lines into lines that cover more. The model reads those lines instead of
the whole history, and opens any of them back down to the original message with its `zoom` tool
(`date` gives a message's date and time). Each recall shows as a tool row, such as "Recalled
messages 40–47". The transcript you read never changes, so turning memory off gives the model the
chat's full history back.

Each chat picks one of two types in the **Memory type** panel:

- **UniiChat**, by Victor Taelin: one chat that never ends. Every turn sends the summary lines of
  the whole chat before it, then the turn itself. The lines grow to UniiChat's summary size,
  128 KB by default, then merge down to half of it.
- **Zoomable compaction**, Sova's: the chat runs as without memory until it would compact. Then the
  compacted part becomes summary lines the model can open, instead of a one-off summary. Its size is
  the size of those lines, 32 KB by default.

The type is this chat's own, kept while memory is off, and Save as default saves it. Each type's
summary size is set once for every chat, in Settings → Memory.
Turning memory on in a chat that already has messages prepares it in the background ("Preparing
memory: 120 of 480 messages"); its turns go out as without memory until that's done. The Session
pane's Memory outline shows the lines the model sees now. Settings → Memory picks the summarizer's
model, with a fallback, and each type's summary size.

Only a chat's mode menu turns memory on, whatever the chat's model; typed, it can be turned off
but not on. Workers and coding sessions never get it. The Overseer and each project overseer have a memory switch of their
own instead, on by default. See [Memory](/docs/modes/memory/).

## Sessions that choose their own mode

- **The Overseer** is always in normal mode with no minor modes, and no project modes. Its composer has no mode switch:
  its **Quick Actions** button takes that place, with its memory switch just before it, and a
  typed `/mode` answers "The Overseer is always in normal mode."
- **A project's coding sessions** start in this computer's default mode and subagent profile,
  pinned from their first message, so a later change to the default never moves them. A project has
  no mode setting of its own: its page names the mode its coding sessions start in, and Save as
  default in any chat's mode menu changes it. Either Overseer can start or message a coding session
  in normal or Delegate, with any minor modes (never memory) and subagent profile, for that session only. Create
  is chosen in a chat, so neither can name it. Neither
  answers alignment questions: while a session waits on your answers, they can't turn its align off.
  A coding session's mode never names a project mode, and never sets strict. You can still switch a
  coding session yourself from its mode menu, like any chat.
