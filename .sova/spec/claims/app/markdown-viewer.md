# §app/markdown-viewer — Reading window
> Part of the Sova design spec · [overview](../design/overview.md)

One reading window for a whole document or file, app-wide, also called the markdown viewer, that
any part of the app can open: `openMarkdown({ title, markdown, subtitle?, view? })` from
`src/lib/markdown-viewer.ts`, and `closeMarkdown()`. A caller that also gives the file's `name` gets
it shown by its type, as the System context card does with a file's path
(§chat.transcript/setup-card-open-file); with no `name` the text is a markdown document, rendered
whole, front matter included, at any size (What It's Told, §app.baton/told). There is only ever one:
a second open while it is open replaces what it shows in place. `view` is `'rendered'` (the default)
or `'source'`.

**Frame.** A native `<dialog class="md-viewer">` opened with `showModal()`, like the lightbox
(§design/deviations): top layer, the page inert behind it, over any dialog already open.

- **A modal, never the whole window.** It is centred on the scrim, with `--r-xl` corners all
  round, and it is only as tall as its document, up to its cap; a longer document scrolls inside
  it while the head stays put.
- **Desktop (768px and wider):** at most 760px wide (the wide modal's width) and at most 80% of
  the window's height, always at least `--space-5` (24px) from every edge. The document is a
  centred reading column up to 72ch wide.
- **Phone (under 768px):** the same centred card, not a sheet: `--space-4` (16px) from each
  side, at most 85% of the window's height, and no `.sheet-grip`.

**A file by its type**, worked out from its name and its contents, or from a language word (`lang`)
the caller gives when the name can't say:

- **Markdown** is rendered, with Rendered and Source views. A YAML front matter block at the very
  start, closed by its own `---` line, is left out of Rendered and kept in Source; one never closed
  is shown as it is.
- **Code** is coloured for its language, as §chat/markdown colours a code block.
- **JSON** is laid out and coloured; text that doesn't parse as JSON is plain text.
- **Anything else** is plain text.
- **A very large file**, past 200 KB whatever its type, is plain text with no colouring; markdown
  that big has no Rendered view and no Source toggle.
- **A file that can't be shown as text** says so: "Not a text file, so it isn't shown.", or past its
  source's size cap "Too large to show here.". A long file its source cut shows its start, under "The
  file is longer; this is its start."

Every open reads the file afresh: nothing is kept between opens. There are no next or previous
buttons.

**Head.** The title (and the subtitle under it, muted, when given), then up to three controls:

- **Source**, on markdown only, a toggle (`aria-pressed`): off shows the rendered document, on shows the exact
  raw text, in mono, wrapping (`white-space: pre-wrap`), nothing escaped away or reflowed. It
  opens on Rendered unless the caller passed `view: 'source'`.
- **Copy** copies the exact text, whichever view is showing, with the toast "Copied markdown." for
  markdown and "Copied the file." for anything else. A file that can't be shown has no Copy.
- **Close.**

**Rendered** is §chat/markdown's renderer unchanged (code blocks with Copy Code, `vis` drawings,
tables, links), without the message bubble's padding, fill and border. An image in it opens the
lightbox above the viewer.

**Closing.** Close, Esc, and a click on the backdrop close it. Esc closes only the viewer: a
dialog open underneath (Settings, the changes viewer) stays open, and what opened it is as it was. Following an in-app link
(`sova://`) closes it after navigating; an external link opens its new tab and leaves it open.

**Focus.** Opening moves focus to Close; closing returns it to whatever had it before the
viewer opened, or to the control the caller names when a read came first, if that is still on the page. The document is only in the DOM while the viewer
is open.
