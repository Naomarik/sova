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

Both kinds are **per chat**. Each chat keeps its own modes, saved in that chat's session file, so
they survive a reload or a server restart. Switching one chat never moves another chat or a
terminal session.

## Switch in the web app

The mode switch sits at the right end of the composer foot, after the model. It reads the chat's
major mode, then each minor mode that is on, for example `delegate · align`. Until Sova knows the
chat's mode it reads just **Mode**.

Press it to open the menu. It has three groups:

- **Major mode**: normal and delegate, each with its one-line description. Picking one closes the
  menu. Delegate's row has a gear, **Configure Delegate**, that opens Settings → Subagents without
  switching anything, so you can set Delegate up before you turn it on.
- **Minor modes**: align, spec, vis and codemode, each with its description. Toggling one keeps
  the menu open, so you can set several. Spec's row has a gear too, **Configure Spec**, that opens
  its spec writer settings.
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
- **A chat that can't switch** shows **This chat can't switch.** That happens when the mode
  extension isn't loaded in that chat, or another program wrote its session. The chat is left as
  it was.

Switching a minor mode in the middle of a chat doesn't rewrite the instructions the model already
has (except align in Delegate, which changes one paragraph of Delegate's instructions). The change reaches the model as a hidden note with its next message, which you don't see in
the transcript. This keeps the model provider's prompt cache, so a toggle doesn't re-send the whole
conversation. Turning **align**, **vis** or **codemode** on or off does change the agent's tools:
align adds its `align` tool, vis its drawing tools, and codemode its `codemode` tool.

Each switch is recorded in the session. It draws nothing in the thread, but it shows in the Session
pane's Changes and as a marker on the Timeline.

## This chat, and the default for new chats

`~/.pi/agent/mode.json` holds the **default for new sessions**. A chat that has never switched
follows it; its first switch pins that chat to its own modes from then on.

**A switch never changes the default**, not even in a brand-new chat. The default moves only when
you ask for exactly that:

- **Save as default** in the menu. It makes this chat's major mode, strict flag, minor modes and
  subagent profile what new sessions start from. It reads **Already the default**, and can't be
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
| `/mode` | Opens the command palette at its **Mode** category: the major modes, one row per minor mode, the alignment viewer, and save as default. It never switches anything by itself |
| `/mode normal`, `/mode delegate` | Switch this session's major mode |
| `/mode align`, `/mode vis on`, `/mode spec off` | Toggle a minor mode, or set it on or off |
| `/mode status` | List this session's modes, the default, its subagent profile and routing, its spec writer and its alignments |
| `/mode default` | Save this session's major mode, strict flag and minor modes as the default for new sessions |
| `/mode strict on`, `/mode strict off` | Set this session's [strict](#strict) flag |
| `/mode subagents <profile>`, `/mode subagents off` | Pick this session's subagent profile, by id or name |
| `/align on`, `/align off` | Turn align on or off |

Shortcuts: `alt+m` switches between normal and Delegate, and `alt+a` opens the alignment viewer.
You can change the first, and give each minor mode a key of its own, in `~/.pi/agent/mode.json`.

To start a session in a mode without changing the default, launch pi with `pi --major delegate`
or `pi --minor align,spec`. A session's own saved mode wins over these flags.

The terminal's status line shows the mode, then `strict` when it's on in Delegate, then each
minor mode that is on.

## What workers get

A worker is not a chat. It has no mode menu, and its parent chat's major mode never reaches it.
Of the minor modes, only those that are meant for workers reach them, and today that is only
**spec**:

- **spec** reaches every worker the chat starts while spec is on: pi or Claude Code, local or
  remote, alone or in a team (a team's monitor excepted). The worker gets the spec guide and a
  short note: its brief is its go-ahead, it works in the draft its brief names, and the parent
  promotes. See [Spec](/docs/modes/spec/).
- **align** doesn't: aligning is a conversation with you, and a worker doesn't have one.
- **vis** doesn't: drawings are for you, and a worker's replies are read by its parent.
- **codemode** doesn't: it changes the chat's own tools, and a worker's tools come from its brief.

A worker gets the modes its parent has **when it starts**. A later switch in the chat doesn't reach
a running worker; a resumed worker takes the parent's current modes. The worker's view in the
Subagents pane shows what it was given as a small chip beside its status, such as `spec`.

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

- **The Overseer** is always in normal mode with no minor modes. Its composer has no mode switch:
  its **Quick Actions** button takes that place, and a typed `/mode` answers "The Overseer is
  always in normal mode."
- **A project's coding sessions** start in the mode set on the project page, pinned from their
  first message. **Automatic**, the default, is normal mode, with spec on when the project has a
  spec (a `.sova/spec/manifest.json` file). The project overseer can't turn on Delegate unless you
  allow it on the project page, can't turn on align (nobody answers a coding session's questions),
  and can't turn spec off while the project's setting has it on. You can still switch a coding
  session yourself from its mode menu, like any chat.
