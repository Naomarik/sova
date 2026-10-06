# §app/insights — Insights
> Part of the Sova design spec · [overview](../design/overview.md)

What the user's pi extensions publish, read-only except for one cache: subscription usage
(usage-status), which this server also keeps fresh itself (§app.insights/usage-refresh), teams and
subagents (subagents + sessions live records), the LLM calls in flight and their output-token ring
(each process's own count in its live record, and each connected host's own count,
§app.insights/llm-inflight, §app.insights/token-velocity), and
per-session summaries (topic-outline, compaction). Data shapes are `UsageInsight`, `AgentsInsight`, and `SessionInsight` in
`shared/protocol.ts`. **Every status says where it came from**: live-sourced states can pulse,
while reported states (read from a session file after the fact) never pulse and carry
"as of `2:06 PM`". A live record lists at most 40 workers, live ones first and then the newest
(§app.subagents-pane/hidden-workers), so a count is always read from its `workerCounts` and a
working worker is never the one it leaves out.

## §app.insights/placement — Placement

- **Global:** two main-pane pages, each about one thing, entered from two pinned `.sidebar-foot`
  rows:
  - **`#/usage`** covers subscription limits.
  - **`#/agents`** covers teams and subagents. Team deep links are `#/agents/{teamId}`.

  The head is full at 320px (§app/session-list). A third sidebar region would scroll away and mix non-session
  data into the session list. An overlay would hide the transcript. The foot is always visible,
  sits in the folded thumb arc, and needs no rail. At folded width both pages use
  `data-view="session"` and show `.app-back`.
- **Old URLs:** `#/insights` redirects to `#/usage`, and `#/insights/{teamId}` to
  `#/agents/{teamId}`, via `history.replaceState`, so no extra history entry is added.
- **Per session:** `details.outline` (the Current goal strip) sits directly under `.session-head`,
  above the live banner.
  Compactions stay in the transcript, at the point where they happened (§chat/transcript items).
- **Aggregates:** neutral count chips on session rows and in the session head.
- **All explanations:** their own page, `#/explanations` (§app.insights/explanations-page), entered
  from the overview's Explanations card (§chat/transcript) and from a session's insight strip, not
  from the foot. The sidebar foot has no Explained row — a grid of pages is not a doorway that
  fits a 44px row.
- No toasts, and nothing is announced on a poll.

## §app.insights/sidebar-foot — Sidebar foot

```html
<!-- after nav.sidebar-list, outside the pane -->
<div class="sidebar-foot">
  <div class="sidebar-foot-row">
    <a class="list-row list-row-interactive insights-row sidebar-foot-link" href="#/usage" aria-current="page"
       title="Usage&#10;Claude 5-hour: 10% used · 2h 10m of 5h · resets 6:59 PM; 7-day: 47% used · day 4 of 7 · resets Oct 9 10:00 PM&#10;OpenAI 7-day: 95% used · day 2 of 7 · resets Oct 8 9:30 PM&#10;…"
       aria-label="Usage: Claude 5-hour: 10% used · 2h 10m of 5h · resets 6:59 PM; 7-day: 47% used · day 4 of 7 · resets Oct 9 10:00 PM. OpenAI 7-day: …">
      <span class="icon" style="--icon: url(/icons/gauge.svg)" aria-hidden="true"></span>
      <span class="insights-row-text usage-glance">
        <!-- a two-window provider: the short window thin on top, the long one below -->
        <span class="usage-glance-item"><span class="usage-glance-tag">C</span>
          <span class="pace pace-two" aria-hidden="true">
            <span class="pace-bar pace-bar-thin"><span class="pace-fill" style="--pace-pct: 10%"></span><span class="pace-tick" style="--pace-at: 43%"></span></span>
            <span class="pace-bar"><span class="pace-fill" style="--pace-pct: 47%"></span><span class="pace-tick" style="--pace-at: 50%"></span></span>
          </span></span>
        <span class="usage-glance-item"><span class="usage-glance-tag">O</span>
          <span class="pace" aria-hidden="true"><span class="pace-bar"><span class="pace-fill pace-fill-error" style="--pace-pct: 95%"></span><span class="pace-tick" style="--pace-at: 29%"></span></span></span></span>
        <span class="usage-glance-item usage-glance-item-stale"><span class="usage-glance-tag">OL</span>…</span>
        <span class="usage-glance-item"><span class="usage-glance-tag">Z</span>…</span>
        <span class="usage-glance-item"><span class="usage-glance-tag">DS</span><span class="text-num">$4</span></span>
      </span>
    </a>
    <!-- the Resource monitor button, §app.resource-monitor/entry-button -->
    <button type="button" class="button button-icon sidebar-settings"
            title="Resource monitor" aria-label="Resource monitor">…activity…</button>
  </div>
  <!-- aria-current on #/agents and #/agents/* -->
  <a class="list-row list-row-interactive insights-row" href="#/agents"
     title="Agents: 7 agents working now: 2 sessions and 5 subagents. Output tokens a minute: 48k over the last 5 minutes, 12k over 30. Replies still being written aren't counted yet."
     aria-label="Agents: 7 agents working now: 2 sessions and 5 subagents. Output tokens a minute: 48k over the last 5 minutes, 12k over 30. Replies still being written aren't counted yet.">
    <span class="icon" style="--icon: url(/icons/worker.svg)" aria-hidden="true"></span>
    <span class="agents-ticker">
      <span class="agents-line">
        <span class="insights-row-text"><span class="text-num">7</span> agents</span>
        <!-- §app.insights/token-velocity: the 5-minute mean -->
        <span class="agents-readout" aria-hidden="true"><b class="text-num">48k</b> <span>tok/min</span></span>
      </span>
      <span class="agents-chart" aria-hidden="true">
        <!-- 180 = 30 columns × the measured 6px pitch at the 320px pane -->
        <svg class="velocity-chart" width="180" height="18" viewBox="0 0 180 18">…30 columns, baseline, dashed 30-minute mean…</svg>
        <span>30m</span>
      </span>
    </span>
  </a>
</div>
```

**Unfolded (≥768)** the foot holds **two stacked rows, and both are always present**, so the layout never
jumps: the Usage row is 44px and the Agents row 64px, the extra 20px holding the token chart
(§app.insights/token-velocity) on a second line. Those two are the foot's only rows: it has no
Shares row, and the spine's foot has no Shares button — the Shares page is reached from the
overview's Shares card (§chat.transcript/landing-page) and from each Sharing section
(§app.session-share/shares-page). **Folded (<768) none of this shows**: a
phone's foot is one bar that opens a sheet holding these same rows verbatim
(§app.insights/sidebar-foot-phone). Each row is a `.sidebar-foot-row`: the whole-row link, then one 44px icon button at its
right end — the **Resource monitor** button on the Usage row (§app.resource-monitor/entry-button),
the Settings gear on the Agents row (§app/settings-dialog) — with one class between them, so the
two buttons stack in one column. The link's own bottom border divides the rows, and the row draws
the same line under its button, so the divider runs the full width. A single row split into two
links was rejected: 288px divided in two truncates "Claude 5-hour 96%". Neither row has a chevron.
They're whole-row links with a hover state and the `aria-current` tint, like session rows, and the
Usage glance needs the room.

- **Usage row, a glance at every provider:**
  - One segment per provider, in the fixed order Claude, OpenAI, Ollama Cloud, Z.ai, DeepSeek.
    The tags are exactly `C`, `O`, `OL`, `Z`, `DS`, each followed by a **pace meter**
    (§app.insights/pace-tick): a `.pace` box 20px wide holding the provider's bars, with no number
    beside it (the numbers are in the row's words, below). **A provider that reports a balance
    instead of windows (DeepSeek) shows the money, not a meter**: `DS $4`, mono, in `.text-num`.
    It has no quota, so there is no percentage to invent; its segment goes last, like its card.
  - **Two precisions for the one balance.** The foot is a shorthand, so it rounds to **whole
    currency units** ($4.29 → `$4`, $4.99 → `$5`; `moneyCompact()`, both fraction-digit options
    set to 0). The row's `title`/`aria-label` and the Usage card keep the **exact** amount
    ($4.29, "Topped up $4.29"; `money()`) — the cents stay one hover, or one click, away.
  - **Bars.** A two-window provider draws two stacked bars, its short window as a 2px bar on top
    and its long one as a 4px bar under it, 1px apart: Claude's 5-hour over the window flagged
    `active` when that is a 7-day one (a 7-day Fable, say), else its 7-day; Z.ai's plan window
    (5-hour) over MCP uses. A one-window provider draws one 6px bar: OpenAI the window flagged
    `active` (the first one, if several are), else its 7-day, else its longest; Ollama its Monthly.
    Never Claude's Opus-only window. A provider sending only one of its two windows draws that one
    as a one-window provider does. A window of the pair with no current reading (its reset
    passed) keeps its place as an empty track, so the meter's shape never jumps.
  - **Which Claude login.** A device can hold several Claude logins (§app/claude-logins), and `C`
    reads one of them: **the open chat's recorded login** (its newest `claude-login` entry, as the
    chat's `claude_login` message names it, §app.claude-logins/active-login; before that message,
    the login the composer shows as known, §chat.composer/known-on-switch, so the glance doesn't
    jump on a switch), else **the login in
    use for new chats** (`claudeLogins[].inUse`: the first ready one in the device's order) — for a
    chat that has not recorded one yet, a TUI-watched session, a workspace pane that isn't a chat,
    and every page with no session open. Only with neither (an older server without
    `claudeLogins`, or no login ready) does it read `providers`' `claude`, Claude Code's own
    login. Its reading is that login's account card on the Usage page (the account's freshest
    reading that still has a current window, else its freshest: its logins share one quota), so the meter follows a failover in the same poll. The visible segment stays `C` and its meter: the glance has no room for a name. With
    more than one login, the row's `title` and `aria-label` name it after "Claude", by its card
    title (its email, else its label): "Claude (spare@example.com) 7-day: 61% used · …". With
    one login nothing is named, as before. `C` never pools accounts (a chat runs on one login),
    but the words then add one line per **other** account usable on this device — its logins on
    this device, never one another device holds or the pool keeps free; logins sharing an
    `accountUuid` are one account, never counted twice — each its account card's reading in the
    same form: "Claude (own@example.com) 5-hour: 0% used; 7-day: 40% used · day 3 of 7 · resets
    Oct 4 10:59 AM", or "… reading pending".
  - **Only current windows.** A window whose `resetsAt` is behind now is not a current reading:
    it is never one of the glance's bars (the choice above is made among the rest), and it never
    reaches the foot's fill, its tone or its words.
  - **Pending Claude reading.** `C` never swaps in another account's number. When the chosen
    login's reading has no current window (it was never read — a login just taken — or every
    window's reset has passed), the segment is a muted pending `C` meter
    (`.usage-glance-item-pending`: the stale item's muted ink, its two tracks empty and faded, no
    fill, no tick, never a tone), and the row's `title` and `aria-label` name the login, even
    when it is the only one, and say its reading is pending: "Claude (spare@example.com)
    reading pending".
    Claude Code's own login is read instead only when no login is chosen (the older server or
    no-login-ready case above). A chosen login in another not-`ok` state (signed out, sign-in
    expired) is missing data.
  - **Missing data.** A provider that isn't `ok`, or has neither windows nor a balance, is left
    out. With nothing at all, the row reads "Usage".
  - **Tone.** Each bar's fill is neutral ink, `warn` when its used share runs more than 10
    points ahead of its tick, `error` at 90% or more, and, with no tick, `warn` from 80%
    (§app.insights/pace-tick, **Foot fill tone**). The hue is the meter's own status; the row's
    words carry the numbers. A balance has no bar: it takes `.usage-glance-item-high`
    (semibold ink, no hue) when the provider says it can't fund calls (`available: false`), out
    of credit being the only bad state money has.
  - **Stale.** Only when the whole cache file is old (`usage.stale`) the item takes
    `.usage-glance-item-stale`: muted, its fills muted ink with no tone, and no added text. A provider's own failed fetch — including
    the last known reading served while an older pi session rewrites the cache — neither dims nor
    annotates its item.
  - **Full text.** The row's `title` and `aria-label` spell everything out, every bar of every
    provider, in the meter's words (§app.insights/pace-tick, **Words**): the `title` is "Usage",
    then one line per provider ("Claude 5-hour: 10% used · 2h 10m of 5h · resets 6:59 PM; 7-day:
    47% used · day 4 of 7 · resets Oct 9 10:00 PM", "DeepSeek balance $4.29" — the exact amount,
    not the rounded one), then the other Claude accounts' lines; the `aria-label` is the same
    after "Usage: ", the lines joined by ". ". Nothing is appended for a stale file.
  - **Width.** The monitor button takes 52px of the row, so the glance is **tightened**:
    segments sit `--space-2` apart (twice the tag-to-meter gap, so each still reads as one
    pair), and the link's right padding drops to `--space-2`, since the button carries its own
    air around its icon. Measured in the 320px sidebar at a 1440px viewport, the glance box is
    215px, and the meters have a fixed width, so the row no longer grows with its readings: four
    meter providers plus `DS $4` is 207px whatever the percentages (22px meters made it 215.3px,
    a clip). A number beside each meter was rejected: about 30px more per provider overruns the
    box. `.usage-glance` still clips
    (it never wraps) as a guard; the full reading stays in the row's `title` and `aria-label`.
- **Agents row, what is working right now:** `{n} agents` and how fast the agents are writing, on
  two lines in one 64px whole-row link, the gear centred at its right.
  - **The figure** is the working count (§app.session-list/working-now): the sessions whose own
    turn is running plus the subagents working, on this host and every connected host — the sum
    of the toolbar's breakdown line, so the two never disagree. It is printed short as agents:
    `{n} agents` (`1 agent`). A known count always shows the bare number, `0 agents` included: a
    floor (a connected host that isn't answering) is marked by no `+` or `~`, only by its
    sentence (below). The word follows the number shown, floor or not: `1 agent`, every other
    figure `agents`. While it is unknown the segment is the plain word "Agents", with no figure,
    never a 0. No other figure follows it in words — the breakdown is the toolbar line's — and
    teams are never counted (their members are subagents already).
  - **The velocity** (§app.insights/token-velocity): line 1 ends with the readout, `48k tok/min`
    (the figure semibold ink at body size, the unit muted micro), never shrunk or cut — `{n}
    agents` truncates first; line 2, aligned under the text, is the 30-minute column chart, full
    width, then a muted `30m`. `–` and the bare baseline while unknown, so the row never changes
    height.
  - **The scrub** (§app.insights/velocity-scrub): hovering the chart with a mouse, or holding the
    row still for 500ms with a thumb or pen and then dragging, reads one column out in a card
    above the pointer. While a mouse scrubs, the row's `title` is dropped and comes back when it
    leaves the chart; a click still opens Agents, and a hold never does.
  - The LLM calls in flight (§app.insights/llm-inflight) are not on the row, in its words or
    anywhere else in the sidebar.
- **The row's full sentence** lives in its `title` and `aria-label`: the destination, the working
  count's sentence, then the velocity's sentence — "Agents: 7 agents working now: 2 sessions
  and 5 subagents. Output tokens a minute: 48k over the last 5 minutes, 12k over 30.
  Replies still being written aren't counted yet."; "Agents: No agents working now. Output tokens
  a minute: …"; "Agents: Agents working now: not known yet. Output tokens a minute: not known
  yet." Each sentence ends in exactly one full stop.
  The row itself has room for the figures, not for the sentences.

The rows take no chip, because the pages carry the status, and no color but the usage meters'
fill tone. Each truncates with an ellipsis.

## §app.insights/sidebar-foot-phone — The foot on a phone: one bar, one sheet

Below 768px the sidebar foot is **one 44px bar** under the list, never the rows: on a phone the
list needs the room. The bar is one plain button; tapping it opens a **bottom sheet** (the
folded-width `.modal`, grip included; the scrim and Escape close it, focus is trapped inside and
returns to the bar) holding the foot's columns **exactly as §app.insights/sidebar-foot draws
them** — the host filter row (§mesh.remote-sessions/host-filter, only while the mesh is on), the
Usage glance row with its monitor button, and the Agents row with its Settings gear; it has no
Shares row (the Shares page is the overview's Shares card's, §chat.transcript/landing-page).
Nothing in them is rewritten, only re-homed: the Agents row's chart scrubs in the sheet
too, by a 500ms hold on the row and then a drag, and the sheet never scrolls under that drag
(§app.insights/velocity-scrub). At ≥768 the bar never shows and the foot
is §app.insights/sidebar-foot as drawn there; the spine is untouched by either. The sheet's
accessible name is "Hosts, usage and agents".

The bar itself reads the same data as the rows, left to right:

- **Mesh.** The connected count `{up}/{total}`, the host filter row's own figures
  (`connectedCount`) — shown only while the mesh is on, the same rule as the row.
- **Agents working.** The `worker` icon and the Agents row's own figure, the working count
  (§app.session-list/working-now: the bare `{n}` whenever known, a floor too, `–` while unknown),
  no word — the bar is a strip of figures; the accessible name says it. Always shown, a complete
  `0` included.
- **Velocity.** Right after it, the Agents row's readout with a short unit, `48k /min` (`–` while
  unknown), then a 60×16 chart of the last 30 minutes in two-minute columns, the same
  drawing as the row's (§app.insights/token-velocity). The bar stays 44px.
- **Usage caps.** Every provider the glance has a part for — `usageGlance()`'s own parts, in its
  order (at most the five) — each as its `{abbr}` and the same pace meter the glance row draws
  (§app.insights/sidebar-foot, **Bars**, **Tone**; §app.insights/pace-tick), a credit provider as
  its `{abbr}` and money (`DS $4`), and a pending Claude reading as a muted `C` with empty tracks
  (§app.insights/sidebar-foot, **Pending Claude reading**). Each part keeps the glance's own
  emphasis: the meters' fill tones, an out-of-credit balance in **semibold ink**, and a stale
  whole-file reading muted, all as §app.insights/sidebar-foot states. Always shown while any
  provider reports; never an invented number. The bar is one line and never wraps: what a
  narrow phone can't hold clips at the edge, exactly like the glance row it stands for.

The bar's accessible name says the facts in words, then what the tap does: "2 of 3 hosts
connected. 7 agents working now: 2 sessions and 5 subagents. Output tokens a minute: 48k over the
last 5 minutes, 12k over 30. Replies still being written aren't counted yet. Claude
5-hour: 12% used · 1h 5m of 5h · resets 4:59 PM; 7-day: 87% used · day 6 of 7 · resets Oct 4
10:59 AM. Z.ai 5-hour: 41% used; MCP uses: 0% used. Open hosts, usage and agents." —
every glance part in the glance's own words; the agents clause is the working count's sentence
(§app.session-list/working-now): "1 agent working now: 1 session" at 1, "At least 3 agents working
now: …" while a floor, "Agents working now: not known yet" while unknown; the velocity's
sentence follows it (§app.insights/token-velocity). No LLM-calls clause.

## §app.insights/llm-inflight — LLM calls in flight: what the one count counts

**Sova counts the logical LLM calls in flight right now, across this host and every connected
host, and pushes the count to every browser; the sidebar shows no figure for it, but the
output-token ring the load average reads rides the same count (§app.insights/token-velocity).** A logical call is one request a process has sent to a model
provider and is still waiting on or receiving, from the moment it is issued until its response
ends, fails or is aborted. Time spent running tools between calls never counts, and neither does
a request still queued for a provider-limits slot or sitting out a cooldown
(§app/provider-limits): it counts from the moment the slot is granted. Every caller counts alike —
a main thread's turn, a subagent's or team member's, and background work: titles, tags,
decisions, topic outlines, compaction, cache warming.

- **Where it is measured.** Each process counts its own calls, at the boundary every model
  call of that process passes through, and keeps nothing but begin/end bookkeeping and, from each
  call's end, the one number its reply reports as its output tokens (§app.insights/token-velocity):
  no payload, no transcript and no other token count is read or written for it, and nothing is
  written per token. The same boundary, at the same call end, appends the call's usage record
  (§app.insights/usage-ledger); that is the ledger's, not part of this count.
  - **pi** (Sova's own server with its hosted chats and one-shots, a TUI, a pi worker): the
    process's model runtime, which every session, compaction and background caller of that
    process shares. A call is counted once however many wrappers it passes through.
  - **Claude Code.** A chat session on the `claude-code` provider is a pi call like any other: one
    per model request of its stream, until the reply stops for a tool or ends. A Claude Code worker
    counts while its CLI reports it is requesting the model, until that reply ends. Calls the CLI
    makes internally without reporting them (its own subagents, side queries, compaction) can't be
    seen, so while a Claude Code turn runs, in a session or a worker, the count is **partial**
    (below), never a guessed number.
  - **One-shot `claude -p`** (a decision, a title, a topic outline): counted as one call from the
    spawn to the process's exit — **approximate**: the process's start-up and exit count too, so
    for part of that time it may not be calling at all, and what it does inside can't be seen.
  - **Jev** (§app/decisions): from the request to its answer.
- **How a host adds up.** Sova's server reads its own process directly. A subagent's calls reach
  the host through the session that runs it: a pi worker reports its count to its parent over the
  worker's own channel, and a Claude Code worker is observed by its parent, so the parent's count
  includes its workers' (each worker's report replaces its last one, and goes when the worker
  does; until a worker's first report, or after one that can't be read, it is unknown, never 0).
  The parent also names every worker it counts this way, transitively, so a worker that publishes
  a live record of its own as well is never counted twice; past 64 named workers it sums no more
  of them (it can't name them), and its count is partial instead. A detached worker that no running
  session has adopted (after a restart, before it is adopted again) is counted by the server from
  its host's record of the worker's last report, or, with no such report (a Claude Code worker),
  makes the count partial; once adopted, only its parent counts it. Every other process on the host publishes its count in its live record (`presence.llm`,
  `pi-config/extensions/sessions/public/SCHEMA.md`), rewritten only when the count or its coverage
  changes, never per token. A call's output tokens land in that same rewrite, at the moment it ends. The server counts each process once (by its producer id, so a
  process with several live records is not counted twice, and the records its own hosted chats
  write are never added to its own count). A fresh record with no `presence.llm` (a process
  without the counter), and a record whose heartbeat went stale while its pid lives, make the
  host's count **partial**; a dead pid's record counts nothing.
- **Connected hosts.** While the mesh is on (§mesh/peers) and at least one browser is listening,
  the server holds one socket per peer to that peer's **local** count (`/ws/watch?feed=llm`,
  through the peer listener's gate) and adds it once per host. A peer only ever publishes its own
  host's count, never one it was sent, so no count is passed on and summed twice; a peer that
  turns out to be this host, or a host already counted, is not added again. A peer still
  connecting, unreachable, refusing, or too old to answer makes the total **partial** and is named
  in its sentence; it never adds a 0. A peer that answered and then went silent is pinged, and
  past a minute or so without a word its last count is dropped and it is unreachable. A count
  past sane bounds, from a process or a peer, is capped or ignored, never added whole. A dial-out
  pairing (§mesh/lan) gets no socket: its calls are not counted, and it doesn't make the total
  partial. With the mesh off, no browser listening, or a peer removed,
  no peer socket is open.
- **Pushed, not polled.** The count rides the session feed (`/ws/watch?feed=sessions`) as an
  `llm_inflight` frame: a full snapshot on every connect, then a frame each time the total or its
  coverage changes. No browser timer and no per-tab peer socket reads it, and it never triggers a
  re-read of the session list or the Agents page's data.
- **Three states, and only one of them may read 0.** The frame carries them as data; the sidebar
  no longer prints the count or its sentence (its figure is the working count,
  §app.session-list/working-now), so they are for its readers — the token ring's coverage
  (§app.insights/token-velocity), the server's own consumers and any later view.
  - **Complete** — every process on every counted host reports and nothing is known to be
    unseen: the count is exact, `0` included.
  - **Partial** — the count is a floor: `partial` with the gaps that say why (Claude Code's own
    internal calls aren't visible; a process or a host doesn't report).
  - **Approximate parts.** `approximate` says how many of the `{n}` are one-shots (above): neither
    exact calls nor a floor.
  - **Unknown** — the page has no snapshot from the current connection (before the first frame,
    and from the moment the socket drops until the next snapshot). A previous connection's
    snapshot is never used.
- **What it is not.** It is not the number of HTTP requests on the wire, nor every model call any
  program on the machine makes: only processes running the counter report, and its partial
  state says so whenever something is known to be missing.

## §app.insights/token-velocity — Token velocity: how fast the agents are writing

**The sidebar shows how fast the agents are writing: the output tokens a minute over the last 5
minutes as a labelled figure (`48k tok/min`), over a chart of the last 30 minutes, across this
host and every connected host.**

- **What is counted.** Each model call's **output tokens**, reasoning included, exactly as the
  provider reports them for that call — never input, cache reads or cache writes. They are added
  once, when the call ends (done, error or abort: whatever its reply reported by then), spread
  evenly back over the time its reply streamed, from its first streamed event to its end, into a
  ring of 60 thirty-second slots aligned to the epoch (slot *k* holds [*k* × 30 s, (*k* + 1) × 30 s)):
  the last 30 minutes. A 2-minute reply fills four or five slots, not one spike; the part of a reply older
  than 30 minutes is gone. The shares are rounded so a call's slots add up to exactly its count.
- **Where it is measured.** In the counter that counts the calls (§app.insights/llm-inflight), at
  the same boundary: a pi process reads the final message's output count of each call its model
  runtime makes; a Claude Code worker's call takes the last output count its CLI streams for that
  reply. A chat on the `claude-code` provider is counted once, as its pi call, never again by the
  CLI it drives. A one-shot `claude -p` and Jev add no tokens.
- **How it adds up.** As the calls do. A pi worker carries its ring in the report it already sends
  its parent, and the parent sums it with its own; a worker that ends leaves its tokens in its
  parent's ring until they age out (a worker detached for another session to adopt takes its
  tokens with it and goes on reporting them itself). Each process publishes its ring in its live
  record (`presence.llm.tokens`, `pi-config/extensions/sessions/public/SCHEMA.md`); the server
  sums each counted process once, by the same producer rule (a folded worker's tokens are already
  in its parent's), and adds each connected host's own ring once. While anyone listens, a process
  or host that goes (an exit, a dead pid, a stale record, a dropped peer) leaves its last ring in
  the sum until it ages out; tokens from before the server started, or ended while nobody
  listened by processes since gone, are not there.
- **Partial, never a guessed number.** Every gap of the calls count (a Claude Code turn running,
  whose internal calls' tokens can't be seen; an unreported process; a peer connecting,
  unreachable or too old) makes the tokens partial too, and so does a process, worker or peer that
  publishes a count without a ring (an older counter, until its `/reload`).
- **Bounds.** One process's slot is capped at 10,000,000 tokens and one host's at 100,000,000; a
  malformed ring is dropped (its tokens unknown, so partial), never its count with it.
- **Pushed with the count, never per token.** A call's tokens land at the instant it ends, in the
  one change that already rewrites its live record and pushes the `llm_inflight` frame for the
  count's drop. No timer, file or frame is added: time passing alone sends no frame (the browser
  slides the windows itself).
- **The means** are windowed means of the `tokens` ring on the `llm_inflight` frame
  (§app.insights/llm-inflight), computed in the browser by `tokenVelocityView()` in
  `src/lib/llm-inflight.ts`: for a window of W minutes, the tokens of the 2W thirty-second slots
  up to and including the current one (by the browser's clock, epoch-aligned; slots after the
  ring's newest are 0, slots older than its oldest are gone), divided by W.
- **The figure and the chart.** The readout is the 5-minute mean, `48k tok/min` (the phone bar's
  `48k /min`): the headline, since the newest minute under-reads while replies stream. The chart
  draws the last 60 thirty-second slots, oldest left and the current slot last, grouped into
  columns: on the Agents row 30 one-minute columns (two slots each), on the phone bar 15
  two-minute columns (four each). A column is the mean per-minute rate of its slots (a slot's
  tokens × 2), on a scale of the larger of 10,000 and the 30 minutes' peak slot — so a trickle
  stays low and a 100k+ load fills the height. A column with any tokens is at least 2px tall, so
  light load reads as low blocks, never as a scribble on the baseline; an empty one isn't drawn.
  Columns are `--color-ink-2` over a 1px baseline in `--color-border-strong`. The Agents row's
  chart (an `aria-hidden` SVG, 18px tall) is drawn at its line's own width in whole pixels: every
  column has the same pitch, the width ÷ 30 rounded down (never under 3px), with a 2px gap from a
  5px pitch and 1px under it, so no column is wider than another; it starts under the working
  count's text, and a muted `30m` ends level with the readout's right edge, the pixels the pitch
  leaves over going between them. The phone bar's chart is 60×16, 3px columns with a 1px
  gap. The **30-minute mean** is a dashed 1px line (2px dash, 3px gap) in `--status-info`, drawn
  behind the columns: a different hue from the neutral columns in both themes, so it never reads
  as their tops, and a different shape (dashed, horizontal), so it never rests on the hue alone;
  the sentence names the figure in words. It is a reference, not a status, so it takes neither
  the accent (kept for the primary action and the live-run mark) nor a warn or error tone. No
  gradient, and nothing moves, except the Agents row's scrub card as it lifts in
  (§app.insights/velocity-scrub).
- **Dense format**, for the readout: under 1,000 the whole number (`840`); 1,000
  to 9,999 one decimal and `k` (`8.4k`); 10,000 and up no decimal (`48k`, `120k`); a million and up
  one decimal and `M` (`1.2M`). A value is rounded once, to the whole token, before it is formatted,
  and a figure that rounds up into the next tier is printed in that tier (`9,999` → `10k`,
  `999,999` → `1.0M`).
- **Three states, as the calls count has them.**
  - **Complete** — every counted process and host keeps a ring: the bare figure, `0 tok/min` (and
    the baseline alone) included. Sentence: "Output tokens a minute: 48k over the last 5 minutes, 12k over 30. Replies still being written aren't counted yet."
  - **Partial** — the ring says some calls' tokens are known missing: the same figure and chart,
    and only the sentence says so: "Output tokens a minute: at least 48k over the last 5 minutes, 12k
    over 30. Some calls' tokens can't be seen. Replies still being written aren't
    counted yet."
  - **Unknown** — no snapshot on this connection, or a server too old to send a ring: the readout
    `–` over the baseline alone, and the sentence "Output tokens a minute: not known yet."
- **Where it shows.** On the foot's Agents row, the readout after the working count and the chart
  under them (§app.insights/sidebar-foot); on the phone bar after the agents figure
  (§app.insights/sidebar-foot-phone); on the spine, no item of its own: the agents tally's name and
  toast, and the Agents doorway's, end with its sentence (§app.session-list/spine). Every one of
  those names carries the sentence; the figure and chart alone are never the only place it is said.
- **The newest minute is hollow.** Tokens land when a reply ends, so the newest minute reads low
  while replies stream. Its column (the phone's newest two-minute column) is drawn as a 1px
  `--color-ink-2` outline with no fill, a shape and not only a tone, so the dip reads as "not in
  yet", not as slowing down; the sentence's last clause says why. With any tokens it is at least
  4px tall, the least an outline needs to show its hollow; with none yet it draws nothing, like
  any empty column. There is no live estimate.
- **Re-rendered by a local tick.** Between frames the windows and the chart slide with the clock: the sidebar
  re-reads the view every 30 s, only while the ring holds a token in its last 30 minutes and the
  tab is visible. An empty ring, or a hidden tab, runs no timer.

## §app.insights/usage-ledger — The usage ledger: every model call's tokens, recorded once

**Every model call made on this device by Sova or pi (main sessions, the Overseer, org and baton
sessions, workers at any depth, pi or Claude Code, and one-shots: decisions, titles, topic
outlines, image descriptions, compaction, branch summaries, cache warming) writes one usage record
at its end, and every figure of spend Sova shows is read from these records and priced by one
function.** Standalone `claude` use outside Sova and pi is not recorded.

- **The record.** Token counts only, never a price: input, output, cache read, cache write (with its
  1-hour part when the provider reports it), the provider, the model asked for and the model that
  answered, when the call ended, the session that owns it, that session's parent (a worker's
  session), the kind (`main`, `worker`, `overseer`, `oneshot`), the purpose of a side call
  (`title`, `decide`, `outline`, `vision`, `branch-summary`, `compaction`, `cache-warm`, …), the
  working directory and the org project when known, and a key that names the call. A call that
  reports no tokens writes nothing. Each attempt of a retried call is its own record.
- **Where.** `<agent dir>/usage/v1/<UTC day>/<producer>.jsonl`, one file per process and day, one
  writer per file, one appended line per call; the shape and its strict parse are
  `pi-config/extensions/llm-inflight/usage-record.ts` (builtins only). The server's own main loop
  does nothing for a call but that one append.
- **Recorded at the boundary that already counts calls** (§app.insights/llm-inflight): the pi model
  runtime records each call when its stream ends; a Claude Code CLI (a chat on the `claude-code`
  provider or a Claude Code worker) is recorded from its stream, once per Anthropic message id,
  plus what its cumulative per-model totals show beyond those messages (its own subagents, side
  queries, compaction), measured against the last total recorded for that Claude session so a
  resume or re-adoption never counts history again; a `claude -p` one-shot and a Jev call are
  recorded from their answers. A `claude-code` chat's calls are recorded from the CLI's stream
  only, never again by the pi runtime.
- **Whose call it is.** A call belongs to the session that registered with the process; a side call
  made for a session (a title, a summary) carries the session, working directory and purpose its
  caller names, so two concurrent side calls never take each other's owner. A worker names its
  parent session.
- **Counted once.** Records are deduplicated by their key, so a replayed stream or a record read
  twice adds nothing. Nothing is recounted from transcripts: spend from before the ledger existed
  is not shown.
- **Off the main loop.** A helper child process of the server reads the records (at its start it
  catches up every day and every file past what it already read, then follows appends), keeps a
  rollup, prices it and answers every query; the server passes its answers to the browser
  unparsed. The helper stopping or restarting loses nothing and counts nothing twice.
- **Priced at read time, at the price in force at each call's own time**
  (§app.project-costs/pricing): a rollup row never spans a price change, and when the price
  history changes the affected days are priced again from the records. Subscription use (Claude
  Code, Codex) is priced at API prices like everything else.
- **Prices are data.** The dated price history lives in `<state root>/model-prices.json`; the
  checked-in seed is only the starting copy when that file is missing. The server pulls models.dev
  every 6 hours and on demand, and a pull only adds dated periods: an old period is never dropped
  or rewritten.

## §app.insights/cost-history — The Costs tab (`#/agents/costs`)

**The Agents page has two tabs, Board (the board as it was, §app.insights/team-cards) and Costs,
which shows this device's spend at API prices from the usage ledger (§app.insights/usage-ledger).**

- **Route.** `#/agents/costs` opens the Costs tab; it is never read as a team key. The filters live
  in the URL, so a reload or a shared link keeps them.
- **Controls.** Range chips `7d` · `30d` · `All` (30d by default), and beside them multi-select **Provider** and
  **Model** filters; the model choices narrow to the selected providers. The range and both filters
  apply to every section below.
- **Sections.** Stats: Total, Main sessions, Workers, One-shots. A daily cost bar chart (local
  days). Tables by provider, by model (input · cache · output · cost), by kind and by project
  (the org project, else the working directory). Top sessions, most expensive first; a click opens
  the session.
- **Prices.** "Prices as of {date}" with the last change found, and a **Refresh Prices** button that
  pulls the prices now (§app.insights/usage-ledger); it says so when pulling is off or the prices are
  still the starter list.
- **When the helper is down** the tab says the counter isn't running yet and that nothing was lost;
  it never shows another count.
- **This device.** The tab says it counts this device only.
- Works at phone widths: tables stack under 560px of page width.

## §app.insights/velocity-scrub — Scrubbing the token chart: one minute's figures

**The Agents row's 30-minute chart (§app.insights/token-velocity) reads out any one of its
columns: the pointer picks a column, the column stands out, a 1px cursor line runs through it, and
a small card floats above the pointer with that minute's figures.** Of the token charts, only the
Agents row's scrubs — on the desktop foot and inside the phone foot sheet (§app.insights/sidebar-foot,
§app.insights/sidebar-foot-phone); the phone bar's 60px chart never does, and nor do the usage
meters' bars. The Usage page's burn charts have a readout of their own in this same card
(§app.insights/usage-burn).
Browser data only: the card reads the same `tokenVelocityView()` the chart draws from, so the two
can't disagree, and nothing is fetched, sent or stored.

- **Picking a column.** With a mouse, hovering the chart's line picks the column under the
  pointer (`columnAtX()` in `src/lib/llm-inflight.ts`: the x from the chart's left edge ÷ the
  pitch, clamped to the first and last column, so the pixels the pitch leaves over and the `30m`
  label pick the newest). Leaving the chart, or Escape, ends it; Escape keeps it hidden until the
  pointer leaves the chart. A click still opens Agents. With a thumb or a pen, holding the Agents
  row still for 500ms (the session rows' hold, `createHoldGesture`, 10px of drift allowed) starts
  it, with a short buzz where the phone has one (`navigator.vibrate(10)`); then dragging left and
  right moves the pick, the row keeping the pointer and the sheet not scrolling under the finger
  until it lifts. A touch that moves before the hold is a scroll, and a quick tap still opens
  Agents. Letting go, or a cancelled touch, ends it, and the click and context menu the hold
  leaves behind are swallowed, so a scrub never navigates. The row takes no long-press callout or
  text selection. While the ring is unknown nothing scrubs.
- **The chart while picking.** The picked column is drawn in `--color-ink` (the hollow newest
  column as an `--color-ink` outline) while every other column dims to 40% opacity, and a 1px
  `--color-ink` cursor line runs the chart's height through the picked column's centre, on whole
  pixels; an empty column shows the line alone. The baseline and the dashed 30-minute mean keep
  their look. The pick is a line and a fill, never a hue alone. With nothing picked the chart is
  exactly §app.insights/token-velocity's.
- **The card's words**, three lines (`velocityColumnAt()` in `src/lib/llm-inflight.ts`):
  1. The column's time span, mono, on a 24-hour clock in whole minutes, each end rounded down to
     its minute, never seconds: `14:06–14:07`, a column starting on the half minute included;
     the hollow newest column reads `Now`.
  2. Its rate in the row's figure style, the figure semibold ink and the unit muted:
     `38k tok/min` (`denseCount`), prefixed `at least` while the ring is partial.
  3. A muted caption: `3.1× the 30-min average` (the column's rate ÷ the 30-minute mean, one
     decimal); for a column with no tokens `No output`. The hollow newest column is a minute not
     yet over, whose replies count when they finish: with tokens its caption reads as partial,
     `So far this minute · 1.2× the 30-min average`; with none, `Nothing yet this minute`. It
     never claims replies are in progress.
- **The card's look** is the drag ghost's (§app.session-list/drop-overlay): surface fill,
  `--r-lg`, `--shadow-3` and the same 120ms lift (scale .96 to 1), but a neutral 1.5px
  `--color-border-strong` edge, never the accent. The two share one stylesheet rule, so they
  can't drift apart. It is fixed to the window over everything (the sheet and the toasts
  included), placed by a transform, and never takes the pointer.
- **Always above the pointer.** The card is centred on the pointer's x and its bottom edge sits
  14px above a mouse pointer's tip, or 40px above a finger or pen, so the finger never covers it.
  It stays 8px inside the window's left and right edges, and only when there is no room above
  (the window's top) does it go the same distance below. It follows with no transition.
- **Time passing.** The 30 s tick that slides the chart re-reads the picked column too: the
  pointer stays on its column index and the card follows what is now there.
- **Reduced motion.** The lift collapses under the global reduced-motion rule; the card reads
  completely from its end state.
- **Accessibility.** The card and the cursor line are `aria-hidden`, and nothing is announced per
  step: the scrub is an accelerator for the pointer, and the row's `aria-label` keeps the
  velocity's full sentence. While a mouse scrubs, the row's `title` is dropped, so the browser's
  tooltip never covers the card, and it comes back when the pointer leaves the chart.

## §app.insights/aggregate-chips-live-vs-working — Aggregate chips: "Live" vs "Working"

- **Live** is session-level: a TUI has the file open. It keeps the accent everywhere and says
  the same word everywhere: §app/session-list's sidebar row carries it as a **static** `TUI` chip in the rail
  (no dot), and the session head as a **static** `TUI` chip. The pulse moved to Busy and to
  running work; no TUI mark pulses anywhere (§design.ground-rules/motion).
- **Working** is worker-level: a subagent is mid-task. On a member row it's
  `.chip-accent.chip-live` "Working", and pulses only when live-sourced (see Team cards). The one
  aggregate that also says "working" of a session's own turn is the toolbar's working-now line,
  which names the two apart: "2 sessions · 5 subagents working" (§app.session-list/working-now).
- **Aggregates are neutral** `.chip.chip-count`, with no dot and no pulse, so each row has only
  one pulsing thing:
  - **Session rows (§app/session-list):** no chip at all. The count is a bare `{n}`, with no icon, in the row's
    left rail (`.session-rail-count`), under the row's state, when `live?.workers?.working ≥ 1`.
    Hidden at 0 or when absent. `.session-rail-count-live` pulses the figure, and only on a
    row with no Busy dot, whose pulse would otherwise be a second moving thing.
  - **Session head:** no chip at all, working or not, team or not. The count is already the
    sidebar row's rail count, and the head's row goes to the title and
    the context readout (§chat.context-window/width-budget). The Agents page, the composer's
    subagents trigger and the session pane keep their own counts.
  - The count inside a sidebar session row is **never** a link, because an `<a>` can't nest in
    the row's link — and now it sits outside the link, in the rail, as a `tabindex="-1"` button.
    The foot's Agents row is still the way to the page from the sidebar.

## §app.insights/usage-page-and-agents-page — Usage page (`#/usage`) and Agents page (`#/agents`)

Both pages share one shell: a `.session-head` and a `.insights.pane` containing
`.insights-inner`.

```html
<!-- #/usage -->
<header class="session-head">
  <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">…</a>
  <div class="session-head-main">
    <h1 class="session-head-title" tabindex="-1">Usage</h1>
    <p class="session-head-meta">Updated 2m ago</p>            <!-- never read: Not read yet -->
  </div>
  <button class="button button-icon button-ghost" aria-label="Refresh Usage">…refresh…</button>
</header>
<section class="insights pane" aria-label="Usage">
  <div class="insights-inner">
    <!-- stale banner here; no section head, since the h1 names the page -->
    <div class="insights-grid">…usage cards…</div>
  </div>
</section>

<!-- #/agents and #/agents/{teamKey}: the Agents board (§app.insights/team-cards) -->
<header class="session-head">
  <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">…</a>
  <div class="session-head-main">
    <h1 class="session-head-title" tabindex="-1">Agents</h1>
    <p class="session-head-meta">2 working · 5 live · $3.40 today · 3 unmerged</p>
  </div>
  <button class="button button-icon button-ghost" aria-label="Refresh Agents">…refresh…</button>
</header>
<section class="insights pane" aria-label="Agents">
  <div class="insights-inner">
    <div class="board-bar">…search · filter chips · "{n} sessions live or open in Sova"…</div>
    <div class="card board">…one .board-row per session…</div>   <!-- none: ONE .empty instead -->
  </div>
</section>
```

- **Split.** Usage and agents never share a page. The Agents page is the board
  (§app.insights/team-cards): one row per session, its workers counted in a column, and what
  it's about, where it stands and its worktrees folded inside the row. When nothing is in view, its whole body under the bar is one `.empty`
  (§design/copy-deck): the live fact first ("{n} sessions live." or "No session is live right
  now."), then the absence for the chip or search in force.
- **Tabs (Agents).** Under the head the Agents page has two tabs, Board (everything this section
  and §app.insights/team-cards describe) and Costs (§app.insights/cost-history), at `#/agents` and
  `#/agents/costs`.
- **Head meta (Agents).** `{w} working · {l} live · {$} today · {u} unmerged`: sessions in the
  Working state, live sessions, this device's spend since local midnight at API prices, every
  call of every kind (§app.insights/usage-ledger, `GET /api/usage/today`; left out before its
  first answer and while nothing was spent today), and distinct
  unmerged branches among the worktrees read so far (left out before the first reading). The
  line's `title` says what each figure counts.
- **Grid (Usage).** `.insights-grid` has 1 column. It becomes 2 columns when the `insights`
  container is at least 640px wide, and 3 at 1000px or more. The container is named, per the skill.
- **Polling** (frontend's call on intervals). Update in place and keep scroll position and
  focus. Don't show a skeleton again after the first load. The board keys its rows by session
  path, so a poll keeps an open row open and a rename field focused.
- **Loading** (first load, after 300ms). The Usage page shows a skeleton list of 5 groups (one per
  provider it can show), one row each. The Agents page shows 1 skeleton list until the session list has loaded.
  Put `aria-busy` on `.insights-inner`.
- **Request error.** Show `.banner-error` at the top of `.insights-inner` with Retry: "Couldn't
  load usage." or "Couldn't load agents." Any data already loaded stays visible below it. The
  worktrees request never raises one (§app.insights/subagent-cards).

## §app.insights/usage-cards — Usage cards

```html
<article class="card usage-card" aria-labelledby="u-claude">
  <header class="card-head">
    <h3 class="card-title" id="u-claude">Claude</h3>
    <span class="chip chip-warn"><i class="chip-dot"></i>Near limit</span>
  </header>
  <div class="card-body">
    <div class="meter">
      <p class="meter-head"><span class="meter-label">5-hour</span>
        <span class="meter-value">96%<span class="meter-of"> used</span></span></p>
      <div class="meter-track-wrap" aria-hidden="true">
        <div class="meter-track"><span class="meter-fill meter-fill-warn" style="--meter-pct: 96%"></span></div>
        <span class="meter-tick" style="--meter-at: 55%"></span>
      </div>
      <div class="meter-context" title="2026-09-19T07:50:00Z">Resets in 2h 17m · 2h 43m of 5h</div>
    </div>
    <!-- or, instead of meters: <p class="usage-note">Not signed in. Run <code>claude /login</code> …</p> -->
  </div>
</article>
```

- **Summary lead.** Above the grid, one `.usage-lead` line: one sentence per provider that needs
  attention, in payload order ("Claude's 5-hour window is rate-limited — resets in 1h 58m.",
  "DeepSeek is out of credit."), or "All providers under limits." when none does. Claude's
  sentence reads the same login the sidebar foot's `C` does (§app.insights/sidebar-foot, **Which
  Claude login**): with no chat open, the login in use for new chats, never a limited login that
  no chat is on. With more than one login it names it: "Claude (spare@example.com)'s 7-day
  window is at 90%." A window whose reset has already passed adds no sentence, as it decides no
  head chip: a 7-day window at 100% whose reset is gone never reads "quota is used up".
- **macOS hint.** When the payload carries `claudeOwnLoginUnreadable` (macOS, and Claude Code's own
  login is neither in its file nor in a keychain this server can read,
  §app.claude-logins/macos-keychain), one muted `.usage-note` under the lead says "On macOS, add
  your Claude login under Settings → Accounts."
- **Cards.** There's one card per `providers[]` entry, in the order given: Claude, OpenAI,
  Ollama Cloud, Z.ai, DeepSeek. Z.ai follows the system like every other provider: no brand color, and
  the title is "Z.ai"; so does DeepSeek, titled "DeepSeek".
- **Claude: one card per account.** When the payload carries `claudeLogins` (every Claude login on
  this device, §app/claude-logins, in the device's order, `default` included; while the mesh is on,
  also every other login of the pool, §app.claude-logins/pool, each with its `holder`), Claude's
  place holds one card per **account** instead of the single Claude card: logins with the same
  `accountUuid` share one account's usage limits, so they share one card, where the first of them
  falls in the order (§app.claude-logins/registry, **Accounts, then logins**). A login with no
  account is a card of its own. An older server without the field gets the single card.
  - The title is the account's email (else the login's label, else "Claude Code's own login"),
    wrapping rather than overflowing. Under it, the caption reads "Claude · {plan}" with the plan
    as people say it ("Max 20x", "Pro"; never a billing type such as `stripe_subscription`), then,
    for an account of one login, that login's name when it has one worth saying: "Claude Code's
    own login" for `default`, else its label.
  - The account's usage is shown **once**, exactly like any provider card: meters, head chip,
    notes. Its reading is the freshest one among its logins that still has a window whose reset
    is ahead, else the freshest at all (an added login's own entry in the
    cache's `claudeAccounts`, `default`'s `providers`' `claude`, or, for a login another device
    holds or the pool keeps free, the figures its last holder published to the pool: 5-hour and
    7-day), since they all read the same quota (§app.insights/usage-refresh). A login kept free is
    never read, so its published figures never renew: when the reading shown is one, a meter whose
    reset has passed says "Not read while it is free." in place of "New reading at the next
    refresh.". An account of one login keeps that login's sign-in
    caption (from its own `.credentials.json`). With no reading at all, a login never read yet says
    "Not read yet. Its usage shows at the next refresh."; a login marked as needing sign-in is not
    fetched and, without a kept reading, says it is not fetched until Claude Code has signed it in
    again.
  - **Its logins.** The body then lists the account's logins, compactly, under a caption "{n}
    logins in the pool" (the account's logins the pool has; `default` is never one of them, so it
    is listed but not counted) or, with none in the pool, "{n} logins on this device" — for an
    account of one login only when that login is in the pool ("1 login in the pool"). Each row: the login's name
    (§app.claude-logins/registry, **Names**), its standing chip, where it is while the mesh is on
    (**This device**, the holding device's name, **Free**, or **Stuck on** a device), and, for the
    login a new chat would start on — the first usable one in the device's order — a neutral
    `.chip.chip-count` "In use for new chats". An account of one login outside the pool (mesh off,
    or `default`) shows its standing and that chip above the meters instead, with no list.
  - **Standing.** The chip speaks Settings → Accounts' words (§app.claude-logins/device-order):
    **Ready**, **Off**, **Limited until** a time, **Sign in again**, or **Not signed in** — and it
    never contradicts the head chip: a login whose recorded standing is ready while the account's
    reading has a window at 100% whose reset is still ahead reads **Limited until** that reset
    (the reading is the newer fact: the host only records a limit once a spawn has run into it). A
    window whose reset has passed counts for neither the head chip nor the standing: it describes a
    window that is gone.
- **Scoped and active windows (any provider).**
  - A window with a `scope` is labeled `{window} {scope}`, e.g. "7-day Fable", the same form as
    "7-day Opus". It stays in source order, so Claude reads 5-hour, 7-day, 7-day Fable.
  - For the head chip, a scoped 7-day counts as a long window.
  - A window with `active: true` carries a neutral badge inside its label: `<span
    class="meter-label">7-day Fable <span class="chip chip-count" title="The window your current
    model counts against">Active</span></span>`. The badge has no dot, no hue, and no pulse,
    the same pattern as the Orchestrator badge.
- **Z.ai windows.**
  - The plan window is labeled like the others (`5h` → "5-hour"), and takes its reset from
    `resetsAt` when one is sent.
  - `mcp` is "MCP uses", the MCP tool-usage quota, shown as a percentage. Its context reads
    "{used} of {limit} uses" (comma thousands) when the window carries both `used` and `limit`
    (optional fields on `UsageWindow`), and is otherwise left out. Its reset is not read, so it
    has no reset line and no tick.
- **DeepSeek: a balance, not meters.** DeepSeek has no usage or quota API — the only account
  data is the prepaid credit — so its card carries `balance` and no windows. The body is one
  `.meter` with no track: a `.meter-head` with `.meter-label` "Balance" and the money left in
  `.meter-value` (`$4.29`, currency of the balance, `Intl.NumberFormat` `style:"currency"`), then a
  `.meter-context` with the non-zero parts of "Granted `$0.00`" and "Topped up `$4.29`" joined by
  " · ". With both at 0 that line is left out. There is **no percentage, no bar, and no reset
  line** — nothing resets; the balance goes down until it's topped up. When `available` is false the
  head chip is `.chip.chip-error` "Out of credit" and a `.usage-note` under the balance reads "This
  balance can't fund calls. They'll fail until it's topped up." A failed fetch that kept the balance
  says nothing: the balance reads as an ordinary one.
- **Meters.** Each window gets a `.meter`. The number comes first, the bar second, and there's
  never a bar alone.
  - **Value.** `Math.round(pct)` followed by `%`. No decimals: the sources round, and a decimal
    claims precision we don't have. The fill's width is clamped to 100%.
  - **Context.** Only when `resetsAt` exists (Claude, OpenAI, Z.ai's plan window, and Ollama
    once its reset day is set, §app.insights/usage-reset-day). Under 24h it's "Resets in 2h 17m",
    otherwise "Resets Sep 25", with the ISO time in `title`; a declared reset (`declared: true`,
    the user's day) is always its date. While the meter has a tick, the line adds its progress:
    "Resets Oct 9 · day 4 of 7", "Resets in 2h 17m · 2h 43m of 5h". Never estimate a reset: a
    reset the user declared is the user's fact, not an estimate.
  - **Tick.** A meter whose window has a known span and a reset still ahead carries the pace
    tick (§app.insights/pace-tick) on its track: a `.meter-tick`, a 1px ink line at the elapsed
    share (`--meter-at`), standing 2px past the track's top and bottom (on `.meter-track-wrap`,
    since the track clips its fill). A ghost meter has
    none.
  - **Reset already passed** (`resetsAt < now`: the reading is older than the reset, its fresh
    one not fetched yet, or it is a free login's pool figures). Use
    `.meter-ghost`, with no fill. The value keeps the old number, and the context says
    "Reset at `11:50`. New reading at the next refresh." (for a free login's figures, "Reset at
    `11:50`. Not read while it is free.").
  - **Fill color.** The fill is neutral. It gets `.meter-fill-warn` at ≥80% and
    `.meter-fill-error` at ≥100%. That matches the extension's own footer threshold, and it
    always pairs with the head chip. The foot's pace tones (§app.insights/pace-tick) are not
    used here: on a card the pace is the tick and the context line.
  - **Burn.** Under the context line, a meter may carry its burn lines (rate, run-out or the
    percent at reset, last period) and, for a window of a day or more, a history chart
    (§app.insights/usage-burn). The DeepSeek balance may carry its spend line the same way.
- **Head chip.** The worst window decides it. A window whose reset has already passed (the meter
  is a ghost) decides nothing. The words follow the skill's model-availability severities:

  | Condition | Chip |
  |---|---|
  | All windows < 80% | none |
  | Any window 80–99% | `.chip.chip-warn` "Near limit" |
  | A 5-hour window ≥ 100% | `.chip.chip-warn` "Rate-limited" (it comes back on its own) |
  | A 7-day, monthly, or MCP-uses window ≥ 100% | `.chip.chip-error` "Quota used" (waits for the reset) |
  | A balance with `available: false` | `.chip.chip-error` "Out of credit" (waits for a top-up) |
  | `error` set and `windows` (or a balance) kept | none: the kept reading is shown with no chip and no note |
- **Provider not ok.** The body is a single `.usage-note` (`nologin`, `expired`, `nokey`,
  `badkey`, `na`, or `error` with no windows; see §design/copy-deck), with no chip and no meters. Commands in
  the note go in `<code>`.
  - `expired` (the provider refused the sign-in) has two notes, chosen from the card's `auth`.
    When `auth` says the access token's own expiry has passed and does not say the refresh token
    has expired too, the note is the soft one: the token expired `{ago}`, and it renews the next
    time Claude Code runs (OpenAI signed in through pi: the next time pi uses OpenAI), after which
    usage updates. Nothing needs the user. In every other case — the refresh token has expired,
    the card has no `auth`, or the access token has not reached its expiry (so it was revoked,
    not timed out) — the note stays "Sign-in expired. Run `claude /login` to renew it."
- **Sign-in token.** A card whose `auth.kind` is `"oauth"` ends its body with one muted
  `.usage-card-caption` line about the sign-in, after the meters or the note; an API-key
  provider (`auth.kind: "apiKey"`) and a card without `auth` get none. Times follow
  §design/copy-deck: a clock (with the date when it isn't today) for when, a relative age for
  when it happened.
  - Valid access token: "Sign-in renews by `{expiresAt}`", plus " · last renewed `{ago}`" when
    `refreshedAt` is known. With `refreshedAt` and no `expiresAt` (the Codex CLI's sign-in): "Sign-in last renewed `{ago}`".
  - Access token expired, refresh token not known to be expired, on a card whose state isn't
    `expired`: the soft sentence from the note above, as the caption (the meters are the reading
    from before it expired).
  - Refresh token expired: "Sign-in can't renew. Run `claude /login` to sign in again."
  - On a card whose note is already the `expired` one, the caption is left out: the note says it.
- **Whole file.**
  - The Usage page's head meta always shows "Updated {rel}" from `fetchedAt`, or "Not read yet",
    then " · next refresh {in}" while `nextFetchAt` is ahead. With the server's own poller
    (§app.insights/usage-refresh) that next refresh really happens without anyone on the page.
  - Refresh Usage (`POST /api/insights/usage/refresh`) fetches every provider now and replaces
    the page's data with the result; the head button is `aria-disabled` + `aria-busy` meanwhile.
  - `stale` is true when the file is more than 10 minutes old, which now means that this
    server's poller is failing or switched off and no TUI refreshed it either.
  - When `stale` is true and the last Refresh Usage failed, add a
    `.banner.banner-warn` (`clock`) above the grid with the failure and a `Retry`. Old data on
    its own gets no banner: the head meta shows the age, and Refresh Usage fetches it. The
    meters still render.
  - When `available` is false, replace the grid with one `.empty`. `missing` means unavailable,
    not an error. `corrupt` gets the error copy.

## §app.insights/pace-tick — Pace ticks

A usage meter says two things: how much of a window is used, and how much of the window has
gone. The bar's fill is the used share (`pct`, clamped to 100%); a **tick**, a 1px ink line
across the bar, stands at the share of the window elapsed, `1 − (resetsAt − now) / length`.
Fill past the tick means the quota is going faster than the window.

- **Span.** The window's span comes from its own data: its `startsAt` when the payload sends one
  (OpenAI, from the window's own `limit_window_seconds`; Ollama, from the user's reset day,
  §app.insights/usage-reset-day), else `resetsAt` minus the length its label states (`5h`,
  `7d`, `7d scoped`, a Z.ai `{n}m|h|d|w`). Two Claude accounts' 7-day windows end at different
  times, so each reading has its own span.
- **No tick when it isn't known.** No `resetsAt` (an idle Claude 5-hour window, Ollama with no
  reset day, Z.ai's MCP uses), or a label of no stated length (`pri`, `plan`, a `month` without
  `startsAt`): no tick. A reset that has passed: no tick either. A tick is never estimated.
- **Words.** A window of a day or more is "day {n} of {total}" (n from 1; a declared monthly
  window counts calendar days, so a 30-day month reads "day 18 of 30"); a shorter one
  "{elapsed} of {length}" ("2h 10m of 5h"). One bar in words is "{window}: {pct}% used ·
  {progress} · resets {when}": `when` is the clock time, with its date when not today ("resets
  6:59 PM", "resets Oct 9 10:00 PM"), and for a declared reset its date alone ("resets Oct 14").
  Without a tick the progress is left out, without a reset the reset is: "MCP uses: 0% used".
- **Foot fill tone.** In the sidebar foot (§app.insights/sidebar-foot) a bar's fill is neutral
  ink, `warn` when its used share is more than 10 points ahead of its tick (`pct − 100 ×
  elapsed > 10`), and `error` at 90% or more. A bar with no tick is `warn` from 80%. The Usage
  cards keep their own fill tones, which pair with the head chip (§app.insights/usage-cards).

## §app.insights/usage-reset-day — Ollama Cloud's reset day

Ollama Cloud reports only the share of its monthly usage used, never when the month resets. The
user can declare the day of the month the subscription resets; nothing guesses it, and no reset
is offered from a drop in usage.

- **The file.** `usage-windows.json` in the pi agent dir, `{version: 1, ollama?: {resetDay:
  1..31}}`, owned by the usage-status extension's `windows.ts` (node builtins only: the strict
  parse, the reader and an atomic writer). Missing or unreadable reads as unknown. It is not kept
  in `auth.json` beside the key: pi replaces a provider's whole entry there on a new sign-in.
- **The window.** With reset day D, the month runs from local midnight on day D, clamped to the
  month's last day (31 is Feb 28 or 29, and Apr 30), to the same clamped day of the next month.
  The server derives it each time it reads usage and never stores it in the usage cache, so a
  changed day or a month rollover shows at once: Ollama's `month` window gains `startsAt` and
  `resetsAt` and is marked `declared: true`. `UsageInsight.ollamaResetDay` is the day, or `null`
  while none is set (absent from an older server, which offers no control).
- **The card.** On an `ok` Ollama card with no day set, the monthly meter's context reads, muted,
  "Reset day unknown · " and a text button "Set". It opens an inline day-of-month field labelled
  "Reset day" (1–31): Enter or Save saves it (`PUT /api/insights/usage/reset-day`, `{provider:
  "ollama", day}`, which answers with the whole usage payload; `day: null` clears), Escape or
  Cancel closes it, and a day outside 1–31 is not sent: the field says "Enter a day from 1 to
  31.". Once set, the context reads "Resets Oct 14 · day 18 of 30" and ends with a quiet text
  button "Change", which opens the same field with a "Clear" beside Save.
- **The command.** `/usage reset-day ollama <1-31|clear>`, in any pi session (the TUI's and
  Sova's hosted ones alike), writes the same file and says "Ollama Cloud resets on day 14 of each
  month." or "Ollama Cloud's reset day is cleared."; any other argument gets "Usage: /usage
  reset-day ollama <1-31|clear>". Its argument is a contract (CLAUDE.md). Plain `/usage` opens its
  screen as before, whose Ollama row shows the declared reset, marked "(set)".
- **Sync.** While the mesh is on, the file syncs as a setting (§mesh.sync/categories): the Ollama
  key travels with the logins, so every device reads the same subscription.

## §app.insights/usage-refresh — Who keeps usage fresh

The usage cache (`usage-status.json` in the pi agent dir's `cache/`) is shared by every pi on the
machine and by this server. Three things refresh it, all through the usage-status extension's own
refresh, which holds a machine-wide lock and fetches only when the cache says its next fetch is
due (sooner after a failed fetch, never more often than the extension itself would):

- **The server's poller.** From 2–5 seconds after start, the server asks for a refresh (never a
  forced one) and schedules its next ask at the cache's `nextFetchAt`, never sooner than 30
  seconds and never later than 5 minutes, plus a few seconds of jitter. When another process holds
  the lock and publishes nothing, or the refresh itself fails, it asks again later; nothing stops
  the chain but shutdown. While a Refresh Usage is in flight it skips its turn. Each distinct
  failure is logged once, not on every tick. `SOVA_USAGE_POLL=off` in the server's environment
  switches it off (say, a second test server that shouldn't double the provider calls); every
  other value leaves it on. It never keeps the process alive, and it stops on shutdown. Each
  tick that yields a cache, fetched or adopted, hands it to the usage history, which also reads
  the file once at server start (§app.insights/usage-burn).
- **Refresh Usage** (§app.insights/usage-cards): a forced refresh, now.
- **A TUI pi**, unchanged: its own timer and after each turn.

Two servers with different agent dirs (the live one and a hermetic test server) keep separate
caches and locks, so each fetches on its own; servers on the same agent dir share one.

**Sign-in data.** `GET /api/insights/usage` adds `auth` (`UsageAuth`) to a provider when its
credentials say something: expiry times, when the sign-in was last renewed, and whether the access
and refresh tokens have expired by the server's clock. It comes from the same credential files the
usage fetch reads (Claude Code's `~/.claude/.credentials.json`, pi's `~/.pi/agent/auth.json`, the
Codex CLI's `~/.codex/auth.json`), re-read only when a file changes; on macOS a Claude login with no
credentials file is read from its keychain item instead, for the fetch and for these numbers
(§app.claude-logins/macos-keychain), and then carries no `refreshedAt`. It carries numbers, enums and
booleans only: no string from a credential file ever leaves the server. Claude's
`refreshedAt` is the credentials file's modification time, and only while that time agrees (to
within 10 minutes) with an 8-hour token lifetime ending at `expiresAt`; otherwise it is left out
rather than guessed. OpenAI signed in through pi has an expiry and no renewal time; signed in only
through the Codex CLI, a renewal time (`last_refresh`) and no expiry. API-key providers carry
`{kind: "apiKey"}` and nothing else.

**Sova never writes a credential file and never refreshes a token.** A Claude sign-in renews only
when Claude Code itself runs; the Usage page says so (§app.insights/usage-cards) instead of
renewing it. The one exception is Settings → Accounts (§app.claude-logins/add-remove): at the
user's request Sova runs Claude Code's own `claude auth login` and `claude auth logout` in an added
login's directory, and deletes that directory on removal. Claude Code writes those credentials.

**Every Claude login's usage.** Claude Code's own credentials are read from its own directory
(`$CLAUDE_CONFIG_DIR` when set, else `~/.claude`), as its spawns use it. Each other Claude login
assigned to this device (§app/claude-logins) is fetched the same way, with the access token in
its own directory's `.credentials.json`, only read, never refreshed or written. The cache keeps
`claude` as Claude Code's own login, so every older reader reads what it always did, and adds
`claudeAccounts`, keyed by login id (never `default`), each `{data?, fetchedAt?, nextFetchAt,
error?, skipped?}`; `CACHE_SCHEMA` is unchanged, since the field is additive. Each login keeps
its own cadence, `default` included: it is fetched when its own `nextFetchAt` is due (150 seconds
after a reading, 60 after a failure, 10 minutes after an HTTP 429, when the usage endpoint is
refusing) or on Refresh Usage; a failed fetch keeps its last reading and says why, and never
shortens the other providers' refresh. `default`'s cadence is in the cache's additive
`claudeFetchedAt` and `claudeNextFetchAt` (a cache without them reads `claude` as fetched with
the file and due now), and its failure stays `errors.claude`, carried while it waits. A login is
also due at once, and with it the whole cache, when it is held here with no entry yet (just
taken or added), or when a window of its last successful reading has reset since that reading;
the fetch moves the reading past the reset, and a failed one waits out its own retry, so
neither loops. The server's poller also wakes at the earliest Claude reset still ahead (within
its 30-second floor), so a reset is read soon after it passes. A login this device marks as needing sign-in
(`claude-accounts-state.json`) is never fetched, `default` included: it keeps its last reading,
marked `skipped: "auth"`, until its credentials change. A login no longer assigned here drops
out. A cache without `claudeAccounts` on a device that has added logins (an older extension
rewrote it) is refetched once; meanwhile the server serves its last readings of the logins
still held here, and none of a login it no longer holds.
`GET /api/insights/usage` adds each login's sign-in data (`auth`) from its own credentials file,
in the same numbers-only form.

**Window lengths.** Each OpenAI window in the cache also keeps `seconds`, its own
`limit_window_seconds`, and takes its label from it: `5h` or `7d` when within 5% of five hours or
seven days, else `pri`; the secondary window, which reads `5h` when it sends no length, included.
`CACHE_SCHEMA` is unchanged, since the field is additive. The server sends `resetsAt − seconds` as
the window's `startsAt` (§app.insights/pace-tick). Ollama's reset is never in the cache: the server
derives it from `usage-windows.json` as it reads (§app.insights/usage-reset-day).

## §app.insights/usage-burn — Usage burn: how fast a subscription is going

**Each Usage card meter says how fast its window is being used, how that compares with the last
period, and when it runs out at this pace. The figures come from the provider's own percent, recorded
over time on this device.**

```html
<div class="meter">
  <p class="meter-head">…7-day … 58% used</p>
  <div class="meter-track-wrap">…</div>
  <div class="meter-context">Resets Oct 9 · day 4 of 7</div>
  <p class="meter-context usage-burn-line">≈16%/day · at this pace used up <span class="text-mono">Wed 10:48 PM</span>,
    <span class="text-mono">19h</span> before reset <span class="chip chip-warn"><i class="chip-dot"></i>Runs out</span></p>
  <p class="meter-context usage-burn-line">Last 24h ≈22%/day · last week 81% (40% by this point)</p>
  <div class="usage-burn-chart">…</div>
</div>
```

- **What is recorded.** Only what the providers report in the usage cache
  (§app.insights/usage-refresh): each `ok` window's percent with its `resetsAt` and, when known,
  its `startsAt` (OpenAI's own length; Ollama's declared month, §app.insights/usage-reset-day),
  and DeepSeek's balance total. Ledger tokens are never used. A **series** is `claude:<accountUuid>` for
  each Claude account, then `openai`, `zai`, `ollama` and `deepseek`. Logins of one account feed one
  series. A login whose identity this device doesn't know yet is skipped, never filed under its
  login id. A window is keyed by its label plus its scope. A sample is stamped with the
  reading's own time: a Claude login's own `fetchedAt` (`default`: the cache's `claudeFetchedAt`),
  any other provider's with the cache's `fetchedAt`. A provider whose `errors` entry is set is not
  recorded, because a failed fetch keeps the old value under a fresh cache time. A reading no newer
  than the last one recorded for its series and window is skipped.
- **When.** Each tick of the server's poller that yields a cache, whether it fetched it or adopted
  another process's (a TUI's), and once at server start from the file as it is. Nothing is
  recorded while the server is off, so history has gaps. Figures a pool holder published are not
  recorded.
- **Storage.** Append-only `<state root>/usage-history/v1/<UTC day>.jsonl`, one JSON line per
  sample, written by this server alone. Samples of closed periods older than 30 days are deleted
  at start and once a day. A period still open keeps all its samples until it closes and its
  summary is written: a 31-day month keeps its first day. A day file goes only once nothing in it
  is kept.
  - History is per device and never synced over the mesh. Lines are parsed strictly, and a bad
    line is skipped. The files are read into memory once.
  - Only changes are written: a reading whose percent or period differs from the last one
    written, plus a period's first reading and its last. The newest reading of an unchanged run
    is held back. It is written before the next change, once it is an hour newer than the last
    line (so a restart loses at most an hour of a plateau), and at the server's shutdown.
- **Period summaries.** When a period closes, one summary line is appended to
  `<state root>/usage-history/periods/v1.jsonl`, once. A period closes when a reading of the next
  period is recorded, or when its reset has passed. A window with no reset closes only when its
  percent drops.
  - A window's summary is `{series, window, startsAt, resetsAt, finalPct, hitLimitAt?, avgRate,
    tenths, firstAt, lastAt}`:
    - `tenths` is the percent at each tenth of the span: 11 numbers, from 0% to 100% of the way
      through. A tenth before the first recorded reading is `null`.
    - `avgRate` is the final percent ÷ the hours from the span's start to the 100% mark, or to
      its end when it never got there.
    - A window with no reset spans from its first recorded reading to its last.
  - DeepSeek's balance writes `{series, window: "balance", firstAt, lastAt, startTotal, endTotal,
    spent, perDay, currency}` for each run a top-up ends.
  - Summaries are kept for a year, judged by `lastAt`. Older lines are dropped at start and once
    a day by rewriting the file atomically.
  - Lines are parsed strictly, and a bad line is skipped.
  - A period still open when the server stops gets its summary once it closes, derived from its
    samples, whether that happens at the next start or later. A period whose time range overlaps
    an existing summary of its series and window already has one, so it is never written twice.
- **Periods.** A reading belongs to the open period when its reset (for a declared Ollama month,
  its start) is within a tolerance of the period's: 2 minutes or 1% of the window's span,
  whichever is larger. Sub-second jitter and OpenAI's moving reset never split a period, and
  rounded keys are never compared. A new period starts when the reset moves forward past the
  tolerance, or when the percent drops. A window with no reset starts one only when the percent
  drops. DeepSeek's balance starts a new run whenever its total rises (a top-up).
- **The rates.**
  - **Window average:** the percent ÷ the time gone in the window's span
    (§app.insights/pace-tick), per hour for a window shorter than a day, else per day. It drives
    the projection, and it needs no history.
  - **Recent:** the change in percent over the last T inside the current period (T is 1 hour for
    a window under a day, 24 hours up to 8 days, 3 days beyond). It shows only when this period's
    recorded history reaches back T.
  - **Projection,** at the window average. When it reaches 100% before the reset, the time it does
    ("used up"); otherwise the percent at the reset (the percent ÷ the share gone, rounded). It is
    never a reset and never a tick, and it is always said with "≈" and "at this pace".
  - **Silence.** Nothing is said for a window at 0%, at 100% or more, a ghost (its reset has
    passed), or one with under 5% of its span gone.
- **Last period.** The previous period of the same series and window: its final percent (the last
  recorded, a lower bound when this device stopped recording before it ended), the time it
  reached 100% if it did, and its percent at the same share of its span as now. That last figure
  is left out when its recording starts after that point. For a window of a day or more, the
  previous period counts only when it ended within 10% of a span before this one began. For a
  shorter window it is the previous recorded window, whenever it was. The previous period is read
  from its samples while they reach back to within 10% of its span's start. Otherwise (its samples
  are older than 30 days) it is read from its summary: its tenths as the points, and its own final
  percent and 100% time. That is how "Last month 72% (27% by this point)" survives the 30 days.
- **Wire.** Each `UsageWindow` may carry `burn` (`UsageBurn`, filled by `GET
  /api/insights/usage`; older clients ignore it, older servers send none): the window-average
  rate, the recent rate and its span, the run-out time or the percent at reset, the last period's
  figures, when recording began, and the series and window keys. The balance carries its own
  `burn` (spend per day, its span, days left). Every window with a series also carries `history`
  (`{series, window}`), even with no burn.
  - The charts' periods come from a separate `GET /api/insights/usage/history?series=&window=&at=`:
    - the current period's samples;
    - every closed period of the last year, newest first, each with its span, final percent, 100%
      time and average rate. Its points are its samples while those cover it, else its summary's
      tenths, marked `coarse`.
  - The 5-hour strip comes from the same route with `strip=1`: the summaries of the last 30 days
    only, with no points.
  - Only the Usage page asks for them, so the payload the sidebar polls every 60 seconds stays
    small. The sidebar foot is unchanged.
- **The lines.** Under the meter's reset line, `.meter-context.usage-burn-line` lines in
  `--color-ink-2`, with times and durations in mono:
  - The rate: "≈21%/h" or "≈16%/day", with one decimal under 1.
  - Runs out before the reset: "at this pace used up `Wed 10:48 PM`, `19h` before reset",
    followed by a `.chip.chip-warn` "Runs out". A window under a day says "used up in `1h 58m`,
    `19m` before reset", and one longer than 8 days gives the date ("`Oct 28`").
  - Otherwise: "on pace for 23% at reset".
  - The recent rate: "last hour ≈25%/h", "last 24h ≈22%/day", "last 3 days ≈4%/day".
  - The last period: "last window 64% (35% by this point)", "last week …" for 7-day windows,
    "last month …" for monthly ones. One that hit 100% reads "last week hit 100% at `Tue 3:10
    PM` (40% by this point)".
  - Arrangement: the first line is the rate and the projection. With a run-out its chip ends that
    line, and a second line holds the recent rate and the last period. Without one, the recent rate
    joins the first line, and the last period does too unless a recent rate is there, in which case
    the last period takes the second line. A second line starts with a capital.
  - **No span** (Z.ai's MCP uses, Ollama with no reset day, a window of no stated length): the
    rate over the recorded part of the current period, at most its last 7 days and at least 6
    hours, in uses when the window sends `used` and `limit`: "≈30 uses/day over 7 days · no reset
    reported, so no run-out estimate".
  - **DeepSeek's balance:** the spend over the run since the last top-up, at most 14 days and at
    least 6 hours: "≈$1.20/day over 14 days · about `15 days` left at this pace". Nothing shows
    while it isn't going down.
- **The chart.** A meter with a `history` key whose window is a day or more, with a known span,
  its reset ahead and any period recorded, gets a chart under its lines, the meter's full width,
  with a 64px plot. It is `aria-hidden`, because the lines carry its figures in words; the
  stepper's buttons are the one control in it.
  - The y axis runs 0–100%, with a dotted 100% guide.
  - **This period:** a solid ink line of the recorded steps from the window start to now, ending
    at the current reading.
  - **Last period:** a dashed muted line across the window, aligned by the share of its span.
  - **At this pace:** a dotted ink line from now toward the reset at the window-average rate. It
    stops where it reaches 100%, or else runs to the reset at the projected percent.
  - **Now:** a thin vertical ink line.
  - **X axis, labelled.** Faint gridlines at each day from the window start. A 7-day window labels
    them by weekday, and its last label is the reset with its time ("Thu 6:00 PM"). A monthly
    window labels dated ticks about a week apart ("Oct 8") and its reset. A second row puts "now
    Mon 8:24 AM" (semibold ink) under the now line.
  - **Run-out pin:** when the projection reaches 100% before the reset, a `--status-warn` dot sits
    at that point, labelled above it in mono "used up Wed 10:48 PM".
  - **Legend** under the chart: "this week", "last week", "at this pace" (month or window for other
    lengths), each beside a sample of its line (solid, dashed, dotted).
  - **Readout.** A mouse hovering the chart, or a finger or pen pressing and dragging along it,
    puts a 1px accent line at the pointer and a floating card above it: the velocity scrub's
    card (§app.insights/velocity-scrub: `.float-card.float-card-neutral`, fixed to the window and
    placed by `floatAbove`, so it stays 8px inside the window's edges and is never cut off by the
    card, never taking the pointer). It sits at the pointer's x, just above the plot and its run-out
    pin's label, so it hides neither: its bottom edge is 14px above that top, or, when that is
    lower, 14px above a mouse and 40px above a finger. The chart takes
    horizontal drags and leaves vertical scrolling to the page. The card reads, in order: the time
    at the pointer, in mono ("Sun 2:30 PM"; for a monthly window, "Oct 9"). Then, before now, "**46%**
    used"; after now, "at this pace ≈**78%** used"; past the run-out, "used up by then, at this
    pace"; before the period's first recorded reading, "Not recorded". Then, when a last period was recorded there, "last week 31% by this point". The number
    comes first and is semibold. The card and the line hide when the pointer leaves, and when a
    touch ends or is cancelled. Both are `aria-hidden`.
  - **Stepper.** Above the plot, a row with buttons "‹" and "›" (`aria-label` "Earlier week" and
    "Later week", or month or window) around the shown period's name. A 7-day span reads "Week of
    Sep 25". A declared month that starts on the 1st reads "Month of Sep"; any other declared
    month, or any other length, reads its date range, "Sep 25 – Oct 25". The name sits in a
    polite live region.
    - The newest step is the current period, exactly as above. "›" is disabled there, and "‹" is
      disabled at the oldest recorded period.
    - Stepping back shows that period as the solid line against the one before it as the dashed
      line (aligned the same way, and only when it counts as its last period). The axis is
      labelled for the shown period's span.
    - The projection, the now line and row, and the run-out pin show only on the current period.
    - A past period gets its own line above the plot, in the burn lines' style:
      - "hit 100% at `Wed 2:00 PM` · ≈12%/day" when it reached 100%;
      - else "peaked at 81% · ≈12%/day".

      The rate is its `avgRate`.
    - A period drawn from its summary adds a muted "Older than 30 days, so drawn at tenths of the
      week." (month or window).
    - The legend reads "week of Sep 25" and "week before".
    - The readout works the same on a past period: the time, "**46%** used" ("Not recorded" where
      nothing is), and "week before 31% by this point".
    - The meter's burn lines above still describe the current window.
- **The 5-hour strip.** A meter whose window is under a day gets no chart. When it has a `history`
  key and its series has summaries from the last 30 days, it gets a strip instead: one bar per
  past window, oldest left, each as tall as its final percent (of a 24px strip). A window that
  reached 100% is drawn in `--status-warn`; the others in `--color-ink-2`.
  - Bars share one pitch, the width ÷ the count rounded down, never under 3px with a 1px gap.
    When they don't all fit, the newest that fit are drawn.
  - A muted caption under it reads "Last 30 days · 47 windows · 6 hit 100%". The hit count is
    left out at 0.
  - **Readout.** Hovering or touch-dragging the strip picks a bar and shows the same floating card
    (same placement, above the strip): the window's time range in mono ("Oct 3 9:00 AM – 2:00
    PM"), "**64%** used" (or "**100%** used"), "≈21%/h", and "hit 100% at `1:12 PM`" when it did.
    The picked bar gets a 1px accent outline. The strip is `aria-hidden`, and its caption
    carries the facts.

## §app.insights/team-cards — Agents board

`#/agents` is one board of sessions. Its rows come from the session list the sidebar loads
(main threads only: never a worker's own session or an Overseer file), joined by path with
`GET /api/insights/agents` (host sessions only: a headless worker pi owns no row). The default
scope, with no chip on, is what the sidebar keeps on top: live sessions, and sessions started in
Sova that aren't archived.

```html
<div class="board-bar">
  <label class="search board-search">…<input class="input" type="search" placeholder="Search title, gist, path, branch"></label>
  <div class="board-filters" role="group" aria-label="Filter sessions">
    <button class="board-filter" aria-pressed="true">…check… Live <span class="board-filter-count">3</span></button>
    …Needs you · Has workers · Unmerged · Archived…
  </div>
  <p class="board-count-line" aria-live="polite">5 sessions live or open in Sova</p>
</div>
<div class="card board">
  <div class="board-head" aria-hidden="true">Session · Activity · Workers · Worktrees</div>   <!-- desktop only -->
  <ul class="board-list" aria-label="Sessions">
    <li class="board-row" data-state="working">          <!-- working | needs-you | idle | archived; a click on it opens the session -->
      <div class="board-line">
        <div class="board-cell board-session">rail · twist (aria-expanded; only when the open row has something to say) · title · gist</div>
        <div class="board-cell board-activity">model · context ring · 5m ago · state chip</div>
        <div class="board-cell board-workers">2/5 working · team chip → its Session details pane, on Agents · $1.20</div>
        <div class="board-cell board-trees">feat/x · ↑3 ↓1 · +120 −4 · dirty dot · +1</div>
        <div class="board-cell board-actions">Open · Session details (aria-expanded) · Archive · Move into group · ⋯</div>
      </div>
      <div class="board-detail">   <!-- open rows only: in the title column, behind a guide rule under the twist -->
        <p class="board-reason">…why it needs you…</p>
        <p class="board-note">…1 open question in al_2 …, or the last turn's error…</p>
        <p class="board-now">…the full now line…</p>
        <ul class="board-topic-list" aria-label="Recent topics">…up to 5 headings, newest first…</ul>
        <ul class="board-tree-list" aria-label="Worktrees">…one line per worktree, when there are 2 or more or one is dirty…</ul>
      </div>
    </li>
  </ul>
</div>
```

- **State.** One per row, on its rail (a colored left edge) and in a chip with a dot and the
  word: **Needs you** when the session waits on input or has an extension dialog open; else
  **Working** when its turn runs or any of its workers works; else **Needs you** when its last
  turn failed or stopped on an error, or it has open alignment questions, or its decision marks (an unseen reply that asks you, unseen
  looping, a stuck subagent) say so; else **Idle**, or **Archived** for an archived session nothing runs in. The
  chip's `title` says why a row needs you, and the open row says it in a line.
- **Sort.** Working first, then Needs you, then the rest; within each, last active first.
- **Filter chips.** One at a time, a second press clears it; each shows its count, and a set one
  carries a check as well as the tint. **Live**: a TUI or runtime reports on it. **Needs you**:
  in that state, anywhere in the list. **Has workers**: any worker listed or counted.
  **Unmerged**: the default scope narrowed to rows with an existing tree whose branch isn't
  merged. **Archived**: only what you archived.
- **Search.** Every word must appear in the title, original title, gist, path, cwd, or a tree's
  branch or path. With no chip it searches every session, not only the default scope; a chip
  still narrows it.
- **Paging.** 50 rows render; "Show {n} More" adds 50.
- **Row click.** A click or tap anywhere on a row that isn't a control (the title, the gist, the
  open row, its bare surface), at every width, opens the session, as Open does. Every control
  keeps its own action and never opens it: the twist, the team chips, the action buttons, ⋯ and
  its menu, and the rename field with its hint. A click that ends a text selection inside the row
  doesn't open it, nor does one with a modifier key. The row itself takes no focus: Open is its
  keyboard target.
- **Columns** (the `insights` container ≥1000px). Session: the title as plain text, the gist
  (`outlineGist`, else the now line, else the cwd in mono). Activity: the compact
  model, the context ring (the sidebar row's rule: the open view's live fill wins, never without a
  window), last active in relative time, the state chip. Workers:
  `{working}/{total} working`, a count chip per team, the workers' spend at API prices, at any
  depth, from the usage ledger (§app.insights/usage-ledger). A team chip is
  a link to `#/agents/{teamKey}`; a click on it opens that session's Session details pane in place
  on its Agents tab. Worktrees: see §app.insights/subagent-cards. Actions: Open, Session
  details, Archive or Unarchive, Move into group (the session pane's group menu, icon only), and ⋯. The head's totals line (working ·
  live · spend today · unmerged, with its `title`) leaves the page head and sits right-aligned on
  the filter line (`.board-totals`); below 1000px it stays in the head.
- **Wide** (the `insights` container ≥1600px). Session takes the extra width (titles and gists
  show in full where they fit); Activity is one line (model, ring, last active, state chip) in a
  15rem track, Workers 8rem, Worktrees 22rem, the actions their fixed width.
- **Page.** Only this page drops the 1280px page cap: side margins `--space-4` below 1600px and
  `--space-6` from there, the content capped at 2400px and centered; the head, the bar and the
  board share the same left and right edges. Other insights pages keep 1280px.
- **Condensed** (768–999px): Activity sits over Workers in one column; the actions are Open,
  Session details and ⋯. **Folded** (<768px): stacked rows — title with the state chip, the gist, a micro line
  (model · workers · last active), the worktree chips — and ⋯ is the door to every action. Every
  target is 44px.
- **Session details.** The info button (`aria-controls="session-pane"`, named "Session details of
  “{title}”") opens that session's Session detail pane (§app/subagents-pane) on its Session tab in
  place: the board stays on `#/agents`, and no session view opens. `aria-expanded` says whether
  the pane shows this row's session. Its own row's button closes it; another row's switches it
  to that session, on Session again. A team chip opens the same pane on its Agents tab, and never
  closes it: on that session already, it only switches the tab. The pane follows the shell's
  bands, so from 1280px it takes a column and the board beside it reflows, usually to its folded
  layout, where ⋯ is the door; below 1280px it covers the actions, and its own close comes first.
  Leaving the page closes it. With no chat on screen, workers come from the polled
  insight, the Timeline can't rewind ("Only a chat open in Sova can rewind."), and a row's jump
  says the message isn't in the transcript on screen.
- **⋯ menu.** Session Details (Close Session Details while that row's pane is open), Open
  Session, Open Subagents (opens the session with its pane on the Agents tab), Rename…, Use Gist as Title (the gist on one line,
  cut to the title limit; off, with the reason, when there's none or it already is the title),
  Reset to Original Title (off when not renamed), Move to Group… (a screen of the groups, with
  "No group"), Archive or Unarchive, Copy Path.
- **Rename.** Only ⋯ → Rename… renames on the board: nothing on the row starts it. In place, the
  sidebar's title field: Enter saves, Escape cancels, an empty field restores the derived title,
  and leaving the field saves what's in it (empty: cancels). A value equal to the title the field
  opened with is a cancel, never a write, on Enter or on leaving, even when the row's title
  changed while the field was open. Kept in Sova only.
- **Archive.** Only for sessions started in Sova, or already archived. Refused with its reason
  (open in a TUI, mid-turn, subagents working) before the press, never after.
- **Open row.** What the session is about and where it stands. Only the twist opens and closes
  it, and a row shows the twist only when its open row has something to say: a needs-you reason,
  open alignment questions, a last turn that failed, a now line, a topic outline with at least
  one topic (`outlineTopics`, known from the list), or worktree lines. A row with none of these
  has no twist, and its title keeps the twist's place. In this order, each only when there is
  one: the why-it-needs-you line; the open alignment question's lead ("1 open question in al_2
  …", the session mark's words) and the last turn's error, each unless the reason line already
  says it; the full now line (`outlineNow`, which the gist cuts to one line); the last 5 topic
  headings, newest first (the Timeline's order), each with its relative time; then one line per
  worktree (§app.insights/subagent-cards). The headings come from one read-only `GET
  /api/insights/session` when the row opens, kept while it stays open, never polled; while it
  runs the list says "Reading topics…", and a failed read says "Couldn't read the topics." with
  nothing else. Workers and teams aren't in it: the Workers column counts them, and a team chip
  or ⋯ → Open Subagents shows them. Everything starts at the title's left edge at every width,
  behind one thin guide rule drawn down from under the twist: that rule, not width, says it
  belongs to the session.
- **Deep link.** `#/agents/{teamKey}` (a bare team id from an older link: the newest team with
  that id) keeps the team's parent session on the board whatever the filter, and opens that
  session's Session details pane on its Agents tab, once per link: polls don't open it again.

## §app.insights/subagent-cards — Board worktrees

The Worktrees column reads `GET /api/insights/worktrees?paths=…` for the rendered rows only
(under Unmerged, for the default scope, which that chip needs a reading to decide), every 15s
and whenever that set of rows changes. Readings are kept per session across requests. A failed
or missing route (an older server) shows "—" in every row it hasn't read, and nothing else: no
banner, no toast.

- **Cell.** The first tree: its branch in mono (`detached` on a detached HEAD, the folder name
  when it's gone), then **merged** (a success chip) when the tip is in the base, **content
  merged** when merging would change nothing, else `↑{ahead} ↓{behind}` in mono; `+{added}
  −{removed}` when the branch changes any line; a dot for uncommitted changes (its word for AT
  and in the `title`). More trees: a `+{n}` count chip; at ≥1600px the second tree shows too, stacked
  under the first, before it. The cell's `title` states every tree.
  No tree: "—". A tree that's gone reads "gone"; a git failure "unreadable"; no base "no base".
- **Open row.** Worktree lines only when the session has 2 or more trees, or one with
  uncommitted changes (a single clean tree is the cell already): one line per tree, with branch,
  the same reading, lines, "uncommitted" in words, "a worker's" when a worker's cwd is the source,
  and the path in mono.
- **Folded.** The cell sits under the session as chips; a row with no tree drops it.

## §app.insights/worktrees-endpoint — Which worktrees a session touched

`GET /api/insights/worktrees?paths=<session path>,<session path>…` answers `WorktreesInsight`
(`shared/protocol.ts`) for the listed sessions only: the board asks for the rows it shows, and
nothing else is read. A path that isn't a session (the same check as `/api/insights/session`) or
whose file is gone comes back with `trees: []`, echoed as it was sent; a request without `paths`
is a 400. It never answers 500 for a repository: a git that fails, times out or refuses names
itself in that tree's `error`, and the tree keeps every reading that did succeed.

**Which trees.** Until sessions record their trees, they are inferred: the session's own folder
(its header cwd) when it is a *linked* git worktree, then every distinct folder a worker of the
session ran in (its worker manifests), taken to its worktree's top level, when that is a linked
worktree too. A main checkout is never listed, whoever ran in it: it is not a feature tree. One tree appears once per session, first
source wins. A folder that no longer exists is listed with `exists: false` and nothing else; a
folder that exists but is not in a git worktree, a relative path, and a remote session's
placeholder are not listed.

**What each tree says,** against its repository's base: local `master`, else `main`, else what
`origin/HEAD` points at; with none, no base fields at all. `merged` is `ancestor` when the tree's
HEAD is already in the base, `content` when it isn't but merging it would leave the base's tree
exactly as it is (a squash or rebase merge landed it), otherwise `no`. `ahead`/`behind` count
commits each side has that the other hasn't; `added`/`removed` are the lines the branch changed
since it left the base (binary files count 0). `branch` is absent on a detached HEAD. `dirty` says
whether anything is uncommitted, untracked files included.

**Read-only and bounded.** Reading a tree never writes to it: no index refresh or lock, no
fsmonitor, no textconv or external diff, and the trial merge behind `content` writes its objects to
a scratch store that is deleted afterwards. Every git runs without a shell under a 5-second limit,
at most four at a time. The comparison is kept until the tree's HEAD or its base moves, `dirty` for
ten seconds, and what hasn't been asked for in an hour is dropped. With git older than 2.38 there
is no trial merge, and `merged` is only ever `ancestor` or `no`.

## §app.insights/explanations-page — Explanations page (`#/explanations`)

Every /explain page on this machine, as cards, on a page of its own in the insights family: the
same shell as Usage and Agents (§app.insights/usage-page-and-agents-page: `.session-head` with
`.app-back` to `#/`, a focusable `h1` "Explanations", a meta line and `Refresh Explanations`,
then `.insights.pane` > `.insights-inner`). It reads the explanations list the app already polls
(`GET /api/explanations`, every 60s) and the session list the sidebar loads; nothing else is
fetched except the lookups below.

```html
<header class="session-head">
  <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">…</a>
  <div class="session-head-main">
    <h1 class="session-head-title" tabindex="-1">Explanations</h1>
    <p class="session-head-meta">12 explanations · newest first</p>
  </div>
  <button class="button button-icon button-ghost" aria-label="Refresh Explanations">…refresh…</button>
</header>
<section class="insights pane" aria-label="Explanations">
  <div class="insights-inner">
    <div class="explain-bar">
      <label class="field explain-bar-session">Session <span class="select-wrap"><select class="select">All sessions · one option per session with explanations</select></span></label>
      <div class="board-filters" role="group" aria-label="Date">…Today · 7 Days · 30 Days · All (aria-pressed)…</div>
      <label class="field explain-bar-sort">Sort <span class="select-wrap"><select class="select">Newest First · Oldest First</select></span></label>
    </div>
    <ul class="explain-grid explain-page-grid">
      <li class="card explain-tile">
        <a class="explain-tile-link" href="/explain/{id}?theme=dark">thumbnail (≥768px) · topic · "2h ago · glm-5.3" · summary · note</a>
        <p class="explain-tile-foot">From <span class="explain-tile-session">{session title}</span> <span class="chip">Archived</span> · <a href="#/s/{path}">Open in Session</a></p>
      </li>
    </ul>
  </div>
</section>
```

- **Routes.** `#/explanations` lists every explanation; `#/explanations/{sessionId}` is the same
  page with the session filter set to that session. Like the Agents page, the route is the
  filter's state: changing the session select replaces the hash (`#/explanations` for All
  sessions, no new history entry), and a hash change sets the select. The date filter and the
  sort are the page's own and reset when the page is left. At folded width the page uses
  `data-view="session"`, its title takes focus when the page opens, and Back (`.app-back`) goes
  to `#/`, the list, as every page's does.
- **Entry points.** The overview's Explanations card (§chat.transcript/landing-page), which is
  also a phone's way in (list → Overview → the card), and the insight strip's
  `Open {n} Explanations`, which opens `#/explanations/{sessionId}` (§app.insights/insight-strip).
- **Head meta.** `{n} explanation(s) · newest first` (or `· oldest first`, following the sort),
  where {n} counts the cards the filters leave. Left out until the first list has loaded.
- **Filters.** A bar above the grid:
  - **Session**: a select of `All sessions`, then one option per session that has at least one
    explanation, most recent explanation first, each named by the session's title (a session
    this tab can't resolve is named `session {first 8 characters of the id}`, and one this host
    says is gone `Session no longer on disk ({first 8 characters})`). A route naming a session
    with no explanations still selects it, and shows the empty state below.
  - **Date**: four toggle buttons, exactly one pressed, with a check beside the pressed one:
    `Today` (since local midnight), `7 Days`, `30 Days`, `All` (the default), counted back
    from now on each explanation's `createdAt`.
  - **Sort**: a select, `Newest First` (the default) or `Oldest First`, on `createdAt`.
- **Grid.** `ul.explain-grid` of cards, 1 column; 2 columns once the `insights` container is at
  least 640px wide, 3 at 1000px or more — the Usage grid's steps.
- **Card.** The explain tile (§chat.transcript/landing-page's former grid tile, `src/explain.css`):
  the thumbnail at 768px and up, the topic, `{relative time} · {model}`, the summary clamped to 3
  lines, and the advisory note when there is one. The thumbnail, topic, caption, summary and note
  are one plain link to `/explain/{id}` with no `target` (the same-tab rule of
  §app.insights/insight-strip). Under it, a foot line says where the page came from:
  - The session in the session list: `From {title}`, an `Archived` chip when it is archived,
    then `· Open in Session`, a separate link to `#/s/{path}`.
  - A session the list doesn't carry (it has no user message, for one): the page asks this host
    once (`GET /api/sessions/summary?id=`). Found, it reads as above, but links to `#/sid/{id}`,
    since `#/s/{path}` opens only rows the list has and `#/sid/` adds the found one. While it is
    asking, or when the ask failed for any reason but "not found", it reads
    `From session {first 8 characters of the id} · Open in Session`, also to `#/sid/{id}`.
  - Not found: the plain text "Session no longer on disk", and no link.
  - The two links are siblings, never one inside the other; the card itself is not a target.
    Each link has the focus ring; the card's border lifts on hover over its page link.
- **Open in Session lands on the explanation.** The link opens the session, and once the
  explanation's row is in the transcript (with the chat's `hello` or the watch view's snapshot,
  or fetched down to it in one request when it's older than the rows they carry,
  §chat.transcript/rendering) the transcript scrolls
  the explanation's own row (the report row whose explanation id matches) into the middle and
  tints it, the transcript's usual jump (§app.insights/insight-strip, Jump to Message), and, like
  every jump, stops the transcript following the bottom, so Jump to Latest appears and rows still
  rendering can't pull the view back down. It works whether or not the session's runtime was
  already open, and it happens once: the request is dropped after
  it lands, after it fails, or 60s after it was made if it still hasn't, the fetch of older rows
  included. While that fetch is on its way it waits, with no toast: a slow fetch shows the
  transcript's top-edge bar (§chat.transcript/rendering). When the branch has no such row (the explanation's entry is not on
  the branch on screen, e.g. after a rewind: the list reaches the top without it, or the server
  finds none), the session stays open and a toast says "That explanation isn't on this branch of
  the session." Rows kept from the last visit never count as the whole transcript.
- **Empty.** With no explanation at all, the grid's place holds one `.empty`: "0 explanations
  yet." and "Run `/explain` in a session and its page shows up here." When the filters leave
  nothing: "{n} explanation(s) in all. None match these filters." and "Choose All sessions or
  All to see more." Neither shows before the first list has loaded; until then, after 300ms, a
  skeleton, with `aria-busy` on `.insights-inner`.
- **Request error.** `.banner-error` "Couldn't load explanations." with Retry, above whatever was
  already loaded.
- **Refresh.** The head's refresh re-reads the explanations and the session list.

## §app.insights/insight-strip — Insight strip (current goal and explanations)

The strip holds **only the newest topic-outline summary** — the goal the agent is on now — and
labels it "Current goal". Every earlier summary lives on the session pane's Timeline tab (§chat/timeline),
which draws them on the session's axis; the strip keeps no history of its own.

```html
<details class="outline">
  <summary class="outline-summary">
    <span class="icon icon-sm icon-twist" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
    <span class="outline-label">Current goal</span>
    <span class="outline-now">· Audit and intercom removal complete</span>
    <span class="outline-count">12 topics</span>
    <span class="outline-count outline-explained">· Explained 3</span>
  </summary>
  <div class="outline-body">
    <div class="outline-column">
      <a class="button button-sm button-ghost outline-explained-open" href="#/explanations/{sessionId}">
        <span class="icon icon-sm" style="--icon: url(/icons/external.svg)" aria-hidden="true"></span>Open 3 Explanations
      </a>
      <button class="button button-sm button-ghost outline-explained-open" type="button" aria-controls="session-pane">
        <span class="icon icon-sm" style="--icon: url(/icons/clock.svg)" aria-hidden="true"></span>Open Timeline
      </button>
      <p class="outline-state">Latest · Why the watcher restarts · 2h ago</p>
      <p class="outline-overall">{overall}</p>
      <p class="outline-state">Updated 3m ago · behind the latest messages</p>
      <ol class="outline-topics">
        <li class="outline-topic">
          <div class="outline-topic-head">
            <span class="outline-topic-heading"><span class="outline-hash">#</span>Model selection and limits</span>
            <span class="outline-topic-time">2d ago</span>
          </div>
          <ul class="outline-bullets"><li>…</li></ul>
          <button class="button button-sm button-ghost outline-jump" type="button">Jump to Message</button>
        </li>
      </ol>
    </div>
  </div>
</details>
```

- **One row, both insights.** The outline and the session's /explain artifacts share this
  single disclosure, so the session head costs one row, not two.
- **One click, nothing nested.**
  1. Closed, the strip shows the `now` line and the counts it has.
  2. Open, it shows everything: the Timeline button and the Explanations link, `overall`, the state line, and
     every topic **flat** — its heading, its time, its bullets and its Jump, with no per-topic
     disclosure and no collapse state. The body scrolls inside `--outline-max`; it doesn't fold.
- **Column.** Open, everything in the body sits in one centered `.outline-column` — the same
  `max-width: calc(var(--measure) + var(--space-9)); margin: 0 auto; padding-inline: var(--space-4)`
  box `.transcript-inner` and `.composer-inner` center (§chat.transcript/transcript-items "Column
  width") — so the buttons, `overall`, the state lines and the topics track the column below at
  every width instead of pinning to the pane's left edge. `.outline-topics` and `.outline-overall`
  keep their `--measure` cap inside it; the body's own padding is vertical only (the shell keeps the
  full-width `--color-border` rule and the `--outline-max` scroll). Below §3's 72ch floor the box
  fills the pane, so narrower widths read exactly as a left-pinned column — the centering only shows
  when the column has margins to center in. The summary row above stays full-width chrome, like the
  session head it hangs from.
- **Explanations.** When the session has any, the summary gains
  `<span class="outline-count outline-explained">· Explained {n}</span>` after the topic count,
  counting finished, openable pages only (a run still in progress shows in the thread as its
  running row, and is counted and listed nowhere until its final entry lands),
  and the body opens with `Open {n} Explanations`, a link styled as a ghost button to
  `#/explanations/{sessionId}` — the Explanations page with this session's filter set
  (§app.insights/explanations-page) — followed by `Latest · {topic} · {relative time}`. There is
  no gallery dialog: the page is where explanations are browsed, one session's or all of them.
- **Every explain link opens in the same tab.** The Explanations page's cards
  (§app.insights/explanations-page), the transcript's report row and the session pane's explain row are all plain links to
  `/explain/:id` with no `target`. In an installed app a new tab is a new window whose history
  has one entry, so Back couldn't return to Sova; in place, it can. `/explain/:id` stays a
  standalone document for direct links. The server sends it with
  `Content-Security-Policy: sandbox allow-scripts` (no `allow-same-origin`): the model-written page
  runs in an opaque origin, so its scripts can't read Sova's storage or call its API as the
  user, while its one inline `?theme=` script still applies the theme, and the thumbnails'
  `sandbox=""` frames render as before. None of them carries the `external` icon or a "new tab"
  suffix any more, so each link's accessible name is just what it is — the report row and the
  pane row start with a visually hidden `Explanation: ` ahead of the topic, read as
  "Explanation: {topic}". The `external` glyph on `Open {n} Explanations` is unrelated: that link
  leaves the session for the Explanations page.
- **Open state.** The strip is closed by default and **nothing is persisted** — the open state
  lives in the component alone. The session view is a keyed `<Show>` on `viewKey()` (`src/App.tsx`,
  `chat:{force}:{path}` / `watch:{why}:{path}`), so a refetch doesn't remount the strip and a
  deliberate open survives updates, while navigating to another session, another mode, or the
  landing page remounts it closed. It should never stay open on nav away, so there is nothing
  worth persisting.
- **Opening a session.** Opening a session — a first visit or a switch back — shows its strip at
  its full height from the view's first frame, so the transcript below never moves when the
  insight lands. Until that load lands the strip is built from what the client already holds of
  THIS session, never another's: the session list's outline snapshot (`outlineNow`,
  `outlineTopics`, `outlineGist`) fills the closed row, "Current goal · {now} · {n} topics", and
  the body's `overall`, and the app's explanations poll gives the Explained count, the
  Explanations link and the Latest line. The state line, the live dot and the topics come with
  the insight, which then replaces all of it. A session the list knows no outline and no
  explanations for shows no strip and holds no space for one until its insight says otherwise.
- **Dismissal.** A `pointerdown` anywhere outside the strip closes it — the transcript, the
  sidebar, the composer, the pane — on the press, not the release. Inside is everything within
  the disclosure (the summary row, a topic's heading and bullets, Jump, `Open Timeline`,
  `Open {n} Explanations`). Following the Explanations link leaves the session, which remounts
  the strip closed. **Esc** dismisses it only when the
  press starts inside the strip, and never calls `preventDefault` — every other Esc in the product
  (the pane's close, Inputs' armed-rewind cancel, a dialog's own) keeps its behavior. Each of the
  three close paths — the summary toggle, the click-away, Esc — hands the transcript back the
  strip's `--outline-max` of flow.
- **Missing data.**
  - When `outline` is null but the session has explanations, the row still discloses: the label
    reads "Explained", the summary is `Explained · {n} · {latest topic}`, and the body holds the
    Explanations link and the Latest line.
  - When `outline` is null and there are no explanations, render no strip at all. Most sessions
    have neither, and an empty strip on each of them is noise.
  - Leave out an empty `now` (the summary then shows only the label and count), and likewise an
    empty `overall`.
- **Open Timeline.** A ghost button beside the Explanations link, opening the session pane on
  its Timeline tab (§chat/timeline): this goal's topics and every past summary's as chapter markers, with
  this session's inputs, tool density and idle gaps drawn in between them. It is always there,
  explanations or not — the summaries are what the axis is built from, and the Timeline is where
  the goals before this one went. It shares `.outline-explained-open`, so the two sit on
  the body's first line and space each other.
- **Topic details.** Each topic is an `li.outline-topic`: a static `.outline-topic-head` row (the
  heading, then the time at the end), then its `.outline-bullets`, then Jump. The head row is
  not a control — no pointer cursor, no hover underline. `.outline-hash` appears only on
  `manual` topics. The time is in mono 24-hour format, with the date prefix when the day isn't today
  (§chat/transcript timestamps). **It is the topic's own section's time** — `sectionAt`, the last
  message of the stretch of conversation the topic's latest update claimed
  (§app.insights/summary-sections) — so topics one summarizer run updated each show their own time.
  A topic without a section (a snapshot from before sections, or one the live overlay invented)
  shows `at`, the summary's own time: when the summarizer last wrote it.
- **Newest first.** Topics run newest first, by that same time; ties keep the later topic first. A
  topic the conversation returns to rises to the top. Only the display is sorted: the outline keeps
  its topics in the order they were created.
- **`updating` / `drafting`.** Put a `.live-dot` after `.outline-label` (a summarizer is running
  now), and the state line reads "Updating".
- **Jump to Message.**
  - It scrolls the transcript item whose entry id equals `entryId` into view, then stops
    auto-follow, so Jump to Latest appears (§chat/transcript). `entryId` is the first message of the
    topic's own section (§app.insights/summary-sections), so no two topics a run updated jump to the
    same place.
  - Leave it out when `entryId` is null or the transcript has no row for it (it was compacted
    away). That is asked of the rows the transcript renders, so a row it hasn't built yet still
    offers Jump, which builds it (§chat.transcript/rendering). While the transcript has older rows
    it hasn't fetched it is offered too, and the Jump fetches them down to the row
    (§chat.transcript/rendering); it removes itself if the branch has no such row. It is decided each time the strip
    opens, and when a topic arrives while it's open; a Jump that finds its item gone since then
    removes itself instead of scrolling nowhere. A topic without
    Jump still shows its heading, time and bullets.
- **Refetching.** Refetch after a watch `append` or chat `agent_settled`, debounced. Update in
  place.
- **Folded width.** `.outline-body` caps at 50vh instead of `--outline-max` (40vh).

## §app.insights/summary-sections — One section of the conversation per topic

The per-session summary (the pi-config `topic-outline` extension) is written in runs. Between runs,
the offset (`basisLeafId`) keeps a run from summarizing messages an earlier run already did. Within
a run, **each section of the transcript is claimed by exactly one topic**, and a topic's Jump and
time come from its own section.

- **Claims.** Each topic update names the range of the run's new messages it covers, first and
  last (`from`/`to`). Within one run no two accepted ranges cover the same messages, except that two
  neighbours may share the one message where one ends and the next begins, as long as each keeps a
  message of its own. Ranges are taken in the model's order: one that overlaps a range already
  accepted in the run is dropped, whole, and so is one that runs backwards or names a message the
  run wasn't given. This is enforced in code, not only asked for in the prompt.
- **Lookback, for context only.** A run also reads the last 4 messages before its offset (user and
  final assistant text, at most about 2,000 characters in all, the oldest dropped first), marked
  already summarized, because the previous run may have cut a thread halfway. It never claims them:
  a range touching one is refused.
- **One fact, one topic.** The prompt asks the model to split the new messages into consecutive
  ranges, one per topic; never to repeat a fact in two topics; and to keep a report that mentions
  other threads in passing in the range of the ask it answers. Topics carry 1–3 bullets of
  outcomes; a next step ("The rerun goes ahead once the last fix branch is merged.") is not one.
- **Stored on the topic.** The snapshot keeps the claimed range on the topic (`range: {from, to}`,
  each an anchor with its entry id and timestamp) beside `anchor`, which becomes the range's
  start. Both are additive: a snapshot from before ranges loads as it did, everywhere it is read
  (the extension, its terminal panel, Sova's decoder), and a malformed range is ignored, not its
  topic. A model that answers in the older single-`anchor` form still works, as a one-message range.
- **Jump.** A topic's Jump (§app.insights/insight-strip) lands on the first message of its latest
  section, so two topics one run updated never jump to the same place. When that message is tool
  traffic no row marks, the range's ends move inward to the nearest message that has a row.
- **Time.** A topic's time is the last message of its latest section (`sectionAt`), not the run's
  clock, so topics one run updated show different times. It orders the strip's topics
  (§app.insights/insight-strip) and the Overseer's `Topics (newest first)` line
  (§app.overseer/tools). Without a section, a topic falls back to `at`, when the summarizer last
  wrote it.

## §app.insights/compaction-row — Compaction row

The compaction `info` row (§chat/transcript) becomes a disclosure. It's fed by
`SessionInsight.compactions`, matched to the row by id.

```html
<details class="disclosure compaction">
  <summary class="disclosure-summary">
    <span class="icon icon-sm icon-twist" …chevron-right…></span>
    <span class="disclosure-label">Compacted</span>
    <span class="disclosure-preview">· <span class="text-mono">67,401</span> tokens summarized</span>
  </summary>
  <div class="disclosure-body">
    <div class="compaction-summary">{summary}</div>
    <p class="toolcard-section-label">Files read</p>
    <ul class="compaction-files"><li>~/…/extensions.md</li></ul>
    <p class="toolcard-section-label">Files changed</p>   <!-- omit an empty list -->
  </div>
</details>
```

The summary is plain text with `pre-wrap`, the same as `.message-text`. Paths use `~` in place
of `$HOME`.

## §app.insights/tokens-motion-and-accessibility — Tokens, motion, and accessibility

- **Tokens.** One new token: `--outline-max` (40vh). **No new colors.** Neutrals and the status
  tokens cover everything, and accent appears only on live-sourced Working/Starting chips and
  focus.
- **Motion.** Nothing new animates but the token chart's scrub card, which lifts in (scale .96 to
  1, 120ms) like the drag ghost and collapses to its end state under reduced motion
  (§app.insights/velocity-scrub). The pulse is reused as the skill's live indicator. Meters
  never animate their fill.
- **Accessibility.**
  - The meter's number is its accessible value, and the track is `aria-hidden`.
  - Every section and card is labelled by its heading.
  - Status chips are text.
  - The foot row is a link named by its text.
  - Contrast pairs:
    - The meter fill is muted on sunken: 5.40 (dark) and 4.75 (light), both clearing 3:1 for a
      graphical object.
    - Ink-2 on sunken (card heads) is 7.65 and 7.22.
    - Ink-2 on accent-tint (the current foot row) matches the selected session row.

---

