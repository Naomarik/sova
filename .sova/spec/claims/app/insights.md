# §app/insights — Insights
> Part of the Sova design spec · [overview](../design/overview.md)

What the user's pi extensions publish, read-only except for one cache: subscription usage
(usage-status), which this server also keeps fresh itself (§app.insights/usage-refresh), teams and
subagents (subagents + sessions live records), and per-session summaries (topic-outline,
compaction). Data shapes are `UsageInsight`, `AgentsInsight`, and `SessionInsight` in
`shared/protocol.ts`. **Every status says where it came from**: live-sourced states can pulse,
while reported states (read from a session file after the fact) never pulse and carry
"as of `14:06`".

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
  <a class="list-row list-row-interactive insights-row" href="#/usage" aria-current="page"
     title="Usage: Claude 7-day 47%, OpenAI 7-day 95%, Ollama Cloud Monthly 80%, Z.ai 5-hour 0%"
     aria-label="Usage: Claude 7-day 47%, OpenAI 7-day 95%, Ollama Cloud Monthly 80%, Z.ai 5-hour 0%">
    <span class="icon" style="--icon: url(/icons/gauge.svg)" aria-hidden="true"></span>
    <span class="insights-row-text usage-glance">
      <span class="usage-glance-item"><span class="usage-glance-tag">C</span><span class="text-num">47%</span></span>
      <span class="usage-glance-item usage-glance-item-high"><span class="usage-glance-tag">O</span><span class="text-num">95%</span></span>
      <span class="usage-glance-item usage-glance-item-stale"><span class="usage-glance-tag">OL</span><span class="text-num">80%</span></span>
      <span class="usage-glance-item"><span class="usage-glance-tag">Z</span><span class="text-num">0%</span></span>
      <span class="usage-glance-item"><span class="usage-glance-tag">DS</span><span class="text-num">$4</span></span>
    </span>
  </a>
  <!-- aria-current on #/agents and #/agents/* -->
  <a class="list-row list-row-interactive insights-row" href="#/agents"
     title="6 active agents in 4 sessions, 2 teams" aria-label="6 active agents in 4 sessions, 2 teams">
    <span class="icon" style="--icon: url(/icons/worker.svg)" aria-hidden="true"></span>
    <span class="insights-row-text"><span class="text-num">6</span> agents · <span class="text-num">4</span> sessions · <span class="text-num">2</span> teams</span>
  </a>
</div>
```

The foot holds **two stacked 44px rows, and both are always present**, so the layout never
jumps. `.list-row`'s bottom border divides them. A single row split into two links was
rejected: 288px divided in two truncates "Claude 5-hour 96%". Neither row has a chevron. They're
whole-row links with a hover state and the `aria-current` tint, like session rows, and the Usage
glance needs the room.

- **Usage row, a glance at every provider:**
  - One segment per provider, in the fixed order Claude, OpenAI, Ollama Cloud, Z.ai, DeepSeek.
    The tags are exactly `C`, `O`, `OL`, `Z`, `DS`, followed by a mono number in the same
    `.text-num`. **A provider that reports a balance instead of windows (DeepSeek) shows the
    money, not a percentage**: `DS $4`. It has no quota, so there is no percentage to invent;
    its segment goes last, like its card.
  - **Two precisions for the one balance.** The foot is a shorthand, so it rounds to **whole
    currency units** ($4.29 → `$4`, $4.99 → `$5`; `moneyCompact()`, both fraction-digit options
    set to 0). The row's `title`/`aria-label` and the Usage card keep the **exact** amount
    ($4.29, "Topped up $4.29"; `money()`) — the cents stay one hover, or one click, away.
  - **Window.** Each provider shows the window flagged `active` (the first one, if several
    are flagged). Otherwise it shows its 7-day window, and failing that, its longest. Ollama
    shows Monthly. Z.ai shows its plan window (5-hour), never MCP uses. An active window gets
    no marker in the glance ("C 55%"); the tooltip names it: "Claude 7-day Fable 55%".
  - **Missing data.** A provider that isn't `ok`, or has neither windows nor a balance, is left
    out. With nothing at all, the row reads "Usage".
  - **High.** At 80% or more, the item takes `.usage-glance-item-high`: semibold ink, and **no
    hue**. The foot has no word to pair with a color, and the Usage page's chip carries the
    status. A balance takes it when the provider says it can't fund calls (`available: false`):
    out of credit is the only bad state money has, and the semibold is its only emphasis.
  - **Stale.** Only when the whole cache file is old (`usage.stale`) the item takes
    `.usage-glance-item-stale`: muted, with no added text. A provider's own failed fetch — including
    the last known reading served while an older pi session rewrites the cache — neither dims nor
    annotates its item.
  - **Full text.** The row's `title` and `aria-label` spell everything out, e.g. "Usage: Claude
    7-day 47%, …, DeepSeek balance $4.29" (the exact amount, not the rounded one); nothing is
    appended for a stale file.
  - **Width.** Measured in the 320px sidebar (the glance box is 259px at a 1440px viewport):
    a real five-provider reading (`C 83% O 97% OL 90% Z 8% DS $4`) is 226px and fits. The fifth
    segment does spend the slack — all four windows at 100% plus `DS $4` is 263px, so the worst
    case now overruns by a few px and `.usage-glance` clips it (it never wraps). Rounding the
    balance to whole units is what keeps the common case comfortable; `DS $4.29` would cost
    another ~20px.
- **Agents row, what is live right now:** `{agents} agents · {sessions} sessions · {teams} teams`.
  Any segment at 0 is dropped, and with nothing live at all the row reads the plain word
  "Agents". The numbers come from `activeAgentCounts` in `src/lib/workers.ts`, and each one is
  narrower than it looks:
  - **An active agent** is a worker in a *fresh* host session whose status is not settled:
    `workerCounts.working + workerCounts.waiting` — **working** is starting, running or
    stopping, **waiting** is a worker that finished its task and is still attached. `done`,
    `error` and `killed` never count, and a stale heartbeat never counts. The counts are read
    from `workerCounts`, not the `workers` array, because the array drops evicted workers.
  - **A host session** is any live record except a headless worker pi (`mode: "rpc"` without
    `embedded`); Sova's own embedded rpc runtimes *are* sessions, because they host agents.
  - **sessions** is how many fresh host sessions hold at least one active agent — not how many
    are running.
  - **teams** is `activeTeams(…).length`, unchanged.
- **The row's full sentence** lives in its `title` and `aria-label`: "6 active agents in 4
  sessions, 2 teams". The row itself has room for figures, not for the word "active".
- **"Agents" and "working" are different windows, on purpose.** This row is the first place the
  app says *agent*, and it counts working **and** waiting. The Agents page still summarises the
  same machines as "{w} working" — `AgentsInsight.totals.working` — which excludes the waiting
  ones. The foot answers "how much is attached to me right now"; the page answers "how much is
  moving". Two numbers, two questions; neither is a rounding of the other.

The rows take no color and no chip, because the pages carry the status. Each truncates with an
ellipsis.

## §app.insights/aggregate-chips-live-vs-working — Aggregate chips: "Live" vs "Working"

- **Live** is session-level: a TUI has the file open. It keeps the accent everywhere and says
  the same word everywhere: §app/session-list's sidebar row carries it as a **static** `TUI` chip in the rail
  (no dot), and the session head as a **static** `TUI` chip. The pulse moved to Busy and to
  running work; no TUI mark pulses anywhere (§design.ground-rules/motion).
- **Working** is worker-level: a subagent is mid-task. On a member row it's
  `.chip-accent.chip-live` "Working", and pulses only when live-sourced (see Team cards).
- **Aggregates are neutral** `.chip.chip-count`, with no dot and no pulse, so each row has only
  one pulsing thing:
  - **Session rows (§app/session-list):** no chip at all. The count is `{n}` + a `worker` icon in the row's
    left rail (`.session-rail-count`), under the row's state, when `live?.workers?.working ≥ 1`.
    Hidden at 0 or when absent. `.session-rail-count-live` pulses the icon only, and only on a
    row with no Busy dot, whose pulse would otherwise be a second moving thing.
  - **Session head:** a link chip before Live. With a live team it stays worded —
    `<a class="chip chip-count" href="#/agents/{teamId}">Team · {n} working</a>`, pointing at
    the busiest live team when there are several. Without a team it matches the rail's
    vocabulary: `<a class="chip chip-count session-head-working" href="#/agents">{n}<span
    class="icon icon-sm" style="--icon:url(/icons/worker.svg)"></span></a>`,
    `aria-label`/`title` "{n} subagents working now",
    the word carried by the label rather than the box. The icon inside a `.chip-count` is 12px.
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
  (§app.insights/team-cards): one row per session, with its workers, team and worktrees folded
  inside the row. When nothing is in view, its whole body under the bar is one `.empty`
  (§design/copy-deck): the live fact first ("{n} sessions live." or "No session is live right
  now."), then the absence for the chip or search in force.
- **Head meta (Agents).** `{w} working · {l} live · {$} today · {u} unmerged`: sessions in the
  Working state, live sessions, what the workers of sessions active since local midnight have
  spent (their lifetime `usageTotal.cost`; left out when none reports a cost), and distinct
  unmerged branches among the worktrees read so far (left out before the first reading). The
  line's `title` says what each figure counts.
- **Grid (Usage).** `.insights-grid` has 1 column. It becomes 2 columns when the `insights`
  container is at least 640px wide, and 3 at 1000px or more. The container is named, per the skill.
- **Polling** (frontend's call on intervals). Update in place and keep scroll position and
  focus. Don't show a skeleton again after the first load. The board keys its rows by session
  path, so a poll keeps an open row open and a rename field focused.
- **Loading** (first load, after 300ms). The Usage page shows 5 `.skeleton` blocks (one per
  provider it can show) at 120px
  tall with `--r-lg`. The Agents page shows 1 skeleton list until the session list has loaded.
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
      <div class="meter-track" aria-hidden="true"><span class="meter-fill meter-fill-warn" style="--meter-pct: 96%"></span></div>
      <p class="meter-context" title="2026-09-19T07:50:00Z">Resets in 2h 17m</p>
    </div>
    <!-- or, instead of meters: <p class="usage-note">Not signed in. Run <code>claude /login</code> …</p> -->
  </div>
</article>
```

- **Cards.** There's one card per `providers[]` entry, in the order given: Claude, OpenAI,
  Ollama Cloud, Z.ai, DeepSeek. Z.ai follows the system like every other provider: no brand color, and
  the title is "Z.ai"; so does DeepSeek, titled "DeepSeek".
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
    (optional fields on `UsageWindow`), and is otherwise left out.
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
  - **Context.** Only when `resetsAt` exists (currently Claude only). Under 24h it's
    "Resets in 2h 17m", otherwise "Resets Sep 25", with the ISO time in `title`. Never estimate
    a reset.
  - **Reset already passed** (`resetsAt < now`, which means the file is stale). Use
    `.meter-ghost`, with no fill. The value keeps the old number, and the context says
    "Reset at `11:50`. New reading at the next refresh."
  - **Fill color.** The fill is neutral. It gets `.meter-fill-warn` at ≥80% and
    `.meter-fill-error` at ≥100%. That matches the extension's own footer threshold, and it
    always pairs with the head chip.
- **Head chip.** The worst window decides it. The words follow the skill's model-availability
  severities:

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
  other value leaves it on. It never keeps the process alive, and it stops on shutdown.
- **Refresh Usage** (§app.insights/usage-cards): a forced refresh, now.
- **A TUI pi**, unchanged: its own timer and after each turn.

Two servers with different agent dirs (the live one and a hermetic test server) keep separate
caches and locks, so each fetches on its own; servers on the same agent dir share one.

**Sign-in data.** `GET /api/insights/usage` adds `auth` (`UsageAuth`) to a provider when its
credentials say something: expiry times, when the sign-in was last renewed, and whether the access
and refresh tokens have expired by the server's clock. It comes from the same credential files the
usage fetch reads (Claude Code's `~/.claude/.credentials.json`, pi's `~/.pi/agent/auth.json`, the
Codex CLI's `~/.codex/auth.json`), re-read only when a file changes. It carries numbers, enums and
booleans only: no string from a credential file ever leaves the server. Claude's
`refreshedAt` is the credentials file's modification time, and only while that time agrees (to
within 10 minutes) with an 8-hour token lifetime ending at `expiresAt`; otherwise it is left out
rather than guessed. OpenAI signed in through pi has an expiry and no renewal time; signed in only
through the Codex CLI, a renewal time (`last_refresh`) and no expiry. API-key providers carry
`{kind: "apiKey"}` and nothing else.

**Sova never writes a credential file and never refreshes a token.** A Claude sign-in renews only
when Claude Code itself runs; the Usage page says so (§app.insights/usage-cards) instead of
renewing it.

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
    <li class="board-row" data-state="working">          <!-- working | needs-you | idle | archived -->
      <div class="board-line">
        <div class="board-cell board-session">rail · twist (aria-expanded) · title (click to rename) · gist</div>
        <div class="board-cell board-activity">model · context ring · 5m ago · state chip</div>
        <div class="board-cell board-workers">2/5 working · team chip → #/agents/{teamKey} · $1.20</div>
        <div class="board-cell board-trees">feat/x · ↑3 ↓1 · +120 −4 · dirty dot · +1</div>
        <div class="board-cell board-actions">Open · Subagents · Archive · Move into group · ⋯</div>
      </div>
      <div class="board-detail">…one line per worker, the team, one line per worktree…</div>   <!-- open rows only -->
    </li>
  </ul>
</div>
```

- **State.** One per row, on its rail (a colored left edge) and in a chip with a dot and the
  word: **Needs you** when the session waits on input or has an extension dialog open; else
  **Working** when its turn runs or any of its workers works; else **Needs you** when its last
  turn failed or stopped on an error, or its decision marks (unseen asks-you or looping, a stuck
  subagent) say so; else **Idle**, or **Archived** for an archived session nothing runs in. The
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
- **Columns** (the `insights` container ≥1000px). Session: the title as a button that starts the
  rename, the gist (`outlineGist`, else the now line, else the cwd in mono). Activity: the compact
  model, the context ring (the sidebar row's rule: the open view's live fill wins, never without a
  window), last active in relative time, the state chip. Workers:
  `{working}/{total} working`, a count chip per team linking to its `#/agents/{teamKey}`, the
  workers' lifetime spend. Worktrees: see §app.insights/subagent-cards. Actions: Open, Subagents
  (opens the session with its subagents pane on the Agents tab), Archive or Unarchive, Move into
  group (the session pane's group menu, icon only), and ⋯. The head's totals line (working ·
  live · spend today · unmerged, with its `title`) leaves the page head and sits right-aligned on
  the filter line (`.board-totals`); below 1000px it stays in the head.
- **Wide** (the `insights` container ≥1600px). Session takes the extra width (titles and gists
  show in full where they fit); Activity is one line (model, ring, last active, state chip) in a
  15rem track, Workers 8rem, Worktrees 22rem, the actions their fixed width.
- **Page.** Only this page drops the 1280px page cap: side margins `--space-4` below 1600px and
  `--space-6` from there, the content capped at 2400px and centered; the head, the bar and the
  board share the same left and right edges. Other insights pages keep 1280px.
- **Condensed** (768–999px): Activity sits over Workers in one column; the actions are Open and
  ⋯. **Folded** (<768px): stacked rows — title with the state chip, the gist, a micro line
  (model · workers · last active), the worktree chips — a tap on the row's bare surface opens it,
  and ⋯ is the door to every action. Every target is 44px.
- **⋯ menu.** Open Session, Open Subagents, Rename…, Use Gist as Title (the gist on one line,
  cut to the title limit; off, with the reason, when there's none or it already is the title),
  Reset to Original Title (off when not renamed), Move to Group… (a screen of the groups, with
  "No group"), Archive or Unarchive, Copy Path.
- **Rename.** In place, the sidebar's title field: Enter saves, Escape cancels, an empty field
  restores the derived title, and leaving the field saves what's in it (empty: cancels). Kept in
  Sova only.
- **Archive.** Only for sessions started in Sova, or already archived. Refused with its reason
  (open in a TUI, mid-turn, subagents working) before the press, never after.
- **Open row.** One line per worker outside a team (working first): name, id and model in mono,
  the preview while working, the status chip (the table below), and **Resume** for a restored
  worker the server can resume (`POST /api/workers/resume`). Then each team, then one line per
  worktree.
- **Team.** A bordered block, `.team-group`, `id="team-{teamKey}"`, `tabindex="-1"`: the name,
  its id in mono, Paused (warn) when its newest pause/resume is a pause, "{n} working", the
  objective on one line, then its members one line each — coordinator (or orchestrator) first,
  then members in roster order, the monitor, retired members last — with their duty or successor
  badge and Ejected as a neutral chip beside the name, never in place of the status. Its events
  fold under "Events ({n})", oldest first.
- **Status.** The word is always shown. The pulse appears only when the worker is in a fresh
  live record (a team's: its parent live and fresh).

  | Source → status | Chip |
  |---|---|
  | live `running` | `.chip.chip-accent.chip-live` Working |
  | live `starting` | `.chip.chip-accent.chip-live` Starting |
  | `waiting` | `.chip` + dot, Idle. If `outcome` isn't `success`, the line adds "last task failed" |
  | `stopping` | `.chip` + dot, Stopping |
  | `done` | `.chip.chip-success` Done |
  | `error` | `.chip.chip-error` Failed |
  | `killed` | `.chip` + dot, Stopped |
  | `restored` | `.chip` + dot, Restored (Interrupted, warn, when it died mid-turn) |
  | retired | `.chip` + dot, Retired, as of the retirement |
  | `worker` null, `lastReport` present | that status's chip with **no pulse**, and the line adds "as of `{HH:MM}`" |
  | neither | neutral `.chip` No report yet |

- **Deep link.** `#/agents/{teamKey}` (a bare team id from an older link: the newest team with
  that id) keeps the team's parent session on the board whatever the filter, opens its row,
  scrolls the team into view and focuses it, tinted, once per link: polls don't take focus back.

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
- **Open row.** One line per tree: branch, the same reading, lines, "uncommitted" in words, "a
  worker's" when a worker's cwd is the source, and the path in mono.
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
- **Open in Session lands on the explanation.** The link opens the session, and once its
  transcript has loaded (the chat's `hello`, or the watch view's snapshot) the transcript scrolls
  the explanation's own row (the report row whose explanation id matches) into the middle and
  tints it, the transcript's usual jump (§app.insights/insight-strip, Jump to Message), and, like
  every jump, stops the transcript following the bottom, so Jump to Latest appears and rows still
  rendering can't pull the view back down. It works whether or not the session's runtime was
  already open, and it happens once: the request is dropped after
  it lands, after it fails, or after 60s unclaimed. When the loaded transcript has no such row (the
  explanation's entry is not on the branch on screen, e.g. after a rewind), the session stays open
  and a toast says "That explanation isn't on this branch of the session."
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
  standalone document for direct links. None of them carries the `external` icon or a "new tab"
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
  `manual` topics. The time is `at` in mono
  24-hour format, with the date prefix when the day isn't today (§chat/transcript timestamps). **That time is
  the summary's own** — when the summarizer wrote the topic, not when the conversation it
  describes happened. It is fine in a list, which claims no order beyond its own; §chat/timeline's axis
  can't use it, and replaces it with the anchored message's time, falling back to this one,
  flagged, when the anchor is gone.
- **`updating` / `drafting`.** Put a `.live-dot` after `.outline-label` (a summarizer is running
  now), and the state line reads "Updating".
- **Jump to Message.**
  - It scrolls the transcript item whose entry id equals `entryId` into view, then stops
    auto-follow, so Jump to Latest appears (§chat/transcript).
  - Leave it out when `entryId` is null or the item isn't rendered (it was compacted away). That
    is decided each time the strip opens, and when a topic arrives while it's open; a Jump that
    finds its item gone since then removes itself instead of scrolling nowhere. A topic without
    Jump still shows its heading, time and bullets.
- **Refetching.** Refetch after a watch `append` or chat `agent_settled`, debounced. Update in
  place.
- **Folded width.** `.outline-body` caps at 50vh instead of `--outline-max` (40vh).

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
- **Motion.** Nothing new animates. The pulse is reused as the skill's live indicator. Meters
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

