# §app/markdown-viewer — Markdown viewer
> Part of the Sova design spec · [overview](../design/overview.md)

One viewer for a whole markdown document, app-wide, that any part of the app can open:
`openMarkdown({ title, markdown, subtitle?, view? })` from `src/lib/markdown-viewer.ts`, and
`closeMarkdown()`. There is only ever one: a second `openMarkdown` while it is open replaces the
document in place. `view` is `'rendered'` (the default) or `'source'`.

**Frame.** A native `<dialog class="md-viewer">` opened with `showModal()`, like the lightbox
(§design/deviations): top layer, the page inert behind it, over any dialog already open.

- **Desktop (768px and wider):** inset `--space-6` from every edge of the window, `--r-xl`
  corners, on the scrim. The document is a centred reading column 72ch wide that scrolls inside
  the frame; the head stays put.
- **Phone (under 768px):** a tall sheet, full width, with a `--space-5` (24px) gap above it,
  `--r-xl` top corners only, and the `.sheet-grip` at its top.

**Head.** The title (and the subtitle under it, muted, when given), then three controls:

- **Source**, a toggle (`aria-pressed`): off shows the rendered document, on shows the exact
  raw text, in mono, wrapping (`white-space: pre-wrap`), nothing escaped away or reflowed. It
  opens on Rendered unless the caller passed `view: 'source'`.
- **Copy** copies the raw markdown, whichever view is showing, with the toast "Copied markdown."
- **Close.**

**Rendered** is §chat/markdown's renderer unchanged (code blocks with Copy Code, `vis` drawings,
tables, links), without the message bubble's padding, fill and border. An image in it opens the
lightbox above the viewer.

**Closing.** Close, Esc, and a click on the backdrop close it. Esc closes only the viewer: a
dialog open underneath (Settings, the changes viewer) stays open. Following an in-app link
(`sova://`) closes it after navigating; an external link opens its new tab and leaves it open.

**Focus.** Opening moves focus to Close; closing returns it to whatever had it before the
viewer opened, if that is still on the page. The document is only in the DOM while the viewer
is open.
