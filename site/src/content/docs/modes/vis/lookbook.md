---
title: Lookbook
description: Ask a chat with vis on for a Lookbook, and hidden sessions on several models each build one page, drawn live side by side, to refine, talk to and combine.
group: Modes
subgroup: Minor
order: 7.5
---

## What a Lookbook does

A Lookbook is one page designed by several models side by side. You describe a page, or point at
one you already have, and several hidden design sessions each build a complete prototype of it. Each
one works in its own style, such as Minimalist or Heritage, on a model you choose. The pages appear
as they are written, on a **Lookbook** card in the chat and in the session pane's **Gallery** tab.

Designs keep the labels they start with (A, B, C), so you can talk about them by name.

Your chat stays out of the work. It fills in the Setup card and passes on what you tell it to. It
reads a design only when you ask, because reading a whole page into the chat is costly.

## How to get one

A Lookbook is part of [vis](/docs/modes/vis/): turn vis on in the chat's mode menu (see
[How modes work](/docs/modes/)), then ask for a Lookbook, by name ("make a Lookbook of the pricing
page") or in words that plainly mean it ("have a few models each mock up this page"). The chat
decides from what you wrote. An ordinary ask to sketch, mock up or wireframe something ("mock up a
login page") gets a quick drawing instead. If the chat asks you something first, such as which
models, your answer still counts as the same ask. Notes and other chats' or workers' messages never
open one, and workers never have Lookbooks.

Turning vis on or off adds or removes the Lookbook's tool with vis's own, so a chat with vis on
from the start changes nothing when a Lookbook begins.

## Setup

Ask for a Lookbook in your chat: "a Lookbook of a pricing page for my tea shop, all Claude models".
The card opens as **Lookbook · Setup**, with what you said filled in. Change anything on it. Your clicks don't go through the chat.

- **What Do You Want to Design**: your request, in your words. Paste a link here to use a page's
  images or its feel.
- **Models**: one section per provider, all closed at first. Each section's row shows how many of its
  models are designing and names them; **All** ticks or unticks the whole section, and the arrow opens
  it to tick single models. Ollama on this computer and Ollama Cloud are separate sections. Your
  favorites from the model menu come first in each section, then the most capable models. **Find a
  model** searches every section. The **Creative Director** dropdown above them picks the one model that
  coordinates; it can coordinate without designing. On a later run, picking a different Creative Director
  starts a new one on that model. It keeps the notes, not the conversation, and Setup says so. A
  model marked "text only" can't read pictures and works from a written outline instead.
- **Directions**: pick from 20.
- **Links**: each link gets a row to choose how it's used:
  - **Use Its Images**: the Creative Director opens the page once and brings back its images, with notes
    on its colors and fonts.
  - **Just Its Feel**: a model that can read pictures describes the page's colors, type and imagery
    in words, and that look leads over each design's direction.
  - **Not a Reference**: the address belongs in the page itself, like a booking or contact link. It
    is never opened.

Press **Start Creative Director**. Nothing is designed yet.

### Design skills

A Lookbook loads no skill and no project file by itself, not even your project's own. To use a
design skill, name it to your chat in your own words: by its name ("use the brand skill", found among
the project's skills) or by its folder ("use the brand kit in ~/kits/acme", a folder holding a
`SKILL.md`). Setup lists the skills you named under **Design skills**; there is nothing to tick. A
skill you named that can't be found becomes one of the Creative Director's questions on the brief.

The Creative Director reads the skills, and can read any file you point it to ("the logo is in my
Downloads folder"), but writes and runs nothing. It chooses which of your skills the designers use,
leaving out any that aren't about design, and the brief's **Design skills** line shows that choice.
Its brief suggests which files of each skill the designers read first. Each designer can read those
skills, and only those, through a reader Sova gives it. While it does, its tile says **Reading the
design skill**. Designers copy the tokens and rules they use into the page, which still loads nothing
but Google Fonts. An image the Creative Director finds, such as a logo, joins the brief's images and
reaches the designers from there. The estimate before Start counts the reading.

## The Design Brief

The Creative Director writes a **Design Brief** on the card. It looks first at any screen or link you gave
it: a running copy of your project, or an address. If it found the wrong screen, press **Not This
Screen** and say which one to use.

- The **summary** is the short version for you to read.
- The **Full Prompt**, folded under it, is exactly what each design session gets.
- **The Creative Director's questions** sit below, each with a recommendation. Answer them, or press
  **Go With Recommendations**. The Creative Director writes the Full Prompt once they're answered.

You can change the brief either way. Press **Edit Summary** or **Edit Prompt**, or tell the
Creative Director in its box. If you edit the summary, the Creative Director rewrites the Full Prompt to match.
If you save your own Full Prompt, it launches as you left it. If something later would change your
prompt, the brief asks **Keep My Prompt** or **Rewrite It**, and Start waits for your choice.

### Images

Images from a link on Use Its Images show in a grid on the brief. Paste your own into the
Creative Director's box, or into your chat, which passes them on. Each image is described for the
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
- The **Creative Director** has its own card and box. It knows what each design is, but not its code.
  Tell it what you want, such as "the header from A with the cards from C", and it starts a new
  design that names its parents.

None of this wakes your main chat. You can also tell the main chat "tell B to go darker", and it
passes that on word for word.

## The Gallery

The session pane's **Gallery** tab holds the chat's **Prototypes**, with **Open Creative Director**, then
**Page Assets**: every image the chat holds, to look through and download. The chat's
explanations come below.

Designs and their images last as long as the chat and show only inside it. They aren't on share
links.
