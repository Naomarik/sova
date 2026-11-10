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

Your chat stays out of the work. It fills in the Setup card and passes on what you tell it to. It
reads a design only when you ask, because reading a whole page into the chat is costly.

## Turn it on

Design is a row in a chat's mode menu (see [How modes work](/docs/modes/)). Only that menu turns it
on, and workers never get it.

## Setup

Ask for designs in your chat: "a pricing page for my tea shop, all Claude models". A **Design** card
opens with what you said filled in. Change anything on it. Your clicks don't go through the chat.

- **What Do You Want to Design**: your request, in your words. Paste a link here to use a page's
  images or its feel.
- **Models**: one section per provider, all closed at first. Each section's row shows how many of its
  models are designing and names them; **All** ticks or unticks the whole section, and the arrow opens
  it to tick single models. Ollama on this computer and Ollama Cloud are separate sections. Your
  favorites from the model menu come first in each section, then the most capable models. **Find a
  model** searches every section. The **Coordinator** dropdown above them picks the one model that
  coordinates; it can coordinate without designing. On a later run, picking a different coordinator
  starts a new one on that model. It keeps the notes, not the conversation, and Setup says so. A
  model marked "text only" can't read pictures and works from a written outline instead.
- **Directions**: pick from 20.
- **Links**: each link gets a row to choose how it's used:
  - **Use Its Images**: the coordinator opens the page once and brings back its images, with notes
    on its colors and fonts.
  - **Just Its Feel**: a model that can read pictures describes the page's colors, type and imagery
    in words, and that look leads over each design's direction.
  - **Not a Reference**: the address belongs in the page itself, like a booking or contact link. It
    is never opened.

Press **Start Coordinator**. Nothing is designed yet.

## The Design Brief

The coordinator writes a **Design Brief** on the card. It looks first at any screen or link you gave
it: a running copy of your project, or an address. If it found the wrong screen, press **Not This
Screen** and say which one to use.

- The **summary** is the short version for you to read.
- The **Full Prompt**, folded under it, is exactly what each design session gets.
- **The coordinator's questions** sit below, each with a recommendation. Answer them, or press
  **Go With Recommendations**. The coordinator writes the Full Prompt once they're answered.

You can change the brief either way. Press **Edit Summary** or **Edit Prompt**, or tell the
coordinator in its box. If you edit the summary, the coordinator rewrites the Full Prompt to match.
If you save your own Full Prompt, it launches as you left it. If something later would change your
prompt, the brief asks **Keep My Prompt** or **Rewrite It**, and Start waits for your choice.

### Images

Images from a link on Use Its Images show in a grid on the brief. Paste your own into the
coordinator's box, or into your chat, which passes them on. Each image is described for the
designers. Untick one to leave it out, or open it to read what it shows, add a note, or describe it
again. While a page using these images is being written, their spots show a plain placeholder. The
real images appear when the page is finished. Start waits while a link's images are still being
captured or described.

## Start

Press **Start**. Nothing is designed before you do, and the button names how many designs it starts.
A batch is models times directions. Above 12 designs Sova shows the count and an estimate and asks
before starting, and one start stops at 24. Models you've barred for workers in Settings don't
appear, and neither do models that can't run, such as retired Ollama Cloud models.

## Watching and working with designs

The card shows a grid of designs, each with its label, direction, model, status and cost. A design
waiting for a free session says so. While a page is being written it fills in as it arrives, with its
scripts off, so its buttons and animations work once it's finished. Up to four pages show live at
once; others say "Waiting for a free preview". A page loads only Google Fonts from the web.

- **Refine** hands a design back with your guidance and any quick prompts (Check Phone Width,
  Tighten Spacing, Fix Contrast, Make Content Real). The session opens the
  page at desktop and phone widths, looks at it, and fixes what it sees, up to two times. Every
  version is kept (A, A2).
- **Open** (or **Chat**) shows a design full size with its own conversation beside it, even while
  its first page is being written. **Hide Chat** gives the page the room. A session that has shut down starts again when you message it.
- **Retry** tries a failed design again in a fresh session.
- The **coordinator** has its own card and box. It knows what each design is, but not its code.
  Tell it what you want, such as "the header from A with the cards from C", and it starts a new
  design that names its parents.

None of this wakes your main chat. You can also tell the main chat "tell B to go darker", and it
passes that on word for word.

## The Gallery

The session pane's **Gallery** tab holds the chat's **Prototypes**, with **Open Coordinator**, then
**Page Assets**: every image the chat holds, to look through and download. The chat's
explanations come below.

Designs and their images last as long as the chat and show only inside it. They aren't on share
links.
