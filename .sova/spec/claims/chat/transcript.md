# §chat/transcript — Transcript (main pane)
> Part of the Sova design spec · [overview](../design/overview.md)

## §chat.transcript/anatomy — Anatomy

```html
<main class="app-main">
  <header class="session-head">
    <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">…chevron-left…</a>
    <div class="session-head-main">
      <h1 class="session-head-title" tabindex="-1">Add a watch endpoint for TUI sessions</h1>
      <p class="session-head-meta">
        <span class="text-mono" title="/home/user/webapps/sova">~/webapps/sova</span>
        <span aria-hidden="true">·</span>
        <span class="text-mono">claude-opus-5</span>
      </p>
    </div>
    <!-- a session with a profile, once its first message is sent (§chat.profiles/after-first-message) -->
    <span class="profile-chip-wrap"><button class="button button-ghost profile-chip" aria-haspopup="dialog">…icon… Read-only reviewer</button></span>
    <span class="chip chip-accent"><i class="chip-dot"></i>TUI</span>   <!-- live only; static, no pulse -->
    <a class="button button-icon button-ghost session-share-open" href="#/share/…" aria-label="Share session">…share…</a>
    <button class="button button-icon button-ghost session-details-open" aria-label="Session details">…info…</button>
  </header>

  <section class="transcript pane" id="transcript" aria-label="Transcript">
    <div class="transcript-banner">…error/notice banner; omitted when there is none…</div>
    <div class="transcript-inner">
      <div class="thread">…items…</div>
    </div>
    <button class="button jump-latest">…chevron-down… Jump to Latest · 3 new</button>  <!-- conditional -->
  </section>

  <footer class="composer">…§chat/composer…</footer>
</main>
<div class="visually-hidden" role="status" aria-live="polite"><!-- turn announcements --></div>
```

- **Head title.** Uses `.session-head-title`, a single line with the full text in `title`. The
  `h1` is sized as a heading-s on purpose: the page is dense and the title is chrome, not a
  display headline.
- **What the head holds.** Back, the title block, the context readout (§chat/context-window), the remote
  chips, the `TUI` chip, a 44px **Share session** icon link (`.session-share-open`, icon `share`, to
  the share page `#/share/<id>`, §app.session-share/share-page) and Session details. No subagents or team chip (§app/insights). Nothing else: the model and the session's
  own facts moved into the composer (§chat/composer, §chat/images), which is where the session is acted on.
- **Model.** Chat sessions read it off the composer's model indicator (§chat/composer) and change it in the
  flyout's Model row (§chat/images); neither is in the head. Watch sessions keep it in
  `.session-head-meta`, as plain mono text they can't change.
- **A usage-limit turn offers a subagent-profile switch.** In a held chat, the live errored
  assistant and the historical `:stop` error row carry the calm limit row beside that actual
  failure (§chat.subagent-profiles/limit-row). Its provider comes from the error text or that
  failed assistant's own producing model, never the chat's current model. The error feed yields
  to a matching live assistant row so the offer is not duplicated. Watched and worker transcripts,
  tool failures, and non-limit errors carry no such switch. It changes this chat's later
  subagent work only, and never switches automatically.
- **Overseer marks.** A user row the Overseer sent carries an **Overseer** tag
  (§app.overseer/sent-marker); its actions are unchanged, Rewind included. An Overseer dialog
  answer renders as the machine row "Overseer chose: {answer}" (§app.overseer/dialog-answers).
- **Copy Session Path.** Gone from the head. The path is a session fact, and it's copied from
  the session pane's Session tab instead, which is where the rest of them live.
- **Archive Session / Unarchive Session.** Web sessions only, in the Session pane, not the head. Moves the
  session between the sidebar regions (§app/session-list "Archiving"). `aria-disabled` while live and not
  archived.

## §chat.transcript/transcript-items — Transcript items (by `TranscriptItem.kind`)

The browser's **Compress thinking & tool calls** preference is on by default (§chat.work-chain-setting/preference). On, working rows use the existing compact timeline; off, the thinking disclosures and tool cards described below retain their original DOM, styles, spacing, and estimates. The preference updates every open transcript without a reload.

Render items in array order. The column is `.thread` (gap `--space-4`) inside `.transcript-inner`,
centred at `--measure` plus 96px (`--space-9`). Messages, tool cards, thinking, and thumbnails
cap at `--measure`.

**Column width.** `--measure` is 72ch (648px in Inter at 14.5px, where 1ch is 9px) at folded
width, and it grows with the pane from unfolded up:
`clamp(72ch, 100vw − --sidebar-width − --space-9 − 2 × --space-8, 110ch)`. That keeps 64px of
margin on each side of the column until the 110ch cap (990px). The formula is under 72ch until
the viewport reaches 1192px, so it grows without a jump. The banner, the composer
(`.composer-inner`), the Current goal strip (§app/insights), and Jump to Latest follow the same token, so they stay
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
expanded or collapsed. Only the expanded thinking content is inset 20px on each side and
uses italic 13.5px body text (`--fs-body` minus 1px) in `--color-ink-2`, on a subtle
`--color-sunken` quote-like block with `--space-3` padding and `--r-sm` corners. It draws no border.
Its summary stays unchanged; other disclosure bodies and tool output keep their own styles.
This treatment applies to settled and streaming thinking, with compact working rows enabled or disabled.

```html
<details class="disclosure">
  <summary class="disclosure-summary">
    <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
    <span class="disclosure-label">Thinking</span>
    <span class="disclosure-preview">· {first line of text, ~80 chars}</span>
  </summary>
  <div class="disclosure-body thinking-body">{text}</div>
</details>
```

While thinking streams, the summary shows `<span class="live-dot"></span>` after the label. The
preview updates live and the disclosure stays closed unless the user opened it. If the user opens
it, keep it open across updates, because the open state is theirs.

**tool-call and tool-result.** One card per call. Expanded tool content and returned media
have no horizontal separator beneath the summary; spacing, outer card boundaries, and focus
styles remain unchanged. Pair them by `toolCallId`, and render the card
at the tool-call's position. A result with no matching call gets its own card with the name
"result".

```html
<div class="toolcard">
  <details class="toolcard-details">
    <summary class="toolcard-summary">
      <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
      <svg class="icon icon-sm" aria-hidden="true">…terminal|file|search|more…</svg>
      <span class="toolcard-name">bash</span>
      <span class="toolcard-arg">npm run typecheck</span>
      <span class="chip chip-success"><i class="chip-dot"></i>Done</span>
    </summary>
    <div class="toolcard-body">                                 <!-- built the first time the card is opened -->
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
  <!-- only when the result carries images: the .toolcard-media strip (§chat.images/thread-thumbnails) -->
</div>
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
  turns are never hidden, since the record of what ran is the trust mechanism. Images the tool
  returned are always visible too, under the summary row, open or closed
  (§chat.images/thread-thumbnails); collapsing hides only Arguments and Output.
- **Built on first open.** Arguments and Output, with their highlighting, are built the first time
  the card is opened and kept after, as a report's body is. A running call's body follows its
  output from then on. So `Ctrl+F` finds a tool's arguments and output only in cards opened once.

**align.** An `align` tool result that changed an alignment (§chat.alignment/card): the card, or
for an earlier revision of the same alignment its one-line change row, at the call's position; the
call's own tool card renders nothing once this result is there. A failed `align` call stays an
ordinary tool-call and tool-result.

**wake.** A fired wake-nudge (pi-config's `wake_nudge` tool): under the hood a real `role:"user"`
message tagged `[wake_nudge n1] …` (shared/wake.ts `parseWakeNudge`), but it never reads as "You" —
a machine event fired the turn, not the person. Same `.toolcard` shell as tool-call/tool-result
(collapsed by default, left-aligned), with a bell where a tool card has its tool icon.

```html
<details class="toolcard">
  <summary class="toolcard-summary">
    <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
    <svg class="icon icon-sm" aria-hidden="true">…bell…</svg>
    <span class="toolcard-name">Wake nudge n1</span>
    <span class="toolcard-arg" title="check the build">check the build</span>
    <span class="toolcard-wake-time">fired 14:06 · 3m17s late</span>
  </summary>
  <div class="toolcard-body">
    <div class="toolcard-section">
      <pre class="toolcard-output">{the fired message, all four lines, exactly as sent}</pre>
    </div>
  </div>
</details>
```

- **Name.** Always "Wake nudge {id}" (`shared/wake.ts` `wakeTitle`), never the raw tag.
- **A schedule's fire** (§chat.schedules/fire) is a wake too: tagged `[schedule s1] …`, it draws the
  same card named "Scheduled run s1", with `· {late} late` from its "Late by … (Sova was not
  running)." line, and is treated as a wake everywhere below.
- **Arg slot.** The parsed reason (`WakeInfo.reason`), muted, truncated with an ellipsis, full text
  in `title`. Empty when the extension wrote `Reason: (none)`.
- **Fired time.** Muted, `fired {HH:MM}` from the entry's own timestamp, same clock as every other
  row. `· {late} late` only when the fire was overdue (the extension's "Overdue by …" line);
  omitted for an on-time fire.
- **Open.** The whole message exactly as it was sent — all four lines (the fire line, the optional
  overdue line, the reason line, the standing instruction) — in mono, never rewritten or hidden.
- **Counts as an input.** A wake row is on every list that counts "your messages": the composer's
  "N inputs" trigger, the Timeline's Inputs Only view (where it shows the reason, or "Wake nudge
  n1" with none — §chat/timeline), rewind targets, and the "calls after the last user message" scan that
  decides whether an open tool call may still be running. Only its rendering differs from an
  ordinary user row.
- **Never hidden, never titles the session.** "Hide tool calls" leaves wake rows alone, and a wake
  row never joins a hidden-tool-call group (it isn't a tool row). The session list never titles a
  session from a wake message — it waits for the next real one.
- **AT.** No author line, and the accessible name never says "You": the native `<summary>`'s own
  text ("Wake nudge n1 …") is what's announced.

**link.** A link message from a linked session on another host (§mesh.links/delivery): under the
hood a real `role:"user"` message tagged `[link_msg <link> <message>]` (`shared/link-message.ts`),
classified by that tag on reload and on the live path alike. It renders **nothing** in the thread
(no row, no pill, never "You") and is not counted among hidden rows. It is a turn start (the
"calls after the last user message" scan and turn boundaries treat it as one) but never an input:
not in the composer's "N inputs", the Timeline's Inputs Only view or the rewind targets, and
regenerating a reply to it is refused. The session list never titles a session from one. Its text
is shown only in the Agents tab (§mesh.links/agents-pane).

**topic.** A batch of notes other sessions pushed to a topic this session opened
(§chat.topics/delivery): under the hood a real `role:"user"` message tagged `[topic <name> tb_…, n
notes]` (`shared/topic-message.ts`), classified by that tag on reload and on the live path alike.
It renders as a compact collapsed card, never "You" (§chat.topics/row). Like a link message, it is
a turn start but never an input, regenerating a reply to it is refused, and the session list never
titles a session from one.

**info.** Compaction, labels, branch summaries and other short machine notes. Model changes,
thinking-level changes and the mode extension's markers are the exception: they render
**nothing** in the thread — they are settings history, not conversation. That history stays where
it belongs, on the Session pane's Changes disclosure and the Timeline's change markers
(§chat.timeline/rows); a switch's own feedback is the toast and the announcement
(§chat.model-menu/states).

```html
<div class="info-row" role="note">
  <span class="info-row-text"><svg class="icon icon-sm" aria-hidden="true">…info…</svg>
    Label "release" on <code>m41</code></span>
</div>
```

Server `text` is used as-is. Put machine facts (ids, model names, counts) in `<code>`.

**Handoff run rows.** A `/compact-handoff` run's `compact-handoff-run` entries
(§chat.slash-commands/compact-handoff-row) are info rows, one per run id: on load only the newest
entry per id renders, and a live append replaces the row carrying the same run id in place
rather than adding one at the bottom. The text is the server's one line: "Writing a handoff
note" (with `: {focus}` when given) while running, then "Handoff note saved" (with `: {path}`),
"Handoff note failed" (with `: {reason}`), "Handoff cancelled" or "Handoff interrupted". While running, the live
dot sits where the info icon goes; a failed run adds a `.chip-error` "Failed" chip and an
interrupted one a `.chip-warn` "Interrupted" chip before the text. An entry whose shape this
version can't read renders no row.

**unknown.** Render the same as info, with the text `Unrecognized entry <code>{raw.type}</code>`,
followed by a `.disclosure` labelled "Raw entry" that holds `<pre>` JSON. Never drop a row
silently.

**Model-context edits render nothing.** A `context_edit` entry (pi 0.87+; pi writes one itself
when it drops an abandoned attempt after a retried error or an overflow recovery) changes only
what the model is sent next: raw history, usage and the chat are unchanged, and pi's own chat
shows nothing for it either. So it yields no row, not an unknown one, and the message it edits
keeps its row exactly as recorded.

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
- **Open.** The body goes through the markdown renderer (§chat/markdown), capped at `--measure` and
  left-aligned in the disclosure's indent, with no left rule. It's never centered, and never
  caption size. Path chips work in it (§chat/images). Error is `--status-error` caption text. Session and
  the truncation note are `--color-ink-muted` captions. The body is parsed only when the row is
  first opened, so a transcript with dozens of reports stays cheap.
- **Explain rows: running.** An `/explain` run appends its `explain-doc` entry twice under one
  `data.id`: at spawn with `status: "running"` and an empty summary, and at settle with no
  `status`. Per id, only the newest entry renders (as with an older session's align-doc entries), so a settled run is one
  row, and a live append replaces the running row in place. A running row is not a link — there
  is no page yet — and reads "Explaining {topic}" with the live pulse where the chevron sits.
- **Explain rows: interrupted.** A run whose parent stopped before it settled (a server restart, a
  `/reload`) leaves its running entry as the newest. Opening the session writes nothing, so the
  row still reads Explaining then; the session's next prompt (or its next `/explain`) appends the
  final entry under the same id with `status: "interrupted"`, which replaces the row. It carries
  a `.chip-warn` "Interrupted" chip where a failed run has "Failed", and the reason under the row
  as a muted `.report-meta` line. When a complete page was on disk anyway (the entry has `note`),
  the row reads "Explained" and links to it like any finished row; when there was none (`error`),
  it reads "Explain" and is not a link. The session pane's explain row shows the same chip in
  place of Failed.
- **Other long extension messages** (intercom messages, team questions, broker reports): any
  `custom_message` longer than 200 characters or spanning lines gets the same row, with its
  customType in place of the agent and no chip. Markdown, not `<pre>`: these payloads are
  written as markdown (`**From …**`, `_id …_`), and the renderer never runs HTML. Short
  one-liners stay `.info-row` (compaction notes, and so on).
- **AT.** The native `<summary>` is the control, and its text is the name: "Report from ag_01 ·
  orchestrator Success All requested checks…". For non-agent messages the hidden prefix is
  "Message: ". Keyboard is native.
- **Tokens.** Summary: the disclosure's (`--fs-caption`, `--color-ink-muted`, `--control-sm`),
  with the sender in `--font-mono` `--color-ink-2`, capped at 40% of the row. Body: the
  `.disclosure-body` spacing (`--space-2` / `--space-4`, no left rule) as a flex
  column with a `--space-2` gap.

**Timestamps.** Take them from `raw.timestamp` when present and format as 12-hour `h:mm AM` in mono.
If the date isn't today, prefix `Mar 4 `. Put the full ISO string in `title`.

## §chat.transcript/message-actions — Message actions

One strip of actions under each delivered message: `<div class="message-actions" role="group"
aria-label="Actions for your message|this reply">`, holding `button.button-icon.button-ghost.message-action`
icons. Under a message of yours it is end-aligned like the message head (`.message-actions-end`).

- **One strip per ENTRY, never per row.** An assistant message renders one row per content block
  (`<entryId>:<n>`), so the strip hangs off the entry's LAST row that shows text — never off a tool
  card, and never once per block. Rows that are not a user message or assistant text (wake nudges,
  tool calls, thinking, info, reports, compactions, and the synthetic `<entryId>:stop` row a failed
  or aborted turn leaves) get no strip. With tools or thinking hidden, the strip follows the last
  SHOWN text row; an entry with nothing shown has no strip, and the hidden-rows disclosure never
  draws one (it renders without the actions provider). Decided in `src/lib/message-actions.ts`,
  which is the only place that answers "where does a strip go".
- **What each role offers.** Your message: `Copy` · `Share` · `Rewind`. A reply: `Copy` · `Share` ·
  `Regenerate` · `Fork`. Fork (icon `branch`, "Fork from here") creates and opens an independent
  session through that reply; the original conversation is unchanged (§chat.session-fork/from-reply).
  Copy and Share come first, followed by Regenerate and Fork. Fork is the fourth reply action and
  needs no destructive confirmation, because it abandons nothing.
  **Share** (icon `share`, "Share from here") opens the share page with this message as the
  start (`#/share/<id>?from=<entryId>`, §app.session-share/share-page), in chat and watch sessions
  alike; sharing only reads, so it is never refused, except off while the view doesn't know the
  session's id yet. Copy is
  absent — not disabled — when there is no text to copy (an images-only message): a Copy that
  copies nothing would claim to have copied the message.
- **Quiet until the message is asked about, and every input can ask.** The strip is hidden with
  `opacity` alone — always in the DOM, always in the accessibility tree, always tabbable, and its
  height is always reserved, so a message never moves when a strip appears or leaves. A mouse
  reveals it by being anywhere over the message region: the whole row (`.entry`), not just the
  bubble, and the row includes its **action band**. A row is `display: contents` and has no box
  of its own, so the strip's box takes over the thread's `--space-4` gap above it (a
  `−--space-4` top margin, padded back down by `--space-4 − --space-1`): the band starts at the
  bubble's bottom edge, the icons stay where they were, the row's flow height doesn't change,
  and the pointer never leaves the row on its way down to a button. A keyboard reveals the strip
  by focusing into it (`:focus-within`, reached by Tab while it is invisible); touch reveals it by
  a TAP on the message, which stays until a tap lands on another message or outside every one.
  **A hidden strip's box takes the pointer and its buttons don't** (`pointer-events: none` on the
  strip's children only), and that is what makes the first tap safe: a tap where an unseen button
  is lands on the strip's box, reveals the row, and presses nothing. The reveal is applied on the
  `click` the tap produces, not at `pointerup`, because a touch's compatibility mouse events
  arrive after `touchend` and would press a strip made live any earlier. Hover is scoped to a
  fine pointer (`(hover: hover) and (pointer: fine)`), because a coarse one leaves `:hover` stuck
  on the last thing tapped. A press that travelled more than 10px is a scroll, not a tap, and
  reveals nothing.
  Three states hold the strip open regardless of the pointer: an armed confirm, Copy's check, and
  a refusal the row is keeping. Revealed, hover and focus still deepen the ink
  (`--color-ink-muted` → `--color-ink-2`), and a coarse pointer, with no hover to deepen it,
  starts at `--color-ink-2`; quiet is a semantic colour at full opacity, never alpha —
  muted measures 4.7:1 or better on every surface a message sits on, in both themes, where a 0.6
  alpha measured 2.4:1 and failed the 3:1 a glyph needs. Each button is 44px wide and reaches 44px
  tall through an `::after` extension, so the visual row stays 36px and messages keep their
  rhythm; the boxes never overlap (44 wide with the strip's own gap between them).
- **Copy.** Your message: its text as sent, with pi's clipboard paths already stripped. A reply:
  all of that entry's text blocks joined by a blank line — markdown source, never thinking or tool
  output. Available in watch mode too: the text is on screen, and nothing owns the clipboard. The
  icon flips to a check for 1.5s and the toast says "Copied message."
- **Rewind** (your messages) moves the branch to just before that message and hands its text back
  to the composer — the same request the Timeline's input rows make (§chat/timeline), with the same refusals.
  **Regenerate** (replies) walks back to the user message that started the turn, rewinds there and
  re-sends that message's own stored text and images with the session's CURRENT model, so
  switch-model-then-regenerate compares. The whole turn re-runs, tools included, and the composer
  draft is not touched. The confirm names the message that started this REPLY — never "this turn" —
  because the server rewinds to the nearest user message and moves the leaf to ITS PARENT, and a
  MID-TURN STEER is a user message: in `u1 → a1 → tool → s1 → a2`, regenerating a2 resolves to the
  steer, so s1 and a2 leave while u1, a1 and the tool call stay; regenerating a1 resolves to u1 and
  takes a1, the tool call, s1 and a2 with it. A reply that answered a scheduled WAKE nudge has no
  message of yours to send again, so Regenerate is off there with that as its reason — permanently,
  since no amount of waiting turns a nudge into something you sent. A reply that answered a topic
  batch (§chat.topics/row) is the same, with its own reason: "That reply answered notes other
  sessions pushed to a topic, not a message you sent, so there's nothing to send again."
- **Both confirm inline, in place.** The first press arms: the strip becomes the sentence plus
  `Rewind Here` / `Regenerate Here` and `Cancel`. Focus follows into the confirm and back to the
  button that armed it on Cancel or Esc. The sentence says what survives as well as what goes:
  "This message and every reply after it leave the branch. The session file keeps them."
- **Some refusals are only the server's to make.** A steer awaits the extension input handlers
  before it is queued, so a message can still be on its way out after the turn it meant to
  interrupt has ended: `isStreaming` is false and the pane looks idle, yet a rewind there would
  deliver that message into the branch it rewound TO. The server refuses with `queued`, and the
  strip shows the server's sentence. The client's own checks stay a fast path and never try to
  guess this state.
- **A blocked action keeps its reason.** `aria-disabled` with the reason as `title`, never hidden:
  "Stop the current turn first.", "Wait for the compaction to finish.", "This session is open in a
  terminal, so Sova won't write to it.", "Only a chat open in Sova can rewind." (watch mode),
  "A rewind is already in progress."
- **A refusal stays on the row.** The chat announces it once; the strip keeps the sentence under
  the message it was about (`.message-actions-refusal`), so looking away doesn't lose it. The
  server is the authority: the client's own checks are a fast path, and every refusal it sends is
  rendered as-is rather than pre-empted.
- **A live reply has no strip until it lands.** Streaming rows carry no entry ids, so nothing on
  them could be copied or regenerated by id; the resync after `agent_settled` replaces
  them with canonical rows and the strip appears then. A disabled action that could never enable
  itself is not drawn at all.

## §chat.transcript/a-queued-message — A queued message (§chat/composer, sending)

A message of yours that hasn't been delivered says which state it is in, with a dot and the word:
`Sending…` while nothing is known to hold it, `Queued` once the server says it does. Only a queued
row carries an action — one `Remove this queued message` — and it is removed BY ITS ID, so a
duplicate in the middle of three goes and its twins stay, and an images-only message is a row like
any other. A delivered row never draws one: nothing can be recalled then. A queued row is not an
`.entry`, so it wraps itself in a `display: contents` host that gives its Remove the same hover
and tap region every other strip has.

The row's head names who queued it: `You`, `Overseer` for a message the Overseer sent into this
session (§app.overseer/sent-marker), `From a session` under the sender header "From {title}" for one
another session sent (§chat.profiles/delivery), or `Sent by Sova` for one Sova queued for the
session itself (a group send, a remote status probe). Every one of them is removable the same way.

The states are the server's to report, and a queue snapshot proves only what it still holds. Every
departure is broadcast to EVERY client of the chat as `queue_item_gone {itemId, reason, text?}`,
and THAT moves the row — a message simply missing from the next snapshot is never called "sent",
because absence is equally true of a delivery, a Stop, a refused hand-off and another tab's
removal. The five reasons:

- **delivered** — the agent took it; the row becomes a sent message.
- **removed** — a `queue_remove` took it, possibly in another tab; the row goes in all of them, and
  **the text does not come back**. Delete is a discard: Stop takes the queue back to be edited and
  re-sent, Delete says this message should never be sent, and re-pasting it into the draft would
  undo the gesture the user just made. The requester's `queue_removed` ack only settles the
  request; the `text` on it names what left, it is not an instruction to restore it.
- **cleared** — Stop drained it; the row goes and `queue_cleared` returns the text, as it always did.
  A link message is never a queued row, and Stop never returns one (§mesh.links/delivery).
- **failed** — the hand-off was refused (a terminal took the file, a foreign writer, the model
  turned off in Settings); the row goes and the text comes back where it was typed.
- **dropped** — an extension `input` handler handled the message instead of queueing it (the
  model-policy extension does exactly this), so **no `message_start` will ever arrive**. Without
  this signal the row would sit on "Sending…" for the life of the pane over text the user has
  lost: the row goes and the text comes back.

A removal the server refuses because the agent already took the message says "Already sent. It
can't be removed now.", and the row becomes the delivered message it turned out to be.

## §chat.transcript/streaming — Streaming (chat sessions)

Driven by `ChatServerMessage.event`. Streaming working blocks follow the same browser-local compression preference as settled history (§chat.work-chain-setting/preference). Off, they render their original components directly, without a timeline wrapper or group control.

- **Start of turn** (`agent_start` / `turn_start`). Append a pending assistant `.message` with the
  class `message-streaming`. Its head is `author` + `<span class="live-dot"></span>`.
  `text_delta` appends into its body; `thinking_delta` feeds a streaming `.disclosure` placed
  before it. `toolcall_start` adds a `.toolcard` with the Running chip.
- **Run status.** Above the textarea, inside `.composer-inner`:
  `<p class="run-status"><span class="live-dot"></span><span class="run-status-state" title="Working · running bash"><span class="icon icon-sm run-status-narrow" style="--icon: url(/icons/wrench.svg)" aria-hidden="true"></span><span class="run-status-say">Working<span class="run-status-detail">· running bash</span></span></span></p>`.
  **One live dot leads the row whenever the session has work in flight**: a turn, Stopping, a
  rare state such as "Retrying after a provider error", a compaction, or at least 1 subagent
  working, the parent idle included. It is the row's first child and its only pulse: nothing else
  in the row carries a dot or moves (the subagents trigger shows a static ring, §app/subagents-pane).
  With nothing in flight the row has no dot.
  It is **one line at every width**, in one of two forms picked by the composer's own width (its
  `composer` container, with a `@media` floor). Both forms' markup is always there; CSS alone
  picks, so nothing moves when one gives way to the other.
  - **Wide** (a composer 620px wide or more): words. The dot, "Working", and the detail
    in mono, muted: "· running bash", "· thinking", "· writing", nothing between blocks. This is
    the loading pattern: say what's happening. A detail longer than the room (a long tool name)
    ends in an ellipsis rather than pushing anything; the whole text is the tooltip.
  - **Narrow** (under 620px): icons. The dot says work is in flight and one icon after it says what
    the turn is doing: `bulb.svg` while it thinks, `pencil.svg` while it writes, `wrench.svg` while
    it runs a tool (never the tool's name), none between blocks. The same words are visually hidden
    and are the tooltip.
  620px was measured, not chosen: it was the narrowest composer content width where the whole
  wide row — "● Working · running agent_spawn", "● 1 subagent ›", "1 align · 0/8 decided",
  "3 inputs ›" — fitted with nothing truncated at the Medium text size. With the subagents
  trigger's words ("◔ 1 of 5 subagents working ›") that row needs 712px; between the two the
  wide form's detail gives way ("· runni…" at 620px) as a long tool name's does, and the rest stays
  whole. Any threshold from 620px to 672px sorts the devices the same way, so it stays: the
  desktop and the Fold's open portrait at 704px (672px of composer) get words; phones, the cover
  screen, the open portrait at 616px and both open landscapes (933px and 816px, beside the
  sidebar) get icons.
  **Screen readers hear the words once in either form**: the one words span is visible in the wide
  form and visually hidden in the narrow one, and the icon and the dot are `aria-hidden`.
  **Stopping and the rare states keep their words in both forms**, after the dot: "Stopping…",
  "Compacting context", "Retrying after a provider error", "Waiting for zai · 5 of 5 in use" (§app.provider-limits/waiting-shown). Short of room they end in an ellipsis,
  with the whole text in the tooltip; in the narrow form they give way first, down to about 4em of
  their words. The row is shared: it also carries the subagents trigger (§app/subagents-pane)
  and the inputs trigger ("7 inputs", which opens the Timeline with Inputs Only on, §chat/timeline), and it
  renders whenever any of the three has something to show,
  so an idle session with messages still has one. The subagents trigger follows the same two forms
  (words wide, its ring and a count narrow, §app/subagents-pane). The triggers never shrink, so none
  runs its words into the next. The alignment chip doesn't either, except in the narrow form once
  nothing else can give: its count then ends in an ellipsis ("1 align · 0/8…"), its full text still
  its accessible name. At 344px that is every state with the subagents trigger and the inputs
  trigger beside it; at 390px only a rare state's.
  **Nothing moves.** The row is 20px tall whatever it carries (the triggers' net height) with its
  own 16px bottom margin, so the textarea and the composer keep their place between idle and
  working and as the step changes. The row's gap and each trigger's inline padding are 8px in the
  wide form; in the narrow one they are 6px and a trigger's parts sit 4px apart, so a working row
  with the subagents trigger, the alignment chip and the inputs trigger stays on one line inside
  the composer at 344px.
- **End of turn** (`agent_settled`, or `agent_end` if that's all you get). Remove the live dots
  and the run status; the row's one dot stays while a subagent still works. Replace the optimistic items with the server's canonical ones if it sends
  them. Announce "Reply finished." in the polite live region; announce nothing per delta.
- **A turn that errors** (`type:"error"`, not a refusal) announces "The turn stopped with an
  error." — the banner's own title, so the failure is heard wherever the banner isn't being read:
  in a workspace a failed member looks exactly like a quiet one until you pan its pane, and the
  announcement is the one signal that crosses panes (§workspace/groups's pane-prefixed member form, "{pane
  name} — stopped with an error."). Once per error: the same failure re-reported on a reconnect
  loop says nothing, because each announcement would read as another error. It replaces that
  turn's "Reply finished." (Accessibility, below): the error is the ending.
- **Performance.** Batch deltas per animation frame. Never re-render the whole thread on each
  delta.

## §chat.transcript/runaway-stream — A runaway stream is stopped

Every runtime Sova hosts (ordinary chats, baton sessions and their wrap-up, the Overseer, a
project's overseer) has its turn stopped once the model's stream passes a limit for its kind. A
model that degenerates — endless whitespace inside a tool call is the case seen — otherwise costs
the server more CPU with every piece it streams, until nothing else on it answers.

| Limit | Baton | Overseer | Project overseer | Ordinary chat |
|---|---|---|---|---|
| Raw whitespace in a row inside one tool call's arguments | 8,192 | 8,192 | 8,192 | 8,192 |
| One tool call's arguments | 65,536 characters | 65,536 | 65,536 | 1,048,576 |
| One reply (text, thinking and tool arguments) | 262,144 characters | none | 1,048,576 | none |
| One run, start to end | 10 minutes | 10 minutes | 10 minutes | none |
| The server stalled over 750 ms while one tool call is at least 131,072 characters | stop | stop | stop | stop |

A project overseer's conversation lives in its org's workspace repo, which every host clones, so a
runaway reply there is capped: it can't write a line too long to read back or to back up.

- Characters are counted as they stream; the clock is checked as each piece arrives as well as by a
  timer, since a busy server runs timers late.
- A stop aborts the turn once (no automatic retry). Everyone connected gets the ordinary turn error
  (§chat.transcript/streaming), "Stopped the turn: {reason}." — e.g. "Stopped the turn: the model
  streamed 8,192 whitespace characters in a row into a tool call." The reply stays in the
  transcript as far as it got, ended as aborted. The server logs the stop.
- Past a stop, the server keeps answering: in the stub reproduction a stopped runaway stalls it for
  a fraction of a second, where the same stream unstopped stalls it for seconds at a time.

## §chat.transcript/live-watch — Live-watch (TUI-owned sessions, `/ws/watch`)

- **No persistent banner.** Watch mode has no "Live from TUI — read only" card; it was removed
  by boss directive. Read-only is already obvious from three things that stay:
  1. **The TUI chip in the session head** (`.chip.chip-accent`, the word "TUI", a **static**
     dot — never `.chip-live`; see §design.ground-rules/motion, "TUI never pulses", and §app/session-list). It carries the process
     facts in its `title`, updated from `live` whenever the session list refreshes:

     ```html
     <span class="chip chip-accent" title="Open in pi in a terminal · pid 889823 · Running: bash"><i class="chip-dot"></i>TUI</span>
     ```

     The pid and status are shown only here now. They're a detail you look up, not something
     read on every visit.
  2. **The disabled composer**, with its reason: "Read only while this session is open in the
     TUI." (§chat.composer/disabled-states). AT gets it through `aria-describedby="composer-reason"`.
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
    button. Only the view moving up stops following: content landing below a following view (a
    reply, a queued message drawn again after a switch back), or the browser moving the view down
    to keep a row in place, never does, and the view goes back to the end.
  - It also appears, not following, when you switch back to a session left at the end that gained
    rows while you were away: the view stops at the last row read, and "N new" counts the rows
    below it (§chat.transcript/rendering).
  - Chat sessions follow the same logic while streaming.
  - Sending a message always resumes following.
- **When the TUI closes** (`live` goes null on refresh). A `.banner.banner-info` appears in
  `.transcript-banner`, with title "The TUI closed this session." and body "You can chat in it
  here now." It's a one-time transition with an action, not a persistent card. Its `.banner-action` is `<button class="button button-sm">Open for Chat</button>`,
  which reconnects with `/ws/chat`.
- **Watch socket drops.** `.banner.banner-warn` with `alert-circle`. Title: "Stopped watching.
  The connection dropped." Body: "What's shown is up to `14:06`. Reconnecting…" When it
  reconnects, the banner goes away. The snapshot replaces the list, and scroll position is
  kept if the user wasn't following. Older rows are fetched when wanted, as in a chat
  (§chat.transcript/rendering). While the rows held have no reply to read the context fill from,
  the gauge shows the fill the server read from the whole branch (the snapshot's, or the last
  append's).

## §chat.transcript/rendering — Opening and switching a long transcript

A transcript opens on its newest rows, and fetches the older ones only when they're wanted: as
the reader scrolls toward them, when a jump needs them, or all at once for a browser on this
machine. It builds about its newest 400 rows into the page on its own; older rows held are
built only as the reader scrolls up to them or a jump needs them. Nothing that's built is
virtualized.

- **Newest rows first.** The chat's `hello` and the watch view's snapshot carry only the
  transcript's newest whole entries: at least 60 rows, within about 256 KB, never opening on a
  tool result or inside a baton wrap-up. Nothing older follows on the socket: from then on it
  carries only live traffic, so a streamed event or an append never waits behind the transcript.
  So the first frame shows the end of the session as soon as those newest rows land, however
  long the session is, and its last 60 rows are built with it. The newest rows alone can't be
  much smaller than the newest entry: one that holds a large image arrives whole with them.
- **Older rows when wanted.** They come over REST (`GET /api/transcript`, read-only, never a
  runtime or a write), cut from the same rows the socket would have carried, so they fit onto the
  list exactly. Three things fetch them:
  - **Scrolling up.** While rows held are not yet built, a view within 2 viewports of the top
    of the built rows builds the next chunk above them. Once every row held is built and the
    view is within 2 viewports of their top, the next rows above are fetched: about 256 KB of
    whole entries, never opening on a tool
    result or inside a baton wrap-up. A list too short to fill that much fetches at once, until
    it's taller or reaches the top. While older rows remain, a line's height is held at the top
    of the transcript, so what appears in it never moves the view. When a fetch (this one, or a
    jump's) takes longer than 0.4 s, a short bar sweeps in that line: the skeleton sweep, with no
    text; screen readers hear it as "Loading older messages" (a status region). The line sticks to
    the top of the view, over the rows, taking no pointer, so a jump fetching from the end shows
    it too.
  - **A jump** fetches every row down to its target in one request (below).
  - **A browser on this machine connecting directly** (the rule of
    §chat.transcript/compressed-transfer; the server says so with the `hello`) fetches all of
    them in the background right after the first paint, in chunks of about 1 MB while the browser
    is idle. They are held as data, built only as above, so a far jump lands without a fetch. A
    phone, or any client reaching the server through a proxy, never does, and neither does the
    Overseer (§app.overseer/transcript-window).

  Rows are built above the ones on screen while the browser is idle, a chunk at a time, each
  chunk sized to stay under a frame, until about 400 rows are built; past that, a chunk is built
  only as the view comes near the top of the built rows (above). Rows landing never build at
  once, and rows appended at the end are built as they come. The view doesn't move
  while they're added, not by a pixel: it keeps its distance from the end, which at the bottom is
  the bottom. Nor does it while a row above it is first drawn at its real height: every row,
  estimated or drawn, is laid out at a whole-pixel height.
  Rows added above aren't new content: they don't scroll a following view and don't count in
  Jump to Latest's "N new". Each fetch names the list's first row and its last entry; if the
  branch has moved under the list since (a rewind in another tab), the view starts again from
  the branch's newest rows, keeping the rows above them that are still their ancestors.
- **Nothing built is virtualized.** A built row stays in the page, so `Ctrl+F`, screen readers
  and text selection reach every row built so far: the newest 400 or so, and every row the
  reader has scrolled up to or a jump has built. A row held but not built, or not fetched, is not
  in the page, so the browser's own find does not reach it; the Timeline, the outline's Jump to
  Message, Open in Session, the card chip and a card reference still reach every row on the
  branch, since each jump builds (and if need be fetches) its target first (below). A row off
  screen is skipped by layout and paint
  (`content-visibility: auto`), at a height estimated from its kind, its text and its images
  until it is first drawn. The estimate counts a card or disclosure at its collapsed height
  (a compaction as its folded disclosure, not its summary). A work timeline's rows are estimated
  at the height they take in the timeline instead: a step at its line plus the air between two
  of them, a run's head at the group line it carries over its first step, and a folded run at
  the group line alone. Text is wrapped at the width the
  transcript has at that moment, so the same row is estimated taller on a phone than on a wide
  window. A row that draws nothing (a tool result shown in its call's card) takes no space. A
  row's single image counts at the height its box will have
  (§chat.images/thread-thumbnails), two or more at an estimate of their rows of tiles. A
  row being pointed at or focused is always drawn whole, a focused one even scrolled away; a
  revealed row (§chat.transcript/message-actions) is drawn whenever it is on screen. Pressing in
  a row never changes whether it is skipped: a row that turned skippable mid-press crashed
  Chrome 154's tab.
- **Jumps build their target first.** Whether an entry can be jumped to is asked of the rows the
  thread renders, not of what is built. Every jump builds the rows down from its target if the
  fill hasn't reached it, then scrolls and tints as before (§chat.timeline/jumping): a Timeline
  input row, the outline's Jump to Message, the Skills tab, Open in Session, and a
  switch back (below). A jump to a row the list doesn't hold, while the branch has rows above
  the list, fetches every row down to it in one request and then lands; nothing is said while it
  waits, and a slow fetch shows the top edge's bar (above). A newer jump replaces a waiting one. "Isn't in
  the transcript" still means the thread has no row for the entry: said by a list that reaches
  the top of the branch, or when the server finds no such row on it.
  Rows never drawn have estimated heights, so a long jump that doesn't land in the middle aims
  again once the scroll has rested, at most twice.
- **Counts of the whole branch.** The `hello` and the snapshot also say what the counts need of
  the rows they don't carry: the ids of their inputs, how many messages they hold, whether
  any is a reply, and the alignments still open among them (each one's newest revision there,
  and its row); so does each fetch, of the rows above what it returns. The inputs count, Fan
  Out's "up to message {n}", Undo last turn and the composer's alignment chip
  (§chat.alignment/chip) count the rows held plus those, so they're right from the first `hello`
  on, with no older row fetched. A newer revision among the rows held, or live, takes an
  alignment's place: one done or dropped there is no longer open.
- **Opening a disclosure keeps the view.** Opening or closing a tool card, thinking, a report or
  the hidden-rows disclosure never scrolls the transcript, even while following. Following is
  re-read from where the view now is, so Jump to Latest appears if the end has gone out of view.
  While following, the transcript also returns to the end when the view gets shorter (the
  composer's status row appearing) or a row below changes height with no new content (an image
  decoding). It keeps following when the view gets narrower or wider (a panel opening beside
  it, a window resized): the rows reflowing is not scrolling away.
- **Refetches keep rows.** A new `hello`, a turn-end reload or a new snapshot replaces the list,
  but every row whose entry renders the same keeps its element. A `hello` or snapshot replaces
  the list from its first row on; rows the list on screen already has above that one (kept from
  the last visit, or before a reconnect or a rewind) stay, since they are that row's ancestors,
  unless their inputs disagree with what the `hello` says of the rows above it (then only its own
  rows stay). A turn-end reload fetches again the rows the list holds, from its first row to the
  end; rows above them stay unfetched. Open cards, focus and a revealed action strip survive the
  end of a turn, a reconnect and a rewind; only changed and new rows are built.
- **Switching back.** The last 3 sessions opened in the tab keep their rows and where they were
  scrolled: at the end while following (and which row was last), else the row at the top of the
  view and its offset. So do the sessions in Recent, fetched ahead (§chat.transcript/recent-preload).
  Switching back to one shows those rows at once, where they were (with Jump to Latest when not
  following), while its `hello` or snapshot is on the way, then reconciles them as above. The
  last row read is the last row drawn when the reader left, live rows included: a running turn's
  prompt, reply and tool rows, and a message still queued, count as read when they come back as
  the transcript's rows. The server names the entry each message that ends was written as (on
  its `message_end`), so a live row knows its row; a reply still streaming when the reader left is
  the entry after the last row named, and a queued message delivered meanwhile is the next prompt
  with its text. Only rows that arrive after the reader left count as gained. One
  left at the end that gained rows while away, kept or brought by that `hello` or snapshot, stops
  at the last row read: that row's bottom at the bottom of the view, not following, with "Jump to
  Latest · N new" counting the rows below it, unless they're short enough that the view is still
  within 80px of the end. One that gained none stays at the end, following, as does one whose last
  row read isn't among its rows, or one the reader has scrolled or touched first. A kept
  spot whose row the `hello` didn't keep is fetched and placed then, unless the view has moved
  from the end meanwhile. Any other open lands at the end. A reload keeps nothing. Rows kept this
  way are never taken as the whole transcript: until this visit's `hello` or snapshot has said
  what's above them, nothing says a row isn't there, and nothing counts the whole list — with
  one exception: opening a chat whose rows were kept shows the inputs count
  (§chat.timeline/opening-it) that was known with them (the last visit's `hello`, or the Recent
  fetch that kept them), and this visit's `hello` corrects it. The count is kept with those rows
  alone; once the list holds other rows it is gone until the `hello`.

## §chat.transcript/compressed-transfer — A transcript travels compressed

A transcript crosses the network compressed whenever the browser can take it that way, except to
a browser on the same machine connecting directly, so a long session opens on a phone over a slow
link in a fraction of the time and a desktop browser beside the server pays nothing for it. Nothing on screen changes:
the rows, the `hello` and the snapshot are the same, and a client that doesn't ask gets exactly
what it did before.

- **Sockets.** The chat and watch sockets (`/ws/chat`, `/ws/watch`) accept `permessage-deflate`
  when the browser offers it, and compress each message of 1 KB or more on its own (no context
  carried between messages, either way); smaller ones, the streaming deltas, go as they are. A
  client that doesn't offer it gets uncompressed frames.
- **REST.** Every `/api/` response of a compressible type (JSON, text) is gzip- or
  deflate-encoded when the request's `Accept-Encoding` allows it, and says so with
  `Content-Encoding` and `Vary: Accept-Encoding`; without it, the response is unencoded. Images,
  event streams, partial content and anything already encoded pass as they are.
- **Not for this machine.** A client whose connection comes from this machine (loopback) and
  that carries no proxy header (`X-Forwarded-For`, `-Host` or `-Proto`, `Forwarded`,
  `X-Real-IP`, `Via`, or any `Tailscale-` header) is sent nothing compressed, on the sockets
  and REST alike: it has no bandwidth to save, and compressing only delays its paint. A phone
  reaching the server through `tailscale serve` also arrives from loopback, but with those
  headers, so it is compressed; so is any other forwarded client. A dev server's proxy that adds
  none of them (Vite's) counts as this machine.
- **Not covered.** The built app's static files, extension sockets and routes (`/ext/`), a
  peer's sessions (`/peer/`) and the share listener are sent as before.

## §chat.transcript/slim-rows — Rows carry what they draw

A transcript row carries what its folded form draws and no copy of the entry it came from, so a
long session's rows weigh about what its text weighs, and opening, switching and reloading never
wait on megabytes nobody looks at. Nothing on screen changes: every row, its time, its chips, the
inputs count, the context fill and the spend read exactly as before, and an opened tool card
shows exactly what it showed before.

- **No entry copy.** A row never carries its source entry. Each entry's first row carries that
  entry's facts once (its type, role, model, usage, stop reason, error, a tool result's failure,
  a compaction's figures), every row carries the entry's time, and a reply's other rows read the
  facts from its first one. An unknown row, whose card shows the entry as JSON, still carries it.
  A consumer that asked for wire 2 (§app.harness/wire) gets those facts in the harness contract's
  words instead (a setting change, a context reset, a compaction's figures, a reply's context
  fill, a tool result's tool and failure); every other consumer gets them as before.
- **No reasoning signatures.** The encrypted reasoning a provider returns with its thinking (and
  any signature on a text block or a tool call) never reaches the browser: not on a row, not in a
  streamed event, not through any route.
- **Tool calls load on opening.** A tool call's row carries its name, the one line its folded card
  shows, and the "+n −m" of an edit or write; its result's row carries whether it failed, and its
  images and named attachments. The arguments, the output and the result's details come from
  `GET /api/transcript/tool` (read-only, a batch of row ids at a time) when the card is opened or
  about to be: the thread fetches the cards near the view, or under the pointer or focus, ahead of
  time, so opening one shows its body at once, with no flash and no jump. A card opened before its
  content has come says it is loading only after about 0.3 s, and a failed fetch says so with a
  way to try again. The folded line's tooltip shows the whole line, as before. Cards that draw as cards rather than
  tool cards (`show_changes`, `sova_card`, `sova_confirm`, `sova_link`, `sova_unlink`, `align`,
  `session_send`, `sova_create_session`, `sova_navigate`) keep their whole content on the row.
  While a reply streams, its rows show everything as they always did.
- **Full content where it's needed.** Copying, the Changes viewer and every server-side reader
  (the Overseer's session reads) still get every tool's whole arguments and output.

## §chat.transcript/recent-preload — Recent sessions open at once

The sessions in the sidebar's Recent (§app.session-list/recent) are kept in memory, so opening
any of them paints its rows in the first frame, including one this tab hasn't opened yet. The
view then reconciles them with its own `hello` or snapshot (§chat.transcript/rendering).

- **What is kept.** The sessions Recent lists with no search typed, the last 3 sessions opened
  (switching back to a session that isn't in Recent works as before), and every session a view
  shows now. Anything else is dropped. Membership follows Recent live: its count setting, and
  sessions moving in or out as they become active or archived.
- **Fetched in the background.** A Recent session not yet in memory is fetched with the
  read-only `GET /api/transcript`: its newest rows only, the ones the `hello` and the snapshot
  carry (§chat.transcript/rendering); fetching never opens a chat runtime or writes anything. One session at a time, in Recent's order, once
  every open view has painted its rows (or 10 s have passed), while the browser is idle. None
  while a turn runs in a session on screen; none for a Recent session in the middle of its own
  turn, until it ends. None at all when the browser asks to save data
  (`navigator.connection.saveData`). Peer sessions are fetched through the host, as their views
  are.
- **Kept current.** A kept Recent session whose file changed (`lastActiveAt`) after its rows
  were fetched, or after the last view showing it closed, is fetched again in the background:
  its newest rows, with any older ones a view fetched kept above them while they're still their
  ancestors. A failed fetch is retried only once the file changes.
- **A memory budget.** The Recent sessions kept beyond the last 3 opened and those on screen add
  up to at most 20 MB of transcript JSON (about 20-32 MB of memory). Past it, the largest go
  first. A session is not downloaded when the size its response announces can't fit, and one
  already found too big is not fetched again while the others are kept. Such a session opens
  the way any unkept one does: it lands at the end once its `hello` arrives.
- **A reload keeps nothing.** Each page load fetches what Recent needs again.

## §chat.transcript/own-writes-across-restart — The server's own writes survive a restart

A session file that changed recently, from a process Sova can't identify and that no TUI claims,
opens read-only for 120 seconds, with the banner "It changed {just now | 2m ago} from a process we
can't identify, and no TUI claims it, so we only read it. Chatting here would put 2 writers on one
file." The age is live: it counts on while the banner is up, instead of freezing at connect time.

The server's own writes are not "a process we can't identify", **across a restart too**. It
keeps the size and modification time it last left each file in, in `owned-writes.json` under
Sova's state root (the most recent 500), and a file whose size and time both still match opens
for chat at once. A stat is recorded only where the write is certainly the server's: a file it
just created, an entry a runtime it held just appended, and a stretch its write guard verified
entry by entry as its own. Any later append by anyone breaks the match, and a TUI-live session is
refused before this check. A missing or corrupt file means nothing is known to be the server's,
and the 120-second rule applies.

## §chat.transcript/landing-page — The overview (`#/`)

With no session selected the main pane is the overview: not an empty state with a grid bolted on — it is one
page with up to seven parts, in this order (the Mesh card, §mesh.ui/card, sits after the Sessions
card). On a phone it is `#/overview`, under the list's head row (§app.shell/overview):

1. **The title**: `.overview-head` holding a plain `h1.overview-title`, "Overview" (`--fs-heading-m`,
   semibold, left-aligned on the sections' own left edge and cap), at every width — no mark and no
   body line; the session count lives only in the Sessions card.
2. **The Start section**, under a `Start` section eyebrow: one action card per way to start
   something, in a `ul.overview-actions` grid — `New Session` ("Start a chat with pi in any folder
   or on any host."), the only one. Organizations is not a Start
   card: it has its own section, the page's last (part 7). Each card is one
   `.card.action-card`: its icon (`plus`) on a 36px `--color-sunken` tile, the
   title (`--fs-heading-s`, semibold) and the line (`--color-ink-2`). The whole card is the control,
   a `<button>` that opens its dialog (New Session's), named by
   its title (`aria-labelledby`) and described by its line (`aria-describedby`). Hover lifts the
   border to `--color-border-strong` and the shadow to `--shadow-2`, like the extension cards; focus
   is the ring round the whole card. The grid is one column, and two once `.overview` (the
   `overview` query container) is at least 640px wide. It is the first thing read at every width
   after the title.
3. **The Sessions card**, always (at every width, with no sessions too), under a `Sessions`
   section eyebrow: one `.card.home-sessions`. It reads: `{n} session(s) across {m} folder(s)` as
   its title — main threads, archived included, and their distinct folders;
   `{live} live · {working} working now` — live = the Live & web region's sessions (open in a
   terminal, or a web session not archived; never an organization's, §app.session-list/ordinary-surfaces), working = a live record says `working`, or the
   server reports a web session busy; when the Needs-you region would list anything, a warn chip
   `Needs you · {n}`, a warn border and `Waiting on you: {title}, {title}[ and {k} more]` — the
   region's rows (§app.session-list/needs-you, from the attention digest the page already polls,
   the same rows and the same proactivity rule; the first two, newest first, each a link to its
   session); and `Last active {title} · {relative time}` with a `Resume` button to it — Recent's
   first row (§app.session-list/recent). With no session at all: "Nothing yet: start one above."
   and no Resume. No server call of its own: the list and the digest the page already has.
   The card itself is one button (its `::after` covers it; the links and Resume sit above it).
   Pressing it opens the session list: on a phone it goes back to the list (§app.shell/overview);
   at 768px and up it expands the pane if it is collapsed into the spine, and focuses the list's
   search.
4. **The Extensions section**, shown **only when at least one extension is installed**: one card
   per extension, under the same section eyebrow (§app.extensions/cards).
5. **The Explanations card**, always (with no explanations too), under an `Explanations`
   section eyebrow: the Mesh card's shape (§mesh.ui/card) — one full-width `a.card.ext-card` to
   `#/explanations` (§app.insights/explanations-page) with the `file` icon, the title
   `Explanations`, a count chip (`{n}`), and one line: `Latest · {topic} · {relative time}`, or,
   with none, "No explanations yet. Run `/explain` in a session to write one." Before the first
   list has loaded the line reads "Reading explanations…". It is the way to the page at every
   width, and on a phone the only one outside a session (list → Overview → the card).
6. **The Shares card**, always (with no public link too), under a `Shares` section eyebrow, after
   the Explanations card and before Organizations: the Explanations card's shape — one full-width
   `a.card.ext-card` to `#/shares` (§app.session-share/shares-page) with the `external` icon, the
   title `Shares`, a count chip (`{n}`: every live public link counted on the line), and one line:
   `{n} session shares · {n} organization links · {n} preview links` (`1 session share`,
   `1 organization link`, `1 preview link` at 1), then ` · {n} viewing now` only while anyone is
   (the Shares page's own viewing count). Session shares are the shares with a live link and
   organization links every live hand-off and owner link, both from `GET /api/shares-overview` on
   this host and each up peer; preview links are this host's active previews from
   `GET /api/previews`, a person's own link (§mesh.public/preview) counted as one link of its own.
   With none: "No public links are open." Before the first read has answered the line reads
   "Reading shares…" and the chip is not shown. A host that doesn't answer is left out of the
   counts and the card never names it (the Shares page does). It reads again every 30 seconds
   while the overview is shown, and never while it isn't. It is the way to the Shares page at
   every width: the sidebar foot, its phone sheet and the spine have no Shares entry
   (§app.insights/sidebar-foot).
7. **The Organizations section**, always and always last (below Mesh, Extensions, Explanations and Shares),
   under an `Organizations` section eyebrow: one full-width `.card.overview-orgs`, the entry point
   to `#/orgs` (§app/organizations). Its head is the `network` icon on the same 36px sunken tile as
   the Start cards, the title `Organizations` (`--fs-heading-s`, semibold) — a link to `#/orgs`,
   44px tall as a target — and the line "Keep each client's people, projects, and hand-off
   sessions together." Its data is `GET /api/orgs`, polled every 30s while the page is shown (the
   same `OrgSummary` rows the org cards read, §app.organizations/org-cards); nothing else is fetched.
   - **With at least one org**, a `dl` of five totals across every org, each a figure
     (`--fs-heading-m`, semibold, tabular) over its label on a `--color-sunken` tile, as many to a
     row as fit at 96px or more: `Organization(s)`, `People` (roster size; `Person` for 1),
     `Project(s)`, `Open hand-off(s)` (baton sessions not done or closed) and `Needs you` — the sum
     of every org's Needs-you items (the org cards' count). Only while that sum is above 0 does its
     tile take the warn colour, a warn border and background and a dot, and the card a warn
     border; at 0 it reads like the others.
   - Then a `ul` of at most 5 rows, most recently active first (`lastActivityAt`, newest first;
     an org with none sorts last; ties keep the server's order). Each row is one `<a>` to
     `#/orgs/<id>`, 44px tall at least, reading: the org's name (medium weight, one line, ellipsis),
     `{n} people · {n} projects · {n} open hand-offs` (the org cards' counts line), a warn chip
     `Needs you · {n}` when that org has anything waiting (its title names the kinds, as on the org
     card), and `Active {relative time}` (`src/lib/format.ts`; the exact stamp in its title; left
     out when the server gives no activity). At 640px of `overview` width and up a row is one line
     in columns that line up from row to row; narrower, the name and chip lead and the counts and
     time share a wrapping line under them.
   - When there are more than 5 orgs, a `View all {N}` link to `#/orgs` follows the rows.
   - **With no org**: the head and its line, then a `Create Your First Organization` button-styled
     link to `#/orgs`. Before the first answer the card shows only its head; a failed first fetch
     says so under it and the poll retries.
   - The title, each row and `View all` are separate links, none inside another, in reading order,
     each with the focus ring; the card itself is not a target.

```html
<div class="overview">
  <div class="overview-head"><h1 class="overview-title">Overview</h1></div>
  <section class="explain-section" aria-labelledby="overview-start-title">…Start, one .card.action-card per action…</section>
  <section class="explain-section" aria-labelledby="home-sessions-title">…Sessions, the .card.home-sessions…</section>
  <!-- only when at least one extension is installed (§app.extensions/cards) -->
  <section class="explain-section" aria-labelledby="ext-section-title">…Extensions {n}, one .card.ext-card each…</section>
  <section class="explain-section" aria-labelledby="explain-section-title">
    <h2 class="explain-section-head" id="explain-section-title">Explanations</h2>
    <ul class="ext-grid ext-grid-full"><li><a class="card ext-card" href="#/explanations">…icon · Explanations · chip {n} · Latest line…</a></li></ul>
  </section>
  <section class="explain-section" aria-labelledby="shares-section-title">
    <h2 class="explain-section-head" id="shares-section-title">Shares</h2>
    <ul class="ext-grid ext-grid-full"><li><a class="card ext-card" href="#/shares">…external · Shares · chip {n} · counts line…</a></li></ul>
  </section>
  <section class="explain-section" aria-labelledby="overview-orgs-title">…Organizations, the .card.overview-orgs…</section>
</div>
```

- **Scrolling.** `.app-main` is a fixed-height flex column with `overflow: hidden`, so `.overview`
  is the scroll region itself (`flex: 1`, `min-height: 0`, `overflow-y: auto`). It carries no
  `.pane`: the tiles ask the window, not this box.
- **Width and padding.** `--space-4` of page padding on both sides at every width, `--space-5`
  above the title, and `--space-6` under the last row so the grid never runs into the viewport
  edge. The title and every section cap at `--page-max` (1280px) and centre, so they share one left
  edge: these are cards, not prose, so the reading measure is the wrong cap for them. The parts are
  `--space-5` apart.
- **The head is the section eyebrow**, the same rule as the Usage and Agents pages'
  `.insights-section-head` (§app/insights) — mono, `--fs-micro`, uppercase, `--ls-eyebrow`, `--color-ink-2`
  — with the count as the `.text-num` span inside it, in `--color-ink-muted` and no casing. A
  `display-l` page opener was rejected: this is the second thing on the page, not its title.
- **Where the CSS lives.** `.overview`, `.overview-head`, `.overview-title`, `.explain-section` and
  `.explain-section-head` are in `src/design/base.css`; the Start grid, `.action-card` and the
  Organizations card are in `src/home.css`, beside the Sessions card; the Explanations and Shares
  cards are extension cards (`src/extensions.css`); `.explain-grid` and every `.explain-tile` rule are in
  `src/explain.css`, which owns the tile on the Explanations page.
- **No grid here.** The overview no longer lists the pages themselves: the card leads to the
  Explanations page, where every one is a card with its filters (§app.insights/explanations-page).
  There is no gallery dialog any more, and the sidebar foot has no Explained row. The page's
  tiles open in the same tab (§app.insights/insight-strip, "Every explain link opens in the same
  tab").

## §chat.transcript/states — States

| State | What renders |
|---|---|
| No session selected (unfolded) | The landing page below, not a bare `.empty`: `.overview` fills `.app-main`: the title "Overview" in `.overview-head`, the Start section's action card (`New Session`), then the Sessions card, Mesh, the Extensions section and the Explained grid when there are any, and last the Organizations card. No composer |
| Loading transcript (after 300ms) | Three placeholder messages in `.thread`: a right-aligned `.skeleton` 40% × 44px, then a left `.skeleton-title` plus 3 `.skeleton-line` at 92/78/60%, then a `.skeleton-row` at 60% width. Put `aria-busy="true"` on the `section`. The head renders straight away from the `SessionSummary` |
| Error (a watched TUI session) | `.banner.banner-error` in `.transcript-inner`. Title: "Couldn't load this transcript." Body: "The file at `{path}` wasn't changed. {server message}." Action: `Retry`. A chat the server refuses to open shows §app.shell's open-failure banner instead |
| Empty (new session) | `.empty` with no icon: the title "New session in `~/webapps/sova`.", then, in an ordinary session, the Profile select and what it changes (§chat.profiles/picker), then the setup card (§chat.transcript/setup-card), then the footnote `.empty-body` "Your first message becomes its title.", then, for a local folder in a git repository with linked worktrees, the worktrees line and its `Clean Up Merged` button (§chat.transcript/empty-worktrees). The composer has focus. Show it only while the thread, holding every row of the branch (a list this short sits at the top, so its older rows, if any, are fetched at once), has no **rendered row**: model, thinking and mode change rows and the profile entry draw nothing and don't count, while local rows such as "Ran `/cmd`" (§chat/slash-commands) still do. Once any rendered row exists, the thread renders normally with no empty state |
| Agent/server error (`type:"error"`, not busy) | `.banner.banner-error` placed as the last item of the thread (in flow, so it stays in the record). Title: "The turn stopped with an error." Body: "{message}. Your messages are kept. Send again to retry." |

## §chat.transcript/setup-card — Setup card

A new session's empty state (the "Empty (new session)" row of States, above) carries a card
between its title and its body: what pi loads into the prompt, the skills it offers this session,
and the repository around its folder. Its commit log and its token figures are
§chat.transcript/setup-card-figures; its words are the [copy deck](../design/copy-deck.md)'s
main-pane rows.

```html
<div class="empty">
  <p class="empty-title">New session in <code>~/webapps/sova</code>.</p>
  <section class="setup-card" aria-label="Session setup">
    <!-- the loadout: these three groups, or one line in their place -->
    <div class="setup-group">                          <!-- omitted when it adds up to 0 B · 0 lines -->
      <p class="setup-sum" title="Everything pi loads into the prompt, plus the skills it offers.">
        <span class="setup-sum-label">System context</span>
        <span class="setup-sum-facts">40 KB · 687 lines · ≈10.2k tokens</span>
      </p>
    </div>
    <div class="setup-group">…Context (/setup-card-context)…</div>
    <div class="setup-group">…Skills (/setup-card-skills)…</div>
    <div class="setup-group">
      <h2 class="text-eyebrow setup-label">Repository</h2>
      …(/setup-card-repository)…
    </div>
  </section>
  <p class="empty-body">…</p>
</div>
```

- **When it shows.** Only inside that empty state, so only while the thread has zero rows, local
  rows included. The first row takes the empty state away, and the card with it.
- **The profile comes first.** In an ordinary session the empty state's Profile select and what it
  changes (§chat.profiles/picker) sit between the title and this card; the card itself is unchanged.
  The `sova-profile` entry draws no row, so picking a profile keeps the empty state.
- **It lands whole.** It asks two things at once, the loadout (`GET /api/sessions/context`) and
  the repository (`GET /api/sessions/git`), and draws nothing until both have answered, whether
  each answered with data or with a failure. There is no skeleton and no placeholder: the card
  appears in one step under the title and never grows in a second. A read that doesn't answer
  keeps the whole card away.
- **Read once.** It reads when it appears, and again only if it is asked about a different
  session; then it disappears until both new answers are in. An answer that arrives after the
  card has gone, or for a session it no longer shows, is dropped. Nothing on it polls or links: no
  Refresh button, no timer, no anchors, and a commit's age is worked out when the card draws and
  doesn't tick. The loadout is redrawn in two cases only, both from
  /setup-card-toggles: a flip of a row's switch draws the server's answer in place, and when the
  chat says the switch window has opened after the first read, the loadout is read again,
  skipping the cache. Neither redraw draws over a newer answer. Either answer can be the server's cached read of that folder, up
  to 30s old for the loadout and 10s for the repository, and a repository read already running
  for the same session is joined rather than repeated.
- **Order.** The loadout comes first and Repository last, every time. For a local folder pi's
  loader could read, the loadout is the `System context` line, then Context, then Skills. In
  every other case it is a single line (below). Each group after the first sits under a 1px
  `--color-border` rule.
- **The one aggregate line.** `System context` leading, its figures trailing in the shape a section
  total uses (`KB · lines · ≈tokens`). It adds up every Context row and every Skills row that is on (a row switched off,
  /setup-card-toggles, is listed but not counted), which is exactly what the two groups under it
  total, so it is the sum of their two totals. Its `title` is the one sentence saying so:
  "Everything pi loads into the prompt, plus the skills it offers." It carries no heading, because
  it is a line and not a section. It is left out when it would read `0 B · 0 lines`, that is when
  there are no files, only empty ones, or every row is off. It is not what the prompt costs before the first
  message: it counts each offered skill's SKILL.md whole, and a skill loads only when it is used
  (/setup-card-skills). The title's "plus the skills it offers" is what says so.
- **One line in place of Context and Skills.** A `.setup-note` in its own group, with no
  aggregate line:
  - A remote session: "Skills and context files are read on {target}, so they aren't listed
    here." Its folder is a placeholder on this machine, so the loadout is never read here. The
    Repository group still reads the target.
  - A folder that couldn't be read: the server's own sentence, such as "This session's folder no
    longer exists: {cwd}." or "Sova couldn't read this folder's setup: {message}." The same holds
    for a session file with no header and a folder that isn't an absolute path. The Repository
    group places the folder the same way, so for a missing folder and for those two it says the
    same sentence again under its own heading.
- **Couldn't read.** When a request fails outright (the server is unreachable, or it refused the
  request), the loadout's place says "Couldn't read what pi loads here. {message}" and the
  Repository group says "Couldn't read this session's repository. {message}". The message is the
  request's own: "The Sova server isn't reachable.", the server's error text, or the HTTP status
  line. The two fail independently, so one failure never hides the other group.
- **Width.** The card is at most 560px wide and left-aligned inside the centred empty state. It is
  its own inline-size container. Under 420px across, every row, the aggregate line and each
  group's total put their figures on their own line under the name, left-aligned, except a row
  with a switch (/setup-card-toggles): it stays one line, its name ellipsised, then ≈tokens, then
  the switch at the right edge. The group padding tightens from `--space-4`/`--space-5` to `--space-3`/`--space-4`.
- **Accessibility.** The card is a `section` with `aria-label="Session setup"`. Context, Skills
  and Repository are `h2`s (the session head's title is the `h1`). The aggregate line has no
  heading. Icons are `aria-hidden`. Rows aren't focusable, so what a row's `title` carries (a full
  path, a skill's description) is available on hover only. The one exception: while the switch
  window is open, each context file and skill row's switch (/setup-card-toggles) is a focusable
  checkbox. The row itself still isn't focusable.

## §chat.transcript/setup-card-context — Setup card: Context

The files pi puts into the prompt, in the order it loads them.

```html
<div class="setup-group">
  <div class="setup-head">
    <h2 class="text-eyebrow setup-label">Context · 3</h2>
    <span class="setup-total">31 KB · 475 lines · ≈7.9k tokens</span>   <!-- omitted at 0 B · 0 lines -->
  </div>
  <p class="setup-note">Loaded into the prompt. Token counts are estimates: 4 characters per token.</p>
  <ul class="setup-list">
    <li class="setup-row" title="/home/user/.pi/agent/AGENTS.md">
      <span class="setup-name"><span class="setup-path">~/.pi/agent/AGENTS.md</span></span>
      <span class="setup-facts">≈530 tokens</span>
    </li>
    <li class="setup-row" title="/home/user/webapps/sova/CLAUDE.md">…</li>
    <li class="setup-row" title="/home/user/webapps/sova/.pi/APPEND_SYSTEM.md">
      <span class="setup-name">
        <span class="setup-path">~/webapps/sova/.pi/APPEND_SYSTEM.md</span>
        <span class="setup-role">appended to the system prompt</span>
      </span>
      <span class="setup-facts">≈480 tokens</span>
    </li>
  </ul>
</div>
```

- **Heading and count.** `Context · {n}`, where n is the rows listed, SYSTEM.md and
  APPEND_SYSTEM.md rows included. With none it reads `Context · 0`.
- **The total beside the label** (`.setup-total`) is the rows that are on added up, as size ·
  lines · ≈tokens (/setup-card-figures). It is left out when they add up to `0 B · 0 lines`.
- **Off rows.** A row this session has switched off (/setup-card-toggles) stays listed and
  counted in the heading's n, but it is dimmed (`.setup-row-off`: its name and figures at half
  opacity) and no total counts it, because pi doesn't load it.
- **Load order, and each row's role.** A `SYSTEM.md` that replaces the default prompt comes
  first, marked "replaces the system prompt", because it is the prompt the rest is added to. The
  context files follow in the order pi layers them (global, then ancestors, then the folder),
  with no role. The APPEND_SYSTEM.md sources come last, in the order they are appended, each
  marked "appended to the system prompt". The role is muted caption text after the path, not a
  chip.
- **The row.** The path with the home folder written `~` (the full path when it isn't under home,
  or before home is known), on one line and cut with an ellipsis when it doesn't fit. The full
  path is in the row's `title`. Then the role, if any, then its token estimate
  (/setup-card-figures).
- **Where the list comes from.** The same read as Skills (/setup-card-skills): the session's own
  chat when this server holds it, otherwise pi's loader for the folder. Sizes are measured on disk
  when the server reads, never taken from the loader. A file the loader names but Sova can't read
  (gone since, a directory, a permission bit) is left out of the list rather than shown empty.
- **The note.** "Loaded into the prompt." The token sentence joins it exactly when at least one
  row carries a token estimate. This server sends one for every file it lists, so in practice the
  sentence is there whenever there are rows. The note is shown only when there are rows.
- **Empty.** With no rows there is no note, no list and no total, only "No context files. pi loads
  AGENTS.md or CLAUDE.md when a folder has one." The same line stands when every file pi names
  was one Sova couldn't read.
- **A total never counts a file the list doesn't show.** One list makes the rows, this group's
  total and its share of the `System context` line, and a file left out of the list is left out of
  all three. The converse doesn't hold for an off row: it is listed, but in neither total.

## §chat.transcript/setup-card-skills — Setup card: Skills

The skills pi offers this session: what it is **offered**, not what is loaded.

```html
<div class="setup-group">
  <div class="setup-head">
    <h2 class="text-eyebrow setup-label">Skills · 2</h2>
    <span class="setup-total">9.3 KB · 212 lines · ≈2.3k tokens</span>   <!-- omitted at 0 B · 0 lines -->
  </div>
  <p class="setup-note">Offered to this session. A skill loads when it is used. Skills an extension adds aren't listed. Token counts are estimates: 4 characters per token.</p>
  <ul class="setup-list">
    <li class="setup-row" title="/home/user/.pi/agent/skills/pdf/SKILL.md&#10;Read and fill in PDF forms.">
      <span class="setup-name"><span class="setup-path">pdf</span></span>
      <span class="setup-facts">≈1.1k tokens</span>
    </li>
    <li class="setup-row" title="…">…</li>
  </ul>
</div>
```

- **Heading and count.** `Skills · {n}`, where n is the rows listed, off rows included. The total
  beside the label follows Context's rule: it adds up only the rows that are on, and it is left
  out at `0 B · 0 lines`.
- **Offered, not loaded.** The rows that are on are the skills pi lists to the model, in its
  order. A row this session has switched off (/setup-card-toggles) stays listed in its place,
  dimmed like an off Context row, but it is not offered, so the model never sees it. A skill
  loads when it is used, and the note's first two sentences say so. A row's token estimate is its whole
  SKILL.md file, so they are not something the session carries before it uses that skill.
- **The row.** The skill's name, in the mono `.setup-path` face, with no path on screen and no
  role. The `title` holds the SKILL.md's full path, then on a new line its description, trimmed.
  A skill with a blank description or none gets only the path. A SKILL.md Sova can't read is left
  out of the list and its totals.
- **Where the list comes from, and its caveat.** When this server holds the session's chat, the
  list is that chat's own set, extension-added skill paths included. Otherwise (a session this
  server doesn't hold open, such as one a TUI owns) Sova asks pi's own loader for the folder
  without extensions, which can't see a skill path an extension adds. The list is then a lower
  bound, and the note says so: "Skills an extension adds aren't listed."
- **The note.** "Offered to this session. A skill loads when it is used.", then the caveat when
  Sova's loader built the list, then the token sentence (/setup-card-figures) when any row
  carries an estimate.
- **Empty.** With no rows there is no note, no list and no total, only "No skills offered to this
  session." It keeps the caveat ("… Skills an extension adds aren't listed.") when Sova's loader
  built the list, since an empty list from that loader may be missing exactly the skills an
  extension adds. A remote session never reads as one with no skills: it gets the single line in
  place of both groups (/setup-card).

## §chat.transcript/setup-card-repository — Setup card: Repository

The whole repository that contains the session's folder, or the folder on the session's
target. It is read-only git, and nothing fetches. The
heading is `Repository`, with no count and no total.

```html
<div class="setup-group">
  <h2 class="text-eyebrow setup-label">Repository</h2>
  <p class="setup-git">
    …branch icon… <span class="setup-git-head">main</span>
    <span class="setup-sep">·</span>                          <!-- this and the next only with an upstream -->
    <span title="Counted against the upstream as this repository last fetched it. Sova never fetches.">2 ahead origin/main</span>
  </p>
  <p class="setup-git">
    …file icon… <span>2 staged · 3 unstaged · 1 untracked</span>
    <span class="setup-num"><span class="setup-add">+120</span> <span class="setup-del">−40</span></span>   <!-- only when non-zero -->
  </p>
  <ul class="setup-list setup-commits">
    <li class="setup-git setup-commit">…clock icon… <span class="setup-oid">12a9ff6</span>
      <span class="setup-subject" title="spec: the three commits' claims, promoted from their draft">spec: the three commits' claims, promoted from their draft</span>
      <span class="setup-ago">2h ago</span></li>
  </ul>
  <p class="setup-note">…at most one note, when there is one…</p>
</div>
```

- **The head line.** A branch icon, then the head: `{branch}`, or `{branch} · no commits yet` in
  an unborn repository, or `Detached at {7-character oid}` (`Detached` when git named no commit).
  Only when the branch tracks an upstream does a `·` follow, then `Level with {upstream}`,
  `{a} ahead, {b} behind {upstream}` (only the sides that aren't zero), or `{upstream} is gone`
  when that ref no longer exists locally. "Level with", not "up to date": the count is against
  the upstream ref as this repository last saw it, and the words' `title` says "Counted against
  the upstream as this repository last fetched it. Sova never fetches." A branch with no upstream
  shows nothing after the head.
- **The changes line.** A file icon, then `Clean`, or the tallies that aren't zero, joined by `·`,
  in the order conflicted, staged, unstaged, untracked. A path with both staged and unstaged
  changes counts in both, so the tallies can add up to more paths than changed. An untracked
  folder that git collapsed counts once. Then `+{added} −{removed}` (U+2212, add and delete ink),
  only when either is above zero. That is the worktree against HEAD (against the empty tree
  before the first commit), staged and unstaged together, summed over every path git counted.
  Untracked and binary files count no lines. The card lists no changed paths.
- **Commits.** Up to three rows, newest first (/setup-card-figures). An unborn repository shows
  none and no line in their place, since the head already says "no commits yet". Any other
  repository with none to show gets "The last commits couldn't be read." in their place.
- **A cut status.** When git status's output hit its size cap, every count is a lower bound. The
  changes line reads `At least {tallies}`, or `Not fully read` when nothing was tallied, and
  never `Clean`. The note says "Git status was cut short, so these counts are lower bounds."
  unless a line-count note takes the slot. Only a whole status can say a repository is unborn:
  with a cut status, an unborn repository's head shows the branch name alone, and since git log
  has nothing to read, the commits' place says "The last commits couldn't be read."
- **The note**, at most one, after the commits. When git couldn't count every tracked path, the
  line-count note is one of: "Line counts stopped at the size limit. Paths past it say "not
  counted"." · "Counting lines took too long in this repository. Rows say "not counted"." ·
  "Git couldn't count lines here. Rows say "not counted"." Then the `±` sums only the paths
  counted, and it is absent when none were. The line-count note wins the slot over the
  cut-status note, and a cut status is still marked by the changes line's "At least". These are
  the repository's shared sentences, and the per-path "not counted" rows they name aren't on this
  card.
- **Not a repository.** One line: "{folder} isn't inside a git repository.", the folder written
  `~/…` here or `{target}:{path}` on a target.
- **Unavailable.** One line, the server's own sentence, for example "Git isn't installed on this
  machine.", "Git took longer than 12s in this folder. Nothing was changed.", "{target} didn't
  answer: {error}." or "This session's folder no longer exists: {cwd}." A failure is never cached,
  so the next card to appear reads again.
- **The group's two error lines.** The request itself failing reads "Couldn't read this session's
  repository. {message}" (/setup-card). Git failing on the far side of a request that did answer
  reads as the unavailable line. Each stands alone in the group, with no head line, changes line
  or commits.

## §chat.transcript/setup-card-figures — Setup card: the commit log and the token figures

A new session's setup card lists the context files pi loads, the skills it offers, and the
repository around the folder. Two of its figures:

- **Repository: the last three commits**, newest first, from `git log -3` in the same read that
  answers the rest of the group. Each row is `{short oid} {subject} {relative age}` in one line —
  the raw subject as git wrote it, never relabelled, cut at 300 characters by the server
  (`SUBJECT_MAX`), cut with an ellipsis at its end when the card is narrow (the full text is the
  row's title), and the age relative to now in the app's own words ("2h ago", "yesterday", "3d
  ago", and past seven days a date like "Mar 4"). Fewer than three when the repository has fewer
  commits. An unborn repository lists none and adds no note: the head line already reads "no
  commits yet". A log the byte cap cut still lists the commits that arrived whole. Only a failed
  read says so in words ("The last commits couldn't be read.") instead of showing an empty list. The
  read is capped at three because this is a glance at where the folder stands, not a log viewer.
- **Every loadout figure carries an estimated token count**, in the app's one token formatter
  (§chat/context-window: `812 · 8.4k · 237k · 1M`). A Context or Skills row shows only that
  estimate (`≈530 tokens`), with no size and no lines, neither on screen nor in a tooltip; the
  section totals and the `System context` line keep `31 KB · 475 lines · ≈8.1k tokens`, the
  token figure last in both, so it reads as one column. The estimate is pi's own —
  `ceil(characters ÷ CHARS_PER_TOKEN)`, `pi-ai`'s `estimateTextTokens`, never a tokenizer (characters
  are the decoded text's JS string length, UTF-16 code units, the same count pi makes) — so the
  card says what a file costs before it is sent, marked `≈` because a model's real count differs,
  and the note under each section says what the mark means: "Token counts are estimates: 4
  characters per token." That note appears **exactly when the section shows token figures**, and a
  figure that isn't there is dropped rather than zeroed: a row the server sent no estimate for shows
  no figure at all (never its size, never `≈0 tokens` for a file nobody counted), and a total
  without estimates keeps bytes and lines.

## §chat.transcript/setup-card-toggles — Setup card: switching context files and skills off

On an ordinary session this server hosts, before its first message, every context file row and
every skill row of the setup card (/setup-card-context, /setup-card-skills) carries an on/off
switch. A switch that is off keeps that file out of this session's prompt, or that skill out of the
skills it is offered, for this one session only.

```html
<li class="setup-row setup-row-off" title="/home/user/.pi/agent/AGENTS.md">
  <span class="setup-name"><span class="setup-path">~/.pi/agent/AGENTS.md</span></span>
  <span class="setup-facts">≈530 tokens</span>
  <label class="toggle toggle-switch setup-toggle">
    <input type="checkbox" aria-label="Load ~/.pi/agent/AGENTS.md" />   <!-- unchecked: off -->
    <span class="toggle-box" />
  </label>
</li>
```

- **Which rows switch.** Every context file pi lists, the global `~/.pi/agent/AGENTS.md` (or
  `CLAUDE.md`) included, and every skill. A SYSTEM.md that replaces the prompt and the
  APPEND_SYSTEM.md sources get no switch: they are always loaded.
- **When.** Exactly the Profile pick's window (§chat.profiles/picker, /applying): the switches show
  only while the session is before its first message, the server holds its chat, the session is
  local, ordinary (not the Overseer, a project overseer, baton, organization or worker session)
  and not open in a terminal. Otherwise the card is as before, with no switches, though a row
  this session keeps off still reads off (except while a terminal has it open, since the TUI
  loads every row).
- **On by default, every time.** Each new session starts with every row on. Nothing is
  remembered between sessions, per folder or globally: the choice lives in the session alone.
- **A flip applies at once.** The card sends the session's whole off set
  (`POST /api/sessions/loadout {path, offContext, offSkills}`), and while it applies every switch
  is disabled. The server writes a hidden `custom` entry `customType: "sova-loadout"`, data
  `{v: 1, offContext: [absolute paths], offSkills: [skill names]}`, newest on the branch wins, then
  rebuilds the session's runtime the way a profile pick does: open tabs get `reloaded` and
  reconnect, keeping the draft. The answer is the card's new loadout, which it draws in place. A
  refusal (409: "Context files and skills are fixed once a message is sent.", mid-turn, open in a
  terminal, a foreign writer, a special session) changes nothing and is shown as a toast. A set
  equal to the one the session already has writes nothing and rebuilds nothing.
- **The entry.** It records exclusions only, never context: no file text, no skill text. It draws
  no transcript row, so writing it keeps the empty state and the session still counts as before
  its first message. It is never LLM context and the TUI ignores it.
- **What it changes.** The runtime is built with pi's loader overrides (`agentsFilesOverride`,
  `skillsOverride`), so an off file is absent from the system prompt, and an off skill is absent
  from the skills list in the prompt, from `/skill:` expansion and from the composer's slash list.
  The skill filter also covers skills an extension adds. A context file or skill named in the entry
  that no longer exists is ignored. Sova-hosted runtimes honour it for every model, pi's and Claude
  Code's alike (the Claude Code provider sends pi's own system prompt). Re-opening the session,
  and restarting the server, rebuild the runtime from the same entry, so the choice holds.
- **What it does not change.** A TUI that opens the session, and any worker the session spawns,
  load their own context files and skills: they do not read this entry. A remote session's card
  has no rows, so it has no switches.
- **Off rows and the totals.** A row that is off stays listed, dimmed, with its switch off. The
  Context and Skills headings still count every row listed, but each group's total and the
  `System context` line add up only the rows that are on, so they say what this session loads and
  is offered.
- **The card's read.** Rows come from the runtime's unfiltered lists, so an off row can be switched
  back on. The folder's cached read is shared as before; whether each row is off, and whether the
  switches show, is worked out for each session on every read.
- **Accessibility.** Each switch is a checkbox labelled "Load {path}" (the path as the row shows
  it) for a file and "Offer {name}" for a skill, checked when on, reachable by keyboard.

## §chat.transcript/empty-worktrees — The worktrees line under a new session

A new session's empty state (the "Empty (new session)" row of States, above) ends, below its
footnote and outside the setup card, with one muted line about the git worktrees of the
repository its folder is in, and a button that removes the merged ones (§chat.worktrees/cleanup).
Its words are the [copy deck](../design/copy-deck.md)'s §design.copy-deck/worktree-cleanup rows.

- **When it shows.** For a local folder inside a git repository with at least one linked
  worktree in git's list. A remote session, a folder outside a repository, a repository with no
  linked worktree, and a read that fails show nothing. Never in the Overseer's empty state.
- **The line.** "{total} worktrees · {merged} merged", with " · {empty} empty" when there are
  empty leftovers (a branch with no commit of its own). The counts are §chat.worktrees/cleanup's:
  every linked worktree in git's list, wherever its folder is.
- **Read once.** It reads when the empty state appears (`GET /api/worktrees/summary`), and again
  only after a removal, or when asked about a different session. Nothing polls: no timer. An
  answer for a session it no longer shows is dropped. It never holds up the setup card, and the
  card never waits for it.
- **The button.** `Clean Up Merged`, outlined and destructive, after the line, only when merged
  plus empty is above 0. A press first asks for a dry run, and the button says it is checking
  while that runs. The dry run's answer opens a confirm dialog: what goes (each folder in mono,
  with its branch, and whether that branch is deleted or kept), then what stays, each with its
  reason. Its confirm button names the count; with nothing removable the dialog says so and only
  closes. Focus starts on Cancel.
- **Confirming** posts exactly the dry run's paths as `expect`, so a tree that changed after the
  preview is kept with its new reason, never removed. The result is said in a toast and to screen
  readers: removed {n}, kept {k}, with the kept trees' reasons in the dialog's place until it
  closes. Then the line reads again.
- **Accessibility.** The line is a `p` in the empty state; the button is a real `button` with its
  words as its name; the dialog is an `alertdialog` that traps focus and returns it to the button.

## §chat.transcript/tokens — Tokens

- **Page and head.** Page `--color-bg`. Head `--color-surface` with bottom border `--color-border`.
- **Messages.**
  - Assistant bubble: `--color-surface` with `--color-border`, and `--r-lg`.
  - User bubble: `--color-accent-tint`, with no border.
  - Text: `--color-ink`.
  - Head: `--fs-caption` in `--color-ink-muted`. Author: `--fw-semibold` in `--color-ink`. Time:
    `--font-mono`.
- **Thinking.** Summary `--fs-caption` in `--color-ink-muted`. Label `--fw-medium` in
  `--color-ink-2`. Body `--color-ink-2` on its inset `--color-sunken` panel, with no left rule.
  No open disclosure body or report body draws a left rule; its content keeps its left inset.
- **Tool card.** `--color-sunken`, `--r-lg`, and `--font-mono` / `--fs-mono`. Name `--fw-semibold`
  in `--color-ink`; arg `--color-ink-muted`. `pre` sits on `--color-surface` with `--r-sm`.
  Section labels use eyebrow styling (`--fs-micro`, `--ls-eyebrow`).
- **Work timeline** (§chat.transcript/work-chain) is the one place the tool card's ground and the
  thread's gap do NOT apply: a step's line draws on the page (`background: none`), with no border
  and no rounding, and its line is `--fs-mono` (a thinking step too, at `--fs-caption`) — the tool
  icon goes, the twist stays. A step's status is the chip's word and dot without the chip: no
  border, no ground, `--fs-micro`, `--color-ink-muted` (`--status-error` for a failure,
  `--color-accent` for a live one). The run's fold mark is `--color-ink-muted` (`--color-ink` under
  the pointer, the focus ring on keyboard focus) on the page, and the folded run's line is
  `--fs-caption` `--color-ink-2`.
- **Tool card file content.** `write` content and each `edit` show as a diff
  (§chat.changes/tool-card-diff, drawn per §chat.changes/diff-renderer). `read` output is
  highlighted by file path (never auto-detected) in `pre.toolcard-code`: back on
  `--color-sunken`, where the syntax colors were checked, with `--color-ink` and no wrapping.
  Unknown extensions, errors, and args still streaming stay plain.
- **Info row.** `--fs-caption` in `--color-ink-muted`, with rules in `--color-border`.
- **Banners.**
  - Info: `--status-info-bg` with a `--status-info` icon.
  - Warn: `--status-warn-bg` with a `--status-warn` icon.
  - Error: `--status-error-bg` with a `--status-error` icon.
  - Title text is `--color-ink`; body is `--color-ink-2`.
- **Spacing.** Thread gap `--space-4`. Inner padding `--space-4` / `--space-6`. A work timeline's
  steps sit `--space-2` apart instead, on a `--space-5` line, with the rail closing over that gap.

## §chat.transcript/accessibility — Accessibility

- **The transcript isn't `role="log"`.** Streaming deltas would flood the announcements. It's a
  labelled `section`. A single visually-hidden `role="status"` region announces turn boundaries:
  - "Working." at the start of a turn.
  - "Reply finished." at the end.
  - "The turn stopped with an error." when a turn ends in an error — the banner's own title, said
    once per error (a reconnect loop's repeat of the same failure announces nothing), and instead
    of that turn's "Reply finished.": an errored turn still settles, and two endings would read
    as two turns.
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
  | Ink-2 on the page (a timeline step's line) | 7.81 | 8.44 |
  | Muted on the page (a step's arg, its status word) | 5.15 | 5.96 |
  | Muted on sunken | 5.40 | 4.75 |
  | Ink on info-bg | 11.07 | 15.57 |
  | Ink-2 on info-bg | 6.30 | 7.60 |
  | Info icon on info-bg | 5.33 | 5.55 |
  | Ink-2 on error-bg | 6.48 | 7.49 |
  | Error on error-bg | 5.01 | 5.16 |
  | Ink-2 on warn-bg | 6.02 | 7.78 |
  | Success on surface (chips) | 6.61 | 6.09 |
  | Error on surface (chips) | 5.42 | 6.01 |

## §chat.transcript/work-chain — The working renders as one timeline

A run of consecutive working rows — a thinking row, a plain tool call, an orphan result, whether
there is one of them or twenty — draws as a single timeline: one bare hairline rail in
`--color-border`, one line per step of `--timeline-row` (`--space-5`, 24px: the summary's
`min-height` and each rail segment's height) with `--timeline-gap` (`--space-2`) of air between two
steps, and no card behind any step summary — no fill, no border, no rounding, and no head line above
them. Expanded thinking content alone uses the inset, italic, subtly shaded quote-like block
specified in the transcript items; it adds no border or rail. The timeline is indented `--space-5` with the rail drawn inside that gutter: it runs from the
run's first line to its last, and reaches half the gap past its own row at each end so the air
between two steps never breaks the line.

**The rail carries one mark: the run's own.** No dot per step: a circle beside every chevron was two
marks before every line of text. Instead the rail holds the run's fold control, on the run's first
line and nothing else — a caret button pointing down while the run is open and right while it is
folded, named for what it does to the run ("Collapse these 6 steps"). A step's own disclosure stays
what it always was: its twist, whose whole row opens it, by click or by keyboard. So the reader has
one control per RUN on the rail and one control per STEP on the row, and neither is decoration.

Folded, the run draws as that one line: the caret and a count — `{n} steps`, and `· {m} failed` when
any step failed — in `--fs-caption` `--color-ink-2`, and no rail, no rows. Clicking the caret, or
that line, opens the run again. A run of one step has nothing to fold and draws no control.

The type is the mono step: a step's line is `--fs-mono` (its name `--fw-semibold`
in `--color-ink`, its argument `--color-ink-muted`), and its status is the chip's word and dot
without the chip — `--color-ink-muted`, `--status-error` for a failure, `--color-accent` for a live
one — so no status is carried by hue alone. A thinking step keeps `--fs-caption` and its preview,
being prose rather than a machine fact. A step keeps its twist and drops the tool's icon, and it
opens the way every other disclosure does: click the row, or reach it by keyboard. It keeps its
whole row as the target, and its Arguments and Output.

The timeline breaks at anything that is the message rather than the working — a user or assistant
message, a report, a card tool (`sova_card`, `sova_confirm`, `sova_link`, `sova_unlink`, `align`,
`session_send`, `sova_create_session`, or `show_changes` with valid successful details),
a compaction, a topic, a wake, a worktree merge — so a card tool is never swallowed into a step.
No step summary draws as a card; the expanded thinking aside is the only subtly shaded content.

A row that draws nothing is TRANSPARENT to the timeline: it is not a step and it never breaks a
run, so consecutive visible working rows join up across it with no gap. That is a tool result whose
call is in the list, a streaming block the session hides, and an empty streaming text block. Hidden
rows of a settled transcript are filtered out before the runs are cut, so they are not steps either,
and a streaming assistant-entry boundary is not a row at all: it does not break a run, where a
visible user, text or card row and a stop notice or an error do.

---

## §chat.transcript/open-questions — Open questions

- **Long info rows.** A multi-line custom entry renders as a centered `.info-row` between rules,
  which reads badly. A likely fix is left-aligned and rule-less beyond 1 line, or clamped at 3
  lines behind a disclosure. It's not specced yet and is out of the current brief.

---

