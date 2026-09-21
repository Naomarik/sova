# 03 · Transcript (main pane)
> Part of the pi-web design spec · [overview](overview.md)

## Anatomy

```html
<main class="app-main">
  <header class="session-head">
    <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">…chevron-left…</a>
    <div class="session-head-main">
      <h1 class="session-head-title" tabindex="-1">Add a watch endpoint for TUI sessions</h1>
      <p class="session-head-meta">
        <span class="text-mono" title="/home/user/webapps/pi-web">~/webapps/pi-web</span>
        <span aria-hidden="true">·</span>
        <span class="text-mono">claude-opus-5</span>
      </p>
    </div>
    <!-- worker count, linked: {n} + the worker icon, the rail's pair (§10) -->
    <a class="chip chip-count session-head-working" href="#/agents"
       title="3 subagents working now" aria-label="3 subagents working now">
      <span class="text-num">3</span><span class="icon icon-sm" style="--icon:url(/icons/worker.svg)"></span></a>
    <span class="chip chip-accent"><i class="chip-dot"></i>TUI</span>   <!-- live only; static, no pulse -->
    <button class="button button-icon button-ghost session-archive" aria-label="Archive Session">…archive…</button>  <!-- web sessions only -->
  </header>

  <section class="transcript pane" id="transcript" aria-label="Transcript">
    <div class="transcript-banner">…error/notice banner; omitted when there is none…</div>
    <div class="transcript-inner">
      <div class="thread">…items…</div>
    </div>
    <button class="button jump-latest">…chevron-down… Jump to Latest · 3 new</button>  <!-- conditional -->
  </section>

  <footer class="composer">…§4…</footer>
</main>
<div class="visually-hidden" role="status" aria-live="polite"><!-- turn announcements --></div>
```

- **Head title.** Uses `.session-head-title`, a single line with the full text in `title`. The
  `h1` is sized as a heading-s on purpose: the page is dense and the title is chrome, not a
  display headline.
- **What the head holds.** Back, the title block, the context gauge (§4f), the mode switch
  (§4g), the working count and the `TUI` chip, and Archive. Nothing else: the model and the session's
  own facts moved into the composer (§4, §4b), which is where the session is acted on.
- **Model.** Chat sessions read it off the composer's model indicator (§4) and change it in the
  flyout's Model row (§4b); neither is in the head. Watch sessions keep it in
  `.session-head-meta`, as plain mono text they can't change.
- **Copy Session Path.** Gone from the head. The path is a session fact, and it's copied from
  Session info (§4h) instead, which is where the rest of them live.
- **Archive Session / Unarchive Session.** Web sessions only, last in the head. Moves the
  session between the sidebar regions (§2 "Archiving"). `aria-disabled` while live and not
  archived. It stays at every width: at a 320px head (292px inside its 16px/12px padding) the
  head holds Back 44, the mode trigger's icon-only 44 and this 44, with 3 gaps of 12px, leaving
  the title 124px — above its 72px floor. This is the app's only archive control, so hiding it
  would remove archiving from phones and narrow panes.

## Transcript items (by `TranscriptItem.kind`)

Render items in array order. The column is `.thread` (gap `--space-4`) inside `.transcript-inner`,
centred at `--measure` plus 96px (`--space-9`). Messages, tool cards, thinking, and thumbnails
cap at `--measure`.

**Column width.** `--measure` is 72ch (648px in Inter at 14.5px, where 1ch is 9px) at folded
width, and it grows with the pane from unfolded up:
`clamp(72ch, 100vw − --sidebar-width − --space-9 − 2 × --space-8, 110ch)`. That keeps 64px of
margin on each side of the column until the 110ch cap (990px). The formula is under 72ch until
the viewport reaches 1192px, so it grows without a jump. The banner, the composer
(`.composer-inner`), the Current goal strip (§10), and Jump to Latest follow the same token, so they stay
aligned with the column.

| Viewport | Pane | `.transcript-inner` | Message cap | Composer |
|---|---|---|---|---|
| 390 (folded) | 390 | 390 | 358 (pane minus padding) | 358 |
| 768 | 448 | 448 | 416 (pane minus padding) | 416 |
| 1024 | 704 | 704 | 648 (72ch) | 672 |
| 1280 | 960 | 832 | 736 (~82ch) | 832 |
| 1440 | 1120 | 992 | 896 (~100ch) | 992 |
| 1920 | 1600 | 1086 | 990 (110ch, the cap) | 1086 |

The cap is the reading limit. Prose in Inter runs about 7px a character, so 110ch is about 140
characters, and the extra width mostly goes to code, diffs, and tool output. Everything up to
1191px, folded included, is the same as the old fixed 72ch.

**user.** A right-aligned tinted bubble.

```html
<article class="message message-user" aria-label="You, 14:06">
  <div class="message-head"><span class="message-author">You</span><span class="message-time">14:06</span></div>
  <div class="message-body message-text">{text}</div>
</article>
```

**assistant-text.** A left-aligned surface bubble. The author is the session's model id (short
form), or `pi` when unknown. Consecutive assistant-text items in one turn share one head: render
the head only on the first.

```html
<article class="message">
  <div class="message-head"><span class="message-author text-mono">claude-opus-5</span><span class="message-time">14:06</span></div>
  <div class="message-body message-text">{text}</div>
</article>
```

MVP renders plain text with `white-space: pre-wrap` (`.message-text`). If markdown is added later,
drop `.message-text`. `.message-body` already styles `p`, `ul`, `ol`, inline `code`, and `pre`.
Don't syntax-highlight in accent colors; the accent means action.

**thinking.** Collapsed by default. A native `<details>`, so it needs no script and AT announces
expanded or collapsed.

```html
<details class="disclosure">
  <summary class="disclosure-summary">
    <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
    <span class="disclosure-label">Thinking</span>
    <span class="disclosure-preview">· {first line of text, ~80 chars}</span>
  </summary>
  <div class="disclosure-body">{text}</div>
</details>
```

While thinking streams, the summary shows `<span class="live-dot"></span>` after the label. The
preview updates live and the disclosure stays closed unless the user opened it. If the user opens
it, keep it open across updates, because the open state is theirs.

**tool-call and tool-result.** One card per call. Pair them by `toolCallId`, and render the card
at the tool-call's position. A result with no matching call gets its own card with the name
"result".

```html
<details class="toolcard">
  <summary class="toolcard-summary">
    <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
    <svg class="icon icon-sm" aria-hidden="true">…terminal|file|search|more…</svg>
    <span class="toolcard-name">bash</span>
    <span class="toolcard-arg">npm run typecheck</span>
    <span class="chip chip-success"><i class="chip-dot"></i>Done</span>
  </summary>
  <div class="toolcard-body">
    <div class="toolcard-section">
      <div class="toolcard-section-label">Arguments</div>
      <pre>{JSON.stringify(args, null, 2)}</pre>
    </div>
    <div class="toolcard-section">
      <div class="toolcard-section-label">Output <button class="button button-sm button-ghost">Copy Output</button></div>
      <pre class="toolcard-output">{result text}</pre>
    </div>
  </div>
</details>
```

- **Arg summary**, one line: `bash` → `command`; `read`/`write`/`edit` → `path` (or `file_path`);
  `grep`/`find` → `pattern`; otherwise the first string value in args. It's mono and truncated,
  with the full value in `title`.
- **Status chip.** The word always accompanies the dot.

  | State | Chip |
  |---|---|
  | No result yet and the session is streaming | `.chip.chip-accent.chip-live` "Running" |
  | Result is OK | `.chip.chip-success` "Done" |
  | Result is an error (`isError` in `raw`) | `.chip.chip-error` "Failed" |
  | No result and the session is not streaming | `.chip` "No result" (neutral) |

- **Errors.** Label the output section "Error" instead of "Output" and add
  `.toolcard-output-error`. The word carries the state, and the red border only reinforces it.
- **Long output.** Caps at `--tool-output-max` (320px) with its own scroll. Past 400 lines,
  render the first 200 and a `button-sm` "Show All 1,240 Lines".
- **Visibility.** Cards stay collapsed, but the summary row is always visible. The skill says tool
  turns are never hidden, since the record of what ran is the trust mechanism.

**info.** Model changes, compaction, labels, and branch summaries.

```html
<div class="info-row" role="note">
  <span class="info-row-text"><svg class="icon icon-sm" aria-hidden="true">…info…</svg>
    Model changed to <code>claude-opus-5</code></span>
</div>
```

Server `text` is used as-is. Put machine facts (ids, model names, counts) in `<code>`.

**unknown.** Render the same as info, with the text `Unrecognized entry <code>{raw.type}</code>`,
followed by a `.disclosure` labelled "Raw entry" that holds `<pre>` JSON. Never drop a row
silently.

**report.** Subagent reports, and every other long extension message. A subagent's final
report (`custom_message`, customType `subagent-complete`) can run to 4000 characters of
markdown. As a centered caption-size info row it filled the whole viewport with literal `###`
and `**`. It's now a collapsed disclosure with the thinking disclosure's grammar: **one line**
closed, and the markdown on the left when open.

```html
<details class="disclosure report">
  <summary class="disclosure-summary report-summary">
    <span class="icon icon-sm icon-twist" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
    <span class="visually-hidden">Report from </span>
    <span class="report-from">ag_01 · orchestrator</span>
    <span class="chip chip-success"><i class="chip-dot"></i>Success</span>
    <span class="disclosure-preview">All requested checks pass. Report for items 5 and 6, plus the item 1 flag check.</span>
  </summary>
  <div class="report-body">                                   <!-- rendered only once opened -->
    <p class="report-error">Error: spawn ENOENT</p>                <!-- only with an Error line -->
    <p class="report-meta">Session <span class="text-mono">~/.pi/agent/sessions/…jsonl</span></p>
    <div class="message-body md">…the worker's final output, as markdown…</div>
    <p class="report-meta">Truncated at 4000 characters. Use agent_transcript for the rest.</p>  <!-- only if cut -->
  </div>
</details>
```

- **What's parsed** (server, `TranscriptItem.report`). The subagents extension writes the
  header `### {id} ({name}) — {status}[ · task {outcome}]`, then an optional `Error:` line, an
  optional `Session:` line, then the final output. Older builds wrote `Subagent {id} ({name})
  finished its task.` / `was killed.`, followed by a `Final output:` label, and that parses
  too. The `[Use agent_transcript for more.]` trailer becomes a flag and leaves the body.
  Anything that doesn't parse still renders as a report, with no chip.
- **Closed: exactly one line.** Who (`{id} · {name}` in mono, or the message's customType), the
  status chip, then the body's first non-empty line, with markdown marks stripped (`#`, `**`,
  backticks, list bullets, link syntax). It's truncated with an ellipsis and never wraps.
- **Status chip.** Failure comes first, using the extension's own "failed" rule:

  | Worker | Chip |
  |---|---|
  | An `Error:` line, task `error`, or status `error` | `.chip-error` "Failed" |
  | Status `killed` | `.chip-warn` "Stopped" |
  | Task `aborted` | `.chip-warn` "Aborted" |
  | Task `success` | `.chip-success` "Success" |
  | Status `done` (older reports) | `.chip-success` "Done" |
  | `starting` / `running` / `waiting` / `stopping`, no task outcome | `.chip-info` with the status word |
  | Anything else | neutral `.chip` with the status word |

  "Waiting" with task `success` reads "Success". Waiting is the worker idling after a finished
  task, and the task result is what you're scanning for.
- **Open.** The body goes through the markdown renderer (§4e), capped at `--measure` and
  left-aligned under the disclosure's `--color-border` rule. It's never centered, and never
  caption size. Path chips work in it (§4b). Error is `--status-error` caption text. Session and
  the truncation note are `--color-ink-muted` captions. The body is parsed only when the row is
  first opened, so a transcript with dozens of reports stays cheap.
- **Other long extension messages** (intercom messages, team questions, broker reports): any
  `custom_message` longer than 200 characters or spanning lines gets the same row, with its
  customType in place of the agent and no chip. Markdown, not `<pre>`: these payloads are
  written as markdown (`**From …**`, `_id …_`), and the renderer never runs HTML. Short
  one-liners stay `.info-row` (mode markers, compaction notes, and so on).
- **AT.** The native `<summary>` is the control, and its text is the name: "Report from ag_01 ·
  orchestrator Success All requested checks…". For non-agent messages the hidden prefix is
  "Message: ". Keyboard is native.
- **Tokens.** Summary: the disclosure's (`--fs-caption`, `--color-ink-muted`, `--control-sm`),
  with the sender in `--font-mono` `--color-ink-2`, capped at 40% of the row. Body: the
  `.disclosure-body` spacing (`--space-2` / `--space-4`, `--stroke-icon` rule) as a flex
  column with a `--space-2` gap.

**Timestamps.** Take them from `raw.timestamp` when present and format as 24-hour `HH:MM` in mono.
If the date isn't today, prefix `Mar 4 `. Put the full ISO string in `title`.

## Streaming (chat sessions)

Driven by `ChatServerMessage.event`.

- **Start of turn** (`agent_start` / `turn_start`). Append a pending assistant `.message` with the
  class `message-streaming`. Its head is `author` + `<span class="live-dot"></span>`.
  `text_delta` appends into its body; `thinking_delta` feeds a streaming `.disclosure` placed
  before it. `toolcall_start` adds a `.toolcard` with the Running chip.
- **Run status.** Above the textarea, inside `.composer-inner`:
  `<p class="run-status"><span class="live-dot"></span>Working<span class="run-status-detail">· running bash</span></p>`.
  The detail names the current tool, or says "· thinking" or "· writing". This is the loading
  pattern: say what's happening. The row is shared: it also carries the subagents trigger (§11)
  and the inputs trigger ("7 inputs", which opens the Timeline with Inputs Only on, §13), and it
  renders whenever any of the three has something to show,
  so an idle session with messages still has one. While the parent's own turn runs, the subagents
  trigger rides along with the counts alone (`Working · 2 subagents…`), because the row already
  says it is working; once the parent settles it goes back to naming them in full (`§11`).
- **End of turn** (`agent_settled`, or `agent_end` if that's all you get). Remove the live dots
  and the run status. Replace the optimistic items with the server's canonical ones if it sends
  them. Announce "Reply finished." in the polite live region; announce nothing per delta.
- **Performance.** Batch deltas per animation frame. Never re-render the whole thread on each
  delta.

## Live-watch (TUI-owned sessions, `/ws/watch`)

- **No persistent banner.** Watch mode has no "Live from TUI — read only" card; it was removed
  by boss directive. Read-only is already obvious from three things that stay:
  1. **The TUI chip in the session head** (`.chip.chip-accent`, the word "TUI", a **static**
     dot — never `.chip-live`; see §0 Motion, "TUI never pulses", and §2). It carries the process
     facts in its `title`, updated from `live` whenever the session list refreshes:

     ```html
     <span class="chip chip-accent" title="Open in pi in a terminal · pid 889823 · Running: bash"><i class="chip-dot"></i>TUI</span>
     ```

     The pid and status are shown only here now. They're a detail you look up, not something
     read on every visit.
  2. **The disabled composer**, with its reason: "Read only while this session is open in the
     TUI." (§4 Disabled states). AT gets it through `aria-describedby="composer-reason"`.
  3. **The error banners** below, which still appear in `.transcript-banner` when something
     goes wrong.

  `.transcript-banner` renders only while one of those banners is showing. Otherwise it's
  omitted, so it takes no height.
- **Appends.** `append` items fade in (the rows' `.message` uses no transform, so no animation is
  needed).
- **Auto-follow.**
  - *Following* means the transcript's scroll bottom is within 80px of the end. While following,
    every append or streamed delta scrolls to the bottom (`scrollTop = scrollHeight`, no smooth
    scroll).
  - When the user scrolls up past 80px, following stops and a `.button.jump-latest` appears:
    "Jump to Latest · N new". Clicking it scrolls to the end, resumes following, and removes the
    button.
  - Chat sessions follow the same logic while streaming.
  - Sending a message always resumes following.
- **When the TUI closes** (`live` goes null on refresh). A `.banner.banner-info` appears in
  `.transcript-banner`, with title "The TUI closed this session." and body "You can chat in it
  here now." It's a one-time transition with an action, not a persistent card. Its `.banner-action` is `<button class="button button-sm">Open for Chat</button>`,
  which reconnects with `/ws/chat`.
- **Watch socket drops.** `.banner.banner-warn` with `alert-circle`. Title: "Stopped watching.
  The connection dropped." Body: "What's shown is up to `14:06`. Reconnecting…" When it
  reconnects, the banner goes away. The snapshot replaces the list, and scroll position is
  kept if the user wasn't following.

## Landing page (`#/`)

With no session selected the main pane is not an empty state with a grid bolted on — it is one
page with two parts, in this order:

1. **The opening**, unchanged: `.welcome-head` wrapping the `.empty` block that has always been
   here — the `chat` mark, "{n} sessions across {m} folders.", "Pick one to read it, or start a
   new one.", and the `New Session` button. It is the first thing read at every width.
2. **The Explained grid**, shown **only when at least one explanation exists** (0 renders
   nothing — no empty state, no head, no reserved space):

```html
<div class="welcome">
  <div class="welcome-head">…the .empty opening…</div>
  <!-- only when there is at least one explanation -->
  <section class="explain-section" aria-labelledby="explain-section-title">
    <h2 class="explain-section-head" id="explain-section-title">Explained <span class="text-num">6</span></h2>
    <ul class="explain-grid">…one .card.explain-tile per page…</ul>
  </section>
</div>
```

- **Scrolling.** `.app-main` is a fixed-height flex column with `overflow: hidden`, so `.welcome`
  is the scroll region itself (`flex: 1`, `min-height: 0`, `overflow-y: auto`). It carries no
  `.pane`: the tiles ask the window, not this box.
- **Width and padding.** `--space-4` of page padding on both sides at every width, `--space-6`
  under the last row so the grid never runs into the viewport edge, and no top padding —
  `.empty` brings its own `--space-8` crown. The section caps at `--page-max` (1280px) and
  centres: these are cards, not prose, so the reading measure is the wrong cap for them.
- **The opening centres when it is alone.** With no explanations, `.welcome-head:only-child`
  takes the leftover height and centres its `.empty` in the pane. With the grid under it, it
  keeps its own height at the top and the grid follows.
- **The head is the section eyebrow**, the same rule as the Usage and Agents pages'
  `.insights-section-head` (§10) — mono, `--fs-micro`, uppercase, `--ls-eyebrow`, `--color-ink-2`
  — with the count as the `.text-num` span inside it, in `--color-ink-muted` and no casing. A
  `display-l` page opener was rejected: this is the second thing on the page, not its title.
- **Where the CSS lives.** `.welcome`, `.welcome-head`, `.explain-section` and
  `.explain-section-head` are in `src/design/base.css`; `.explain-grid` and every `.explain-tile`
  rule are in `src/explain.css`, which owns the tile in both places it appears.
- **The session-scoped gallery is unchanged.** The same `ExplainGrid` still renders inside the
  gallery modal that the insight strip's `Open {n} Explanations` button opens (§10), scoped to
  one session and keeping the 0-explanations empty state. The landing page is the *all*-scope
  view of the same rows, and it is a page, not a dialog: the sidebar foot no longer has an
  Explained row.
- **Tiles open in the same tab.** Each tile is a plain link to `/explain/:id` with no `target`,
  here and in the gallery alike. In an installed app (standalone display mode) a new tab is a new
  window with one history entry, so its back button couldn't return to pi-web; navigating in place
  keeps Back working. `/explain/:id` is still a standalone document, so a direct link opens it
  on its own. There is no external-arrow icon and no "opens in a new tab" suffix on a tile.

## States

| State | What renders |
|---|---|
| No session selected (unfolded) | The landing page below, not a bare `.empty`: `.welcome` fills `.app-main`, its `.welcome-head` holds the `.empty` opening (`chat` icon in `.empty-mark`, title "48 sessions across 7 folders.", body "Pick one to read it, or start a new one.", `.empty-action` `New Session`), and the Explained grid follows when there is one. No composer |
| Loading transcript (after 300ms) | Three placeholder messages in `.thread`: a right-aligned `.skeleton` 40% × 44px, then a left `.skeleton-title` plus 3 `.skeleton-line` at 92/78/60%, then a `.skeleton-row` at 60% width. Put `aria-busy="true"` on the `section`. The head renders straight away from the `SessionSummary` |
| Error | `.banner.banner-error` in `.transcript-inner`. Title: "Couldn't load this transcript." Body: "The file at `{path}` wasn't changed. {server message}." Action: `Retry` |
| Empty (new session) | `.empty`. Title: "New session in `~/webapps/pi-web`." Body: "Nothing sent yet. Your first message becomes its title." No action; focus the composer instead. Show it only while the thread has **zero rows**, counting local rows such as "Ran `/cmd`" (§4d) and model-change info rows. Once any row exists, the thread renders normally with no empty state |
| Agent/server error (`type:"error"`, not busy) | `.banner.banner-error` placed as the last item of the thread (in flow, so it stays in the record). Title: "The turn stopped with an error." Body: "{message}. Your messages are kept. Send again to retry." |

## Tokens

- **Page and head.** Page `--color-bg`. Head `--color-surface` with bottom border `--color-border`.
- **Messages.**
  - Assistant bubble: `--color-surface` with `--color-border`, and `--r-lg`.
  - User bubble: `--color-accent-tint`, with no border.
  - Text: `--color-ink`.
  - Head: `--fs-caption` in `--color-ink-muted`. Author: `--fw-semibold` in `--color-ink`. Time:
    `--font-mono`.
- **Thinking.** Summary `--fs-caption` in `--color-ink-muted`. Label `--fw-medium` in
  `--color-ink-2`. Body `--color-ink-2`, left rule `--stroke-icon` in `--color-border`.
- **Tool card.** `--color-sunken`, `--r-lg`, and `--font-mono` / `--fs-mono`. Name `--fw-semibold`
  in `--color-ink`; arg `--color-ink-muted`. `pre` sits on `--color-surface` with `--r-sm`.
  Section labels use eyebrow styling (`--fs-micro`, `--ls-eyebrow`).
- **Tool card file content.** `write` content, each `edit` pair ("Replaced" / "With", "· n of
  m" when several), and `read` output are highlighted by file path (never auto-detected) in
  `pre.toolcard-code`: back on `--color-sunken`, where the syntax colors were checked, with
  `--color-ink` and no wrapping. The path shows above in `.toolcard-path` (mono, ink-muted).
  Edit blocks add a 3px left rule: `.toolcard-code-del` in `--diff-del-ink`,
  `.toolcard-code-add` in `--diff-add-ink`; the label carries the meaning. Copy Code on write
  content and on each "With" block. Unknown extensions, errors, and args still streaming stay
  plain.
- **Info row.** `--fs-caption` in `--color-ink-muted`, with rules in `--color-border`.
- **Banners.**
  - Info: `--status-info-bg` with a `--status-info` icon.
  - Warn: `--status-warn-bg` with a `--status-warn` icon.
  - Error: `--status-error-bg` with a `--status-error` icon.
  - Title text is `--color-ink`; body is `--color-ink-2`.
- **Spacing.** Thread gap `--space-4`. Inner padding `--space-4` / `--space-6`.

## Accessibility

- **The transcript isn't `role="log"`.** Streaming deltas would flood the announcements. It's a
  labelled `section`. A single visually-hidden `role="status"` region announces turn boundaries:
  - "Working." at the start of a turn.
  - "Reply finished." at the end.
  - For watched sessions, "{n} new entries." throttled to at most once every 5s.
- **Articles.** Each message is an `article` with an `aria-label` like "You, 14:06" or
  "claude-opus-5, 14:07".
- **Disclosures** are native `<details>`/`<summary>`: Enter and Space toggle them and their state
  is announced. Don't add click handlers that call `preventDefault`.
- **Keyboard.** Tab order runs head → banner action (if any) → transcript disclosures and cards →
  Jump to Latest → composer. The transcript `section` is focusable (`tabindex="0"`) so keyboard
  users can scroll it with the arrow keys and PageUp/PageDown.
- **Contrast.**

  | Pair | Dark | Light |
  |---|---|---|
  | Ink on accent-tint (user bubble) | 12.57 | 14.57 |
  | Ink-2 on sunken (thinking body; tool card sits on sunken) | 7.65 | 7.22 |
  | Muted on sunken | 5.40 | 4.75 |
  | Ink on info-bg | 11.07 | 15.57 |
  | Ink-2 on info-bg | 6.30 | 7.60 |
  | Info icon on info-bg | 5.33 | 5.55 |
  | Ink-2 on error-bg | 6.48 | 7.49 |
  | Error on error-bg | 5.01 | 5.16 |
  | Ink-2 on warn-bg | 6.02 | 7.78 |
  | Success on surface (chips) | 6.61 | 6.09 |
  | Error on surface (chips) | 5.42 | 6.01 |

## Open questions

- **Long info rows.** A multi-line custom entry renders as a centered `.info-row` between rules,
  which reads badly. A likely fix is left-aligned and rule-less beyond 1 line, or clamped at 3
  lines behind a disclosure. It's not specced yet and is out of the current brief.

---

