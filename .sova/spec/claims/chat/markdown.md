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

Wrap every fenced block like this:

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
  and label as usual. Most GFM renderers already treat the rest of the text as code. Copy Code
  is present but copies what's there so far.
- **Highlighting.** Highlight a block only once its fence closes, or when the turn ends. While
  it's open it shows as plain escaped mono. Highlighting changes only color and weight, never
  line breaks, so it causes no layout jump.
- **Layout jumps.** Partial constructs (a table's header row before its separator, a half-typed
  `**bold`) render as text until they complete. That jump is accepted, and there's no height
  reservation. Auto-follow (§chat/transcript) keeps the bottom pinned. When you're not following, the browser's
  scroll anchoring (`overflow-anchor`, on by default) holds your place.
- **Author.** The `.live-dot` stays in the author row as in §chat/transcript, and there's no cursor glyph.

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

