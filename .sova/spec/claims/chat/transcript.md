# §chat/transcript — 03 · Transcript (main pane)
> Part of the Sova design spec · [overview](../design/overview.md)

## §chat.transcript/anatomy — Anatomy

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

## §chat.transcript/transcript-items — Transcript items (by `TranscriptItem.kind`)

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
- **Arg slot.** The parsed reason (`WakeInfo.reason`), muted, truncated with an ellipsis, full text
  in `title`. Empty when the extension wrote `Reason: (none)`.
- **Fired time.** Muted, `fired {HH:MM}` from the entry's own timestamp, same clock as every other
  row. `· {late} late` only when the fire was overdue (the extension's "Overdue by …" line);
  omitted for an on-time fire.
- **Open.** The whole message exactly as it was sent — all four lines (the fire line, the optional
  overdue line, the reason line, the standing instruction) — in mono, never rewritten or hidden.
- **Counts as an input.** A wake row is on every list that counts "your messages": the composer's
  "N inputs" trigger, the Timeline's Inputs Only view (where it shows the reason, or "Wake nudge
  n1" with none — §13), rewind targets, and the "calls after the last user message" scan that
  decides whether an open tool call may still be running. Only its rendering differs from an
  ordinary user row.
- **Never hidden, never titles the session.** "Hide tool calls" leaves wake rows alone, and a wake
  row never joins a hidden-tool-call group (it isn't a tool row). The session list never titles a
  session from a wake message — it waits for the next real one.
- **AT.** No author line, and the accessible name never says "You": the native `<summary>`'s own
  text ("Wake nudge n1 …") is what's announced.

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
- **What each role offers.** Your message: `Copy` · `Fork` · `Rewind`. A reply: `Copy` · `Fork` ·
  `Regenerate`. The safe actions come first and the one that changes the branch is last. Copy is
  absent — not disabled — when there is no text to copy (an images-only message): a Copy that
  copies nothing would claim to have copied the message.
- **Quiet until the message is asked about, and every input can ask.** The strip is hidden with
  `opacity` alone — always in the DOM, always in the accessibility tree, always tabbable, and its
  height is always reserved, so a message never moves when a strip appears or leaves. A mouse
  reveals it by being anywhere over the message region, the whole row and not just the bubble; a
  keyboard reveals it by focusing into it (`:focus-within`, reached by Tab while it is invisible);
  touch reveals it by a TAP on the message, which stays until a tap lands on another message or
  outside every one. A hidden strip takes no pointer (`pointer-events: none`), and that is what
  makes the first tap safe: it is hit-tested against the row, so it can never fire an action
  nobody could see. Hover is scoped to a fine pointer, because a coarse one leaves `:hover` stuck
  on the last thing tapped. A press that travelled is a scroll, not a tap, and reveals nothing.
  Three states hold the strip open regardless of the pointer: an armed confirm, Copy's check, and
  a refusal the row is keeping. Revealed, hover and focus still deepen the ink
  (`--color-ink-muted` → `--color-ink-2`); quiet is a semantic colour at full opacity, never alpha —
  muted measures 4.7:1 or better on every surface a message sits on, in both themes, where a 0.6
  alpha measured 2.4:1 and failed the 3:1 a glyph needs. Each button is 44px wide and reaches 44px
  tall through an `::after` extension, so the visual row stays 36px and messages keep their
  rhythm; the boxes never overlap (44 wide with the strip's own gap between them).
- **Copy.** Your message: its text as sent, with pi's clipboard paths already stripped. A reply:
  all of that entry's text blocks joined by a blank line — markdown source, never thinking or tool
  output. Available in watch mode too: the text is on screen, and nothing owns the clipboard. The
  icon flips to a check for 1.5s and the toast says "Copied message."
- **Rewind** (your messages) moves the branch to just before that message and hands its text back
  to the composer — the same request the Timeline's input rows make (§13), with the same refusals.
  **Regenerate** (replies) walks back to the user message that started the turn, rewinds there and
  re-sends that message's own stored text and images with the session's CURRENT model, so
  switch-model-then-regenerate compares. The whole turn re-runs, tools included, and the composer
  draft is not touched. The confirm names the message that started this REPLY — never "this turn" —
  because the server rewinds to the nearest user message and moves the leaf to ITS PARENT, and a
  MID-TURN STEER is a user message: in `u1 → a1 → tool → s1 → a2`, regenerating a2 resolves to the
  steer, so s1 and a2 leave while u1, a1 and the tool call stay; regenerating a1 resolves to u1 and
  takes a1, the tool call, s1 and a2 with it. A reply that answered a scheduled WAKE nudge has no
  message of yours to send again, so Regenerate is off there with that as its reason — permanently,
  since no amount of waiting turns a nudge into something you sent.
- **Both confirm inline, in place.** The first press arms: the strip becomes the sentence plus
  `Rewind Here` / `Regenerate Here` and `Cancel`. Focus follows into the confirm and back to the
  button that armed it on Cancel or Esc. The sentence says what survives as well as what goes:
  "This message and every reply after it leave the branch. The session file keeps them."
- **Fork** makes a new session from this branch: at a message of yours, the branch through its
  parent with that message (text and COPIES of its images) staged in the new session's composer, unsent
  (pi's `/fork`); at a reply, everything through it (pi's `/clone`). The new session opens; this
  one is unchanged. **Images are counted, never quietly left behind.** Files that still exist are
  staged by path; images the server could only return as BYTES (a /tmp file cleaned up months ago)
  are uploaded into the new session's own attachments. **Every image is copied; no path is ever
  borrowed.** A draft chip's Remove deletes by path, and the server allows deleting anything under
  the attachments root, so a child holding the SOURCE's path could delete the picture out of the
  message it was forked from — silent, permanent loss in the original session. The draft's text is
  rewritten to name the copies, and a name it couldn't copy is removed from the text rather than
  left pointing at a file the child doesn't own. A duplicate between the two channels is dropped
  only when the copied CONTENT proves it is one; one that
  can do neither is counted in the sentence ("…, with 1 of 2 images. The other 1 couldn't come
  along.") — counted, never explained, because `available: false` covers a deleted file, a path
  this server won't read and an upload over the size cap alike. When a readable path and stored
  bytes are both present the FILE wins, so one picture never lands in the draft twice. An
  unavailable path is never staged as a draft attachment — a draft attachment carries no
  availability, so it would look fine in the composer and fail at send.
- **Some refusals are only the server's to make.** A steer awaits the extension input handlers
  before it is queued, so a message can still be on its way out after the turn it meant to
  interrupt has ended: `isStreaming` is false and the pane looks idle, yet a rewind there would
  deliver that message into the branch it rewound TO. The server refuses with `queued`, and the
  strip shows the server's sentence. The client's own checks stay a fast path and never try to
  guess this state.
- **A blocked action keeps its reason.** `aria-disabled` with the reason as `title`, never hidden:
  "Stop the current turn first.", "Wait for the compaction to finish.", "This session is open in a
  terminal, so Sova won't write to it.", "Only a chat open in Sova can rewind." (watch mode),
  "A rewind is already in progress." Fork is blocked by what would stop it READING the file (a
  terminal, a turn in flight, a compaction), not by anything that only stops writing — a model
  switch or an archived pane leaves it available.
- **A refusal stays on the row.** The chat announces it once; the strip keeps the sentence under
  the message it was about (`.message-actions-refusal`), so looking away doesn't lose it. The
  server is the authority: the client's own checks are a fast path, and every refusal it sends is
  rendered as-is rather than pre-empted.
- **A live reply has no strip until it lands.** Streaming rows carry no entry ids, so nothing on
  them could be copied, forked or regenerated by id; the resync after `agent_settled` replaces
  them with canonical rows and the strip appears then. A disabled action that could never enable
  itself is not drawn at all.

## §chat.transcript/a-queued-message — A queued message (spec §4 sending)

A message of yours that hasn't been delivered says which state it is in, with a dot and the word:
`Sending…` while nothing is known to hold it, `Queued` once the server says it does. Only a queued
row carries an action — one `Remove this queued message` — and it is removed BY ITS ID, so a
duplicate in the middle of three goes and its twins stay, and an images-only message is a row like
any other. A delivered row never draws one: nothing can be recalled then. A queued row is not an
`.entry`, so it wraps itself in a `display: contents` host that gives its Remove the same hover
and tap region every other strip has.

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
- **failed** — the hand-off was refused (a terminal took the file, a foreign writer, the model
  turned off in Settings); the row goes and the text comes back where it was typed.
- **dropped** — an extension `input` handler handled the message instead of queueing it (the
  model-policy extension does exactly this), so **no `message_start` will ever arrive**. Without
  this signal the row would sit on "Sending…" for the life of the pane over text the user has
  lost: the row goes and the text comes back.

A removal the server refuses because the agent already took the message says "Already sent. It
can't be removed now.", and the row becomes the delivered message it turned out to be.

## §chat.transcript/streaming — Streaming (chat sessions)

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
- **A turn that errors** (`type:"error"`, not a refusal) announces "The turn stopped with an
  error." — the banner's own title, so the failure is heard wherever the banner isn't being read:
  in a workspace a failed member looks exactly like a quiet one until you pan its pane, and the
  announcement is the one signal that crosses panes (§14's pane-prefixed member form, "{pane
  name} — stopped with an error."). Once per error: the same failure re-reported on a reconnect
  loop says nothing, because each announcement would read as another error. It replaces that
  turn's "Reply finished." (Accessibility, below): the error is the ending.
- **Performance.** Batch deltas per animation frame. Never re-render the whole thread on each
  delta.

## §chat.transcript/live-watch — Live-watch (TUI-owned sessions, `/ws/watch`)

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

## §chat.transcript/landing-page — Landing page (`#/`)

With no session selected the main pane is not an empty state with a grid bolted on — it is one
page with two parts, in this order:

1. **The opening**, unchanged except for its actions: `.welcome-head` wrapping the `.empty` block
   that has always been here — the `chat` mark, "{n} sessions across {m} folders.", "Pick one to
   read it, or start a new one.", and two buttons in one `.empty-action` cluster: `New Session`
   and `Fan Out…` (§14b "Entry points" — the empty screen is fanout's front door, which is a
   creation gesture offered beside the other creation gesture, not in the sidebar). It is the
   first thing read at every width.
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
  window with one history entry, so its back button couldn't return to Sova; navigating in place
  keeps Back working. `/explain/:id` is still a standalone document, so a direct link opens it
  on its own. There is no external-arrow icon and no "opens in a new tab" suffix on a tile.

## §chat.transcript/states — States

| State | What renders |
|---|---|
| No session selected (unfolded) | The landing page below, not a bare `.empty`: `.welcome` fills `.app-main`, its `.welcome-head` holds the `.empty` opening (`chat` icon in `.empty-mark`, title "48 sessions across 7 folders.", body "Pick one to read it, or start a new one.", an `.empty-action` cluster with `New Session` and `Fan Out…`), and the Explained grid follows when there is one. No composer |
| Loading transcript (after 300ms) | Three placeholder messages in `.thread`: a right-aligned `.skeleton` 40% × 44px, then a left `.skeleton-title` plus 3 `.skeleton-line` at 92/78/60%, then a `.skeleton-row` at 60% width. Put `aria-busy="true"` on the `section`. The head renders straight away from the `SessionSummary` |
| Error | `.banner.banner-error` in `.transcript-inner`. Title: "Couldn't load this transcript." Body: "The file at `{path}` wasn't changed. {server message}." Action: `Retry` |
| Empty (new session) | `.empty`. Title: "New session in `~/webapps/pi-web`." Body: "Nothing sent yet. Your first message becomes its title." No action; focus the composer instead. Show it only while the thread has **zero rows**, counting local rows such as "Ran `/cmd`" (§4d) and model-change info rows. Once any row exists, the thread renders normally with no empty state |
| Agent/server error (`type:"error"`, not busy) | `.banner.banner-error` placed as the last item of the thread (in flow, so it stays in the record). Title: "The turn stopped with an error." Body: "{message}. Your messages are kept. Send again to retry." |

## §chat.transcript/tokens — Tokens

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
  | Muted on sunken | 5.40 | 4.75 |
  | Ink on info-bg | 11.07 | 15.57 |
  | Ink-2 on info-bg | 6.30 | 7.60 |
  | Info icon on info-bg | 5.33 | 5.55 |
  | Ink-2 on error-bg | 6.48 | 7.49 |
  | Error on error-bg | 5.01 | 5.16 |
  | Ink-2 on warn-bg | 6.02 | 7.78 |
  | Success on surface (chips) | 6.61 | 6.09 |
  | Error on surface (chips) | 5.42 | 6.01 |

## §chat.transcript/open-questions — Open questions

- **Long info rows.** A multi-line custom entry renders as a centered `.info-row` between rules,
  which reads badly. A likely fix is left-aligned and rule-less beyond 1 line, or clamped at 3
  lines behind a disclosure. It's not specced yet and is out of the current brief.

---

