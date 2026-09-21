# 13 · Timeline tab
> Part of the pi-web design spec · [overview](overview.md)

The session pane (§11) gets a **Timeline** tab, beside Inputs: the whole session on one time
axis. The outline's topics are chapter markers, each message you sent is a row, and what the
agent did between two of your messages is a single line of counts under the row it belongs to —
"3 replies · 14 tools · 6m". Notable moments (a compaction, a rewind, a subagent spawning or
retiring, a model, thinking or mode change) get their own marker rows, and a stretch with
nothing in it gets a dotless "idle 38m".

It answers a question neither the transcript nor Inputs answers: *what shape did this session
have?* The transcript is every row in order, and Inputs is your own messages with a verb on
each. The timeline is the session at arm's length — where the topics turned, where the long
gaps were, where the model changed under you.

**It is read-only.** Every row jumps to its message in the transcript, and nothing else.
Inputs stays the pane's only writing surface, for the reason it gives itself
([12-inputs-tab.md](12-inputs-tab.md) §12, "it's the one place in the pane that writes"): a
surface that reads and a surface that acts are easier to trust apart than together, and a
destructive button on an overview row would be reachable by a user who is browsing, not
deciding.

## Opening it

- **The tab strip**, like any tab. The pane keeps the tab per session path.
- **The outline strip's `Open Timeline`** (§10), a ghost button in `.outline-body` beside
  `Open {n} Explanations`. The strip is where someone is already reading the session's chapters;
  the timeline is those chapters with everything else drawn in between them.
- **A bare `/timeline` in the composer**, mirroring `/tree` (§12). It opens the pane on Timeline,
  **opens and never toggles shut**, clears the draft, and announces "Timeline open." `/timeline`
  with arguments falls through to a normal send. The runtime doesn't register it, so it isn't in
  the command menu — it is a shortcut for someone who already knows the tab, not a way to find it
  (§4d "Local commands").

**No chip in the `.run-status` row.** That row already carries two (§11 subagents, §12 inputs),
it is one line in a chat, and a third control competing for it would cost the composer more than
the tab is worth. This is about the row and its chips only: `/timeline` is a different door —
typed, costing no pixels, and gone the moment it runs — and it does not spend the composer's one
line. The timeline is a place you go to look back, not a thing that becomes true mid-turn, so it
earns a command and not a standing control.

## Rows

```html
<p class="timeline-state">Updated 3m ago · behind the latest messages</p>
<ol class="timeline" aria-label="Session timeline">
  <li class="timeline-row" data-kind="chapter">
    <span class="timeline-time" title="2026-09-19T14:06:11Z · 2d ago">14:06</span>
    <span class="timeline-dot" aria-hidden="true"></span>
    <button type="button" class="timeline-body">
      <span class="visually-hidden">Jump to this message: </span>
      <span class="timeline-chapter"><span class="outline-hash">#</span>Model selection and limits</span>
    </button>
  </li>
  <li class="timeline-row" data-kind="input">
    <span class="timeline-time" title="2026-09-19T14:08:02Z · 2d ago">14:08</span>
    <span class="timeline-dot" aria-hidden="true"></span>
    <button type="button" class="timeline-body">
      <span class="visually-hidden">Jump to this message: </span>
      <span class="timeline-title">can you check why the watcher restarts on every save</span>
    </button>
  </li>
  <li class="timeline-row" data-kind="density">
    <span class="timeline-meta">3 replies · 14 tools · 6m</span>
  </li>
  <li class="timeline-row" data-kind="gap">
    <span class="timeline-gap">idle 38m</span>
  </li>
  <li class="timeline-row" data-kind="marker">
    <span class="timeline-time" title="2026-09-19T14:58:40Z · 2d ago">14:58</span>
    <span class="timeline-dot" aria-hidden="true"></span>
    <button type="button" class="timeline-body">
      <span class="visually-hidden">Jump to this message: </span>
      <span class="timeline-title">Compacted · 67,401 tokens summarized</span>
    </button>
  </li>
</ol>
<p class="usage-note text-muted">Oldest first, active branch only. A row jumps to its message.</p>
```

`ol`, not `ul`: the order is the point. Every row is `li.timeline-row` with a `data-kind`, and
the kinds are the whole vocabulary — `input`, `chapter`, `marker`, `density`, `gap`.

| Kind | What it is | Dot | Clock | Jumps |
|---|---|---|---|---|
| `input` | One message you sent, clamped to two lines (`.timeline-title`, full text in `title`) | Solid, muted | Yes | Its own message |
| `chapter` | An outline topic, at its anchored message's time (`.timeline-chapter`, one line, ellipsized; `.outline-hash` for a `manual` topic) | Hollow, larger | Yes | The anchored message |
| `marker` | A notable moment, in regular weight ink-2 | Hollow, small | Yes | The entry it happened on |
| `density` | What the agent did after the input above it | — | — | — |
| `gap` | A stretch over the idle threshold | — | — | — |

**Oldest first**, unlike Inputs. Inputs is reversed because the message someone wants to take
back is nearly always the last one they sent; here the reading is the session's own direction,
and a chapter that comes after another has to be below it or the word "after" stops meaning
anything. The list opens at the top, and a session in progress is read by scrolling down.

### Fixed rhythm, stated idle

**Rows do not scale with time.** A row is a row: the same height whether it followed the last
one by 4 seconds or by 4 hours. Idle time is *said* — "idle 38m" — never drawn.

Proportional spacing was the first cut and it is the wrong tool here. A session is minutes of
work separated by hours of nothing, so honest proportions give you a screen of whitespace with
four rows glued to the top, and the rows you want to read are the ones proportion squashes. A
fixed rhythm is also the only version that stays readable in a 520px pane, where the axis is a
column and not a canvas. The gap line keeps the information the spacing would have carried, in
a form you can read out loud.

The threshold is a minute count, not a fraction of the session, so the same wall-clock silence
always reads the same way. It reuses the duration formatter (`duration()` in
`src/lib/format.ts`, "40s" · "42m" · "2h 17m" · "3d 4h"), so an idle line and a density line
speak the same language.

### Density, not rows

**Assistant turns and tool bursts never get a row each.** They fold into one `density` line
under the input that caused them: `{n} replies · {n} tools · {duration}`, each clause dropped at
zero, the whole row dropped when all three are.

A row per assistant block would be a second transcript — and the transcript
([03-transcript.md](03-transcript.md) §3) already renders every row, unwindowed, one scroll
away. Two renderings of the same thing is how they drift. Counts are also what the question
actually wants: "that one took fourteen tool calls" is a shape; the fourteen cards are detail,
and the jump is right there when you want them.

### Chapters, and whose clock they use

A chapter's time is **the anchored message's**, not the summarizer's. The summary was written
whenever the summarizer happened to run — often minutes or hours after the conversation it
describes, sometimes in a batch with five others — so placing a topic at the summary's time puts
it in the wrong part of its own session. The outline strip can afford that (§10: its
`.outline-topic-time` *is* the summary's own time, and it sits in a list that never claims to be
an axis); an axis can't.

**When the anchor can't be resolved, the row says so.** The anchor is compacted off the branch,
or the entry id is null, and there is no message left to take a time from. The row falls back to
the summary's own time and is flagged: `.timeline-row-flagged`, the clock dimmed
(`.timeline-time-flagged`), and the title says it out loud — "summary time" after the topic, in
`.timeline-meta`. The row keeps its place in the order the fallback time gives it, which may be
wrong; the flag is what stops that from being a lie. Dropping the chapter instead was rejected:
a topic missing from an outline you can see in the strip above reads as a bug.

### Markers

One row each, all of them jumping to the entry they happened on:

| Marker | Copy |
|---|---|
| Compaction | `Compacted · {n} tokens summarized` |
| Rewind | `Rewound to an earlier message` |
| Subagent spawned | `{name} started` |
| Subagent retired | `{name} finished` (`{name} stopped` when it errored or was killed) |
| Model change | `Model → {model}` |
| Thinking change | `Thinking → {level}` |
| Mode change | `Mode → {mode}` |

**The rewind marker names no turns.** It says a rewind happened and when, and stops. Naming what
was abandoned would need the whole session file — the branch the timeline reads is, by
definition, the one the abandoned turns are not on — and the marker is built from the invisible
`pi-web-rewind` entry the server leaves on the new tip (§12 "What the server does"), which
carries ids, not text. Inputs already shows the abandoned turns for the one turn after a rewind,
with the text; the axis's job is to record that the branch moved.

Markers are ink-2 at regular weight. They are the axis reporting, not the session speaking.

### The state line

Above the list, `.timeline-state` carries the outline strip's own state sentence, word for word:
"Updated 3m ago · behind the latest messages", or "Updated 3m ago · current", or "Updating"
while a summarizer runs. The chapters on this axis come from the same summary as the strip's,
and an axis is far more persuasive than a list — it looks complete. Without the line, a session
whose summarizer last ran an hour ago would present an hour-old set of chapters as the whole
truth, with today's inputs drawn underneath them in the same ink. The line is the one place that
says which half is fresh.

When the session has no outline at all the line is left out, the chapters with it, and the axis
is inputs, density, markers and gaps — still a timeline, just without headings.

### Empty

"0 messages in this session yet." with "The timeline draws itself as you and the agent work."
An empty state leads with a live fact and states the absence second (§0).

## Jumping

Identical to Inputs, and it is the same helper: `jumpToEntry` in `src/lib/jump.ts`, which the
outline strip, the Skills tab, Inputs and this tab all share. The row scrolls to the middle of
the transcript and tints for ~1.5s (`.entry-jumped`, `JUMP_HIGHLIGHT_MS`).

- **Below the column band (1280)** the pane is a drawer over the transcript, so a landing would
  be behind it: **the pane closes on jump** there, and stays open in the column band. It's the
  same `isDrawer()` test the Inputs tab makes (`src/components/SessionInputs.tsx`). The foot line
  says so at those widths, and only at those widths: "Oldest first, active branch only. A row
  jumps to its message and closes this pane." A user who has never seen the pane stay open has no
  reason to be told it usually does.
- **A message the transcript doesn't show** — compacted away, or not on the branch on screen —
  can't be landed on, so the jump says so instead of scrolling nowhere: "That message isn't in
  the transcript on screen." One toast, the Inputs wording exactly, because it is the same
  failure.
- **Density and gap rows aren't buttons.** They describe a stretch, and a stretch has no one
  message to land on. The input above the density line is the landing, and it is one row away.

## Watch mode

The tab works for a session pi-web isn't running: the pane opens from the session head's
Session-details button, the rows render from the same transcript and insight the Session tab
reads, and the jumps land in the watched transcript. Nothing about the axis needs a chat
socket, because nothing about it writes. A TUI-live session is the case this is most useful in —
you didn't watch it happen, so the shape of it is all you have.

While watching, the state line is the only thing that moves: it is re-read with the insight, on
the same debounce as the outline strip (after a watch `append` or `agent_settled`, §10). New
rows arrive on the same refetch and are appended at the bottom, where the reading already ends.

## No virtualization

The axis for a 500-row session is roughly 40–120 items: a few dozen inputs, their density lines,
the outline's topics, a handful of markers. The Inputs tab already renders a row per message with
no windowing, and this list is shorter than that one. Windowing would cost a scroll container
with its own quirks, break `Ctrl+F`, and buy nothing measurable.

## Accessibility

- **The list** is `<ol class="timeline" aria-label="Session timeline">`. An ordered list, so a
  screen reader announces the position and the count, which is the axis's whole claim.
- **Each jump button opens with a visually hidden "Jump to this message: "**, so its name says
  what it does, not just what it contains — the Inputs rule, and the same string.
- **Times are paired.** The visible clock is the 24-hour mono form (§3 timestamps); the `title`
  on `.timeline-time` carries the absolute time *and* the relative one ("2026-09-19T14:06:11Z ·
  2d ago"), so neither reading is lost. See §7 for why the clock leads here and the relative form
  follows, which inverts the ground rule for lists.
- **A session that spans days** doesn't widen the clock column — a mixed-width column stops the
  digits lining up, which is the only reason the column is mono. The date lives in the `title`,
  and a day boundary is already visible as the gap row that crosses it ("idle 9h 12m").
- **The flagged chapter says it in text**, not only in dimmed ink: "summary time" is in the row's
  words, so the fallback survives being read aloud. The dim is the second signal, never the only
  one (§0: no color-only state).
- **The dots are `aria-hidden`.** They are the rail, and the rail is `data-kind`'s job in text.
- **Focus** stays on the row's button through a jump in the column band. Below it, where the jump
  closes the pane, focus goes back to the control that opened the pane, the way closing it any
  other way does.
- **Esc closes the pane**, unchanged. The tab arms nothing, so it has no Esc of its own to spend
  (§12's Esc cancels an armed rewind; there is nothing here to cancel).
- **No live region.** The pane announces nothing — the tab has no verb and nothing it does is
  invisible. The polite region belongs to the chat (§3), and a timeline narrating its own
  refetches would talk over it. "Timeline open." is the exception that proves it: the announcement
  belongs to the command that ran in the composer, and it is made there, the way `/tree` announces
  "Inputs open.".
- **Contrast.** The clock is ink-2; the flagged clock and the density and gap lines are
  ink-muted, all on surface, the same pairings `.input-row-meta` and `.outline-state` already
  ship.

## Rejected

- **Proportional spacing.** Above: honest proportions hide the rows you came to read.
- **A row per assistant turn or tool call.** It rebuilds the transcript inside a 520px pane, and
  two renderings of one thing drift. The density line says the same in one row.
- **Chapters at the summarizer's time.** It puts a topic in the wrong part of its own session.
  The strip can live with it; an axis can't.
- **Dropping an unresolvable chapter.** A topic visible in the strip and missing from the axis
  reads as a bug. Flagging it is honest and costs one line.
- **Naming the turns a rewind abandoned.** They aren't on the branch the tab reads, so it would
  take the whole session file to name them, for a marker.
- **A horizontal axis.** The pane is a 520px column. Horizontal would need panning to read a
  long session, and every label would be rotated or truncated.
- **Rewind on a timeline row.** Inputs owns the verb. Two places to destroy the same branch is
  one place too many, and a browsing surface is the wrong one.
- **A third chip in the `.run-status` row.** It is one line in a chat, and it already carries
  two. `/timeline` gives the same reach for none of the room.
- **Merging Timeline into Inputs as a toggle.** They disagree about direction (newest first
  against oldest first), about what a row is, and about whether a row acts. A toggle that
  changed all three is two tabs wearing one label.

## Class table

| Need | Classes |
|---|---|
| The list | `ol.timeline` (named by `aria-label`) · `li.timeline-row[data-kind="input\|chapter\|marker\|density\|gap"]` (+ `.timeline-row-flagged`) |
| Rail | `.timeline-dot` (`aria-hidden`); the line itself is `.timeline-row::before`, trimmed at the first and last row |
| Time | `.timeline-time` (mono, right-aligned) `.timeline-time-flagged` |
| Row body | `button.timeline-body` (the whole hit area and the jump) `.timeline-title` (2-line clamp) `.timeline-chapter` (+ `.outline-hash`) `.timeline-meta` |
| Between rows | `.timeline-gap` |
| Above the list | `.timeline-state` |
| Borrowed | `.visually-hidden` (the jump prefix) · `.usage-note.text-muted` (the foot) · `.empty.subagents-empty` (the empty state) · `.entry-jumped` (the landing tint, in the transcript) · `.outline-explained-open` (the strip's `Open Timeline` button, §10) |

---
