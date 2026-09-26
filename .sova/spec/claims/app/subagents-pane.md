# §app/subagents-pane — Subagents pane
> Part of the Sova design spec · [overview](../design/overview.md)

The composer's "2 subagents working…" row opens a pane beside the session: this session's
workers on the left, the selected worker's live transcript on the right, read-only. It answers
"what are my workers doing right now?" without leaving the conversation that started them.

It is **this session only**. `#/agents` (§app/insights) stays the cross-session surface: every running pi,
its teams and solo workers, as cards with no transcripts. The session head's "{n} working" chip
keeps linking there. The pane is for watching; the page is for finding.

## §app.subagents-pane/trigger — Trigger

There are two ways in, and both reach the pane whether or not anything is working: the composer's
subagents row, and `/agents`.

**`/agents` (and `/subagents`), bare, opens the pane.** It is a local command (§chat/slash-commands): Sova runs
it itself and sends nothing to the runtime, whose own `/agents` monitor is a TUI overlay and
answers a web session with "requires Pi's interactive TUI". It is listed in the "/" menu like any
other command, because the runtime registers it; picking it there inserts `/agents`, and Enter
opens the pane instead of sending. The draft clears, the pane takes focus, and a live region says
"Subagents open." An already-open pane stays open (the command opens, it doesn't toggle) and says
"Subagents already open." **With arguments** — `/subagents models haiku` — it is the runtime's
command and goes through untouched, and so does `/agents` with images attached.

The subagents row was plain text: `.run-status`, shown whenever at least 1 worker runs — the
parent's own turn included (§chat/transcript "Run status") — and, once the parent is idle, also when the
session has settled workers. It becomes a control. The `<p>` stays, and a
button takes its contents. The row is no longer only this: §chat/timeline's inputs trigger sits at its
right end, and the row renders whenever any of streaming, workers or inputs has something:

```html
<p class="run-status">
  <button type="button" class="run-status-link" aria-expanded="false" aria-controls="session-pane"
          aria-label="2 subagents working — show subagents">
    <span class="live-dot"></span>2 subagents working…
    <span class="icon icon-sm" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
  </button>
</p>
```

- **It reads as the row it was, plus two cues.** The live dot and the words keep `.run-status`'s
  look (caption, ink-2). A muted chevron says "opens to the right", and hover fills the whole
  control with sunken and lifts the words to ink. It never becomes a primary or secondary
  button: it's a status you can open, and the composer already has its one primary.
- **Size.** 36px drawn with an `--r-md` fill, a 44px hit area (a `::after` 4px above and below),
  and a net 20px of layout, so the composer doesn't jump whether this row stands alone or rides
  beside the Working label. It sits 8px left of the row's edge, so the dot lines up with the
  Working row's dot.
- **The count is in the label** and changes in place. The accessible name is the visible words
  plus what the control does: "2 subagents working — show subagents".

| State | Renders |
|---|---|
| Parent turn running, ≥ 1 working | The Working row (§chat/transcript) **and** this trigger beside it: live dot, the counts alone — "2 subagents" · "1 subagent · 2 team members" — labelled "2 subagents working — show subagents". Working already says what's happening, so the trigger only says how many. This is how the pane is one click away mid-turn |
| Idle, 0 workers ever | No row, no trigger. `/agents` still opens the pane, which says so |
| Idle, ≥ 1 working | The trigger, with the live dot: "2 subagents working…" |
| Idle, none working, ≥ 1 settled | The trigger, **no live dot**: "2 subagents", labelled "2 subagents — show subagents". The per-worker counts and the Σ are what it's for, and they outlive the work |
| Hover · active | Sunken fill, ink words, chevron to ink · active also moves 1px down, like `.button` |
| Focus-visible | The 2px accent ring, at `--r-md` |
| Pane open | `aria-expanded="true"`. **No pressed styling**: the open pane beside it is the state, and a tinted trigger would be one more accent-adjacent thing in a composer that has Send. Clicking again closes the pane |

The pane doesn't need the trigger to stay open: it survives a turn starting or ending. While the
parent runs, the trigger stays in the row with the counts alone, so watching the workers mid-turn
is one click rather than a wait for the turn to settle.

## §app.subagents-pane/shell-a-third-column — Shell: a third column

```html
<div class="app" data-view="session">
  <aside class="app-sidebar" aria-label="Sessions">…§app/session-list…</aside>
  <main class="app-main">…§chat/transcript head, thread, composer…</main>
  <aside class="app-subagents" id="session-pane" aria-label="Session detail">
    <header class="subagents-head">
      <h2 class="subagents-title">Subagents</h2>
      <span class="chip chip-count">2 working</span>            <!-- omitted at 0 -->
      <span class="chip chip-count subagents-usage" title="41.9k in · 11.3k out · 402k cache read · 61.8k cache write · $0.72">53.2k tokens</span>
      <button class="button button-icon button-ghost subagents-close" aria-label="Close subagents">
        <span class="icon" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
      </button>
    </header>
    <div class="subagents-body">
      <ul class="subagents-list" aria-label="Subagents">…rows…</ul>
      <div class="subagents-view">…head + transcript, or an empty state…</div>
    </div>
  </aside>
</div>
```

The aside is a direct child of `.app`, after `.app-main`, and it's **mounted only while open**.
The grid keys off its presence (`.app:has(> .app-subagents)`), so nothing else has to change
state. Changing route closes it. The shell is the window, so, like §app/shell, the bands are `@media`:

| Window | The pane | Session pane (`.app-main`) |
|---|---|---|
| ≥ 1280 | A column: `--sidebar-width` · `minmax(--main-min, 1fr)` · `--subagents-width`. It pushes | Keeps at least `--main-min` (440px) |
| 768–1279 | A drawer over `.app-main`, anchored right, full height, `--shadow-2` and a left border. Width `min(--subagents-width, 100% − --sidebar-width − --space-8)` | Stays put underneath. The sidebar and at least a 64px strip of the thread stay visible |
| < 768 | Full screen over the session view | Hidden beneath, unchanged |

- **What wins when space is tight: the thread.** `--subagents-width` is `clamp(520px, 40vw,
  880px)`. 320 + 440 + 520 = 1280, so the column exists only where the session pane keeps its
  440px floor. Below that, the pane gives up its column and becomes a drawer, rather than
  squeezing the conversation the user is in.
- **The drawer is not modal.** No scrim, no focus trap, and the visible strip of the thread
  still scrolls. It's a second view of the same session, not a question.
- **Grounds.** The pane head and the list sit on surface, like the sidebar. The transcript
  view sits on paper, like the session's own transcript. That makes the nesting read as
  "a session inside a session".

## §app.subagents-pane/head — Head

`.subagents-head` matches `.session-head`: 56px, surface, a bottom border, so the two heads read
as one band across the window. The title is `heading-s`. The count chip is the neutral §app/insights
aggregate, `{n} working`, with no dot and no pulse, left out at 0. Close is a ghost icon button
pushed right, `aria-label="Close subagents"`. Its chevron points right: it sends the pane back
the way it came.

**The token Σ** sits beside the working count as a second neutral chip, `{n} tokens` in mono
(`.subagents-usage`), left out when nothing has been spent. It is a **session-lifetime** total:
every worker this session ever started, on any branch, including the ones the manager's
retention cap and the live record's 40-row cap dropped, so it is normally larger than the rows add
up to. While the runtime runs it never goes down. After a server restart it is **rebuilt from the
workers' transcripts** (§app.worker-restore/usage-from-transcripts), which may give a different
total than the one shown before: the rebuild counts what the live count left out (cache-warm
calls), and a Claude Code worker's cost is its last snapshot's. The headline is input + output, the §chat/context-window token format. Everything the headline hides
is in the `title`: `{in} in · {out} out · {cacheRead} cache read · {cacheWrite} cache write`,
the cost (`$0.72`, `<$0.01`) when a backend reports one, and the head count it covers
("57 subagents so far"). Under 520px of pane the chip goes and the working count stays: one
answers whether anything is happening, the other only how much it cost.

## §app.subagents-pane/body-list-transcript — Body: list | transcript

`.subagents-body` is a grid, `--subagents-list-width` (256px) · `minmax(0, 1fr)`. The list and
the transcript are **each their own scroll region**, and the body, the pane, and the page never
scroll. The list scrolls on its own (`overscroll-behavior: contain`). The transcript is a `.pane`.

**Under 560px of pane, it's list/detail.** One half shows at a time, and it gets the whole body:
the list, or one worker's view. `.subagents-body[data-view]` says which. A row opens its worker,
and the view head's back button (`.subagents-back`, a 44px ghost icon button, chevron left,
named "All subagents", or "All workers" when the session has a team) returns to the list with
the row still selected. Focus follows the swap: to the back button on opening, and to the
selected row on the way back. Rows gain a trailing chevron, because a row now opens something.
Neither the back button nor the chevron is drawn side by side. The pane is a named container,
`subagents`. The threshold is 560, the 256px list plus a 304px transcript, the least that reads
beside it. The 520px drawer used to keep both and left the transcript 264px: at 933 unfolded, a
tool row showed `bash sl…`. The rule contracts, so it has a `@media (max-width: 1279px)` floor,
per the skill's union. Below 1280 the pane is the 520px drawer or full screen, so it's always
list/detail. From 1280 the column is 40vw and asks its own box, so it's side by side from 1400.

- **Which half opens.** It's settled once, when the first workers arrive: 1 worker opens on
  that worker, and more open on the list. A second worker starting later doesn't swap the half
  under the reader. The pane (`SessionPane`) keeps the half across tab switches for as long as
  it's open. Skills' "show this worker" opens the worker. With nothing selected (no workers, or
  the list couldn't load), the view half shows, since it holds those empty and error states.
- **Stacking was rejected.** Putting the list on top of the transcript gave each one a strip,
  with no visible line between them, and at 30vh a list of 7 workers still scrolled.

## §app.subagents-pane/worker-rows — Worker rows

```html
<ul class="subagents-list" aria-label="Subagents">
  <li>
    <button class="subagent-row" type="button" aria-current="true">
      <span class="subagent-row-name">designer</span>
      <span class="subagent-row-status">
        <span class="context-ring" title="Context: 64,210 of 1,000,000 tokens (6%), as of the last reply.">…</span>   <!-- only with a fill and a window -->
        <span class="chip chip-accent chip-live"><i class="chip-dot"></i>Working</span>
      </span>
      <span class="subagent-row-meta meta-line">
        <span>claude code</span>
        <span class="meta-line-sep" aria-hidden="true">·</span>
        <span class="text-mono meta-line-shrink" title="anthropic/claude-opus-5[1m]">opus-5 1M</span>
        <span class="meta-line-sep" aria-hidden="true">·</span>
        <span class="text-mono" title="18.4k in · 5.3k out · 242k cache read · 32.1k cache write · $0.41">23.7k</span>
      </span>
      <span class="icon icon-sm subagent-row-go" aria-hidden="true"></span>   <!-- list/detail only -->
    </button>
  </li>
</ul>
```

- **Anatomy.** The whole row is the button, 44px minimum. Line 1 is the name (the team role when
  the worker is a team member, else its own name), with the context ring and the status chip at
  the right. Line 2 is the meta. Every line ellipsizes. **There's no excerpt of the worker's reply**, whether that's
  "No response yet." or the reply itself: one clipped line of a reply said little and cost every
  row a line. The transcript says it whole, one tap away.
- **The meta line ranks its facts** (`.meta-line`, shared with the transcript view's meta). It is
  a nowrap flex row and **leads with the provider** — the route that serves the model
  (`WorkerInfo.provider`): `claude code` for that backend, else the model ref's own provider, else
  the one pi's cached catalogs give for a bare id. The provider, the tokens, the "as of" time and
  "last task failed" keep their room, and the **model id is the only part that shrinks**
  (`.meta-line-shrink`, ellipsized, 8ch floor, so a short id such as `haiku` or `glm-5.3` stays whole). A number that's been clipped is worse than a name
  that has, the model is the one fact already known from elsewhere, and a provider that clipped
  would be the least useful half of `zai · glm-5.3`. A worker whose provider can't be derived shows
  none: the pane never guesses one. Separators are `.meta-line-sep` dots, `aria-hidden`.
- **Model ids are shortened for display**: no provider, no dated build, a dotted version, and the
  context variant spelled out — `anthropic/claude-haiku-4-5-20251001` → `haiku-4.5`,
  `claude-opus-5[1m]` → `opus-5 1M`. An id that matches none of that is left as it is
  (`gpt-5-mini`). The **full id is the `title`**, here and in the transcript view's head, so
  nothing shortened is lost.
- **Status** is §app/insights's member table, word for word. The chip always carries the word:

  | Worker | Chip | Meta |
  |---|---|---|
  | `running` | `.chip.chip-accent.chip-live` Working | `{provider}` · `{model}` · `{tokens}` |
  | `starting` | `.chip.chip-accent.chip-live` Starting | `{provider}` · `{model}` |
  | `waiting` | `.chip` + dot, Idle | `{provider}` · `{model}` · `{tokens}` · as of `{HH:MM}` · after a failure: · last task failed |
  | `stopping` | `.chip` + dot, Stopping | `{provider}` · `{model}` · `{tokens}` |
  | `done` | `.chip.chip-success` Done | `{provider}` · `{model}` · `{tokens}` · as of `{HH:MM}` |
  | `error` | `.chip.chip-error` Failed | `{provider}` · `{model}` · `{tokens}` · as of `{HH:MM}` |
  | `killed` | `.chip` + dot, Stopped | `{provider}` · `{model}` · `{tokens}` · as of `{HH:MM}` |
  | `restored` | `.chip` + dot, Restored | `{provider}` · `{model}` · `{tokens}` · as of `{HH:MM}` |
  | `restored`, mid-task at the restart (`interruptedAt`) | `.chip.chip-warn` Interrupted | `{provider}` · `{model}` · `{tokens}` · as of `{HH:MM}` |
  | a team member whose `ejectedAt` is set (§app.teams/seats) | `.chip` + dot, Ejected, **before** the status chip, which stays | unchanged |

  **Tokens** are that worker's own running total (input + output, mono, the same §chat/context-window format and
  the same split-and-cost `title` as the head's Σ). A worker that has spent nothing yet shows
  none, and so does a worker from a pi-config that doesn't publish counts: the meta line then
  reads exactly as it did before. It is one worker's spend, never the Σ.
  "As of" is `endedAt`, else `lastActivity`, mono 24-hour, the full ISO time in `title`. **Only a
  live-sourced Working or Starting chip pulses**, so each row has one pulsing thing at most.
  **Restored** workers (§app.worker-restore/restore) are the ones the session recorded before a
  server restart: no process runs them and they never pulse. One that was idle at the restart
  reads Restored, one that was mid-task reads Interrupted (warn: the turn it was on never
  finished), and one that had ended keeps its ending's chip. Usage rebuilt from a snapshot says
  so in the `title` ("$0.41 as of {HH:MM}"), and a worker whose usage can't be read shows
  "usage unavailable" in the tokens' place, never 0. While
  the pane's connection is down, nothing pulses and every row reads "as of" the last update.
- **Context ring.** Each row shows how full that worker's **own** context is
  (§app.subagents-pane/context-fill) as the session row does: §chat.context-window/sidebar-ring's
  12px ring, the same `contextStep` warn (≥80%) and error (≥95%) steps, and a `title` that is the
  view head's exact sentence ("Context: 64,210 of 1,000,000 tokens (6%), as of the last reply.").
  It sits in line 1's status slot, before the chip, not on the meta line: there the name gives
  up the 20px, and the meta line, already the row's tightest, keeps every fact. It is a different
  fact from the tokens beside it, which stay: the tokens are what the worker has spent, the ring
  how close its next reply is to its limit. No ring when there is nothing honest to draw — no fill
  yet, a fill with no known window, or a compaction since the last reply — exactly the sidebar
  ring's three cases (§chat.context-window/sidebar-ring's table); for a worker, what words there
  are to say live in the pane's view head ("Context compacted", "Context 64k" with the window
  unknown — and before the first reply there is nothing yet to say). For the selected worker the
  ring follows the open transcript's value, so row and head never disagree.
- **Order.** Working first, then the most recent activity first. Rows keep their identity across
  updates, so a row never jumps under the pointer except when its status changes.
- **Selected** is `aria-current="true"`: the house accent tint (like a selected session row) plus
  a semibold name, so the state isn't hue alone. Hover is sunken. Focus-visible is the ring, inset.
- **Selection.** Opening the pane selects the first row if nothing is selected yet. The
  selection is sticky while the pane is open: if the selected worker drops out of the live list,
  its last known record, and so its transcript, stays shown until you pick another row or close
  the pane. That keeps a finished worker's transcript readable after the parent prunes it.

## §app.subagents-pane/transcript-view — Transcript view

A nested, read-only session view: **no composer, no Send, no Steer, no Stop, no attach**, and
no disabled composer with a reason either. The one exception is a restored worker
(§app.worker-restore/restore). Under its view head, a `usage-note` says what happened: a
`restored` one reads "Not running since a server restart." (interrupted: "Not running since a
server restart; it was mid-task at {HH:MM}, and that turn never finished."). When the worker is
`resumable` (a session this server hosts, on a backend that resumes), the note adds "Resuming
starts it idle; nothing is sent to it." and a **Resume Worker** button (`.button.button-sm`,
"Resuming…" while busy) follows (§app.worker-restore/resume). A worker that had ended shows only
that sentence and the button. A failed resume adds an alert, "Couldn't resume {name}. {reason}
Nothing else changed." The transcript itself stays read-only. A worker's session belongs to its worker, and the
webapp never writes to it (CLAUDE.md: no file locking).

```html
<div class="subagents-view">
  <header class="subagents-view-head">
    <h3 class="subagents-view-title">designer</h3>
    <span class="chip chip-accent chip-live"><i class="chip-dot"></i>Working</span>
    <p class="subagents-view-meta meta-line"><span class="text-mono">ag_03</span> <span><span class="meta-line-sep" aria-hidden="true">·</span> anthropic</span> <span class="text-mono meta-line-shrink" title="anthropic/claude-opus-5"><span class="meta-line-sep" aria-hidden="true">·</span> opus-5</span> <span><span class="meta-line-sep" aria-hidden="true">·</span> effort <span class="text-mono">medium</span></span> <span class="text-mono" title="18.4k in · 5.3k out · 242k cache read · 32.1k cache write · $0.41"><span class="meta-line-sep" aria-hidden="true">·</span> 23.7k tokens</span> <span><span class="meta-line-sep" aria-hidden="true">·</span> <span class="context-readout"><span class="context-gauge" title="{the sentence}"><span class="context-label" aria-hidden="true">Context</span> <span class="context-value" aria-hidden="true">64k / 1M · 6%</span><span class="context-pct" aria-hidden="true">6%</span></span><span class="visually-hidden">{the sentence}</span></span></span></p>
  </header>
  <section class="subagents-transcript pane" tabindex="0" aria-label="designer transcript">
    <div class="subagents-banner stack-2">…banners, or nothing…</div>
    <div class="thread">…the same rows as §chat/transcript…</div>
  </section>
  <button class="button jump-latest subagents-jump">Jump to Latest · 3 new</button>   <!-- scrolled up only -->
</div>
```

- **Sub-header.** `.subagents-view-head` names the worker on surface above the scroll region, so
  it never scrolls away (sticky by construction, not by `position: sticky`). The title is body
  semibold, then the same status chip as the row, then a meta line: the id in mono, then the
  provider, then the model, then **the effort** (`effort {level}`, the level in mono; a worker
  that reports none shows nothing here), then the worker's tokens, and last the **context readout**
  (§app.subagents-pane/context-fill): the gauge trails the facts that name the worker and what it
  has spent. **The effort leads the count**: what a worker is thinking at is a fact about
  the worker, where the count beside it is a running total that changes under the reader. **A
  separator belongs to the fact it introduces**: each `·` is inside its own fact's element, not a
  sibling before it, so a wrapped line starts with its own dot and no wrap can strand one. The
  model fact's dot is shown only when a provider precedes it: a worker whose provider can't be
  derived opens the line on its model, undotted. The
  token number here is the **open transcript's own**
  total, counted from the file as it is tailed (`/ws/watch` sends it with every `snapshot` and
  `append`), so it ticks while you watch instead of waiting for the next worker snapshot; it
  falls back to the row's number when the server doesn't report one. A Claude Code transcript
  carries no cost, so that `title` shows counts only.
  The head repeats the row on purpose: in list/detail, the list
  isn't on screen. There, the back button leads the head, and title, chips and meta sit beside
  it in `.subagents-view-id`.
- **Context readout.** Last in the meta line, after the tokens, the meta line carries the worker's
  context fill (§app.subagents-pane/context-fill) as the chat head says it
  (§chat/context-window): "Context 64k / 1M · 6%", plain text, the same format, steps, glyph at
  ≥95% and sentence (`title`, and a visually hidden copy for AT), "Context compacted" after a
  compaction, "Context 64k" when the window is unknown, and nothing before the first reply. Like
  the tokens it is the **open transcript's own** value, recomputed on every `snapshot` and
  `append`, and falls back to the row's. It isn't in a `.session-head`, so the head's width
  steps don't apply; it collapses to the percent ("6%") when the pane itself is under 480px, and
  never disappears on a phone. The meta line wraps to a second line rather than clip the facts at
  its end, and because each dot belongs to the fact it introduces, a wrapped line begins with that
  fact's own `·` rather than leaving a dot stranded at the end of the line above.
- **Thread.** The same §chat/transcript rows, capped at the transcript column (`--measure` + `--space-9`) and
  centred, 16px side padding. Auto-follow and Jump to Latest behave exactly as §chat.transcript/live-watch.
  `.subagents-jump` is `.jump-latest` held inside the view's width.
- **Banners** go in `.subagents-banner`, sticky at the top of the scroll region, taking no space
  when empty, like `.transcript-banner`.

| State | Renders in `.subagents-view` |
|---|---|
| No workers (the list is empty) | `.empty.subagents-empty`, no view head: **0 subagents in this session.** Workers it starts show up here while they run. The list is empty, not hidden |
| Workers, none selected | `.empty.subagents-empty`: **{n} subagents, {w} working.** Pick one to read its transcript. |
| Workers list couldn't be fetched | `.banner-warn`: **Couldn't load this session's subagents.** {message} Your workers keep running. We'll retry on our own. Whatever is shown stays |
| Selected, file empty (just started) | View head, then `.empty.subagents-empty`: **0 entries in {name}'s session so far.** Entries show up here as it writes them. |
| Loading (after 300ms) | View head, then §chat/transcript's loading skeletons in the thread. `aria-busy="true"` on the section |
| Selected, no session yet (Claude Code worker) | View head, then `.empty.subagents-empty`: **Its transcript isn't available in Sova.** `{name}` is starting — no Claude session yet. Latest: {preview, mono}. (Pi worker from an older pi-config: …runs on a pi that doesn't publish its session file yet.) |
| File gone, first load | View head, then `.empty.subagents-empty`: **Couldn't find this worker's transcript.** `{path}` is gone (a claude-code worker reads `Claude session {id}`). Nothing else changed. |
| File gone after loading | Keep what's shown. `.banner-warn` in the banner slot: **This transcript's file is gone.** What's shown is up to `{HH:MM}`. |
| Connection lost, retrying | Keep what's shown. `.banner-warn`: **Stopped watching. The connection dropped.** What's shown is up to `{HH:MM}`. Reconnecting… (§design.copy-deck/live-watch). Pulses stop |
| Gave up | `.banner-error`: **Lost the connection to the Sova server.** Nothing in the session changed. Check `pnpm run dev:server` is running, then retry. · `Reconnect` |
| Other load error | `.banner-error`: **Couldn't load this transcript.** The file at `{path}` wasn't changed. {server message} · `Retry` |

A settled worker's transcript stays readable: Done, Failed and Stopped workers keep their rows
for as long as the parent lists them, and a selected one stays shown after that (sticky
selection, above).

## §app.subagents-pane/context-fill — Each worker's context fill

A worker's fill is §chat.context-window/last-reply applied to **that worker's own transcript**:
input + cache read + cache write of its last reply that measured the context (a failed, aborted,
synthetic or zero-usage reply is passed over), "compacted" when a compaction came after it, and
nothing before its first such reply. Never 0 for unknown. It rides the wire as
`WorkerInfo.context` (`ContextInfo` or `"compacted"`, absent when unknown) and
`WorkerInfo.contextWindow`, and on `/ws/watch` as `context` on every `snapshot` and `append`
(a fill, `"compacted"` stated explicitly, or `null` before the first reply).

- **Both backends, one rule.** A pi worker's reply carries `usage.input`, `cacheRead`,
  `cacheWrite`; a Claude Code worker's `input_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, on every line the CLI repeats a reply on. Claude Code's
  `isApiErrorMessage` and `<synthetic>` replies count as failed, a `compact_boundary` as a
  compaction, and nested agents' (`isSidechain`) lines are their own context, so they are skipped.
- **Live workers** publish spend only (the live registry's schema is unchanged), so the server reads
  the fill off the **tail of the worker's transcript**, backwards from the end (16KB steps, 256KB
  at most), like the sidebar ring, and only again when the file's mtime or size moved. It lags a
  turn in flight exactly as §chat.context-window/honesty says a TUI row does: never wrong, only
  late. Only a local file is read: a pi session file the rest of the API accepts, never one under a
  remote target's placeholder tree, or the Claude session record `?claude=` reads. Anything else
  has no fill, never a 0.
- **Restored workers** take it from their transcript summary: the worker-transcript protocol's
  additive `lastContextTokens` (a number, or `null` when a compaction followed it), read by each
  backend's adapter over the worker's own branch or main chain.
- **The window** is the one the worker was **spawned** with. claude-code: the provider's rule, a
  `[1m]` alias is 1,000,000 and anything else 200,000 — and the model is the spawn model (the
  manifest's spec, else its last snapshot's biggest row), never the transcript's, which is the bare
  id and would drop the `[1m]`. A live row's model already carries it; a restored or resumed one
  names what it ran under, so the session's manifests supply it, and the row's model takes the spawn
  model's variant too: a restored `opus[1m]` worker reads "opus-5.5 1M", like its 1M ring and head. pi: the model's catalog window,
  and a fill takes its own reply's model's window when that differs.

## §app.subagents-pane/claude-code-workers — Claude Code workers

A worker on the claude-code backend writes no pi session file; it writes its own Claude Code
transcript at `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, and the live record gives us the
session id (`WorkerInfo.sessionId`). Its meta line's provider reads `claude code`: this backend
names its own route rather than an LLM provider. The viewer opens `/ws/watch?claude=<uuid>` instead of
`?path=`; the server finds the file by scanning the project dirs (id must be a UUID, the resolved
file must stay inside `~/.claude/projects`; `server/claude-transcript.ts`) and tails it read-only
like any other. CC's JSONL is normalized into the same `TranscriptItem` rows, each carrying a
pi-shaped synthetic `raw`, so every row renders through the existing components: prose, thinking
(redacted signature-only blocks are dropped), tool calls paired with their results (CC's `Bash`,
`Read`, `Edit`, `Write`, `Glob`, `Grep` map to pi's names and icons; anything else keeps CC's
name), compaction boundaries as info rows. Image blocks (`{type:"image", source:{type:"base64",
media_type, data}}`), in a tool result or a prompt, become the row's `images` as data URLs, the
same field a pi row fills, so a worker's image results show in its tool cards as a pi session's
do (§chat.images/thread-thumbnails); they never become placeholder text. Sidechains (a
worker's own Task agents), injected meta prompts and CLI bookkeeping lines produce nothing. Arguments are CC's own (`file_path`,
`old_string`), so an edit/write card shows JSON rather than pi's diff view. Read only, always:
nothing is ever sent to a Claude Code session.

## §app.subagents-pane/narrow-viewports — Narrow viewports

Folded (< 768), the pane is **full screen over the session view**. It isn't suppressed: on the
phone this is the only way to watch a worker without leaving the session, and it costs nothing
when closed. It's list/detail (Body, above). Close stays in the head at the right,
in the thumb arc, and Esc works with a keyboard. There's no swipe to dismiss, since a gesture is
never the door. The browser back button doesn't close it, because the pane isn't a route.

## §app.subagents-pane/accessibility — Accessibility

- **Landmark.** `<aside id="session-pane" aria-label="Session detail">`, a complementary landmark.
  The id is tab-neutral, because every trigger opens the same pane on its own tab: the composer's
  subagents row, the composer's inputs row (§chat/timeline) and the head's Session details button all point
  their `aria-controls` at this one id. The pane is in the DOM only while open, so that reference
  dangles while it's closed — intended, and the same pattern the subagents trigger has always had.
- **Opening** moves focus to the selected row, or the first row. With no rows, it goes to the
  close button.
- **Focus order** follows the DOM: head (close), the rows, then the transcript section
  (`tabindex="0"`, so the arrow keys and PageUp/PageDown scroll it), its banner actions, and
  Jump to Latest. In the column band, Tab from the session's composer reaches the pane next.
- **Esc** inside the pane closes it, unless a popover or menu inside it is open (that closes
  first). Focus returns to the trigger if it's still rendered, or else to the session's
  transcript section (`#transcript`). The same happens after Close.
- **Rows.** Each is a `<button>` in a labelled list. The selected one carries
  `aria-current="true"`. Its name reads the name, status word, and meta in order.
- **No aggressive live regions.** The pane announces nothing on updates: no `role="log"`, no
  `aria-live` on the list, the chip, or the thread. Status words are text, and a user who wants
  them reads the row. The session's single polite region (§chat/transcript) stays the only one.
- **Contrast.** Everything here is an existing pair: muted on accent-tint (the selected row's
  meta) is 5.05 (dark) and 4.68 (light), ink on accent-tint is 12.57 and 14.57, and muted on
  surface and sunken are already measured (§chat/transcript).

## §app.subagents-pane/motion — Motion

Opening, the pane fades in and slides 24px from the right over `--dur-base` with
`--ease-standard`, in every band. Closing is instant: the aside unmounts, and a surface that's
leaving shouldn't hold the eye. The column doesn't animate its width, because the thread
reflowing mid-animation is worse than a jump. Under `prefers-reduced-motion`, the slide goes
(the animation becomes `enter-fade`) and `tokens.css` collapses its duration. The live pulse is
the existing one.

## §app.subagents-pane/tokens — Tokens

Three new layout tokens in `tokens.css`: `--main-min` (440px), `--subagents-width`
(`clamp(520px, 40vw, 880px)`), `--subagents-list-width` (256px). **No new colors.** The pane uses
surface, paper, sunken, border, accent-tint for the selected row, and the §app/insights chips.

## §app.subagents-pane/rejected — Rejected

- **A route (`#/s/<path>/agents/<id>`).** Back would then close panes and walk through workers,
  where it should walk through sessions. The pane is a view of the session, not a destination.
- **Squeezing the thread to fit the column below 1280.** At 933 it leaves the conversation
  under 100px wide. The drawer keeps it whole underneath.
- **Hiding the sidebar to make room.** It moves the one navigation surface depending on
  whether a side panel is open.
- **Suppressing the pane when folded.** It removes the feature from the device the product is
  designed for.
- **A tab strip for workers.** Tabs truncate names at 3 workers, and they can't carry status
  and meta. The list can.
- **Opening `#/agents` from the trigger.** That's a different question (every session) and
  leaves the conversation.
- **A pressed or tinted trigger while open.** It adds a state that the pane beside it already
  shows.

---

