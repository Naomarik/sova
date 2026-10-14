---
title: How modes work
description: Each chat has one major mode and any set of minor modes. You switch them per chat from the composer, and a switch applies from that chat's next message.
group: Modes
order: 1
---

## Major and minor

The **major mode** is one of two:

- **normal**: Pi as usual. The agent does the work itself.
- **delegate**: Orchestrate: route planning, investigation and implementation to workers by
  profile. See [Delegate](/docs/modes/delegate/).

**Minor modes** are independent switches. Any set can be on at once, in either major mode:

| Minor mode | What it adds | Reaches workers |
|---|---|---|
| [align](/docs/modes/align/) | The agent agrees with you on what to build before building it, and records each agreement as an alignment. | No |
| [spec](/docs/modes/spec/) | The agent works from the project's spec: it reads the claims a task touches, and proposes changes in drafts. | Yes |
| [vis](/docs/modes/vis/) | The agent can draw small diagrams and charts in its replies. | No |
| [codemode](/docs/modes/codemode/) | The agent can run a short script that calls its other tools, several at once, and filters their output. | No |
| memory | A cheap model folds the chat's messages into short summaries, and the model opens any of them back to the original message, so a chat can outgrow its context. The transcript you read never changes. Only Sova's mode menu turns it on. | No |

A project can also ship minor modes of its own, with instructions and its own command-line tools,
in its `.sova/minor-modes/` folder. Chats in that project list them in their own group, and none is
ever on until you turn it on. See [Project modes](/docs/modes/project-modes/).

Both kinds are **per chat**. Each chat keeps its own modes, saved in that chat's session file, so
they survive a reload or a server restart. Switching one chat never moves another chat or a
terminal session.

## Switch in the web app

The mode switch sits at the right end of the composer foot, after the model. It reads the chat's
major mode, then each minor mode that is on, for example `delegate · align`, with any project modes
that are on after the built-in ones. Until Sova knows the
chat's mode it reads just **Mode**.

Press it to open the menu. It has these groups:

- **Major mode**: normal and delegate, each with its one-line description. Picking one switches
  the chat and keeps the menu open. Delegate's row has a gear, **Configure Delegate**, that opens Settings → Subagents without
  switching anything, so you can set Delegate up before you turn it on.
- **Minor modes**: align, spec, vis, codemode and memory, each with its description. Toggling one
  keeps the menu open, so you can set several. Spec's row has a gear too, **Configure Spec**, that
  opens its spec writer settings. Memory is listed only in a chat whose runtime can run it; its
  row has a chevron, **Memory type**, that opens a panel to choose the chat's memory type and
  summary size.
- **This project · {name}**, only in a chat whose project has [project modes](/docs/modes/project-modes/):
  one row per mode, with its description and, when it applies, its state, such as **Asks before
  turning on** for a mode with tools you haven't approved.
- **Subagents**: one row, **Subagents · {profile}**, that opens the picker for this chat's
  [subagent profile](/docs/subagent-profiles/).

The menu's foot reads `strict: off` (or `on`), then "A switch here is this chat's own. New sessions
start from the default." Beside it is the **Save as default** button.

The menu works from the keyboard: arrow keys move between rows, Enter or Space picks or toggles,
Escape closes, and Tab reaches Save as default.

## When a switch applies

A switch reaches **that chat only**, **from its next message**. There is no reload and no new
chat, and the chat's running workers keep running.

- **During a turn**, the running turn keeps the old mode, and so do messages you queue during it.
  The menu says so: **Applies after this turn.** Your next message follows the new mode.
- **A chat that can't switch** shows **This chat can't switch.** in its menu, for example when
  another program wrote its session. The chat is left as it was; **Save as default** still works.

Switching a minor mode in the middle of a chat doesn't rewrite the instructions the model already
has (except align in Delegate, which changes one paragraph of Delegate's instructions). The change reaches the model as a hidden note with its next message, which you don't see in
the transcript. This keeps the model provider's prompt cache, so a toggle doesn't re-send the whole
conversation. Turning **align**, **vis** or **codemode** on or off does change the agent's tools:
align adds its `align` tool, vis its drawing tools, and codemode its `codemode` tool. A project mode
with tools adds or removes its own tools the same way.

Each switch is recorded in the session. It draws nothing in the thread, but it shows in the Session
pane's Changes and as a marker on the Timeline.

## This chat, and the default for new chats

`~/.pi/agent/mode.json` holds the **default for new sessions**. A chat that has never switched
follows it; its first switch pins that chat to its own modes from then on.

**A switch never changes the default**, not even in a brand-new chat. The default moves only when
you ask for exactly that:

- **Save as default** in the menu. It makes this chat's major mode, strict flag, minor modes and
  subagent profile what new sessions start from. Project modes are never part of the default. It reads **Already the default**, and can't be
  pressed, when all four already match.
- `/mode default` in a terminal, which saves the current session's mode (not its subagent profile).

A saved default reaches new sessions, in the TUI and in Sova, from their next start. It also
reaches any session that has never switched, the next time it starts or reopens. Chats that have
switched keep their own modes.

## From the terminal

The same switches work in pi's terminal UI. Sova's menu runs the same `/mode` command, so a
switch made either way is the same switch.

| Command | What it does |
|---|---|
| `/mode` | Opens the command palette at its **Mode** category: the major modes, one row per minor mode, one row per project mode, the alignment viewer, and save as default. It never switches anything by itself |
| `/mode normal`, `/mode delegate` | Switch this session's major mode |
| `/mode align`, `/mode vis on`, `/mode spec off` | Toggle a minor mode, or set it on or off |
| `/mode project:<id>`, `/mode project:<id> on`, `/mode project:<id> off` | Toggle one of the project's own [project modes](/docs/modes/project-modes/), or set it on or off |
| `/mode status` | List this session's modes, the default, its subagent profile and routing, its spec writer, its project modes and its alignments |
| `/mode default` | Save this session's major mode, strict flag and built-in minor modes as the default for new sessions (never a project mode) |
| `/mode strict on`, `/mode strict off` | Set this session's [strict](#strict) flag |
| `/mode subagents <profile>`, `/mode subagents off` | Pick this session's subagent profile, by id or name |
| `/align on`, `/align off` | Turn align on or off |

Shortcuts: `alt+m` switches between normal and Delegate, and `alt+a` opens the alignment viewer.
You can change the first, and give each minor mode a key of its own, in `~/.pi/agent/mode.json`.

To start a session in a mode without changing the default, launch pi with `pi --major delegate`
or `pi --minor align,spec`. A session's own saved mode wins over these flags. `--minor` names only
built-in modes.

The terminal's status line shows the mode, then `strict` when it's on in Delegate, then each
minor mode that is on, project modes after the built-in ones.

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
- **codemode** doesn't: it changes the chat's own tools, and a worker's tools come from its brief.
- **memory** doesn't: it is the chat's own memory of its conversation, and a worker starts fresh
  from its brief.
- A **project mode** does when its file says `workers: yes`: the worker gets the chat's copy of it,
  with its tools if it can run commands. See [Project modes](/docs/modes/project-modes/#workers).

A worker gets the modes its parent has **when it starts**. A later switch in the chat doesn't reach
a running worker; a resumed worker takes the parent's current modes. The worker's view in the
Subagents pane shows what it was given as a small chip beside its status, such as `spec`, with a
project mode by its id.

## strict

Strict is a flag for Delegate. While a chat is in Delegate with strict on, the agent loses its
`edit` and `write` tools. Only those two go: `bash`
and every other tool stay, and the agent's instructions read the same either way.

- It is **per session** and **off by default**. Set it in a terminal with `/mode strict on` or
  `/mode strict off`.
- The web mode menu shows it read-only in its foot, `strict: off` or `strict: on`. Save as default
  saves it with the rest of the chat's modes.
- In normal mode the flag is kept and does nothing. Switching to Delegate applies it.
- Sova never sets it: a switch from the menu can't carry it, and project coding sessions never set
  it. Workers are never strict.

## Sessions that choose their own mode

- **The Overseer** is always in normal mode with no minor modes, and no project modes. Its composer has no mode switch:
  its **Quick Actions** button takes that place, and a typed `/mode` answers "The Overseer is
  always in normal mode."
- **A project's coding sessions** start in the mode set on the project page, pinned from their
  first message. **Automatic**, the default, is normal mode, with spec on when the project has a
  spec (a `.sova/spec/manifest.json` file). The project overseer can't turn on Delegate unless you
  allow it on the project page, can't turn on align (nobody answers a coding session's questions),
  and can't turn spec off while the project's setting has it on. A coding session's mode never names a
  project mode. You can still switch a coding
  session yourself from its mode menu, like any chat.
