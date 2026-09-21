# 13 · Timeline tab
> Part of the pi-web design spec · [overview](overview.md)

The session pane (§11) has a **Timeline** tab: the whole session on one time axis. The outline's
topics are chapter markers, each message you sent is a row, and what the agent did between two of
your messages is a single line of counts under the row it belongs to — "3 replies · 14 tools ·
6m". Notable moments (a compaction, a rewind, a subagent spawning or retiring, a model, thinking
or mode change, an earlier summary of the session) get their own marker rows, and a stretch with
nothing in it gets a dotless "idle 38m".

It answers a question the transcript doesn't: *what shape did this session have?* The transcript
is every row in order. The timeline is the session at arm's length — where the topics turned,
where the long gaps were, where the model changed under you, what the session was about at each
point.

**It is also where you take a message back.** Each message you sent carries a **Rewind** that
takes the chat back to just before it, and the message's text comes back to the composer so it
can be edited and sent again. It is pi's `/tree` on a user message, cut down to the one thing
people use it for: "take that back and let me say it better." One toggle, **Inputs Only**,
narrows the axis to your own messages and the gaps between them, which is the view `/tree` and
the composer's inputs row open.

This tab absorbed the old Inputs tab (formerly §12): the same rows, the same rewind rules, the
same notes, on the axis instead of in a second list of the same messages. Rewind is the pane's
only verb, and it lives on exactly one kind of row: a message you sent, on the active branch.

## Opening it

- **The tab strip**, like any tab. The pane keeps the tab per session path. Opens with the
  filter off.
- **The outline strip's `Open Timeline`** (§10), a ghost button in `.outline-body` beside
  `Open {n} Explanations`. The strip is where someone is already reading the session's chapters;
  the timeline is those chapters with everything else drawn in between them. Opens with the
  filter **off**.
- **A bare `/timeline` in the composer.** It opens the pane on Timeline with the filter **off**,
  **opens and never toggles shut**, clears the draft, and announces "Timeline open." The runtime
  doesn't register it, so it isn't in the command menu (§4d "Local commands").
- **A bare `/tree` in the composer.** It opens the pane on Timeline with the filter **on** — your
  messages, each with its Rewind — opens and never toggles shut, clears the draft, and announces
  "Timeline open, your messages only." pi's own `/tree` is a TUI built-in; this is the web's
  answer to the same wish. With arguments, either command falls through to a normal send.
- **The composer's inputs row**, below. It is the discoverable door: the tab strip only helps
  someone who already opened the pane, and `/tree` only helps someone who knows pi. It opens the
  Timeline with the filter **on**.
- **The composer flyout's `Undo last turn`** (§9 Composer flyout), the last item after a
  separator, rewinds to just before the newest message **without opening the pane**. It is a
  different gesture — one step back, from where you are typing — and it stays.

Each door **sets** the filter, even on a pane already showing the tab: `/tree` on an unfiltered
Timeline turns it on, and `/timeline` on a filtered one turns it off. A door that promised your
messages and showed everything, or the reverse, would be lying about where it goes.

### The inputs row

The composer's `.run-status` line (§3) carries a right-aligned `button.run-status-link` pushed
over with `margin-left:auto`, beside the subagents trigger (§11):

```html
<p class="run-status">
  <!-- the subagents trigger (§11), when there is one -->
  <button type="button" class="run-status-link" aria-expanded="false" aria-controls="session-pane"
          aria-label="7 inputs in this chat — show them on the Timeline">
    7 inputs
    <span class="icon icon-sm" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
  </button>
</p>
```

- **The count is the user's own messages on the active branch**, from `inputCount` in
  `src/lib/input-count.ts`. It drops the moment a rewind lands, because the branch is what it
  counts. The count stays visible: it is a fact about the session, whether or not the pane is open.
- **Hidden at 0**, and hidden means *absent*: a session nobody has written to yet shows no control,
  not a greyed one. Visible text is "7 inputs" / "1 input"; the accessible name says where it
  goes, singular throughout at one: "1 input in this chat — show it on the Timeline".
- **The row renders whenever any of its three parts has something to say** — a running turn,
  workers, or inputs — so an idle session with messages still has one.

Both triggers point `aria-controls` at the pane's one tab-neutral id, `session-pane` (§11). The
pane is in the DOM only while it's open, so that reference dangles while it's closed: intended,
and the same thing the subagents trigger has always done.

`aria-expanded` is **per destination, not per pane**: true only when the pane shows what that
trigger opens. For the inputs trigger that is the Timeline *with Inputs Only on*; a tab name alone
can't answer, so the app passes the answer down as one boolean.

| Pane state | Subagents trigger | Inputs trigger |
|---|---|---|
| Closed | `false` | `false` |
| Open on Agents | `true` | `false` |
| Open on Timeline, Inputs Only on | `false` | `true` |
| Open on Timeline, Inputs Only off | `false` | `false` |
| Open on Session, Skills or Explain | `false` | `false` |

The unfiltered Timeline row looks odd — the pane is open on the right tab and the trigger says
collapsed — but `aria-expanded` answers "did *this* control's content open?", and it didn't:
activating the trigger still changes something (it turns the filter on).

**No chip for the timeline itself in the `.run-status` row.** It is one line in a chat and already
carries two controls. `/timeline` is a different door — typed, costing no pixels, gone the moment
it runs. The timeline is a place you go to look back, not a thing that becomes true mid-turn.

## Rows

```html
<div class="spread">
  <p class="timeline-state">Updated 3m ago · behind the latest messages</p>
  <button type="button" class="button button-sm button-ghost" aria-pressed="false">Inputs Only</button>
</div>
<ol class="timeline" reversed aria-label="Session timeline">
  <li class="timeline-row" data-kind="marker">
    <span class="timeline-time" title="2026-09-19T14:58:40Z · 2d ago">14:58</span>
    <span class="timeline-dot" aria-hidden="true"></span>
    <span class="timeline-body timeline-body-static" title="Reworking the watcher so a save restarts only …">
      <span class="timeline-title">Goal · fixing the watcher restart loop</span>
    </span>
  </li>
  <li class="timeline-row" data-kind="gap">
    <span class="timeline-gap">idle 38m</span>
  </li>
  <li class="timeline-row" data-kind="input" data-input="e41f">
    <span class="timeline-time" title="2026-09-19T14:08:02Z · 2d ago">14:08</span>
    <span class="timeline-dot" aria-hidden="true"></span>
    <div><!-- the third grid column -->
      <div class="input-row-line">
        <button type="button" class="timeline-body input-row-body">
          <span class="visually-hidden">Jump to this message: </span>
          <span class="timeline-title input-row-title">can you check why the watcher restarts on every save</span>
        </button>
        <span class="input-row-actions">
          <button type="button" class="button button-sm button-ghost" data-focus="rewind"
                  aria-label="Rewind to before this message">Rewind</button>
        </span>
      </div>
    </div>
  </li>
  <li class="timeline-row" data-kind="density">
    <span class="timeline-meta">3 replies · 14 tools · 6m</span>
  </li>
  <li class="timeline-row" data-kind="chapter">
    <span class="timeline-time" title="2026-09-19T14:06:11Z · 2d ago">14:06</span>
    <span class="timeline-dot" aria-hidden="true"></span>
    <button type="button" class="timeline-body">
      <span class="visually-hidden">Jump to this message: </span>
      <span class="timeline-chapter"><span class="outline-hash">#</span>Model selection and limits</span>
    </button>
  </li>
</ol>
<p class="usage-note text-muted">Newest first, active branch only. A row jumps to its message; Rewind takes the chat back to just before it.</p>
```

`ol`, not `ul`: the order is the point. Every row is `li.timeline-row` with a `data-kind`, and
the kinds are the whole vocabulary — `input`, `chapter`, `marker`, `density`, `gap`.

| Kind | What it is | Dot | Clock | Jumps | Acts |
|---|---|---|---|---|---|
| `input` | One message you sent, clamped to two lines (`.timeline-title`, full text in `title`); images-only reads "1 image" / "{n} images" | Solid, muted | Yes | Its own message | Rewind, on the active branch |
| `chapter` | An outline topic, at its anchored message's time (`.timeline-chapter`, one line, ellipsized; `.outline-hash` for a `manual` topic) | Hollow, larger | Yes | The anchored message | — |
| `marker` | A notable moment, in regular weight ink-2 | Hollow, small | Yes | The entry it happened on, when there is one — a rewind or a past summary has none, so it is text | — |
| `density` | What the agent did after the input directly above it — an input and its density line stay together, input on top | — | — | — | — |
| `gap` | A stretch over the idle threshold, between the two rows it separates: the later one above it, the earlier one below | — | — | — | — |

**Newest first.** The pane opens at the top, and the top is now the live end: in a session being
watched, new rows arrive where you are already looking, and in a long one the freshest thing is
the thing you most often want. The axis still records the session's own direction, only read
backwards — a row **below** another *precedes* it in time, and the foot line says so out loud.
The order is computed chronologically (`timelineRows()`: gaps, tie-breaks, rewind standing) and
only then turned over for rendering, group-aware (`newestFirst()`): an input keeps its density
line directly beneath it, and a gap stays between the same two rows. The filter only hides
rows; the direction is the tab's, so both modes run newest first.

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

One row each:

| Marker | Copy |
|---|---|
| Compaction | `Compacted · {n} tokens summarized` |
| Rewind | `Rewound to an earlier message` |
| Subagent spawned | `{name} started` |
| Subagent retired | `{name} finished` (`{name} stopped` when it errored or was killed) |
| Model change | `Model → {model}` |
| Thinking change | `Thinking → {level}` |
| Mode change | `Mode → {mode}` |
| Past summary | `Goal · {now}` |

**The rewind marker names no turns.** It says a rewind happened and when, and stops. Naming what
was abandoned would need the whole session file — the branch the timeline reads is, by
definition, the one the abandoned turns are not on — and the marker is built from the invisible
`pi-web-rewind` entry the server leaves on the new tip ("What the server does", below), which
carries ids, not text. The axis already shows the abandoned turns for the one turn after a
rewind, with the text ("After a rewind", below); the marker's job is to record that the branch
moved.

**Past summaries.** Every summary the outline extension wrote on the branch is a marker at the
time it was written — `SessionInsight.outlines`, oldest first, consecutive repeats already dropped
by the server — reading `Goal · {now}`, the summary's one-line "now", with its longer `overall` in
the row's `title`. A summary with no "now" falls back to the first line of its `overall`. Read in
order, they are what the session was about at each point, which neither the chapters (topics,
not goals) nor the strip (the latest only) can say.

- **The newest snapshot gets no row.** It is the current goal, and the outline strip above the
  chat (§10) already shows it; a row repeating it at the top of the axis would be the same
  sentence twice, one scroll apart.
- The list is read off disk, so a live session's strip can be one broadcast newer than the
  newest snapshot here. Then the newest *on disk* is still left off, and the strip shows a newer
  one: nothing is doubled, and one summary briefly has no row.

**A marker with no single message behind it is text, not a button.** The rewind marker and the
past summary are the cases that exist today: both entries render as nothing in the transcript,
and the message a rewind names is the one it took away, off the active branch by construction —
so a button there would only ever reach "That message isn't in the transcript on screen." The
row keeps its clock, its dot and its copy and drops the button:
`span.timeline-body.timeline-body-static`, no `Jump to this message: ` prefix, no pointer, no
accent on hover. It is the precedent the density and gap rows already set — nothing to land on,
so nothing to press — and it differs from them in the one way that matters: it happened at a
time, on the axis, so it keeps the clock and the dot they don't have.

Every other marker jumps to the entry it happened on, and a row whose message is gone from the
transcript — a chapter whose anchor was compacted away — still has a button and still says so
when it can't land. That is a jump that failed, not a row with nowhere to go.

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

## Inputs Only

One toggle button in the tab's own head, right-aligned on the state line's row:
`button.button.button-sm.button-ghost[aria-pressed]`, "Inputs Only". It is the filter's **only**
control: one press on, one press off, `aria-pressed` saying which. Pressed, a `check` icon sits
before the words, so the state has a shape and never rests on colour (§0).

**On, the axis is your messages and the time between them.** Every `input` row renders, each
with its own density line under it (replies · tools · duration) and its Rewind; the `gap` rows are
measured again between the rows that remain, so "idle 43m" is the silence between two of your
messages. Every other row goes: chapters, compactions, rewind markers, subagents started and
finished, model/thinking/mode changes and past summaries. The rows a fresh rewind left behind
(below) stay — they are your messages too, and the filter is what `/tree` opens.

The list's name follows it: `aria-label="Session timeline, your messages only"`, and the foot line
starts "Your messages only, newest first,".

**The state is in memory, never persisted.** The app holds it for the pane: it survives a switch
to another tab and back, and it goes off whenever the pane closes, however it closes. The doors
set it as they open the tab (above). There is no stored preference, because the filter is a
question you are asking right now — "just my messages" — not a way you like to read the session.

**Empty, filtered.** When the filter hides everything — a session with markers, chapters or
summaries but no message of yours on the branch — the panel says why rather than going blank:
"0 messages from you in this session yet." with "Turn off Inputs Only to see the rest of its
timeline." A session with nothing at all shows the ordinary empty state, filter or not.

## Rewind

**Only an `input` row acts, and only while it is on the active branch.** Its body is the jump —
the safe half of the row, and the whole of its hit area — and **Rewind** (ghost, `button-sm`)
sits apart at the row's end in `.input-row-actions`, so the destructive half stays small and
deliberate. Chapters, markers, density and gap rows never carry it: two places to destroy the same
branch is one too many, and the thing you take back is always a message you sent.

The rules are the ones the Inputs tab used, unchanged, and they live in one module:
`src/lib/inputs.ts` decides which row may act (`rowAction`), the two-step confirm (`stepRewind`),
and the boundary and abandoned rows after a rewind (`viewRows`, `rewoundAt`, `sentSince`);
`src/lib/timeline.ts` only places those rows on the axis.

### Confirm, inline

Rewind is two steps, in the row, with no modal. The first press turns the row's button into
**Rewind Here** (destructive, focused) beside **Cancel** (ghost), and an `.input-row-note` says
"This message and every reply after it leave the branch. The session file keeps them." Esc
cancels without closing the pane. The flyout's Undo last turn works the same way: the first
press relabels it "Confirm: undo last turn" and the flyout stays open; closing it disarms.

While one rewind is in flight its button reads "Rewinding…" with `aria-busy`, and every other
row is disabled ("A rewind is already in progress.").

### When it's off

Rewind is `aria-disabled` with the reason in its `title` and on `aria-describedby`, **never
hidden**:

| State | Copy |
|---|---|
| A turn is running | "Stop the current turn first." |
| A compaction is running (including a manual `/compact`) | "Wait for the compaction to finish." |
| Open in a terminal (TUI-live) | "This session is open in a terminal, so pi-web won't write to it." |
| Watching, or no chat open here | "Only a chat open in pi-web can rewind." |
| A rewind is in flight | "A rewind is already in progress." |

Streaming refuses; it never auto-aborts. Stopping is the user's call, and a rewind that silently
killed a running turn and its workers would be the surprise. The server enforces all of this
again (below), so a stale pane can't get past it: a refusal's message shows inline under its row
(a `.text-error` span inside an `.input-row-note`, hung off the button's `aria-describedby`), and
the flyout toasts it.

### After a rewind

The composer gets the message's text ahead of whatever draft was there, the same way a Stop
hands back queued messages, and announces "Rewound. Your message is back in the composer."
Images aren't handed back, as in pi's `/tree`. The thread, context ring and mode redraw for the
new branch; a rewind to the first message leaves an empty thread.

On the axis, the rewound-to row stays as the **boundary** (`.input-row-boundary`, the accent tint)
with a focusable note, "Rewound to just before this message. Its text is in the composer.", and
focus lands on it. The messages that left the branch stay as a **shadow** for one turn:
`.input-row-abandoned`, muted ink, regular weight, no Rewind, and a visually hidden "Left behind
by the rewind." They keep their own times, so on this newest-first axis they sit **after** the
boundary — above it — which is the same place the Inputs list put them: beyond the line the
branch now ends at, where the turns you threw away happened. The
boundary and the shadow go as soon as the branch shows a message the rewind didn't know about,
which is the next send. Until then you can still see what you took back.

A shadow row still jumps (it toasts "That message isn't in the transcript on screen." once the
transcript has reloaded without it), and it has no density line: the replies it drew left the
branch with it. The rewind marker for this rewind lands at its own time, after them.

**Any successful rewind refreshes the axis once, whoever started it** — a row, the flyout's Undo
last turn. The chat tells the app each time the server says `rewound`; the app mints a counter
and hands it to the pane for that session path only, and the pane re-reads the transcript and
draws the boundary and the shadow. A rewind in one session never refreshes another's. **A refusal
refreshes nothing and changes nothing**: the rows are still true, so they stay as they are and
only the note under the row appears. Without this the rows went stale after a flyout undo — they
kept offering Rewind on messages that had already left the branch, and the press came back "That
input is not on this chat's current branch anymore."

The two halves of that are independent on purpose. The notification the chat raises carries the
session path and the message id, and **no text**: the chat has already filled the composer from
the server's own reply, and the tab rebuilds its boundary and shadow from the id alone. Nothing
downstream can drift out of sync with what the composer shows, because nothing downstream holds
a second copy of it.

A refusal is **announced as well as shown**. The inline note is easy to miss for a screen-reader
user who just heard "Rewound.", so the polite region (§3) gets the refusal's own words. **The
chat owns the announcement** — every refusal, whether a row asked for it, the flyout did, or the
chat turned it down without asking the server — and the row owns the note. One owner, because two
code paths saying the same sentence is how the live region ends up reading it twice.

### What the server does

`{type:"rewind", id, entryId}` over the chat socket. The server runs the same guards as every
other write (TUI-live, foreign writer), refuses while streaming or compacting, and refuses an id
that isn't a user message on the active branch. Then it calls the SDK's
`navigateTree(entryId, {summarize:false})`, which moves the tip to that message's parent. On its
own that only moves an in-memory pointer, and pi reopens a file at its last line, so a reload or
restart would quietly put the abandoned turns back. So the server appends one invisible `custom`
entry, `customType: "pi-web-rewind"` (`data: {targetId, fromLeafId}`), on the new tip. It's
extension state: never model context, no row in either transcript, no usage. Then every client
of the chat gets a fresh `hello`, the workers snapshot and the chat's `mode`, and the requester
gets `rewound` with the text. Refusals come back as `rewind_refused`, never as a thread error.

## Jumping

`jumpToEntry` in `src/lib/jump.ts`, the one helper the outline strip, the Skills tab and this tab
share. The row scrolls to the middle of the transcript and tints for ~1.5s (`.entry-jumped`,
`JUMP_HIGHLIGHT_MS`). **The filter doesn't change a jump**: with Inputs Only on, pressing a row's
body lands on that message exactly as it would unfiltered, and the filter stays as it was.

- **Below the column band (1280)** the pane is a drawer over the transcript, so a landing would
  be behind it: **the pane closes on jump** there (and the filter goes off with it, as it does on
  any close), and stays open in the column band. The foot line says so at those widths, and only
  at those widths: "… A row jumps to its message and closes this pane; Rewind takes the chat back
  to just before it." A user who has never seen the pane stay open has no reason to be told it
  usually does.
- **A message the transcript doesn't show** — compacted away, or not on the branch on screen —
  can't be landed on, so the jump says so instead of scrolling nowhere: "That message isn't in
  the transcript on screen."
- **Density and gap rows aren't buttons.** They describe a stretch, and a stretch has no one
  message to land on. The input above the density line is the landing, and it is one row away.
  The rewind and past-summary markers aren't buttons either, for the same reason and with their
  clock and dot kept (above, "Markers").

## Watch mode

The tab works for a session pi-web isn't running: the pane opens from the session head's
Session-details button, the rows render from the same transcript and insight the Session tab
reads, and the jumps land in the watched transcript. A TUI-live session is the case the axis is
most useful in — you didn't watch it happen, so the shape of it is all you have.

**Rewind is chat-only, and it says so.** Watching, every input row still shows its Rewind,
`aria-disabled`, with the reason: "This session is open in a terminal, so pi-web won't write to
it." for a TUI-live session, "Only a chat open in pi-web can rewind." otherwise. A button that
vanished in watch mode would leave a reader who used it yesterday wondering where it went.

While watching, the state line is the only thing that moves: it is re-read with the insight, on
the same debounce as the outline strip (after a watch `append` or `agent_settled`, §10). New
rows arrive on the same refetch, at the top, where the reading already starts.

## No virtualization

The axis for a 500-row session is roughly 40–120 items: a few dozen inputs, their density lines,
the outline's topics, a handful of markers, and the past summaries (the server caps those at 200). Windowing would cost a scroll
container with its own quirks, break `Ctrl+F`, and buy nothing measurable. Rows are keyed, so a
refetch or an armed Rewind never remounts the row under focus.

## Accessibility

- **The list** is `<ol class="timeline" reversed aria-label="Session timeline">` (filtered: "Session
  timeline, your messages only"). An ordered list, so a screen reader announces the position and
  the count, which is the axis's whole claim; `reversed`, so that position counts from the
  session's start while the rows read newest first.
- **The filter** is one `button[aria-pressed]`, "Inputs Only": its name stays the same and the
  pressed state is announced, the way a toggle should read. The `check` icon is the visible twin
  of `aria-pressed`, not colour.
- **Each jump button opens with a visually hidden "Jump to this message: "**, so its name says
  what it does, not just what it contains.
- **Rewind** is never hidden when it can't act: it stays in the row, `aria-disabled`, with the
  reason in its `title` and on `aria-describedby`, so it reads out with the button. Its name is
  "Rewind to before this message"; armed, "Confirm: rewind to before this message".
- **A refusal** shows inline under the row *and* goes to the polite region, once, from the chat.
- **Focus follows the step**: into Rewind Here when a row arms, back to Rewind when it cancels,
  and onto the boundary note when the rewind lands — which is also how a screen-reader user hears
  where the branch now ends.
- **Esc** cancels an armed row without closing the pane; the pane's own Esc still closes it when
  nothing is armed.
- **The abandoned rows** carry a visually hidden "Left behind by the rewind.", because muted ink
  and a missing button say nothing out loud.
- **A row that can't be jumped to isn't a button.** The rewind and past-summary markers are
  `span`s, so a screen reader reads them as the lines of text they are and they never appear in
  the tab order — a control that could only fail is worse announced than absent.
- **Times are paired.** The visible clock is the 24-hour mono form (§3 timestamps); the `title`
  on `.timeline-time` carries the absolute time *and* the relative one ("2026-09-19T14:06:11Z ·
  2d ago"), so neither reading is lost. See §7 for why the clock leads here and the relative form
  follows, which inverts the ground rule for lists.
- **A session that spans days** doesn't widen the clock column — a mixed-width column stops the
  digits lining up, which is the only reason the column is mono. The date lives in the `title`,
  and a day boundary is already visible as the gap row that crosses it ("idle 9h 12m").
- **The flagged chapter says it in text**, not only in dimmed ink: "summary time" is in the row's
  words, so the fallback survives being read aloud (§0: no color-only state).
- **The dots are `aria-hidden`.** They are the rail, and the rail is `data-kind`'s job in text.
- **Focus** stays on the row's button through a jump in the column band. Below it, where the jump
  closes the pane, focus goes back to the control that opened the pane, the way closing it any
  other way does.
- **No live region of its own.** The polite region belongs to the chat (§3), and a timeline
  narrating its own refetches would talk over it. "Timeline open." and "Timeline open, your
  messages only." belong to the commands that ran in the composer, and are made there; the rewind
  outcomes are the chat's (above).
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
- **Naming the turns a rewind abandoned, on its marker.** They aren't on the branch the tab
  reads, so it would take the whole session file to name them, for a marker.
- **Drawing the newest summary as a row.** The strip already says it; see "Past summaries".
- **A horizontal axis.** The pane is a 520px column. Horizontal would need panning to read a
  long session, and every label would be rotated or truncated.
- **Keeping a separate Inputs tab.** It listed the same messages the axis already drew, so the
  pane had two renderings of one thing and every change to one had to be made twice. The one thing only it had — Rewind — moved onto the axis's input rows, and the
  filter gives back the short list.
- **Newest first under the filter** (alone). Both modes run newest first, so the toggle changes
  only what rows there are, never which way the axis runs; the direction is the tab's.
- **Rewind on a non-input row.** The thing you take back is always a message you sent. A marker
  or a chapter would be a second, vaguer handle on the same branch.
- **A second control for the filter** (a segmented pair, a menu, a remembered preference). One
  press on, one press off; see "Inputs Only".
- **A modal confirm.** It takes the user off the row they chose; the inline step keeps the
  choice and its consequence in one place.
- **Auto-aborting a running turn.** See "When it's off".
- **Showing every branch.** A tree picker is the TUI's `/tree`. Here, the branch you're on is
  the only one you can act on.
- **Summarizing the abandoned branch.** It costs a model call per rewind, and the file keeps the
  turns anyway.

## Class table

| Need | Classes |
|---|---|
| Head | `.spread` (the state line and the filter) · `.timeline-state` · `button.button.button-sm.button-ghost[aria-pressed]` (+ `.icon` `check` when pressed) |
| The list | `ol.timeline` (named by `aria-label`) · `li.timeline-row[data-kind="input\|chapter\|marker\|density\|gap"]` (+ `.timeline-row-flagged`; input rows `[data-input="<entry id>"]`, + `.input-row-boundary` / `.input-row-abandoned`) |
| Rail | `.timeline-dot` (`aria-hidden`); the line itself is `.timeline-row::before`, trimmed at the first and last row |
| Time | `.timeline-time` (mono, right-aligned) `.timeline-time-flagged` |
| Row body | `button.timeline-body` (the whole hit area and the jump) · `span.timeline-body.timeline-body-static` (a marker with nothing to land on) `.timeline-title` (2-line clamp) `.timeline-chapter` (+ `.outline-hash`) `.timeline-meta` |
| Input row | a third-column wrapper · `.input-row-line` · `button.timeline-body.input-row-body` · `.timeline-title.input-row-title` · `.input-row-actions` (Rewind; armed: `.button-destructive` Rewind Here + ghost Cancel) · `.input-row-note` (confirm, boundary, `.text-error` refusal) |
| Between rows | `.timeline-gap` |
| Borrowed | `.visually-hidden` (the jump prefix, the disabled reason, "Left behind by the rewind.") · `.usage-note.text-muted` (the foot) · `.empty.subagents-empty` (the empty states) · `.entry-jumped` (the landing tint, in the transcript) · `.outline-explained-open` (the strip's `Open Timeline` button, §10) · `.run-status-link` (the composer's inputs trigger) |

The input row borrows the old Inputs tab's `.input-row-*` classes rather than growing its own,
so the boundary tint, the muted abandoned title and the note rhythm are the ones already
measured. A pressed-state style for the ghost toggle, and a `.timeline-*` home for the input
row's wrapper (it carries `grid-column: 3` inline today), are the designer's to add.

---
