# §chat/markdown — Markdown and code
> Part of the Sova design spec · [overview](../design/overview.md)

**Scope.** **assistant-text** rows render markdown, and so do the other places that show model- or
agent-written prose with this same renderer: the alignment viewer, report rows and team-message
cards, linked-session messages, the Overseer's briefs and idea text, and the markdown viewer
(§app/markdown-viewer). Everything else stays as it is:

- **user** text is plain, keeping `.message-text` and `white-space: pre-wrap`;
- **thinking** is plain inside its disclosure;
- **tool args and results** stay `<pre>` in mono, except file content (`write` content, `edit`
  before/after, `read` output), which is highlighted by its path with the theme below (§chat/slash-commands
  tool card).

The rendered content lives in one scope class on the bubble, and `.message-text` is dropped
there:

```html
<article class="message">
  <div class="message-head">…</div>
  <div class="message-body md">{rendered markdown}</div>
</article>
```

**Renderer rules** (any GFM renderer, e.g. `marked`, plus `highlight.js`; adding either
dependency needs approval under CLAUDE.md):

- **GFM on.** That gives tables, `~~strikethrough~~`, task lists, and autolinks for bare URLs.
- **Raw HTML is never rendered.** Any HTML in the model's output (block or inline) is emitted as
  **escaped text**. `<div onclick="x">hi</div>` shows literally, in the surrounding font, with
  no special styling. Don't sanitize-and-render, and don't strip it.
- **Links.**
  - Only absolute `http:`, `https:`, and `mailto:` URLs become links. Anything else (relative
    paths, `javascript:`, `file:`, `data:`) renders as its link text, unlinked.
  - `sova://s/<id>` and `sova://g/<groupId>` also become links, **in-app** ones (§app.overseer/links):
    resolved to the session's or group's route, same tab, no new-tab text or glyph. An unknown session id
    still links, through `#/sid/<id>`; an unknown group renders as its text, unlinked.
  - Every other link gets `target="_blank" rel="noreferrer"` and a trailing
    `<span class="visually-hidden"> (opens in a new tab)</span>`. The CSS adds the `external`
    glyph after it.
- **Headings** stay `h1`–`h6` in the DOM, but `.md` restyles them to bubble scale. `h1` and
  `h2` get `--fs-heading-s` at 600, and `h3`–`h6` get `--fs-body` at 600. They're never page
  size, because a message is not a page.

## §chat.markdown/element-styling — Element styling (what `.md` gives you)

| Element | Treatment |
|---|---|
| `p` | `--space-3` apart |
| `ul` / `ol` | `--space-5` indent, `--space-1` between items, nested lists tight |
| Task list `- [x]` | `<li><input type="checkbox" checked disabled> …` from the renderer. The bullet is dropped and the box is static (disabled, not clickable, `accent-color: --color-ink-2`). AT reads it as "checkbox, checked, dimmed". No class is needed, because CSS matches `li:has(> input[type=checkbox])` |
| `blockquote` | A 1.5px `--color-border-strong` left rule, `--space-3` inset, `--color-ink-2` text |
| `hr` | A 1px `--color-border` rule with `--space-4` above and below |
| `del` | Strikethrough in `--color-ink-muted` |
| `strong` | 600 |
| `em` | Renderer default, which is synthetic oblique. Only regular faces ship, so it's allowed but not styled further |
| Inline `code` | The base rule: `--color-sunken` chip, `--r-xs`, mono. It wraps anywhere |
| Table | Always wrapped: `<div class="md-table-wrap"><table>…</table></div>`. The wrapper scrolls sideways, so the pane never widens. Header row on `--color-sunken` at 600, `--fs-caption` text, 1px row rules. Words never break mid-word, so the table grows and scrolls. `align` from GFM is honored, and right-aligned cells get tabular numerals |
| Links | `--color-accent`, underlined, with an external glyph (one of the accent's three uses, §design/ground-rules). Long URLs wrap anywhere |

## §chat.markdown/code-blocks — Code blocks

Wrap every fenced block like this, except a `vis <kind>` fence, which is a drawing (§chat.markdown/visuals) and falls back to this block only when it can't be drawn:

```html
<div class="md-code">
  <div class="md-code-head">
    <span class="md-code-lang">ts</span>
    <button class="button button-sm button-ghost md-code-copy" type="button">
      <span class="icon icon-sm" style="--icon: url(/icons/copy.svg)" aria-hidden="true"></span>Copy Code
    </button>
  </div>
  <pre><code class="hljs language-ts">{highlighted html}</code></pre>
</div>
```

- **Language label.** The first word of the fence's info string, lowercased, and shown in
  uppercase eyebrow type. No info string means "text".
- **Highlighting.**
  - Languages: the `highlight.js/lib/common` set plus clojure, cmake, dart, dockerfile, elixir,
    erlang, haskell, http, latex, nix, powershell, protobuf and scala.
  - The fence word goes through one alias table first (`resolveLanguage` in
    `src/lib/markdown.ts`): `ts`/`tsx` → typescript, `js`/`jsx`/`mjs` → javascript, `c++`/`hpp`
    → cpp, `c#`/`cs` → csharp, `sh`/`zsh`/`shell` → bash, `console` → shell (prompt
    transcripts), `yml` → yaml, `html`/`vue`/`svelte` → xml, `toml` → ini, `jsonc` → json,
    `text`/`txt`/none → plaintext (never highlighted). The label still shows the raw word.
  - Highlight only when `hljs.getLanguage(lang)` exists. Otherwise, escape the text and add no
    `hljs-*` spans.
  - Don't use auto-detect: it guesses wrong on short snippets, and a wrong guess looks worse
    than plain text.
- **Long lines** don't wrap: the `pre` scrolls sideways inside the block (`white-space: pre;
  overflow-x: auto`). Code keeps its shape, and the block never widens the pane, 320 included.
- **Copy Code.**
  - The skill has no code-block copy control, so this reuses our existing copy pattern (Copy
    Session Path, Copy Output): `.button-sm.button-ghost` with the `copy` icon. Size sm is
    allowed because it sits inside an already-reached context.
  - It copies the **raw source text**, never the highlighted HTML.
  - On success the icon turns into `check` and the label becomes "Copied" for 1.5s, then
    reverts. Announce "Copied code." in the polite live region.
  - No toast: the feedback sits where the click happened.
  - On failure the label becomes "Couldn't copy" for 1.5s.
- **Block tokens.** `--color-sunken` ground, a 1px `--color-border` edge, `--r-sm` (monospace
  corners), and code in `--color-ink`. The head is `--control-sm` tall with a 1px rule under it.

## §chat.markdown/highlight-theme — Highlight theme (dark and light, tokens only)

The skill forbids the accent for syntax ("a keyword is not an action"). So the theme uses
weight and ink for structure, plus three status hues as *roles*. Those hues only ever appear
inside `.md-code` and `.toolcard-code`, so they never read as status.

| Role | highlight.js classes | Style | On sunken, dark / light |
|---|---|---|---|
| Keyword | `hljs-keyword` `-literal` `-selector-tag` `-doctag`, `.hljs-meta .hljs-keyword` | `--color-ink`, 600 | 13.43 / 14.78 |
| Type | `hljs-built_in` `-type` `-class` | `--color-ink`, 530 | 13.43 / 14.78 |
| Name | `hljs-title` (`.function_`, `.class_`), `-section` | `--status-info` | 6.47 / 5.27 |
| String | `hljs-string` `-regexp` `-char` `-symbol` `-template-tag` `-link` | `--status-success` | 7.19 / 5.04 |
| Number / attribute | `hljs-number` `-attr` `-attribute` `-variable` `-template-variable` `-selector-attr/-class/-id` | `--status-warn` | 6.98 / 4.90 |
| Comment | `hljs-comment` `-quote` `-meta` | `--color-ink-muted` | 5.40 / 4.75 |
| Punctuation | `hljs-params` `-property` `-punctuation` `-operator` `-subst` | `--color-ink-2` | 7.65 / 7.22 |
| Diff | `hljs-addition` / `-deletion` | `--diff-add-ink` on `--diff-add-bg` / `--diff-del-ink` on `--diff-del-bg`. The `+`/`−` sign carries the meaning too | 4.91 / 5.38 · 5.01 / 5.16 |
| Emphasis | `hljs-strong` / `-emphasis` | 600 / an underline in `--color-border-strong` (no italic face ships) | — |

Don't import a highlight.js stylesheet. These rules are the whole theme, and they follow
`data-theme` automatically.

## §chat.markdown/images-in-markdown — Images in markdown

- **`data:image/*` sources** (rare, and already local) render as a single §chat/images thumbnail. Use
  `<ul class="message-images message-images-single">`, alt "Image in this reply" or the
  markdown alt text if there is one, and the same lightbox.
- **Remote `http(s)` images are never fetched automatically**, because loading them would leak
  that you read this, from a local tool. They render as a link instead:

  ```html
  <a class="md-image-link" href="{url}" target="_blank" rel="noreferrer">
    <span class="icon icon-sm" style="--icon: url(/icons/image.svg)" aria-hidden="true"></span>Image: {alt or "untitled"}<span class="visually-hidden"> (opens in a new tab)</span>
  </a>
  ```

- **Anything else** renders as its alt text.

## §chat.markdown/streaming — Streaming

- **Re-rendering.** Re-parse the whole message's markdown per animation frame, not per delta.
  Swap the body's content in one go.
- **Open fences.** An **unclosed fence** mid-stream renders as an open code block, with its head
  and label as usual (an open `vis` fence is a fixed-height "Drawing…" box instead: §chat.markdown/visuals). Most GFM renderers already treat the rest of the text as code. Copy Code
  is present but copies what's there so far.
- **Highlighting.** Highlight a block only once its fence closes, or when the turn ends. While
  it's open it shows as plain escaped mono. Highlighting changes only color and weight, never
  line breaks, so it causes no layout jump.
- **Layout jumps.** Partial constructs (a table's header row before its separator, a half-typed
  `**bold`) render as text until they complete. That jump is accepted, and there's no height
  reservation. Auto-follow (§chat/transcript) keeps the bottom pinned. When you're not following, the browser's
  scroll anchoring (`overflow-anchor`, on by default) holds your place.
- **Author.** The `.live-dot` stays in the author row as in §chat/transcript, and there's no cursor glyph.

## §chat.markdown/visuals — Inline visuals (`vis` fences)

A fenced block whose info string is `vis <kind>` is a **drawing**, not code. Sova draws it with its
own Solid/SVG code (`src/vis/`): no diagram or chart dependency, and **model HTML or SVG never
enters the app's DOM**. Assistant-text rows only (§chat/markdown's scope), and the replies on share
and owner pages, which draw only `chart`, `flow`, `matrix`, `timeline`, `tree`, `steps`,
`wireframe` and `layers`, with no Source or Copy and no frames, and show one quiet line instead of a broken
block's source (§app.baton/outsider-view).

- **Kinds.** One registry (`src/vis/registry.ts`) lists every fence word; nothing else is drawn:

  | Fence | Draws | `mark` targets |
  |---|---|---|
  | `vis flow` | boxes and arrows, laid out by rank; frames around some nodes (§chat.markdown/vis-flow-groups) | node id or label |
  | `vis state` | a state machine (flow's layout, round nodes, `start`/`end` dots; frames as in flow) | state id |
  | `vis sequence` | actors, lifelines and numbered messages, with step-through | actor id or label, message number or exact label |
  | `vis layers` | a stack of labelled layers | layer label |
  | `vis tree` | an indented hierarchy | item name |
  | `vis flow` sections | side-by-side panels (§chat.markdown/vis-flow-sections) | node id or label |
  | `vis chart` | bar (grouped via `series:`, stacked), line, scatter; linear or log axis; parts (§chat.markdown/vis-parts) | row label |
  | `vis timeline` | dated events in order | the row's date or label |
  | `vis steps` | scenario chains with a status per row (§chat.markdown/vis-steps) | row label |
  | `vis wireframe` | low-fi screens: phone or desktop frames, wireflow arrows between screens (§chat.markdown/vis-wireframe) | a block's first text, a screen name or a block word |
  | `vis matrix` | a comparison grid (yes / no / partial / text cells, a text cell optionally toned: §chat.markdown/vis-matrix-tones) | row label or column label |
  | `vis code` | an annotated snippet: highlighted, numbered, marked lines with notes | line number or range |
  | `vis html`, `vis svg` | free-form, in a sandboxed frame (below) | — |

  An unknown kind word is an error (below). The grammar of each kind is taught to the model by the
  `vis` minor mode (`pi-config/extensions/mode/vis-mode.md`); its examples are parsed by the
  renderer's own parser in tests, so the guide and the renderer can't drift.
- **The figure.** Every kind sits in one shell (`Visual.tsx`): a head with the `title:` (wrapping,
  never ellipsized) or, without one, the kind's name as an eyebrow; a **Source** toggle
  (`aria-pressed`, shows the fence as written, without ligatures) and **Copy** (copies the whole
  fence, announced like Copy Code); the drawing; the numbered notes; the `caption:`. Backticks in a
  caption or note render as inline code; everything else is text.
- **Emphasis.** `mark <target>[, <target>…] [tone] ["note"]`, at most 8 mark lines per block,
  notes ≤ 120 characters, works in every kind. Commas outside quotes separate targets (`a, b`,
  `a,b`; a `"quoted, label"` is one target); a stray or trailing comma is an error. A marked item
  takes its tone (default accent), a heavier outline or a tinted row, and the note's number as a
  badge; one mark line naming several targets lists its note once and puts the same number on the
  first item of each target (a range still numbers only its first line); the notes are listed
  under the drawing in writing order.
  A malformed mark line is an error. A mark that can't apply is dropped with a warning (below): a
  target that names nothing (the line's other targets are kept), an item already marked (a range keeps its items not yet marked, its
  note on the first of them), a mark past the 8th. A dropped mark takes no number. A note over 120
  characters is cut to 120, with a warning. Colour is never the only signal: emphasis adds weight
  and a number, chart series pair hue with marker and dash, matrix marks carry a word, toned matrix
  cells carry an icon and a visually hidden word, flow frames carry a title.
- **Step-through** (sequence). The drawing starts complete; nothing plays by itself.
  **Step Through** starts at the first item; Previous / Next walk it ("Step 3 of 8", "3/8" at phone
  width, announced politely); later items are dimmed; **Show All** ends the walk.
- **Warnings (soft).** Where the intent is plain, a block draws instead of falling back: any one
  text (a label, a note, a `title:`, a `caption:`) over 200 characters is cut to 200, ending in "…"
  (the whole text stays in Source), and the marks above are dropped. The figure then draws with,
  in the chat, one muted line after its caption: "Drawn with warnings: line N: <what>; …." (each
  once, in line order; line 0 means the whole block, shown without "line"; no ligatures). The share
  and owner pages draw the figure without that line.
- **Errors (hard).** A closed fence that doesn't parse (an unknown kind, a line the grammar can't
  read, a limit a kind states as an error) renders as the ordinary code block of
  §chat.markdown/code-blocks, its head reading `vis <kind>`, plain (not highlighted), followed by one
  muted line: "Couldn't draw this vis <kind> block (line N: <what to write instead>), so here is its
  source." Error text and that source never use ligatures.
- **One parser, two grades.** `parseVis` (`src/vis/parse.ts`, with `registry.ts` DOM-free, so the
  server can run it) returns `{ok: true, spec, warnings}` (`warnings` is `[]` for a clean block;
  when not empty the spec carries the same list as `spec.warnings`) or `{ok: false, line, message}`
  for a hard error. Only a hard error is a block that failed.
- **Feedback to the model** (`server/vis-check.ts`). The model learns of a block that didn't draw
  through a hidden retry note, not through the reader's error line. In a chat Sova hosts (not the
  Overseer's, a baton session's or a project overseer's) with the vis minor mode on, when a run is
  about to settle, Sova parses every `vis` fence in that run's assistant text with the same
  `parseVis`, finding fences as the reader's view does (per text block). If any block has a hard
  error, Sova adds one hidden note (a `sova-vis-retry` custom message, `display: false`: never in
  the transcript or the live view; the model sees it) naming each such block (its number in the
  reply, its kind, its first line), the line and the error, and the model gets one more request in
  the same run, asked to re-send only the fixed blocks. At most one retry per run: the retry's own
  reply is never checked again, even if a block is still broken, and the broken block stays visible
  above the fix. No retry when the run was stopped or failed, when a message is queued behind it
  (that message goes first), when the session's file is held by another writer, or when vis is
  off. A block that draws with warnings never triggers one.
- **`vis_check`.** While vis is on, the model has a `vis_check` tool for draft `vis html` / `vis
  svg` bodies (title/caption lines included). It answers whether the block would draw (or its error
  and line), any warnings, and the document's size in characters against the budget (aim under
  8K; over 16K doesn't draw). With vis off the tool is not in the model's loadout. The guide's
  html/svg section names it in one line.
- **Streaming.** An open `vis` fence is never drawn half-way: it holds a 200px dashed box reading
  "Drawing <kind>… N lines", with a pulsing dot (static under reduced motion). The drawing replaces
  it when the fence closes. A re-render keeps an unchanged drawing's DOM (and a frame's state); a
  drawing's identity is a hash of its fence.
- **No layout shift.** A drawing reserves its height before it draws: each kind estimates it from
  its parsed spec at the body's width, and the figure holds a blank box of that height until the
  View mounts. All kinds' Views load together, the first time any visual appears. A frame starts
  at the last height it reported for the same source and width (kept for the tab), else a default.
  A drawing is never the scroll anchor, so one growing above the reader leaves their text in place.
- **Size and phones.** SVG kinds draw at their natural size, shrink to 80 % to fit the pane, then
  scroll sideways inside a focusable region; the pane never widens (390 px included). Kinds that
  can re-lay out do so first (flow turns `dir: right` downwards; bars turn horizontal when labels
  can't fit). At a container width ≤ 420 px the head's buttons are icon-only.
- **Tokens and theme.** Tokens only (`src/design/tokens.css`), through three tone variables
  (`--vis-fill`, `--vis-stroke`, `--vis-ink`) for `accent ok warn error info muted`. SVG is styled
  by classes, so a theme switch needs no re-render.
- **Free-form (`vis html`, `vis svg`).** The fallback when no kind fits:
  - a budget in **characters** (code points, not bytes) of the document after the `title:` /
    `caption:` lines: up to 8K (8,192) draws as is; up to 16K (16,384) draws with the warning
    "large: <n>K characters of <kind> (aim under 8K)"; over 16K is an error. The guide says to aim
    under 8K and states what is counted;
  - an `<iframe sandbox="allow-scripts">` with `srcdoc` (**never** `allow-same-origin`), a CSP that
    blocks all network access, and the app's tokens injected (re-sent on theme change);
  - **no autoplay**: a motion gate runs before the model's code and holds CSS animations, SMIL,
    `requestAnimationFrame` and `setInterval` until the first pointer or key event in the frame
    (`setTimeout` loops and script-made SVG escape it; the guide asks for a Play/Step button);
  - height: only a clamped number posted by the frame is trusted;
  - a script error shows one muted line under the frame.
- **The `vis` minor mode** (§chat/mode-menu) puts the guide in the system prompt, or in a hidden note
  when it is turned on mid-session (§chat.mode-menu/minor-toggle-keeps-prompt): when to draw (at most
  1–2 per reply, small, captioned, next to prose that says what to notice), the shared rules (with
  the 200-character text limit and the one-line caption), and one section per kind. A kind flagged
  `stub` in the registry is never taught. Its examples draw without warnings, and the flow and
  state examples are checked for what they mean, not only that they parse (`guide.test.ts`).
- **No regression.** A block that drew before soft warnings, inline flow labels
  (§chat.markdown/vis-flow-sections), panel-local ids, label marks in sequences and the character
  budget draws exactly as before (`src/vis/golden.json`, a fixed set of synthetic blocks and the
  guide's earlier examples with the specs the earlier parser gave).

## §chat.markdown/vis-parts — `vis chart` `type: parts`: a whole and its parts

One bar split into the chart's rows, in order, for a part-of-whole question (a request against the
context window, a share of a limit). HTML, drawn by `src/vis/kinds/chart/Parts.tsx`.

- **Syntax.** `type: parts`, then one row per part: `label value [tone]`. Optional `unit:` and
  `of: <capacity>`. `mark` a part by its label.
- **Head.** Number first, as the design system's Meter: with `of:`, "89.3k of 200k tokens ·
  45%" (the total in semibold mono, the rest muted); without, "908 KB in total".
- **Bar.** 20px, the parts in order, 1px apart, each as long as its share; a part with a value above 0
  keeps at least 3px, so a tiny part stays visible. With `of:` the bar is a track (1px strong border,
  sunken ground) and the unused rest is its empty part. The bar is `aria-hidden`: the legend carries
  the numbers. A marked part gets an ink outline inside its own box.
- **Legend.** One row per part under the bar: swatch, label, value, share, the numbers right-aligned
  in mono columns; with `of:` a last "Free" row (dashed swatch, muted label) for the unused rest.
  Shares are of the capacity, else of the total: `<1%` under 1, one decimal under 10, else whole.
  Once the whole reaches 10k every value from 1000 reads in k (9k beside 14k).
- **Colour.** A part's tone colours it; parts without one take the chart's series colours in turn
  (accent, warn, success, error, info, muted). A mark tints the part's legend row, adds the note's
  number there and outlines the segment; it never recolours the part.
- **Past `of:`.** Parts adding up to more than `of:` draw as without `of:`, with a warning
  (§chat.markdown/vis-lenience).
- **Errors.** A negative part, a part without a number, parts adding up to 0, `of:` on any other
  type or not a number above 0, `series:`,
  `scale: log`, `x:`/`y:`, more than 12 parts.
- **Height.** Estimated from the same metrics before it draws (§chat.markdown/visuals, No layout shift).

## §chat.markdown/vis-flow-sections — `vis flow` sections: panels side by side

A `== label ==` line in a `vis flow` or `vis state` starts a **panel**; the nodes and edges after it
belong to that panel. For two small graphs to compare (before/after, A vs B).

- **Layout.** Each panel is laid out on its own by flow's layout. The panels sit side by side,
  top-aligned, with a 1px rule between them, when all of them fit the pane at natural size;
  otherwise they stack, a rule between them, each re-fitted to the width as a lone flow is (a phone
  always stacks them). Each panel has its label above it as a heading (caption size, semibold).
- **Ids are local to their panel.** The same id in two panels is two nodes, each in its panel (the
  later one's key in the spec is `<id>@<panel number>`, which no written id can be; its label
  defaults to the id as written). So an edge never crosses panels. `mark <id>` names the node in
  the first panel that has the id; `mark "label"` the first node with that label.
- **Errors.** Nodes or edges before the first section line, a node declared twice in one panel, an
  empty or unlabelled section, a repeated section label, more than 4 sections.
- **No regression.** A flow without `==` lines parses and draws exactly as before (no `sections`),
  and so does a sectioned flow whose ids differ across panels (every one that parsed before).
- Frames around some nodes of one connected graph are §chat.markdown/vis-flow-groups; a panel may
  hold its own groups.
- **Chain tones** (any `vis flow` or `vis state`, panels or not). A tone word right after an edge's
  target (after its optional quoted edge label) tones that node: `a -> miss "dead" error`; a node
  given two different tones (by a `node` line or another chain) is an error naming both.
- **Inline labels** (any `vis flow` or `vis state`, panels or not), decided per fence. When any
  chain line has a quoted string right after its first id (`web "Browser" -> srv "Server"`), the
  fence is inline-style. Then, reading in order, the first string after an id labels that node when
  it has no label yet (no `node` line in its panel, no earlier inline label), and the next string
  labels the edge: `-> srv "Server" "WS"` gives srv its label and the edge "WS"; later,
  `db --> app "rows"` (app already labelled) labels the return edge. Writing a node's inline label
  again is not an edge label. After a target with a `node` line one string labels the edge. A
  different string right after an already-labelled source has no edge to label: the first label is
  kept, with a warning. A string right after a source that has a `node` line, or a third string, is
  an error. Shape and tone words may follow an id in an inline-style chain, one of each in any
  order (`gate "Manual approval" decision`, `db "Orders" store warn`); two different shapes or tones
  for one node are an error, and a chain shape applies to a node whose `node` line gives none. A
  fence with no such line reads exactly as before: a string after a target is the edge's label
  (`idle -> busy "prompt"`) and a shape word in a chain is an error. The guide teaches inline labels
  first, with an example that shows the label-then-edge pair, a return edge's label and a shape.

## §chat.markdown/vis-flow-groups — `vis flow` groups: frames inside one graph

A `group "Label" a b c` line in a `vis flow` or `vis state` draws a labelled **frame** around those
nodes of one connected graph (a process, a machine, a scope). `frame`, `subgraph` and `cluster` are
read as `group`, silently. The line has one quoted label, then node ids (commas between them
allowed), and no arrow; it may come before or after the chains that declare its nodes. A node
called `group` or `frame` in a chain still parses as before.

- **Membership.** Flat: a node sits in at most one group; groups do not nest and take no tone or
  mark. Edges may cross frame borders freely. Inside `== panels ==` a group line belongs to its
  panel and names that panel's ids; each panel draws its own frames.
- **Errors.** An id no node has (in that panel), a node in two groups, a group line with no ids,
  anything but ids after the label, more than 6 groups in a fence, a group line before the first
  section line of a sectioned fence.
- **Layout.** Flow's own layered layout keeps each group's members side by side on every rank it
  spans, groups in one left-to-right order on all ranks, and pushes every other node out of each
  frame's rectangle: no non-member box meets a frame, every member is inside its frame, and two
  frames never overlap, at natural size and when re-fitted to a narrow pane. An edge with one end
  in a group runs inside that frame on the ranks the frame spans.
- **Look.** A frame is a rounded, dashed `--color-border-strong` rectangle with a `--color-sunken`
  fill, drawn under edges and nodes. Its title sits inside at the top (caption size, semibold),
  drawn over the edges with a halo in the frame's fill, so it stays legible where an edge enters.
  In `dir: right` the title is cut to the frame's width with an ellipsis, the whole label as a
  tooltip. Share and owner pages draw a flow's frames the same way; the phone re-lays out as any
  flow does.
- **No regression.** A fence without group lines parses and lays out exactly as before, and a
  chain line that uses the word as an id (`frame -> x`) is a chain, not a group.
- **The guide** teaches it in one line under flow, and its main flow example draws one group.

## §chat.markdown/vis-lenience — `vis` lines models get wrong: one reading, or a did-you-mean

Models writing `vis` fences reach for a few shapes the grammar didn't read. Where such a line has
only one plausible meaning, it draws with that meaning; where it doesn't, its error says what to
write, quoting the corrected line. Every line that parsed before keeps its meaning.

- **A flow source's second line.** In a `vis flow` or `vis state` chain, a second string right
  after the chain's source, before its first arrow, is that node's second line, drawn under its
  label as a `node` line's is: `g1 "Gathering" "own states" -> n1` draws g1 as "Gathering" over
  "own states". The line is inline-style (§chat.markdown/vis-flow-sections), as it is with one
  string. A different second line for a node that already has one keeps the first, with a warning.
  A third string there is an error: "g1 takes a label and one second line before its arrow: g1
  "Gathering" "own states" -> n1".
- **A declaration without `node`.** A flow or state line of an id, a string, an optional second
  string and optional shape and tone words, with no arrow (`a1 "Worker starts" round`), declares
  that node exactly as `node a1 "Worker starts" round` does: a string after it as an edge's target
  is the edge's label, and it doesn't make the fence inline-style. A lone id is still an error
  that names the `node` line.
- **After a flow target**, the first string still labels the node (inline style) and the second the
  edge. A further string is an error that says what to write, by what came before it:
  - the target was labelled on this line: "unexpected "own states" after d1: one label and one
    edge label per target; for a second line use node d1 "Decision" "own states"";
  - the target was labelled earlier (or has a node line, or the fence isn't inline-style), so the
    first string was the edge's: "… one string per edge label (\n breaks a line): -> api "Notify
    completion\nPOST /confirm-upload"", led, when inline, by "api is labelled "API Server"
    already, so "Notify completion" labels the edge";
  - it follows a shape or tone word: "… strings go before shape and tone words: -> staging
    "rejected" error".
- **Sequence, Mermaid messages.** A message whose target ends in `:` or starts with `>`
  (`Client -> Server: SYN`, `Client->>Server: SYN`) is an error quoting the vis message: "write
  Client -> Server "SYN" (not Mermaid a -> b: msg)", a `-->>` reply as `-->`.
- **Tree, a slash outside the quotes.** A lone `/` right after a quoted name's closing quote (then
  the line's end or a space) is the folder's slash: `"Docs"/ "shared" ok` draws exactly as `"Docs/"
  "shared" ok` (a name already ending in `/` takes no second one). A slash joined to more text
  (`"Docs"/x`) is an error: "put the / inside the quotes: "Docs/"x".
- **Chart parts past `of:`.** A `type: parts` chart whose parts add up to more than `of:` draws
  exactly as the same fence without its `of:` line (no capacity, no free rest, shares of the
  total, "… in total"), with the warning "line N: the parts add up to 4.41, more than of: 4.19:
  drawn without of:" at the `of:` line (§chat.markdown/visuals, Warnings). Parts up to `of:` are
  unchanged.
- **The guide** teaches flow example-first, one bullet per shape, each quoting its example (a
  node labelled where it first appears, two lines in a box by `\n` in its label, the edge label
  after a target, shape and tone, a `node` line declaring a node); says that after a target the
  first string labels it and the second the edge, never a second line; lists short "Not vis"
  wrong→right pairs for Mermaid habits (`A->>B: msg`, `A[Label] --> B`) in its shared rules; and
  asks for a tree folder's `/` inside the quotes, a quoted mark target when it has spaces, and no
  `of:` when a chart's parts exceed it. It shows no node with two strings (a source's second line,
  a declaration without `node`): in an offline eval of weak models at low effort, showing one led
  a model to write `-> b "B" "role"` on targets, drawing the role on the arrow; the parser reads
  those forms when a model writes them anyway. The text sent to the model stays within the size it
  had (12,356 bytes), and so does the file (15,279).

## §chat.markdown/vis-matrix-tones — `vis matrix` cell tones

A matrix text cell may end in a tone word (`accent ok warn error info muted`): `72% warn`,
`83% ok`. For model × metric scorecards.

- **Grammar.** An unquoted text cell whose last word is a tone, with text before it, becomes that
  text with that tone. A quoted cell stays text (`"works ok"`); `"72%" error` is the text 72% with
  the tone error. A lone tone word (`ok`) is text. Yes/no/partial cells are unchanged: `no error`
  is still the mark no with the note "error". An empty or `-` cell stays empty.
- **Look.** The text sits in a chip with the tone's fill (`--vis-fill` through `vis-tone-*`), led
  by a status icon for ok, warn, error and info (the steps kind's icons) and a visually hidden tone
  word, so tone is never the only signal; accent is weight plus tint, muted is muted ink. A column
  or row mark and a cell tone coexist (the chip sits inside the tinted cell). Phone cards show the
  same chip. The height estimate counts the icon.
- **No regression.** A matrix with no toned cell parses and draws exactly as before.
- **The guide** teaches it in one line under matrix.

## §chat.markdown/vis-steps — `vis steps`: scenario chains

A kind for scenarios or journeys as chains, each with a status. HTML, `src/vis/kinds/steps/`.

- **Syntax.** One row per line: `"Label" [tone] | step -> step -> …`. The label is a "quoted label"
  or bare words (a label mixing the two, such as `'"all"'`, is kept as written, quotes and all); a
  step is a "quoted label" or bare words, and steps join with `->` only.
  `== lane ==` lines group the rows under a heading. No ids. `mark` a row by its label.
- **Row.** A status mark, then the label (semibold), then the steps as chips (sunken, 1px border)
  each after the first led by an arrow; the chips wrap with the pane, an arrow staying with the
  chip it leads to. Beside a 144px label column; at a figure width of 420px or less the label sits
  above its chain. Rows are bordered bands 4px apart; a marked row takes the shared emphasis tint
  and the note's number before its label.
- **Status.** `ok`, `warn`, `error` and `info` rows show their tone's icon (check, alert, x, info) in
  the tone's colour, so status never rests on hue alone; `accent` a filled dot, `muted` a dotted ring
  (and a muted label), no tone an empty ring.
- **Lane heads.** Caption size, semibold, 8px more space above all but the first.
- **Errors.** A row without `|`, an empty label or step, a step mixing a quoted label and bare
  words, an arrow other than `->`, an empty or unlabelled lane, more than 10 steps in a row, 16 rows
  or 6 lanes.
- **Height.** Estimated from steps.css' fixed metrics before it draws.

## §chat.markdown/vis-wireframe — `vis wireframe`: low-fi screens and wireflows

A kind for a screen's layout: what sits where on a phone or desktop page, one or more screens, the
taps between them, before/after and states. DOM blocks with an SVG arrow overlay,
`src/vis/kinds/wireframe/`; the parser is DOM-free (the server's vis check runs it).

- **Syntax.** Settings `title:`, `caption:`, `device: phone|desktop` (default phone). Then one block
  per line: `<word> ["text"]… [words] [-> "Screen"]`. A line indented more than the one above sits
  inside the nearest less-indented line, so any indent width works. `screen "Name" [phone|desktop]`
  starts a screen (optional for one screen); `== Name ==` does too, and a `screen` line right after
  it names the same screen. The strings fill the block's slots left to right; the words after them,
  in any order, are a tone, `on` (checked, selected), `wide`, and for `chart` `bar|line|pie`. No ids:
  an arrow names a screen; `mark` names a block by its first text (first in the screen it is
  written under, then anywhere), a screen by its name, or a block word. A block word written
  before a quoted text, or before a list of targets (`mark button "Save", "Cancel"`), is ignored.
- **Vocabulary.** The words the guide teaches: `header`, `tabs`, `tabbar`, `sidebar`, `footer`;
  `row`, `col`, `grid`, `card`, `list`, `item`, `modal`, `sheet`; `heading`, `text`, `image`,
  `avatar`, `icon`, `badge`, `stat`, `chart`, `table`, `progress`; `button`, `link`, `input`,
  `search`, `select`, `checkbox`, `toggle`, `radio`; `empty`, `loading`, `alert`, `toast`.
  `divider` draws but isn't taught. Common synonyms map silently (`navbar` → header, `dialog` → modal, `switch` →
  toggle, `primary` → accent, …). A word that is none of these draws as a plain box tagged with the
  word, which may hold blocks.
- **Page chrome.** A `header` sits at the top of its screen, its title first and the blocks inside
  it at its right; a back, menu or left-arrow `icon` goes before the title. On a desktop screen
  whose first block is a `header` and which has a `sidebar`, the header spans the frame, with the
  sidebar and the page below it.
  A `heading`'s first blocks, when they are a `button`, `link` or `icon`, sit at its right; the
  rest of what it holds is its section, below it. `tabbar` and
  `footer` sit at the bottom.
- **Screens.** Up to 6, each in a phone frame (240–300px) or a desktop frame (560–760px), both
  fluid with the figure, side by side in a strip. A frame never pans inside itself:
  - When the strip fits at those widths, it draws as is.
  - Otherwise, several screens that fit at 75% or more of their narrowest widths draw scaled as a
    whole, with no scroll.
  - Otherwise each frame wider than the figure is scaled down to fit it (small text is accepted: the
    layout is the message), and several screens sit in a sideways scroll-snap strip that scrolls
    only between screens. A row of screen buttons ("1 Before", "2 After") sits above it, one line,
    with ‹ › at its end; in a figure 420px wide or less it shows the numbers and the current
    screen's name, without ‹ ›, and numbers only (each button still named for assistive tech) when
    fewer than about 6 characters of that name would fit. It appears only while the strip scrolls. A figure opens on screen 1.
    The current screen (`aria-current`) is the one picked by a button, chip or ‹ › while it stays
    whole in view (a scroll, swipe or key by the reader drops the pick), otherwise the one the reader has scrolled to, and the last at the strip's end;
    ‹ › step from it, moving to a screen already in view without scrolling.
  A `modal` or `sheet` draws over its screen with a scrim; a `toast` floats over it without one.
- **Wireflow.** `-> "Name"` at the end of a block's line (or alone on the next line, for the block
  above it, or for the screen before any block) is the screen a tap opens; `"A" -> "B"` alone on a line links two screens. It draws a "→ 2 Name"
  chip on the block, a button that scrolls to and focuses that screen, and an SVG arrow from the
  block to the screen: a curve into the next screen, and a backward or skipping one through a lane
  beside the frames, never across a screen's content; arrow ends spread along the target's edge,
  and in a dense diagram (more than five backward or skipping arrows) lanes are shared. A scrolling strip narrower than 600px draws
  no arrows; the chips carry the targets. A name matches a screen exactly, else by a prefix that
  only one other screen has, else by its number. An arrow to a screen not drawn, or to a prefix
  several screens share (with a warning), is a "→ Name" chip with no arrow; an arrow to its own
  screen is dropped.
- **Hit targets.** The chips and the screen buttons are real controls with a 44px target. A chip's
  target scales with its frame (to 33px at the smallest whole-strip scale, 0.75); where frames are
  scaled down one at a time the screen buttons, never scaled, are the 44px route to every screen.
  The drawn controls are pictures and stay small.
- **Look.** Theme tokens only, light and dark; no gradients. Icons come from Sova's own icon set, never a
  library (an unknown name, or one the set lacks, draws a neutral dot); an image is a crossed box with its text. Marks take the shared
  emphasis ring and number (§chat.markdown/visuals).
- **Warnings, not errors.** Unknown words, stray words, unknown settings, a block under a leaf
  (drawn after it), limits (6 screens, 80 blocks, 6 levels, 6 tabs or table columns, 12 table
  rows), a screen-to-screen line (`"A" -> "B"`) naming a screen not drawn (dropped), all draw
  with a warning.
- **Errors.** The kind's own: a block line that starts with neither a word nor a "text" (ASCII
  art, HTML), an unclosed quote on a block line (a quote that closes on a later line, spanning at most 12 lines
  in all, is joined into one text, with a warning), and nothing to draw; plus a malformed `mark` line,
  as in every kind (§chat.markdown/visuals). Settings are read as text and never fail.
- **Height.** Reserved before it draws from wireframe.css' metrics (frame widths, nav row, row
  wrapping), within about 15% of the rendered height, so a drawing doesn't shift the thread.

## §chat.markdown/vis-wireframe-items — `vis wireframe` items: text beside, blocks wrapping under

An `item` is one line: its avatar, icon, image, checkbox or radio first; then its title over its
detail, which keep at least about 12 characters' width; then its right text; then its other blocks,
at its right. Blocks that don't fit beside the title go on a line of their own under the title and
detail, wrapping, each at its own width, never overlapping one another or running out of the item.
A `row` among them is laid out as part of that group. In a row beside other blocks, a badge takes
its label's width, cut short with an ellipsis if it must, like a button.

## §chat.markdown/accessibility — Accessibility

- **Headings.** They stay real headings, so heading navigation works inside long replies.
  Their level comes from the markdown. Since the page's `h1` is the session title, that
  duplicates levels. That's accepted for model content, and they're never promoted.
- **Code.** A code block is a `pre` that screen readers read verbatim. The Copy Code name
  includes "Code", and the language label is visible text.
- **Tables** keep `th`, which the renderer produces.
- **Contrast.**

  | Pair | Dark | Light |
  |---|---|---|
  | Accent link on surface | 4.67 | 6.81 |
  | Ink-2 blockquote on surface | 7.03 | 8.72 |
  | Syntax colors on sunken | see the theme table | see the theme table |

---

