---
title: Vis
description: With vis on, the agent can draw small diagrams and charts in its replies. Sova draws them with its own code, and never puts the model's HTML or SVG into the page.
group: Modes
subgroup: Minor
order: 7
---

## What vis does

Vis is a minor mode: turn it on in the chat's mode menu (see [Modes](/docs/modes/)), in either
major mode. While it's on, the agent knows it can draw, and when a picture explains faster than
prose, it adds one to its reply: at most 1 or 2 per reply, small, captioned, next to text that says
what to notice.

The agent writes a drawing as a fenced code block labelled `vis` and a kind, such as `vis flow`.
Sova draws it with its own code instead of showing the block's text.

## The kinds

| Kind | Draws |
|---|---|
| `vis flow` | Boxes and arrows, with optional frames around groups of nodes, or side-by-side panels |
| `vis state` | A state machine, with start and end dots |
| `vis sequence` | Actors, lifelines and numbered messages, which you can step through |
| `vis layers` | A stack of labelled layers |
| `vis tree` | An indented hierarchy |
| `vis chart` | Bars (grouped or stacked), lines or scatter, on a linear or log axis |
| `vis timeline` | Dated events in order |
| `vis steps` | Scenario chains, with a status per row or step and an optional outcome; up to 4 chains stand side by side, with equal steps merged |
| `vis wireframe` | Low-fidelity phone or desktop screens, with arrows between them; a row can pin blocks to its end, let one block fill the room, share its width in set proportions and line its blocks up |
| `vis matrix` | A comparison grid with yes, no, partial or text cells |
| `vis code` | An annotated snippet: highlighted, numbered lines with notes |
| `vis html`, `vis svg` | Free-form: a clickable prototype of any screen beyond a simple one, something to play with, or a drawing no kind covers (see below) |

Any drawing can **mark** up to 8 items, each with a tone and a short numbered note listed under
the drawing. Colour is never the only signal: a marked item is also heavier, and carries its
note's number.

There is an example of every kind at the end of this page, under [Examples](#examples).

## Recorded tours

Ask in chat for a tour of a real feature or UI experiment. Say what it should cover, who it is for,
and what they should understand or decide. The agent asks for anything missing, then organizes
chapters, main steps and named views, with desktop and phone pictures. Before/After can be views
of the same step; a state that cannot be recorded safely is clearly labelled reference text.

The vis catalogue's `tour` entry teaches the agent the full recording workflow. It uses hosted
`record_tour` and `show_tour` tools, not a `vis tour` drawing fence. Sova checks a no-image dry run,
records with installed Chrome, then provides contact sheets for the agent to review before a
complete checked edition can be shown. Recording never sends, saves, approves or submits; it
follows the chat's sandbox. A new site needs your approval, and sign-in uses test accounts only.

Read the tour with Back/Next for main steps and chips for views. Your place is saved server-side,
so Continue works across desktop and phone. Ask in chat to change a tour; re-recording keeps the
previous complete edition readable until its replacement passes checking.

A share link needs your preview of every picture and its text, plus an expiry. Each link stays on
the edition you reviewed; a changed tour needs a new link. Reviewed tours can also be attached to
organization hand-off conversations without granting participants access to the recorded app.
Ask About This Step fills a draft on their turn, never sends it.

## Reading a drawing

Each drawing has a title (or its kind's name), the drawing itself, its numbered notes and its
caption. Two buttons sit in its head:

- **Source** shows the block as the agent wrote it.
- **Copy** copies the whole block.

A sequence starts complete. **Step Through** walks it one message at a time with Previous and
Next ("Step 3 of 8"), dimming the later steps, and **Show All** ends the walk. Nothing plays by
itself.

A flow or state drawing never cuts its words: questions are wide hexagons, and every label,
note and frame title wraps to as many lines as it needs. Tap or click a shape to follow it: its
neighbours stay lit, the rest fades, and a panel under the drawing shows its full text with
buttons to the shapes before and after it. Tap it again, or press Escape, to clear. With the
keyboard, Tab to the drawing, move between shapes with the arrow keys and pick with Enter.

A drawing never widens the chat: a wide one shrinks to fit, then scrolls sideways inside its own
box, at phone widths too. While the agent is still writing a block, its place holds a box reading
"Drawing {kind}…", so the reply doesn't jump when it finishes.

## When a block can't be drawn

- **With warnings.** If the intent is clear but something is off, such as a label over 200
  characters or a mark that names nothing, the drawing still draws. A muted line under it says what
  was changed: "Drawn with warnings: …".
- **Broken.** A block that can't be read shows as an ordinary code block, with a line saying why:
  "Couldn't draw this vis {kind} block (line N: …), so here is its source."

- **Cramped.** A wireframe whose labels would be squeezed into boxes too narrow to read still
  draws, with no warning line; Sova treats it like a broken block (below).

When a reply has a broken block or a cramped wireframe, Sova tells the agent with a hidden note,
once, and the agent gets one more chance in the same run to re-send only the fixed blocks (or, for
a dense screen, a clickable `vis html` prototype instead). The first drawing stays visible above the
fix. This happens wherever the agent draws: with vis on, or with align on in a chat that started
with Visuals, where it also covers the drawings on the alignment card.

A wireframe sizes itself by what it holds: a short desktop dialog stays small and one holding a
layout or a form takes most of the screen, a grid has as many columns as its room holds, and text
wraps between words, never letter by letter.

## Free-form drawings, and safety

`vis html` is the agent's default for any screen beyond a simple one (where the look and feel
matters, panes side by side, an editor in a dialog, a dense desktop layout), without your asking
for HTML; a wireframe stays for simple screens and flows across screens. `vis html` and `vis svg`
also draw something to play with, or a picture no kind covers. The model's markup never enters
Sova's own page:

- It runs in a sandboxed frame, cut off from Sova's page, whose rules block scripts, styles,
  images, fonts and connections from anywhere outside the block itself.
- Most animation waits for your first click or key press in the frame.
- A block is meant to stay under 8K characters. Up to 16K it still draws, with a warning; over
  16K it doesn't draw.

## Where drawings show

- **In the chat**, in the agent's replies.
- **On shared pages**, where Sova draws every kind but `vis code`. A free-form `vis html` block
  draws there only when the session allows it, and `vis svg` shows as a static image. Shared pages
  show no Source or Copy and no warning lines, and a block they can't draw becomes one quiet line.
- **On alignment cards**, with [align](/docs/modes/align/) on and **Visuals** switched on in
  Settings → Alignment, where the agent can draw a question's wireframe or flow.

## What the agent gets

With vis on, the agent has a short entry in its instructions: when to draw, and one line per kind.
Each kind's exact syntax comes from a `vis_guide` tool, which the agent calls before the first
drawing of a kind in a chat, so a reply that draws nothing carries no drawing grammar. A
`vis_check` tool, in chats Sova runs, lets it test a free-form block or a wireframe before sending
it. Both tools
come and go with the mode, and a chat with align on that started with Visuals has them too. The
`tour` entry instead returns its recording workflow, with Sova's hosted `record_tour` and
`show_tour` tools. Tour tools require vis mode on; align with Visuals alone keeps drawing tools
only. Hand-off conversations receive only scoped presentation access, independent of their drawing
switches.

Turning vis on in the middle of a chat reaches the agent from its next message. Workers don't get
vis: drawings are for you, and a worker's replies are read by its parent session.

## Where vis isn't available

The Overseer is always in normal mode with no minor modes, so it doesn't draw.

## Examples

One block of each kind, as the agent writes it, followed by the drawing Sova makes of it. On this
page the drawings are still pictures: in the chat, a sequence's **Step Through** works.

<!-- vis-examples -->
