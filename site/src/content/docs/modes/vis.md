---
title: Vis
description: With vis on, the agent can draw small diagrams and charts in its replies. Sova draws them with its own code, and never puts the model's HTML or SVG into the page.
group: Modes
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
| `vis steps` | Scenario chains, with a status per row |
| `vis wireframe` | Low-fidelity phone or desktop screens, with arrows between them |
| `vis matrix` | A comparison grid with yes, no, partial or text cells |
| `vis code` | An annotated snippet: highlighted, numbered lines with notes |
| `vis html`, `vis svg` | Free-form, when no other kind fits (see below) |

Any drawing can **mark** up to 8 items, each with a tone and a short numbered note listed under
the drawing. Colour is never the only signal: a marked item is also heavier, and carries its
note's number.

## Reading a drawing

Each drawing has a title (or its kind's name), the drawing itself, its numbered notes and its
caption. Two buttons sit in its head:

- **Source** shows the block as the agent wrote it.
- **Copy** copies the whole block.

A sequence starts complete. **Step Through** walks it one message at a time with Previous and
Next ("Step 3 of 8"), dimming the later steps, and **Show All** ends the walk. Nothing plays by
itself.

A drawing never widens the chat: a wide one shrinks to fit, then scrolls sideways inside its own
box, at phone widths too. While the agent is still writing a block, its place holds a box reading
"Drawing {kind}…", so the reply doesn't jump when it finishes.

## When a block can't be drawn

- **With warnings.** If the intent is clear but something is off, such as a label over 200
  characters or a mark that names nothing, the drawing still draws. A muted line under it says what
  was changed: "Drawn with warnings: …".
- **Broken.** A block that can't be read shows as an ordinary code block, with a line saying why:
  "Couldn't draw this vis {kind} block (line N: …), so here is its source."

When a reply has a broken block, Sova tells the agent with a hidden note, once, and the agent gets
one more chance in the same run to re-send only the fixed blocks. The broken block stays visible
above the fix.

## Free-form drawings, and safety

`vis html` and `vis svg` are the fallback when no kind fits. The model's markup never enters
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
  show no warning lines, and a block they can't draw becomes one quiet line.

## What the agent gets

With vis on, the agent has a short entry in its instructions: when to draw, and one line per kind.
Each kind's exact syntax comes from a `vis_guide` tool, which the agent calls before the first
drawing of a kind in a chat, so a reply that draws nothing carries no drawing grammar. A
`vis_check` tool lets it test a free-form block before sending it. Both tools come and go with the
mode.

Turning vis on in the middle of a chat reaches the agent from its next message. Workers don't get
vis: drawings are for you, and a worker's replies are read by its parent session.

## Where vis isn't available

The Overseer is always in normal mode with no minor modes, so it doesn't draw.
