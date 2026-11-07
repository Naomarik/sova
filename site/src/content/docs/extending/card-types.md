---
title: Card types
description: A project can add its own cards to its chats' transcripts. Sova draws a data card for you, or runs your own view in a sealed box.
group: Extending
order: 22
---

A card type lets the agent, a script or a project mode's hook put a card in a chat: a question, a
checklist, a status, a table, some buttons, or a view of your own.

## The folder

Each type is a folder `.sova/cards/<name>/` in the checkout the chat runs in, so a chat in a worktree
uses its own branch's cards. It holds a `card.json`:

```json
{
  "version": 1,
  "toolkit": 1,
  "title": "Deploy check",
  "when": "When a release is ready for the user to confirm",
  "draws": "question",
  "answer": "at-once"
}
```

| Key | Meaning |
|---|---|
| `version` | Always `1` |
| `toolkit` | The toolkit version the type was made for, today `1` |
| `title` | The card's title |
| `when` | When the agent may raise it, at most 200 characters. Without it, the agent can't raise the card, and only a script or hook can |
| `draws` | `question`, `checklist`, `status`, `table`, `buttons`, or `view` for your own view |
| `data` | With `view` only: the shape its data must have, as a JSON Schema of types, properties, required fields, items, enums and lengths |
| `answer` | `none` (the default), `at-once` or `gather`. A question or buttons card is always answered, a status or table card never |
| `placement` | `anchored` (the default) or `follow`, where each new revision is drawn in full where it's raised |
| `height` | With `view` only: the height it reserves, 32 to 1200 px |

A view needs `view.tsx` beside `card.json`. A type's name is lowercase letters, digits and hyphens,
and it is `project.<name>` to everyone else, so it can never replace one of Sova's own. A project
counts at most 16 types.

A folder with a bad name, a bad or missing `card.json`, or a missing `view.tsx` is **broken**: it raises
nothing, and it never hides the others. The project page's Settings tab lists its types and each
broken folder with what's wrong, in its **Cards** section.

## Raising a card

An ordinary chat whose set holds a type with a `when` gets a `card` tool. Workers, the Overseers and
other special chats never do, and a chat with no such type sees no change at all.

From outside, scripts, hooks and extensions raise cards with the `session.card.post` command, read
them with `session.card.get`, and answer with `session.card.answer`. See [Scripting Sova](/docs/extending/scripting/).
A card can stand beside an open alignment question: answering it never answers the question or ends the chat's wait on it. A card's data is at most 64 KB, is
checked when it's raised, and a card that doesn't fit is never raised.

## What a view can do

A view runs in a **sealed box**: walled off from Sova's page, from its cookies and storage, from other
cards and from the network. It loads only Sova's toolkit and its own built code. Its look follows
Sova's design and theme. It runs only in Chrome, Chromium, Edge and the rest of their family; elsewhere
the card says so instead.

```tsx
import { card, mount } from "sova:card";
```

Through that one toolkit it can:

- read its card's data, answer, status and state, the session's id and title, and the theme;
- keep state of its own, up to 64 KB, across redraws, reloads and reopened chats;
- record an answer on its own card;
- put text at the end of the chat's draft, where you read and edit it before sending. It never sends;
- set its own height;
- run Sova's commands, once you trust the project's cards.

Anything else it asks for is refused.

## Trust

The first time one of a project's cards wants to act, it asks: **Trust {name}'s Cards** or **Not Now**.
A data card's button acts when it sends a message or runs a command that changes something. A view acts
when it runs any command at all, even one that only reads, because a read could hand it a whole chat.

Trust is once per project, and it covers every command, after later edits too. Only you grant it, on
Sova's page, and Sova keeps it outside every repository, so no branch can trust itself. **Stop Trusting
Cards** in the project's **Cards** section takes it back from the next command.

## When a card reaches a chat

**Types are fixed per chat.** A chat keeps the types it had the first time Sova built its tools, and
adding, changing or removing a `card.json` never changes a running chat. New chats get the new set, from
their own checkout.

**A view's code redraws on save.** Saving `view.tsx` or a file it imports redraws every card using it,
in every open browser, within about a second, each keeping its data, answer and state. A save that
doesn't build shows the card's error box with what's wrong, and the next good save draws it again.
The rest of the chat isn't touched.

A view built for another toolkit version never runs: its card says it needs updating. Data cards never do.

An extension can add card types too, named `<extension id>.<name>`, declared in its manifest entry.
