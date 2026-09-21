# 10 · Insights
> Part of the pi-web design spec · [overview](overview.md)

What the user's pi extensions publish, read-only: subscription usage (usage-status), teams and
subagents (subagents + sessions live records), and per-session summaries (topic-outline,
compaction). Data shapes are `UsageInsight`, `AgentsInsight`, and `SessionInsight` in
`shared/protocol.ts`. **Every status says where it came from**: live-sourced states can pulse,
while reported states (read from a session file after the fact) never pulse and carry
"as of `14:06`".

## Placement

- **Global:** two main-pane pages, each about one thing, entered from two pinned `.sidebar-foot`
  rows:
  - **`#/usage`** covers subscription limits.
  - **`#/agents`** covers teams and subagents. Team deep links are `#/agents/{teamId}`.

  The head is full at 320px (§2). A third sidebar region would scroll away and mix non-session
  data into the session list. An overlay would hide the transcript. The foot is always visible,
  sits in the folded thumb arc, and needs no rail. At folded width both pages use
  `data-view="session"` and show `.app-back`.
- **Old URLs:** `#/insights` redirects to `#/usage`, and `#/insights/{teamId}` to
  `#/agents/{teamId}`, via `history.replaceState`, so no extra history entry is added.
- **Per session:** `details.outline` (the Current goal strip) sits directly under `.session-head`,
  above the live banner.
  Compactions stay in the transcript, at the point where they happened (§3 items).
- **Aggregates:** neutral count chips on session rows and in the session head.
- **All explanations:** the landing page at `#/`, under the opening (§3). The sidebar foot has no
  Explained row — a grid of pages is not a doorway that fits a 44px row.
- No toasts, and nothing is announced on a poll.

## Sidebar foot

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
    `embedded`); pi-web's own embedded rpc runtimes *are* sessions, because they host agents.
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

## Aggregate chips: "Live" vs "Working"

- **Live** is session-level: a TUI has the file open. It keeps the accent everywhere, but §2's
  sidebar row carries it as a wordless, **static** rail pill and the session head as a worded,
  **static** `TUI` chip. The pulse moved to Busy and to running work; no TUI mark pulses
  anywhere (§0 Motion).
- **Working** is worker-level: a subagent is mid-task. On a member row it's
  `.chip-accent.chip-live` "Working", and pulses only when live-sourced (see Team cards).
- **Aggregates are neutral** `.chip.chip-count`, with no dot and no pulse, so each row has only
  one pulsing thing:
  - **Session rows (§2):** no chip at all. The count is `{n}` + a `worker` icon in the row's
    left rail (`.session-rail-count`), under the state pill, when `live?.workers?.working ≥ 1`.
    Hidden at 0 or when absent. `.session-rail-count-live` pulses the icon only, and only on a
    row whose pill is static.
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

## Usage page (`#/usage`) and Agents page (`#/agents`)

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

<!-- #/agents and #/agents/{teamId} -->
<header class="session-head">
  <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">…</a>
  <div class="session-head-main">
    <h1 class="session-head-title" tabindex="-1">Agents</h1>
    <p class="session-head-meta">3 working · 2 pi sessions running</p>   <!-- 0 live: No pi sessions running -->
  </div>
  <button class="button button-icon button-ghost" aria-label="Refresh Agents">…refresh…</button>
</header>
<section class="insights pane" aria-label="Agents">
  <div class="insights-inner">
    <!-- 0 live sessions: ONE .empty here and nothing else (no section heads) -->
    <section class="insights-section" aria-labelledby="ins-teams">
      <h2 class="insights-section-head" id="ins-teams">…worker icon-sm… Teams <span class="insights-section-count">· 2 active</span></h2>
      <div class="insights-grid">…team cards, or .empty…</div>
    </section>
    <section class="insights-section" aria-labelledby="ins-agents"><!-- only with non-team workers -->
      <h2 class="insights-section-head" id="ins-agents">…worker icon-sm… Subagents <span class="insights-section-count">· 3 working</span></h2>
      <div class="insights-grid">…agent cards…</div>
    </section>
  </div>
</section>
```

- **Split.** Usage and agents never share a page. The Agents page runs Teams first, then
  Subagents, and leaves out Subagents when no session has solo workers. With 0 live sessions,
  the whole Agents body is one `.empty` (§9).
- **Head meta (Agents).** The format is `{w} working · {n} pi sessions running`. Drop
  "{w} working · " when w is 0, and use "1 pi session running" when n is 1.
- **Grid.** `.insights-grid` has 1 column. It becomes 2 columns when the `insights` container is
  at least 640px wide, and 3 at 1000px or more. The container is named, per the skill.
- **Polling** (frontend's call on intervals). Update in place and keep scroll position and
  focus. Don't show a skeleton again after the first load.
- **Loading** (first load, after 300ms). The Usage page shows 5 `.skeleton` blocks (one per
  provider it can show) at 120px
  tall with `--r-lg`. The Agents page shows 1. Put `aria-busy` on `.insights-inner`.
- **Request error.** Show `.banner-error` at the top of `.insights-inner` with Retry: "Couldn't
  load usage." or "Couldn't load agents." Any data already loaded stays visible below it.
## Usage cards

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
  `badkey`, `na`, or `error` with no windows; see §9), with no chip and no meters. Commands in
  the note go in `<code>`.
- **Whole file.**
  - The Usage page's head meta always shows "Updated {rel}" from `fetchedAt`, or "Not read yet".
  - When `stale` is true (more than 10 minutes old, which means no TUI pi is refreshing it),
    add a `.banner.banner-warn` (`clock`) above the grid. The meters still render.
  - When `available` is false, replace the grid with one `.empty`. `missing` means unavailable,
    not an error. `corrupt` gets the error copy.

## Team cards

Teams come from `AgentsInsight.sessions[].teams`, meaning teams whose parent pi is running now.
Workers die with their parent, so a team is only active while its parent runs. Ended teams
have no global surface. If one is rendered at all, it's in its parent session, from
`SessionInsight.teams` with `live: false`. There it uses the same `.team-card` markup, with a
neutral `.chip` "Ended" in the head. Every member chip then takes the reported form: no pulse,
and "as of `{HH:MM}`" in the meta.

```html
<article class="card team-card" id="team-team_02" aria-labelledby="tt-team_02">
  <header class="card-head">
    <h3 class="card-title" id="tt-team_02">pi-web-insights</h3>
    <span class="text-mono text-caption">team_02</span>
  </header>
  <div class="card-body"><p class="team-objective" title="{full objective}">{objective}</p></div>
  <ul class="list member-list">
    <li class="list-row member-row" title="Owns: server/**">
      <div class="list-main">
        <p class="list-title">lead <span class="chip chip-count">Orchestrator</span></p>
        <p class="list-meta"><span class="text-mono">ag_08</span> · <span class="text-mono">opus[1m]</span></p>
        <p class="member-preview">{worker.preview}</p>   <!-- working only -->
      </div>
      <span class="chip chip-accent chip-live"><i class="chip-dot"></i>Working</span>
    </li>
  </ul>
  <footer class="card-foot"><p class="text-caption">Started 42m ago in <a href="#/s/…">{parent title}</a></p></footer>
</article>
```

- **Rows.** Rows are not targets: they carry no link and no hover. The role is `.list-title`.
  Ids and models are mono in the meta line. Orchestrator is a neutral count-style badge, not a
  status. Owned paths go only in the row's `title`, because they're advisory.
- **Order.** Orchestrator first, then members in roster order.
- **Status.** The word is always shown. The pulse appears only when `member.worker` is present
  **and** its session is `fresh`.

  | Source → status | Chip |
  |---|---|
  | live `running` | `.chip.chip-accent.chip-live` Working |
  | live `starting` | `.chip.chip-accent.chip-live` Starting |
  | `waiting` | `.chip` + dot, Idle. If `outcome` isn't `success`, the meta adds "last task failed" |
  | `stopping` | `.chip` + dot, Stopping |
  | `done` | `.chip.chip-success` Done |
  | `error` | `.chip.chip-error` Failed |
  | `killed` | `.chip` + dot, Stopped |
  | `worker` null, `lastReport` present | that status's chip with **no pulse**, and the meta adds "as of `{HH:MM}`" |
  | neither | neutral `.chip` No report yet |

  A live record with `fresh: false` renders its workers the reported way, with "as of" set to
  the heartbeat time. They're never shown as working.
- **Deep link.** `#/agents/{teamId}` is a route segment, not a fragment, because the whole
  route lives in the hash. The view scrolls `#team-{teamId}` into view and focuses it (the card
  has `tabindex="-1"`). `.team-card:focus` draws the focus ring; `:focus-visible` wouldn't,
  because this focus is programmatic after a click.

## Subagent cards

There's one `.card.agent-card` per live session that has **non-team** workers. The head holds
the session title as a link to `#/s/…` (or `cwd`, mono, when `path` is null) and a
`.chip-count` "{n} working". Its body is a `.member-list` of `.member-row`s: the worker's `name`
as the title, `id` and `model` in the meta, the preview while working, and the status chip from
the table above. When no session has solo workers, the section is omitted.

## Insight strip (current goal and explanations)

The strip holds **only the newest topic-outline summary** — the goal the agent is on now — and
labels it "Current goal". Every earlier summary lives on the session pane's Timeline tab (§13),
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
    <button class="button button-sm button-ghost outline-explained-open" type="button" aria-haspopup="dialog">
      <span class="icon icon-sm" style="--icon: url(/icons/external.svg)" aria-hidden="true"></span>Open 3 Explanations
    </button>
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
</details>
```

- **One row, both insights.** The outline and the session's /explain artifacts share this
  single disclosure, so the session head costs one row, not two.
- **One click, nothing nested.**
  1. Closed, the strip shows the `now` line and the counts it has.
  2. Open, it shows everything: the Timeline and gallery buttons, `overall`, the state line, and
     every topic **flat** — its heading, its time, its bullets and its Jump, with no per-topic
     disclosure and no collapse state. The body scrolls inside `--outline-max`; it doesn't fold.
- **Explanations.** When the session has any, the summary gains
  `<span class="outline-count outline-explained">· Explained {n}</span>` after the topic count,
  and the body opens with a ghost `Open {n} Explanations` button — the existing gallery dialog
  (`aria-haspopup="dialog"`) — followed by `Latest · {topic} · {relative time}`. This dialog is
  **unchanged** and stays session-scoped; every explanation on the machine is the landing page's
  grid instead (§3), which is a page and not a dialog.
- **Every explain link opens in the same tab.** The gallery's cards, the landing page's grid
  (§3), the transcript's report row and the session pane's explain row are all plain links to
  `/explain/:id` with no `target`. In an installed app a new tab is a new window whose history
  has one entry, so Back couldn't return to pi-web; in place, it can. `/explain/:id` stays a
  standalone document for direct links. None of them carries the `external` icon or a "new tab"
  suffix any more, so each link's accessible name is just what it is — the report row and the
  pane row start with a visually hidden `Explanation: ` ahead of the topic, read as
  "Explanation: {topic}". The `external` glyph on `Open {n} Explanations` is unrelated: that is
  the button that opens the gallery dialog.
- **Open state.** The strip is closed by default and **nothing is persisted** — the open state
  lives in the component alone. The session view is a keyed `<Show>` on `viewKey()` (`src/App.tsx`,
  `chat:{force}:{path}` / `watch:{why}:{path}`), so a refetch doesn't remount the strip and a
  deliberate open survives updates, while navigating to another session, another mode, or the
  landing page remounts it closed. It should never stay open on nav away, so there is nothing
  worth persisting.
- **Dismissal.** A `pointerdown` anywhere outside the strip closes it — the transcript, the
  sidebar, the composer, the pane — on the press, not the release. Inside is everything within
  the disclosure (the summary row, a topic's heading and bullets, Jump, `Open Timeline`,
  `Open {n} Explanations`) **and the gallery dialog it opens**, which is portalled, so a click in
  that dialog or on its scrim leaves the strip open underneath. **Esc** dismisses it only when the
  press starts inside the strip, and never calls `preventDefault` — every other Esc in the product
  (the pane's close, Inputs' armed-rewind cancel, a dialog's own) keeps its behavior. Each of the
  three close paths — the summary toggle, the click-away, Esc — hands the transcript back the
  strip's `--outline-max` of flow.
- **Missing data.**
  - When `outline` is null but the session has explanations, the row still discloses: the label
    reads "Explained", the summary is `Explained · {n} · {latest topic}`, and the body holds the
    gallery button and the Latest line.
  - When `outline` is null and there are no explanations, render no strip at all. Most sessions
    have neither, and an empty strip on each of them is noise.
  - Leave out an empty `now` (the summary then shows only the label and count), and likewise an
    empty `overall`.
- **Open Timeline.** A second ghost button beside the gallery one, opening the session pane on
  its Timeline tab (§13): this goal's topics and every past summary's as chapter markers, with
  this session's inputs, tool density and idle gaps drawn in between them. It is always there,
  explanations or not — the summaries are what the axis is built from, and the Timeline is where
  the goals before this one went. It shares `.outline-explained-open`, so the two sit on
  the body's first line and space each other.
- **Topic details.** Each topic is an `li.outline-topic`: a static `.outline-topic-head` row (the
  heading, then the time at the end), then its `.outline-bullets`, then Jump. The head row is
  not a control — no pointer cursor, no hover underline. `.outline-hash` appears only on
  `manual` topics. The time is `at` in mono
  24-hour format, with the date prefix when the day isn't today (§3 timestamps). **That time is
  the summary's own** — when the summarizer wrote the topic, not when the conversation it
  describes happened. It is fine in a list, which claims no order beyond its own; §13's axis
  can't use it, and replaces it with the anchored message's time, falling back to this one,
  flagged, when the anchor is gone.
- **`updating` / `drafting`.** Put a `.live-dot` after `.outline-label` (a summarizer is running
  now), and the state line reads "Updating".
- **Jump to Message.**
  - It scrolls the transcript item whose entry id equals `entryId` into view, then stops
    auto-follow, so Jump to Latest appears (§3).
  - Leave it out when `entryId` is null or the item isn't rendered (it was compacted away). That
    is decided each time the strip opens, and when a topic arrives while it's open; a Jump that
    finds its item gone since then removes itself instead of scrolling nowhere. A topic without
    Jump still shows its heading, time and bullets.
- **Refetching.** Refetch after a watch `append` or chat `agent_settled`, debounced. Update in
  place.
- **Folded width.** `.outline-body` caps at 50vh instead of `--outline-max` (40vh).

## Compaction row

The compaction `info` row (§3) becomes a disclosure. It's fed by
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

## Tokens, motion, and accessibility

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

