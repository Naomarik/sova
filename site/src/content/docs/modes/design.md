---
title: Design
description: With Design on, a chat sends one-page prototypes out to hidden sessions on several models, draws them live, and lets you refine, talk to and combine them.
group: Modes
subgroup: Minor
order: 8.6
---

## What Design does

Design is a minor mode for trying out how a page could look. You describe a page, or point at one
you already have, and several hidden design sessions each build a complete prototype of it. Each one
works in a design direction, such as Minimalist or Heritage, on a model you choose. The pages appear
as they are written, on a card in the chat and in the session pane's **Gallery** tab.

Designs keep the labels they start with (A, B, C), so you can talk about them by name.

Your chat stays out of the work. It fills in the Setup card and passes on what you tell it to, and
it reads a design only when you ask. A page costs it 16,000 to 24,000 tokens.

## Turn it on

Design is a row in a chat's mode menu (see [How modes work](/docs/modes/)). Only that menu turns it
on, and workers never get it.

## Start a batch

Ask for designs in your chat: "redesign my settings page, all Claude models and all Ollama models".
A **Design** card opens with what you said filled in. Change anything on it. Your clicks don't go
through the chat.

- **Brief**: what to design.
- **Models**: tick each model that should design. Each model also has a **Coordinator** checkbox,
  and one model holds it at a time. It can coordinate without designing.
- **Directions**: pick from 20.

A batch is models times directions: 6 by default. Above 12 in one launch Sova shows an estimate before
anything is spent, and a launch stops at 24. Models you've barred for workers in Settings don't appear.

Press **Start Coordinator**. A new idea launches at once. If the brief is about a screen you already
have, the coordinator finds it first, in a running copy of your project or at an address you gave it,
and shows it to you: press **Design This Screen**, or **Not This Screen**, or tell it where to look.

## Watching and working with designs

Each design shows its label, direction, model, status and cost. While a page is being written it is a
still picture. Its buttons and animations work once it is finished. Ollama models take 2 to 5 minutes
a page and appear the same way. A page can load Google Fonts and nothing else from the web, so images
are drawn in the page.

- **Refine** hands a design back with your guidance. The session opens the page at desktop and phone
  widths, looks at it, and fixes what it sees, up to two times. Every version is kept (A, A2).
- **Chat** opens a design's own conversation beside the page. A session that has shut down starts
  again when you message it.
- The **coordinator** has its own card and chat. It knows what each design is, but not its code. Tell
  it what you want, such as "the header from A with the cards from C", and it starts a new design
  that names its parents.

None of this wakes your main chat. You can also tell the main chat "tell B to go darker", and it
passes that on word for word.

Designs last as long as the chat and show only inside it. They aren't on share links.
