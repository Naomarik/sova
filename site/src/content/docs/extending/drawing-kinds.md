---
title: Drawing kinds
description: A project or an extension can add its own kinds of drawing to the ones the vis mode draws. Your view runs in a sealed box, and the agent learns the kind from your guide.
group: Extending
order: 23
---

Beside Sova's own [vis](/docs/modes/vis/) kinds, a project can add kinds of its own. The agent writes
one as a fence in its reply, and Sova draws it with your view.

## The folder

Each kind is a folder `.sova/drawings/<name>/` in the chat's own checkout, holding three files:

- `kind.json`, read as strictly as a card's:

  ```json
  { "version": 1, "toolkit": 1, "accepts": "data", "height": 240,
    "data": { "type": "object", "properties": { "tasks": { "type": "array" } }, "required": ["tasks"] } }
  ```

  `accepts` is `text` (your view gets the fence's body as text) or `data` (JSON checked against the
  `data` shape). `height` is the height it reserves.
- `view.tsx`, your view.
- `GUIDE.md`, which tells the agent how to use the kind.

A project counts at most 8 kinds. Broken ones are listed in the **Cards** section on the project page's
Settings tab, with what's wrong, as card folders are.

## How a fence names it

The fence word is `<owner>.<name>`: `project.gantt` for a project's, `notes.mindmap` for one from an
extension called `notes`. It can never replace one of Sova's kinds, which have no dot.

````markdown
```vis project.gantt
title: Release plan
{ "tasks": [{ "name": "Freeze", "days": 2 }] }
caption: Two days to freeze.
```
````

An optional `title:` first line and `caption:` last line are Sova's. The rest is your kind's.

## What a view can do

A drawing's view runs in the same [sealed box](/docs/extending/card-types/#what-a-view-can-do) as a card's,
inside Sova's figure, with its title, Source, Copy and caption. **A drawing only draws.** It can size
its box and nothing else: it has no answer, stages no text and runs no commands. One that can't be drawn
shows an error box with **Reload**.

## How a chat learns one

While [vis](/docs/modes/vis/) is on, the agent's `vis_guide` tool lists the chat's own kinds, one line
each, and for one kind returns how its fence is written and your `GUIDE.md`. With vis off a kind still
draws, but the chat isn't told about it.

## When a kind reaches a chat

The kinds a chat may draw, and their guides, are fixed with its card types, so a new or changed kind
reaches new chats. A fence naming a kind outside the chat's set is the ordinary vis error.

A view's code redraws on save, within about a second, as a [card's](/docs/extending/card-types/#when-a-card-reaches-a-chat)
does. Share and owner pages show the quiet line they show for any kind they don't draw.

An extension can add kinds too, declared in its manifest entry.
