# §chat/markdown — Markdown and code
> Part of the Sova design spec · [overview](../design/overview.md)

**Scope.** **assistant-text** rows render markdown. Everything else stays as it is:

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
    resolved to the session's or group's route, same tab, no new-tab text or glyph. An unknown id
    renders as its text, unlinked.
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
and owner pages, which draw only `chart`, `flow`, `matrix`, `timeline`, `tree`, `steps` and
`layers`, with no Source or Copy and no frames, and show one quiet line instead of a broken
block's source (§app.baton/outsider-view).

- **Kinds.** One registry (`src/vis/registry.ts`) lists every fence word; nothing else is drawn:

  | Fence | Draws | `mark` targets |
  |---|---|---|
  | `vis flow` | boxes and arrows, laid out by rank | node id or label |
  | `vis state` | a state machine (flow's layout, round nodes, `start`/`end` dots) | state id |
  | `vis sequence` | actors, lifelines and numbered messages, with step-through | actor id or label, message number or exact label |
  | `vis layers` | a stack of labelled layers | layer label |
  | `vis tree` | an indented hierarchy | item name |
  | `vis flow` sections | side-by-side panels (§chat.markdown/vis-flow-sections) | node id or label |
  | `vis chart` | bar (grouped via `series:`, stacked), line, scatter; linear or log axis; parts (§chat.markdown/vis-parts) | row label |
  | `vis timeline` | dated events in order | the row's date or label |
  | `vis steps` | scenario chains with a status per row (§chat.markdown/vis-steps) | row label |
  | `vis matrix` | a comparison grid (yes / no / partial / text cells) | row label |
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
- **Emphasis.** `mark <target> [tone] ["note"]`, at most 8 per block, notes ≤ 120 characters,
  works in every kind. A marked item takes its tone (default accent), a heavier outline or a tinted
  row, and the note's number as a badge; the notes are listed under the drawing in writing order.
  A malformed mark line is an error. A mark that can't apply is dropped with a warning (below): a
  target that names nothing, an item already marked (a range keeps its items not yet marked, its
  note on the first of them), a mark past the 8th. A dropped mark takes no number. A note over 120
  characters is cut to 120, with a warning. Colour is never the only signal: emphasis adds weight
  and a number, chart series pair hue with marker and dash, matrix marks carry a word.
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
- **Errors.** A negative part, a part without a number, parts adding up to 0, parts adding up to more
  than `of:` (at the `of:` line), `of:` on any other type or not a number above 0, `series:`,
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
- Frames or clusters inside one connected graph are not part of this.
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

