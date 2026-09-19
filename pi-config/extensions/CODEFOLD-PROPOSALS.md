# Code-fold proposals for the main pi chat thread

Status: **proposal only, nothing implemented.** Scope: long fenced code blocks inside
*assistant text* in the main transcript. Tool results, bash output and write/edit rows
already collapse with the built-in `ctrl+o` (`app.tools.expand`); see
`components/bash-execution.js` (`PREVIEW_LINES = 20`) and `tool-execution.js`
(`FALLBACK_PREVIEW_LINES = 10`). These designs cover the part `ctrl+o` doesn't touch.

All three are deliberately **not** the `▸ lang · N lines · snippet` line from
`subagents/codefold.ts`.

---

## 0. Feasibility ground truth (applies to all three)

What I checked in the source (paths relative to the pi-coding-agent package):

| Question | Answer | Evidence |
|---|---|---|
| How is assistant text rendered? | `AssistantMessageComponent.updateContent()` creates one pi-tui `Markdown` per text part, passing `transform: createMarkdownTransform("assistant", isStreaming, transformers)` | `dist/modes/interactive/components/assistant-message.js` |
| How are fences drawn today? | `Markdown.renderToken` `case "code"`: a `codeBlockBorder("```lang")` line, then `codeBlockIndent` (default 2 spaces) + `highlightCode()` lines, then a closing border line. The layout is hardcoded and no theme hook replaces it | `node_modules/@earendil-works/pi-tui/dist/components/markdown.js` ~l.382 |
| Can `registerMarkdownTransformer` fold fences? | **Yes.** It runs on the raw markdown before `marked.lexer`, receives `{messageType, isStreaming, availableWidth}`, is sync, and is re-run whenever `Markdown.render()` misses its cache (text change or width change) | `markdown.js` l.186, `markdown-transform.js` |
| Can the transformer emit custom chrome? | **Yes, verified by running pi-tui's `Markdown`.** Raw ANSI (e.g. `theme.fg(...)`) and box-drawing chars pass through paragraph text, `\` + newline hard breaks become `"\n"` line breaks, and **each code line wrapped as a codespan** (backtick fence one longer than any backtick run in the line, with ZWSP guards) stays literal: `*`, `_`, `#`, `<div>`, `|`, leading spaces and pre-highlighted ANSI all survive. Plain backslash-escaping does **not** work reliably next to ANSI (tested: stray `\` leaks) | `/tmp/mdtest{1,2,3}.mjs` experiments |
| Syntax highlighting inside custom chrome? | `highlightCode(code, lang)` and `getMarkdownTheme` are exported from `@earendil-works/pi-coding-agent` (`dist/index.d.ts` l.29), so an extension can reuse pi's exact highlighter and theme colours | `theme.js` l.838 |
| Can `registerMessageRenderer` override built-in assistant rendering? | **No.** It's only looked up for `role: "custom"` messages (`case "custom"` → `getMessageRenderer(message.customType)`). The same goes for `registerEntryRenderer` and `appendEntry` entries | `interactive-mode.js` ~l.2927, docs/extensions.md "registerMessageRenderer" |
| Global toggle key | `registerShortcut`. `ctrl+o` is **reserved** (`app.tools.expand` is in `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS`), so the extension can't take it. **`alt+o` is unbound** in the default keymap | `dist/core/extensions/runner.js` l.7-25, docs/keybindings.md |
| Forcing already-rendered messages to re-render after a toggle | Flipping a module flag alone does nothing because `Markdown` caches by `(text, width)`. `setToolsExpanded` only calls `setExpanded()` on `isExpandable` children, and `AssistantMessageComponent` isn't one. Working path: capture the `TUI` instance from a `ctx.ui.setWidget(key, (tui) => emptyComponent)` factory (it receives `this.ui`, `interactive-mode.js` ~l.1725), then call `tui.invalidate(); tui.requestRender()`. `AssistantMessageComponent.invalidate()` rebuilds its `Markdown` children, which re-runs the transformer. This is the same path pi takes on theme changes (`onThemeChange → this.ui.invalidate()`) | `tui.js` l.531, `assistant-message.js` `invalidate()` |
| Cost of that re-render | In main-screen mode, changes above the viewport trigger `fullRender(true)` (clear screen + scrollback, then replay). `ctrl+o` already works this way, so it's acceptable, but it visibly repaints | `tui-main-screen.js` l.237-317 |
| Theme tokens | `ctx.ui.theme` is a live getter: read it lazily at transform time, not captured once. Tokens used below: `mdCodeBlockBorder`, `mdCodeBlock`, `mdCode`, `accent`, `muted`, `dim`, `border`, `borderMuted`, `borderAccent` | docs/themes.md "Color Tokens" |
| Width / ANSI | `availableWidth` equals the Markdown content width (terminal minus pi's `outputPad` on each side). pi-tui **wraps** (`wrapTextWithAnsi`) and doesn't truncate, so every emitted line must already fit: use `truncateToWidth` / `visibleWidth` from `@earendil-works/pi-tui` | `markdown.js` l.210 |

**Shared constraints (all designs):**

- **Fence scanner.** The transformer needs its own line scanner for `` ``` `` and `~~~`
  fences (tracking fence char and length, per CommonMark). Fold **only column-0 fences**.
  Fences inside list items or blockquotes are left untouched, because rewriting them as
  paragraphs would break the list or quote structure. Blocks at or below a threshold
  (proposed: 12 lines) are never folded.
- **Streaming.** `isStreaming` is true for partial assistant updates. An unclosed trailing
  fence means the code is still being typed. pi's own `trimPartialClosingFences` hides a
  half-typed closing fence. The scanner has to treat a trailing line of 1–2 backticks as
  "not yet closed" so nothing flickers. Each design below defines its own streaming look.
- **Cost.** The transformer re-runs on **every streamed delta** for the whole text part.
  Cache `highlightCode` output keyed by `(lang, code, themeName)` and cache the folded
  rendering by `(blockHash, width, expanded)`.
- **Scope.** Only `messageType === "assistant"`. User text and thinking are passed through
  unchanged.
- **Copy/paste.** Folded or re-chromed blocks are display-only, so the session text stays
  intact. Selecting from the terminal will pick up the chrome (and ZWSPs in expanded
  custom-chrome bodies). `app.message.copy` copies the original.
- **Width rule (identical for all three).** Every design spans exactly `availableWidth`.
  On resize the pieces shrink in this order: **(1)** snippet/code text is truncated with
  `…`, **(2)** `N lines` becomes `NL` and the key hint disappears, **(3)** language
  becomes its short alias (`python` becomes `py`), **(4)** below ~16 columns only the
  count is shown. Rules and edges are always recomputed from `availableWidth`, so nothing
  wraps. Resize re-runs the transformer automatically (width-keyed cache miss).

The mockups below are drawn at an 80-column terminal (78-column content width).

---

## Proposal A — "Ledger Rule"

A folded block collapses into **one full-width horizontal rule** that works like a
ledger line: the language sits in a tab on the left, the first *definition* line sits
inline, and the line count is right-aligned. There's no marker glyph at the start. The
rule itself is what tells you the block is folded.

**(a) Collapsed, inside prose**
```text
Here's a loader that validates the config before the server boots:

──┤ python ├─ def load_config(path: str) -> Config: ────────────── 30 lines ──

Call it once from `main()`; it raises on the first invalid key.
```

**(b) Expanded.** The header rule stays in place, the body is indented like pi's native fence, and a footer rule closes it.
```text
Here's a loader that validates the config before the server boots:

──┤ python ├────────────────────────────────────────────────────── 30 lines ──
  import yaml
  from dataclasses import dataclass
  
  @dataclass
  class Config:
  ⋮
      return Config(**raw)
──────────────────────────────────────────────────────────────── alt+o fold ──

Call it once from `main()`; it raises on the first invalid key.
```

**(c) Streaming.** The header shows `writing` and a live count, followed by the last 2 typed lines and the cursor.
```text
Here's a loader that validates the config before the server boots:

──┤ python ├─ writing ─────────────────────────────────────────── 14 lines… ──
      raw = yaml.safe_load(fh)
      if "port" not in raw:
  █
```

**(d) Consecutive blocks.** Each fold is exactly one row, so they stack into a scannable table of contents.
```text
Two changes — first the loader:

──┤ python ├─ def load_config(path: str) -> Config: ────────────── 30 lines ──

then the test:

──┤ python ├─ def test_missing_port(tmp_path): ─────────────────── 18 lines ──

and register it:

  [tool.pytest.ini_options]      (4-line blocks stay unfolded: threshold 12)
  testpaths = ["tests"]
```

Narrow terminals (44 and 24 columns):
```text
──┤ python ├─ def load_conf… ─── 30 lines ──
──┤ python ├───── 30L ──
```

**Anatomy**

| Element | Meaning | Token |
|---|---|---|
| `──┤ … ├─` tab | language (from the fence info string, else `code`) | rule `mdCodeBlockBorder`, language `accent` |
| inline text | first *definition* line (`def`/`class`/`function`/`fn`/`func`/`export`/`const X =`), else first non-trivial line (reuse `isTrivialLine` from codefold.ts) | `muted` |
| `─── 30 lines ──` | total line count, right-aligned | `dim` |
| footer `alt+o fold` | key hint, expanded state only | `dim` |
| body | pi's `highlightCode()` output, 2-column indent | syntax tokens |

No path is shown: assistant fences rarely carry one. If the info string looks like
`python title=foo.py` or `py:foo.py`, the path replaces the snippet.

**Interaction**

- Global only: `alt+o` flips a module-level `expanded` flag, then triggers
  `tui.invalidate(); tui.requestRender()` and shows a status message
  (`ctx.ui.notify("Code blocks: expanded")`).
- Folding applies to finalized messages. The streaming message always shows the live
  tail from (c) and folds itself once it finalizes (`isStreaming` becomes false).
- Narrow terminals follow the shared width rule. The rule is always exactly one row.

**Feasibility.** Transformer + shortcut + the widget-captured `tui` for invalidation. The
expanded body can take either route:

- **Cheap route:** emit the original fence untouched, with a header and footer rule
  around it. You get pi's native `` ```python `` border plus the rule.
- **Faithful route:** emit the codespan-per-line body shown above.

**Effort: S.** No blockers.

**Trade-offs**

- Densest option: 1 row per block, so 10 folded blocks cost 10 rows.
- It's the only design that can look *native* when expanded (cheap route), so it has the
  least rendering risk.
- A single rule can be mistaken for a markdown `---` hr. The language tab and count
  mostly prevent that.
- It shows no actual code when collapsed, only one signature line. For short or unnamed
  blocks the snippet may be a weak hint.

---

## Proposal B — "Index Card"

Each folded block becomes a **3-row box-drawn card**. The top edge carries the language
and size, the single body row shows the signature, and the bottom edge carries a
**block number** (`#1`, `#2`, …, per message) plus the key hint. The card reads as a
closed object you can open, not as text.

**(a) Collapsed, inside prose**
```text
Here's a loader that validates the config before the server boots:

┌─ python ──────────────────────────────────────────────────────── 30 lines ─┐
│ def load_config(path: str) -> Config:                                      │
└─────────────────────────────────────────────────────────────── #1 · alt+o ─┘

Call it once from `main()`; it raises on the first invalid key.
```

**(b) Expanded.** The same card grows to hold the whole block; long lines truncate with `…` inside the right edge.
```text
Here's a loader that validates the config before the server boots:

┌─ python ──────────────────────────────────────────────────────── 30 lines ─┐
│ import yaml                                                                │
│ from dataclasses import dataclass                                          │
│                                                                            │
│ @dataclass                                                                 │
│ class Config:                                                              │
│ ⋮                                                                          │
│     return Config(**raw)                                                   │
└─────────────────────────────────────────────────────────────── #1 · alt+o ─┘

Call it once from `main()`; it raises on the first invalid key.
```

**(c) Streaming.** The card is open at the bottom (dashed `┆` sides, no bottom edge) and shows the last lines plus a live count.
```text
Here's a loader that validates the config before the server boots:

┌─ python ───────────────────────────────────────────────── live · 14 lines ─┐
│     raw = yaml.safe_load(fh)                                               │
│     if "port" not in raw:                                                  │
│ █                                                                          │
┆                                                                            ┆
```

**(d) Consecutive blocks.** Numbered cards; `#n` is what per-block commands target.
```text
Two changes — first the loader:

┌─ python ──────────────────────────────────────────────────────── 30 lines ─┐
│ def load_config(path: str) -> Config:                                      │
└─────────────────────────────────────────────────────────────── #1 · alt+o ─┘

then the test:

┌─ python ──────────────────────────────────────────────────────── 18 lines ─┐
│ def test_missing_port(tmp_path):                                           │
└─────────────────────────────────────────────────────────────── #2 · alt+o ─┘
```

Narrow terminals (40 and 20 columns):
```text
┌─ python ────────────────── 30 lines ─┐
│ def load_config(path: str) -> Confi… │
└───────────────────────── #1 · alt+o ─┘

┌─ py ──────── 30 ─┐
│ def load_config  │
└───────────── #1 ─┘
```

**Anatomy**

| Element | Meaning | Token |
|---|---|---|
| top edge `┌─ python ──── 30 lines ─┐` | language, total lines | edges `border`, language `accent`, count `dim` |
| body row | first definition line (same heuristic as A), truncated to fit inside `│ │` | `muted` (collapsed) / syntax tokens (expanded) |
| bottom edge `#1 · alt+o` | block index within this message, key hint | `borderMuted` edge, `dim` label |
| dashed `┆` sides | block still streaming, not closed | `borderAccent` |

**Interaction**

- `alt+o`: global expand/collapse of all cards (same invalidate path as A).
- Per block: `/code <n>` toggles card `#n` in the **latest** assistant message. The
  optional `alt+shift+o` toggles the most recently rendered card. Per-block state lives
  in a `Map<blockHash, boolean>`, where `blockHash` hashes `lang + code`. The transformer
  only sees markdown, not message ids, so a content hash is the only stable key it has.
  Two identical blocks in one session would share state, which is an acceptable quirk.
- Narrow terminals: the card always spans full width. The shared width rule applies, and
  the right edge `│` is placed with `visibleWidth` so it never drifts.

**Feasibility.** Transformer + shortcut + command + widget-captured `tui`. The collapsed
card is trivial. The expanded card *requires* the codespan-per-line trick, because pi's
native fence can't be boxed: `renderToken("code")` is hardcoded. Every code line must be
pre-highlighted with the exported `highlightCode`, then padded or truncated to
`availableWidth - 4`. **Effort: M.** No hard blocker, but the expanded body depends on a
marked-codespan behaviour I verified experimentally. It is not a documented pi contract.

**Trade-offs**

- Strongest "this is a closed object" affordance, and per-block control makes long
  answers navigable.
- Costs 3 rows per folded block, versus A's 1.
- A right edge on every expanded line means long code lines *always* truncate, never
  wrap. You lose content on narrow terminals until you widen the window or copy the
  message.
- `/code n` numbering is per message, so it can't reach older messages without an
  extra selector UI.

---

## Proposal C — "Margin Peek"

No box and no header. The block keeps its first **two real lines of code**,
syntax-highlighted, behind a heavy **left gutter bar** `┃`. A heavy footer rule `┗━`
then says how much is hidden. The collapsed state *is* code, just cut short. The fold is
marked in the margin, not with a header line.

**(a) Collapsed, inside prose**
```text
Here's a loader that validates the config before the server boots:

┃ def load_config(path: str) -> Config:
┃     """Load and validate the YAML config."""
┗━ python · +28 lines ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ alt+o ━

Call it once from `main()`; it raises on the first invalid key.
```

**(b) Expanded.** The gutter runs the full length and the footer shows the total.
```text
Here's a loader that validates the config before the server boots:

┃ import yaml
┃ from dataclasses import dataclass
┃ 
┃ @dataclass
┃ class Config:
┃ ⋮
┃     return Config(**raw)
┗━ python · 30 lines ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ alt+o ━

Call it once from `main()`; it raises on the first invalid key.
```

**(c) Streaming.** A tail window of the last few lines, `┆` marking hidden lines above, and a `┣━` footer while the fence is open.
```text
Here's a loader that validates the config before the server boots:

┆ … 11 lines above
┃     raw = yaml.safe_load(fh)
┃     if "port" not in raw:
┃ █
┣━ python · streaming · 14 lines ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**(d) Consecutive blocks**
```text
Two changes — first the loader:

┃ def load_config(path: str) -> Config:
┃     """Load and validate the YAML config."""
┗━ python · +28 lines ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ alt+o ━

then the test:

┃ def test_missing_port(tmp_path):
┃     cfg = tmp_path / "c.yaml"
┗━ python · +16 lines ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ alt+o ━
```

Narrow terminals (40 and 20 columns):
```text
┃ def load_config(path: str) -> Config:
┃     """Load and validate the YAML con…
┗━ python · +28 ━━━━━━━━━━━━━━━━━━━━━━━━

┃ def load_config(p…
┃     """Load and v…
┗━ +28 ━━━━━━━━━━━━━
```

**Anatomy**

| Element | Meaning | Token |
|---|---|---|
| `┃` gutter | folded or foldable code region | `accent` while streaming, `borderMuted` when final |
| peek lines | first N (default 2) *non-trivial* lines, skipping leading imports and blank lines; real highlighting | syntax tokens |
| `┗━ python · +28 lines` | language and **hidden** line count (not total) | rule `borderMuted`, language `accent`, count `dim` |
| `┣━ … streaming` | fence still open (tee junction, block continues) | `borderAccent` |
| `┆ … N lines above` | tail window while streaming | `dim` |
| `alt+o` at the right end of the footer | key hint | `dim` |

**Interaction**

- `alt+o` is a global toggle (same mechanism as A).
- The peek size is configurable: a `/codepeek 0|2|4` command. `0` reduces C to a single
  footer line.
- The streaming view always tails, so a 300-line block never pushes the prose off
  screen while it's typed.
- Narrow terminals: the gutter is always 2 columns and peek lines truncate with `…`.
  The footer follows the shared width rule.

**Feasibility.** Transformer + shortcut + widget-captured `tui`. The peek and expanded
body need the codespan-per-line trick (highlighted code in custom chrome). The footer is
plain ANSI text. **Effort: M.** The "skip imports" heuristic is language-specific. Start
with a small regex table (python, js/ts, go, rust) and fall back to "first 2 non-blank
lines".

**Trade-offs**

- The collapsed state carries **real information**: you can often read enough from the
  peek to skip expanding.
- Lightest visually: no top border, and the prose flow feels uninterrupted.
- 3 rows per folded block (same as B). The two peek lines can look like the whole block
  if you miss the footer.
- The heavy `┃ ┗━` glyphs render in a different weight in some fonts. Fallback: light
  `│ └─`.

---

## Comparison

| | A: Ledger Rule | B: Index Card | C: Margin Peek |
|---|---|---|---|
| Rows per folded block | **1** | 3 | 3 (peek=2) |
| Shows real code when folded | signature only | signature only | **2 highlighted lines** |
| Per-block toggle | no | **yes** (`/code n`) | no |
| Expanded look | native fence possible | full box | gutter |
| Needs codespan-per-line trick | optional | **required** | required |
| Streaming view | header + tail | open card + tail | tail + `┣━` |
| Effort | **S** | M | M |
| Main risk | hr look-alike | edge truncation, most chrome | peek mistaken for whole block |

## Recommendation

**A — Ledger Rule.** It has the highest density (1 row per block) and is the smallest
build (S). It's also the only design whose expanded state can fall back to pi's untouched
native fence, so it doesn't *depend* on the codespan trick. Borrow C's streaming tail
window for (c), and add B's per-block `/code n` later if global `alt+o` turns out to be
too coarse.

---

# Second batch: Proposals D–F

Same constraints, same hooks (markdown transformer + `alt+o`), same shared width rule.

## Proposal D — "Editor Fold" (IDE-inline)

What VS Code does: collapse leaves the block's **real first line** in place,
syntax-highlighted, with a small chip trailing at the right end of that same line.
No rules, no boxes — one row total, and that row is actual code.

**(a) Collapsed, inside prose** (chip right-aligned on the first line's row)
```text
Here's a loader that validates the config before the server boots:

  def load_config(path: str) -> Config:                     ⋯ py · +29 · alt+o

Call it once from `main()`; it raises on the first invalid key.
```

**(b) Expanded.** Pure pi-native fence, zero chrome — cheapest expanded rendering of any
proposal. The chip disappears; `alt+o` folds back.
```text
Here's a loader that validates the config before the server boots:

──┤ python ├────────────────────────────────────────────────────────────── (native)
  import yaml
  from dataclasses import dataclass
  
  @dataclass
  class Config:
  ⋮
      return Config(**raw)
────────────────────────────────────────────────────────────────────────── (native)

Call it once from `main()`; it raises on the first invalid key.
```

**(c) Streaming.** Tail window with a live-count chip pinned right of the cursor row.
```text
Here's a loader that validates the config before the server boots:

  raw = yaml.safe_load(fh)
  if "port" not in raw:
  █                                                          ⋯ py · 14 lines…
```

**(d) Consecutive blocks.** Literal first lines, so import-first blocks look weak —
see trade-offs.
```text
Two changes — first the loader:

  def load_config(path: str) -> Config:                     ⋯ py · +29 · alt+o

then the test:

  def test_missing_port(tmp_path):                          ⋯ py · +17 · alt+o
```

Narrow terminals (40 and 20 cols):
```text
  def load_config(path: s… ⋯ +29

  def load_c… ⋯ +29
```

**Anatomy**

| Element | Meaning | Token |
|---|---|---|
| left text | literal first line of the block, highlighted (option: skip-imports heuristic from C to show first *meaningful* line instead) | syntax tokens |
| `⋯ py · +29` | language short-alias + hidden line count | `⋯` `accent`, rest `muted` |
| `alt+o` | key hint, dropped below ~50 cols | `dim` |

**Interaction.** Global `alt+o`, same invalidate path as A/B/C. Expanded intentionally
shows nothing extra — it *is* pi's native block.

**Feasibility.** Transformer + shortcut + widget-captured `tui`. Collapsed first line
with full highlighting needs the codespan-per-line trick; a muted-plain variant of the
first line drops that need. Body when expanded is native — no trick. **Effort: S–M**
(S if the collapsed line stays unhighlighted).

**Trade-offs**
- Densest of all six: one row and it shows real code, not a description of code.
- Nothing to confuse with an `---` hr (A) and no 3-row tax (B/C).
- Literal first line is often `import yaml` — weak hint. Fix option: first-definition
  heuristic (A/C style) but then it's no longer "what the IDE shows".
- The right-floating chip needs width math (`visibleWidth`) and flickers if the first
  line itself nearly fills the row.

---

## Proposal E — "Statusband" (tmux bar)

The fold becomes a **full-width background-filled band**, segmented with thin bars like
a tmux/tab line: language tab, signature, count, key. It's unmistakably window chrome —
nothing in prose looks like that. (Mockups can't show fills: every gap inside the row is
background-colored.)

**(a) Collapsed, inside prose**
```text
Here's a loader that validates the config before the server boots:

▕ python ▕ def load_config(path: str) -> Config:          ▕ 30 lines ▕ alt+o ▕

Call it once from `main()`; it raises on the first invalid key.
```

**(b) Expanded.** The band stays as a title bar; the body is pi's native fence beneath
(cheap route, native highlighting untouched).
```text
▕ python ▕ expanded                                        ▕ 30 lines ▕ fold ▕
  import yaml
  from dataclasses import dataclass
  ⋮
      return Config(**raw)
```

**(c) Streaming.** Band shows a recording-style dot and a live count; tail rows below.
```text
▕ python ▕ ● writing                                       ▕ 14 lines… ▕
  raw = yaml.safe_load(fh)
  if "port" not in raw:
  █
```

**(d) Consecutive blocks.** Bands stack like file tabs.
```text
▕ python ▕ def load_config(path: str) -> Config:          ▕ 30 lines ▕ alt+o ▕
▕ python ▕ def test_missing_port(tmp_path):               ▕ 18 lines ▕ alt+o ▕
```

Narrow terminals (40 and 20 cols):
```text
▕ py ▕ def load_conf… ▕ 30L ▕
▕ py ▕ 30 ▕
```

**Anatomy**

| Element | Meaning | Token |
|---|---|---|
| row fill | full-width background | `theme.bg("customMessageBg")` (or `mdCodeBlock` bg) |
| `▕ python ▕` first segment | language tab | text `accent` |
| signature segment | first definition line (A/C heuristic) | `muted` |
| `▕ 30 lines ▕` | total lines, `NL` at narrow widths | `dim` |
| `▕ alt+o ▕` | key hint | `dim` |

**Interaction.** Global `alt+o`. Optional later: `alt+shift+o` toggles latest block only.

**Feasibility.** Transformer + shortcut + `tui` capture. Bands and all states are plain
text + `bg()`, so **no codespan trick needed anywhere**; expanded is native.
**Effort: S.**

**Trade-offs**
- Most scannable "chrome vs content" separation of the six; reads as a UI bar instantly.
- Only design besides A with zero experimental rendering in expanded view, at effort S.
- The full-width fill is the loudest option — can feel heavy beside light themes or
  several consecutive bands.
- Background fills break if the user's theme lacks a distinct `customMessageBg`; needs a
  fallback to `mdCodeBlock` bg or plain dim text.

---

## Proposal F — "Tear-off" (receipt cut)

Print metaphor: the hidden part was *cut away*. One dashed cut line with scissors at the
left edge, meta strung along the dash run. Expanded swaps dashes for solid cut lines that
bracket the block.

**(a) Collapsed, inside prose**
```text
Here's a loader that validates the config before the server boots:

✂┄┄ python ┄ 30 lines ┄ def load_config(path: str) -> Config: ┄┄┄┄┄┄┄┄┄┄┄┄┄

Call it once from `main()`; it raises on the first invalid key.
```

**(b) Expanded.** Solid cut lines above and below pi's native fence body.
```text
✂── python ── 30 lines ───────────────────────────────────────────────────
  import yaml
  from dataclasses import dataclass
  ⋮
      return Config(**raw)
✂── alt+o fold ───────────────────────────────────────────────────────────
```

**(c) Streaming.** Dashed line with live state; tail window under it.
```text
✂┄┄ python ┄ writing ┄ 14 lines… ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  raw = yaml.safe_load(fh)
  █
```

**(d) Consecutive blocks**
```text
✂┄┄ python ┄ 30 lines ┄ def load_config(path: str) -> Config: ┄┄┄┄┄┄┄┄┄┄┄┄┄
✂┄┄ python ┄ 18 lines ┄ def test_missing_port(tmp_path): ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
```

Narrow terminals (40 and 20 cols):
```text
✂┄┄ py ┄ 30L ┄ def load_c…
✂┄ 30 ┄
```

**Anatomy**

| Element | Meaning | Token |
|---|---|---|
| `✂` | "content cut away here" | `accent` |
| `┄…┄` run | collapsed state fill | `dim` |
| `──…──` run | expanded-state bracket lines | `mdCodeBlockBorder` |
| meta segments | language · total lines · signature | `muted` / `dim` |

**Interaction.** Global `alt+o`, same as the rest.

**Feasibility.** Everything is plain ANSI text; expanded uses the native fence — **no
codespan trick anywhere**. **Effort: S.** One caveat: `✂` (U+2702) can render as a
double-width emoji on some fonts; force text presentation (`\u2702\uFE0E`) and if that
still misbehaves in the user's terminal, drop the scissors and lead the dash run with
`┄▷` instead.

**Trade-offs**
- One row per block like A/D, but a playful, distinct personality.
- Zero rendering risk; the whole design is one computed line per state.
- Closest to A of the three new ones (it's still a horizontal run) — choose it for the
  dashed/scissors character, not for structure.
- Emoji-width quirk on `✂` is a real portability wart.

---

## Comparison (all six)

| | A Ledger | B Card | C Peek | D IDE-inline | E Statusband | F Tear-off |
|---|---|---|---|---|---|---|
| Rows / folded block | 1 | 3 | 3 | **1** | 1 | 1 |
| Real code visible folded | sig | sig | 2 lines | **1 line** | sig | sig |
| Per-block toggle | no | yes (`/code n`) | no | no | no | no |
| Expanded = native fence | yes (optional) | no | no | **yes (always)** | yes | yes |
| Needs codespan trick | optional | required | required | optional (S if skipped) | **no** | **no** |
| Effort | S | M | M | S–M | **S** | **S** |
| Personality | strict ledger | object/card | quiet gutter | your editor | tmux bar | receipt cut |

My (parent-agent) note: D is the strongest of this batch if you want "least chrome, most
content"; E is the safest S-effort build with a strong look; F is A's density with a
lighter mood.
