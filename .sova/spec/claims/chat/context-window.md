# §chat/context-window — 04f · Context window
> Part of the Sova design spec · [overview](../design/overview.md)

How full the model's context is, as of the last reply. The data is `ContextInfo
{ tokens, window | null }`, or `null` when there's no assistant turn yet. It appears in the
session head in **chat and watch** views.

## §chat.context-window/plain-text-not-a-meter — Plain text, not a meter

The readout is plain text. The skill's `.meter` puts the number first and the bar second, but in
a 56px head a 6px bar says less than "24%" and costs a line. So it's the number alone.
Closeness to the limit is carried by the number, then by hue, and at the top step by a glyph
too, so it never rests on hue alone.

## §chat.context-window/sidebar-ring — The sidebar ring: a deliberate exception

**A ring is a bar**, and the rule above says the context readout is never one. The session row
(§2, line 3) gets one anyway. This is the exception, stated once, with what buys it:

- **It is list-scale, where text is not affordable.** The head has 56px and a full line to spend;
  a row's meta line has 250px already holding a timestamp and a model id, and 279 of them scroll
  past. "24%" on every row is 279 numbers to read when the question is *which rows are close to
  the edge* — a question a shape answers at a glance and a column of digits does not.
- **It is static.** No animation, no transition, no indeterminate state, no pulse. It never
  reports that something is happening, only what the last reply left behind. The row's one
  sanctioned moving thing is still the Busy dot.
- **The AMOUNT is the signal; hue only repeats it.** The arc length carries the fact at every
  value, including every value under 80% where there is no hue at all. `.context-warn` and
  `.context-error` recolour a ring that is *already visibly three-quarters or all the way round*.
  So this is not status by hue alone, and it doesn't need the dot-plus-word rule the chips live
  under — there is no word to drop, because the geometry is the word.
- **The sentence is the head's sentence.** The `title` is `contextSentence`, byte for byte what
  the head's gauge and `#context-desc` say. Hover or long-press gets the exact numbers; nothing
  is only in the ring.
- **The head keeps its text, and that is why the exception is safe.** A bar cannot say
  "compacted" and cannot name a token count. The head is where those sentences are said, so the
  ring never has to carry a state it has no shape for — it just doesn't render.

**What the ring cannot express**, and what happens instead:

| Case | The row shows | Where the fact lives |
|---|---|---|
| No window (the model's limit is unknown) | **No ring.** A fill with no denominator is a lie about the arc | The head: "237k", tokens only, no percent |
| Just compacted (`null` after a compaction row) | **No ring.** An empty ring would read as 0%, which is a claim we can't make | The head, in words: "compacted" |
| No reply yet (`null`, no compaction) | **No ring.** Nothing has filled anything | The transcript's empty state, "Nothing sent yet" |

In all three the meta line simply ends after the model, and the line's right edge is empty.

## §chat.context-window/honesty — Honesty: what the row's number is, and isn't

The head reads the **active branch**; the row reads the **file tail**. They are not the same fact,
and on some sessions they visibly differ:

- **A rewound or branched session can show a different fill in the row than in the head.**
  `readTailContext` scans backwards from EOF and takes the first assistant reply with usage,
  exactly as `readTailModel` takes the last model — "the file end wins", not branch-aware. Open a
  session whose active branch is behind the file's end and the head's gauge is the one that
  describes what you are looking at. The row is describing the file.
- **A TUI mid-turn lags.** The live record carries no context, so a watched session's ring holds
  the last reply's value until the new reply is appended and the index re-reads the tail. It is
  never wrong, only late — which is the same contract the head's gauge has during streaming.
- **The topics count comes from the same snapshot as the line it sits beside.** In the file, both
  are read off the one accepted `topic-outline` entry (`readTailOutline`), so the sentence and the
  figure describe one moment and cannot contradict each other. A live session's newer broadcast
  overrides both together when it carries its `topics` array; when it carries only a "now" line,
  the count stays at the file's — the one case where the two can be a snapshot apart, and it
  resolves as soon as the next entry lands.

## §chat.context-window/markup — Markup

It goes after `.session-head-main`, **before** the mode trigger in chat, or before the `TUI` chip
in watch. A second copy leads the meta line for narrow heads, and CSS shows one or the other.

```html
<header class="session-head">
  …back…
  <div class="session-head-main">
    <h1 class="session-head-title" …>…</h1>
    <p class="session-head-meta">
      <span class="context-meta {context-warn|context-error}" aria-hidden="true">24%</span>
      <span class="context-meta" aria-hidden="true">·</span>
      <span class="text-mono" title="{cwd}">~/webapps/pi-web</span>
      …
    </p>
  </div>
  <span class="context-gauge {context-warn|context-error|context-compacted}" title="{exact sentence}">
    <!-- ≥95% only: -->
    <span class="icon icon-sm" style="--icon: url(/icons/alert-circle.svg)" aria-hidden="true"></span>
    <span class="context-label" aria-hidden="true">Context</span>
    <span class="context-value" aria-hidden="true">237k / 1M · 24%</span>
    <span class="context-pct" aria-hidden="true">24%</span>
  </span>
  <span class="visually-hidden" id="context-desc">{exact sentence}</span>
  …mode trigger (chat) or TUI chip (watch)… archive…
</header>
```

**AT.** All the visible context text is `aria-hidden`, because CSS hides one copy or the other.
The fact reaches AT through **one** sentence, `#context-desc`, which sits outside both copies and
is never hidden. Point the head title at it with
`<h1 class="session-head-title" aria-describedby="context-desc" …>`. When nothing is shown (no
reply yet), omit both the sentence and the `aria-describedby`.

## §chat.context-window/format — Format

| Value | Shows | Rule |
|---|---|---|
| Tokens under 1,000 | `812` | exact |
| Under 10k | `8.4k` | 1 decimal, and a trailing `.0` is dropped (`8k`) |
| 10k to under 1M | `237k` | whole thousands, rounded. A value that rounds to `1000k` shows as `1M` |
| 1M and up | `1M`, `1.5M`, `2.1M` | 1 decimal, `.0` dropped. 1,048,576 shows as `1M` |
| Percent | `24%` | `floor(tokens / window × 100)`, so it never shows 100% before the limit is actually reached. `<1%` when above 0 and under 1. Over the window it shows the real value (`103%`) |
| Full | `237k / 1M · 24%` | tokens / window · percent |
| Window unknown | `237k` | tokens only: no percent, no color steps |

The numbers are mono (`--font-mono`, `--fs-mono`) with tabular numerals, in `--color-ink-2`. The
word "Context" is `--fs-caption` in `--color-ink-muted`.

## §chat.context-window/steps-toward-the-limit — Steps toward the limit

| Share of window | Class | Color | Extra |
|---|---|---|---|
| under 80% | none | `--color-ink-2` | — |
| 80% and up | `.context-warn` | `--status-warn` (6.42 dark / 5.93 light on the head's surface) | — |
| 95% and up | `.context-error` | `--status-error` (5.42 / 6.01) | The `alert-circle` glyph before "Context" |

Thresholds use the exact ratio, not the rounded percent. The meta-line copy takes the same class.

## §chat.context-window/exact-numbers — Exact numbers (title and AT)

- **With a window:** "Context: 237,412 of 1,048,576 tokens (24%), as of the last reply."
- **Window unknown:** "Context: 237,412 tokens, as of the last reply. This model's limit is
  unknown."
- **Compacted:** "Context was compacted. The next reply reports the new size."

Use `title` on `.context-gauge` for hover, and the same text in `#context-desc` for AT. Use comma
thousands.

## §chat.context-window/states — States

| State | Shows |
|---|---|
| No assistant turn yet (`null` and no compaction row) | **Nothing.** No gauge and no meta copy. The empty state (§3) already says "Nothing sent yet", and a "No replies yet" readout would repeat an absence |
| Just compacted (`null` after a compaction row) | `.context-gauge.context-compacted`: "Context" plus "compacted" (in body type, muted). Narrow shows `compacted` in the meta line |
| Streaming | It keeps the last reply's value until the turn ends, then updates. It never animates and never pulses |
| Watch view | Same rules, from the same data |

## §chat.context-window/width-budget — Width budget: what collapses first

It collapses by the **head's** width (a named container on `.session-head`, with an `@media`
floor, because these rules contract):

1. **Head ≥ 720px:** full, "Context 237k / 1M · 24%" (about 165px).
2. **520 to 719px:** the percent only, "24%" (or "237k", or "compacted"), still in the head.
3. **Under 520px** (320 included):
   - The gauge leaves the head, and the percent leads the meta line: `24% · ~/webapps/pi-web`.
   - The cwd truncates first.
   - The head holds back, the mode trigger (icon-only) and Archive, so the title keeps about
     124px at 320.

Order of sacrifice: the context label and fraction, then the context's place in the head, then
the cwd. The title is the last thing to shrink. The model isn't in this budget at all anymore:
it lives in the composer flyout (§4b), which is full-width at every size.

Three more head rules cover every head, not just chat:

- **Aggregate chip.** Under 520px of head width, the head's aggregate `Team · {n} working` /
  `{n}` + worker-icon link chip (§10) is hidden. It repeats the sidebar row's rail count and the
  Agents foot row. Before this rule, a watched live session with a team at 320 had back, Team
  chip, Live, and copy, and that left the title block about 0px wide.
- **Floor.** `.session-head-main` has `min-width: 72px`. Whatever else lands in the head later,
  the title and meta line can't collapse to nothing. Extra chips overflow before the title
  disappears, and each new head chip needs its own narrow rule.
- **Mode trigger** (chat, §4g). Under 520px of head width it's icon-only: 44px, with its name in
  `aria-label`. Under 360px it's hidden, since the title can't spare 44px more (at 360 the title
  keeps about 76px). There, `/mode {name}` in the composer still switches.

## §chat.context-window/tokens — Tokens

`--font-mono`, `--fs-mono`, `--fs-caption`, `--color-ink-2`, `--color-ink-muted`,
`--status-warn`, `--status-error`, `--space-1`. The sidebar ring adds `--color-border` (the
track) and reuses `--color-ink-muted` (the fill at rest) and the two status tokens (the fill at
its steps); its geometry — 12px box, 1.5 track, 2 fill — is written in §2's Tokens.

---

