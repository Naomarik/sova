# Playbook: update the README after a change

> Part of [Sova branding](../overview.md). For editing `README.md` when a feature lands, changes,
> or goes away. It is a checklist, not a template; the README's existing shape is the template.

## Before you write

1. Name the revision. `git rev-parse --short HEAD`. If your change isn't committed yet, say so
   in your report; the README describes the tree it ships in.
2. Confirm the feature the way [truth-sources.md](../truth-sources.md) says: route or socket
   message, component, and a look at the screen. The spec section that describes it is context,
   not evidence.
3. Read the README section you're touching and the sections that link to it. The README is
   short on purpose and every paragraph carries a fact; find the one your change makes wrong.
4. **Check the name.** The product is Sova, the package is `sova`, and the repository is
   [Naomarik/sova](https://github.com/Naomarik/sova). But the state directory
   `~/.pi/agent/pi-web/`, the `pi-web:*` browser keys and the `pi-web-theme/v1` schema are not
   migrated; leave those old names where they are the true ones. See
   [naming.md](../naming.md) for the ledger.

## What the README is

One page a pi user reads to decide whether to run this and how. It has a fixed order: what it is,
setup, running, the few features that need explaining (models, themes), tests, environment and
secrets, the pi-config mirror. It does not have a feature list, a roadmap, screenshots, or a
changelog, and it should not grow one for your change.

## Rules

- **Change the sentence that is now false.** Don't add a paragraph next to it.
- **A new feature gets a section only if a user needs instructions.** Models and Themes have
  sections because a user configures them. A new panel that just appears needs one sentence in
  the opening paragraph at most, or nothing.
- **Say the limit with the feature.** "It is for one local user." "Read-only here." If your
  feature has an edge, the README says it in the same sentence or the next.
- **Digits, code spans, en-US, sentence case.** As [voice.md](../voice.md).
- **Keep the tables as tables.** The path table and the env-var table are the README's index.
  A new path or variable goes in as a row, in the existing order.
- **Don't mention the spec section number.** Readers of the README don't have the spec open.
  Link to a file only when the reader will open it (an extension README, `CLAUDE.md`).
- **Don't write "now".** "Now supports" is false in a month. State the fact.
- **Never touch `CLAUDE.md` or an `AGENTS.md` from this playbook.** Those are agent instructions
  with their own owner.

## After you write

- Read the changed section aloud to the reader in [identity.md](../identity.md): another pi
  user on their own machine. Every sentence should be something they can check.
- `grep -n` for the old wording elsewhere in the README, `pi-config/README.md`, and the extension
  READMEs. The mirror publishes `pi-config/`; don't leave a contradiction there. Note that
  `pi-config/` names the app in places too and is owned elsewhere — flag it, don't edit it from
  here.
- Report which sentences changed and at which revision you verified them.

## Example

A change lands that makes a theme file appear in the picker without a restart.

Wrong: add a "Live reload" section with three paragraphs.

Right: find "Drop-in is live" under Themes, check that it's still true, adjust the number if the
poll interval changed, and leave it. If it is new, add two sentences where the drop-in directory
is introduced, with the interval as a digit.
