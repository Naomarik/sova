---
title: Add-ons in a Sova chat
description: A pi add-on loads in your Sova chats too. Its tools, commands and dialogs work there. Features that draw in the terminal don't.
group: Extending
order: 26
---

A pi **add-on** (pi calls it an extension) is code that changes what a chat can do. It isn't a
[Sova extension](/docs/extending/#give-them-new-abilities), which adds to Sova's page and nothing to
the agent. Sova embeds pi, so the add-ons your agent folder holds load in your chats.

**An add-on asks nothing and runs with full access**, as you. Read one before you add it. Add-ons in a
project's `.pi/extensions` folder, or in its `.pi/settings.json`, load in every chat in that folder with no
prompt, and Create doesn't offer them.

## What works

| Feature | In a Sova chat |
|---|---|
| Tools | Work, on pi and Claude Code models alike |
| `/` commands | Work, and are listed in the composer's menu with an `ext` chip |
| Events | Work: an add-on's handlers run as in the terminal |
| Model providers | Work, and are the supported way to add one from your own folder |
| `select`, `confirm`, `input` and `editor` dialogs | Work, as Sova's own dialogs |
| `notify` and status lines | Work |

## What doesn't

These do nothing in a Sova chat, and raise no error:

- widgets, the header, the footer and the title;
- editor components, and text put in or read from the editor;
- autocomplete providers;
- working messages and indicators;
- terminal input and shortcuts.

**Custom overlays** answer at once with no result. A command that needs one shows
"`/name` needs the terminal UI. Run it in pi in a terminal."

**MCP servers** an add-on or pi registers don't load in Sova chats. MCP isn't supported yet.

## What reaches workers

Workers don't inherit add-ons. A worker loads a fixed set, with discovery off, and an add-on reaches it
only when the chat names it in that worker's `extensions`. That has to be a path or a package pi has
already installed: nothing installs when a worker starts.

Project Overseers, the Project Assistant and gathering chats load no add-ons at all, so a tool made this
way doesn't reach them.

## When one reaches a chat

An add-on loads when a chat's process starts. A new chat gets it, and an open chat gets it at its next
reload. A chat keeps what it started with until then, so adding one changes nothing in a running chat.
A package added with `pi install` reaches chats the same way.

## Turning one on or off

Adding, removing or disabling an add-on is done in a terminal: `pi install` and `pi remove` for a
package, the file for your own, and `/extensions` in pi's terminal UI, which has no screen in Sova.
