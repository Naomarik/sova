# Identity

> Part of [Sova branding](overview.md). The visual identity is the design skill; this page is the
> product's self-description.

## One line

A local web app for reading, watching, and continuing your pi sessions.

## One paragraph

Sova runs on your own machine next to the pi coding agent and reads the same `~/.pi/agent` the
terminal does. It lists every session on the machine, shows any transcript, watches a session
that's open in a TUI as it runs, and lets you chat in the sessions it started itself. Nothing
leaves the machine unless you point it at a remote target you own. It is one person's tool for
one person's agent.

## Who it is for

Someone who already runs pi. They have sessions on disk, extensions in `pi-config`, and opinions
about their terminal. Sova doesn't replace that setup; it gives it a second window, one that
works on a phone across the room and shows more than 80 columns can.

Write for that person. They know what a session, a model, and a tool call are. They don't need
the agent explained. They do need to know what Sova will and won't touch on disk, because it
shares the directory with a process they trust.

## What it stands for

**It reads what's there.** The session list is the sessions directory. The live view is the
session the TUI is writing. There is no import step and no copy.

**It stays out of the TUI's way.** A session open in a terminal is read-only here. Chat happens
only in sessions Sova created. The rule is in the code, not in a warning.

**It doesn't raise its voice.** One accent color, spent on the primary action, the live indicator,
and focus. Status carries a word, never a hue alone. Failures are stated once, plainly, with what
was and wasn't changed.

**It is honest about scope.** Local, single-user, no authentication. The README says to keep the
port behind a firewall because that is the truth of it.

## What it is not

Not a hosted service. Not a team product. Not a replacement for pi's TUI. Not a general chat
client: it speaks to pi's SDK and reads pi's files, and it would be useless without them.

Do not describe it with words that imply otherwise: platform, workspace-for-teams, cloud, seat,
tenant, plan. See [voice.md](voice.md) for the words it does use.

## Where the visual identity lives

- The system: `.claude/skills/fold-ai-dev-design/SKILL.md`, sections Voice, Color, Type, Logo.
- What Sova changes: [`spec/07-deviations.md`](../../spec/07-deviations.md). Dark by default,
  a JSON theme system, the Fold symbol in place of the skill's placeholder.
- The name and the mark: [naming.md](naming.md). The mark is Astra's **Fold**, shipped as
  `public/icons/sova-mark.svg`; the wordmark is lowercase `sova` in Inter 640.
- The mark that shipped before, `public/icons/pi-web-mark.svg` (a stroked π), is left on disk as
  history and is no longer used.
- Exploration sets for the marks are under `logos/`; the chosen lockup is
  [`logos/selected/sova-fold.html`](logos/selected/sova-fold.html).
