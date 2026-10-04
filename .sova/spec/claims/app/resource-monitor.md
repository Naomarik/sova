# §app/resource-monitor — Resource monitor
> Part of the Sova design spec · [overview](../design/overview.md)

What this server and everything it started are costing the machine, right now and over the last
hour, **charged to the session and worker that started it**. A load spike is only worth measuring
if it can be traced to a session afterwards, so attribution is the point of the surface, not a
detail of it: every process a Sova session or worker starts — pi and claude workers, the Claude
Code provider process, member-mcp helpers, and their tool children such as a JVM test REPL, `tsc`,
`vite` or a test run — counts against that worker and its session.

It is **read-only**. Its only actions are **Open Session** links; it never stops a worker or
archives a session. It opens like Settings (§app/settings-dialog): a modal with no route and no URL,
from its own button in the sidebar foot. Data shapes are `MonitorSnapshot` and `MonitorHistory` in
`shared/protocol.ts`, served by `GET /api/monitor` and `GET /api/monitor/history`.

The monitor must not become the load it measures: it runs all the time, so its own cost has a
budget (§app.resource-monitor/lightness-budget), and cosmetic parts are cut before attribution ever
is.

## §app.resource-monitor/entry-button — The entry button

```html
<!-- the sidebar foot's Usage row (§app.insights/sidebar-foot) -->
<div class="sidebar-foot-row">
  <a class="list-row list-row-interactive insights-row sidebar-foot-link" href="#/usage" …>…gauge… glance</a>
  <button type="button" class="button button-icon sidebar-settings"
          title="Resource monitor" aria-label="Resource monitor">
    <span class="icon icon-sm" style="--icon: url(/icons/activity.svg)" aria-hidden="true"></span>
  </button>
</div>
```

- **Where.** At the right end of the sidebar foot's Usage row, **directly above the Settings gear**,
  in the same column: the same markup and the same class as the gear (`.button.button-icon.sidebar-settings`),
  so both are 44 × 44 with the same margin and right edge, in both themes. Its glyph is
  `activity.svg`, a pulse line (§design.ground-rules/icons).
- **Collapsed.** The spine carries the same button as a `.spine-item` right after the Usage gauge
  (§app.session-list/spine), so the monitor is reachable with the sessions pane collapsed.
- **What it does.** Opens the monitor modal. Which is open lives in a module signal in
  `src/lib/monitor-nav.ts` (`openMonitor` / `closeMonitor` / `monitorOpen`), rendered through a
  `Portal` in `App.tsx` beside Settings — no route, no hash, nothing in history.
- **Label.** "Resource monitor" in both `title` and `aria-label`; the button carries no count, dot
  or color. The screen says the numbers.

## §app.resource-monitor/sampling-and-history — Sampling and history

- **Always sampling.** The server samples in the background from startup, **whether or not the
  modal is open**. A spike that has passed before anyone looks is exactly the case the monitor
  exists for.
- **Tick.** Every **5s**. A tick that finds the previous one still running is **skipped**, never
  queued; the skip count is reported (`sampler.skipped`).
- **Ring.** The last **1 hour** of ticks (720) in memory, as compact numeric records: the totals,
  each session's and worker's CPU% and memory, and the **top 5 processes by CPU** in that tick. A
  process's label (its short command) is stored once per process, not per tick. The ring stays
  near **2 MB**.
- **On disk.** Every **30s** one line is appended to `<stateRoot>/monitor/YYYY-MM-DD.jsonl`:
  the window's mean and maximum CPU, its maximum memory, the per-session and per-worker rollups,
  and the window's top processes, attributed. So a spike survives a server restart or crash.
  When the server stops (SIGTERM, SIGINT or exit), the 30s window in progress is written at once,
  best effort, so a restart loses at most what that last write missed. Files older than **3 days** are deleted at startup and once a day. Nothing is ever written into
  a session file or a live record.
- **Serving.** `GET /api/monitor` returns the latest `MonitorSnapshot`. `GET
  /api/monitor/history?since=<ms>&res=5s|30s` returns points since then: `5s` from the ring, `30s`
  from the disk log, with the labels for every group once in `groups`.
- **Client polling.** The modal polls `GET /api/monitor` every 5s **only while it is open**, and
  stops on close. There is no WebSocket for it.
- **Units.** CPU% is of **one core** (100 = one core busy), averaged over the tick. Memory is RSS;
  swap is `VmSwap`.

## §app.resource-monitor/attribution — Attribution

Who is burning the machine is the question; every number on the screen is charged to someone, or
says that it isn't.

- **Subtree CPU.** A worker's (or session's) CPU is the sum of `utime + stime + cutime + cstime`
  over its **live descendants**, differenced tick to tick and **clamped at 0**. A child that lived
  for 3 seconds between two ticks still counts, through its parent's `cutime`/`cstime`, and nothing
  is counted twice.
- **Joins, strongest first** (`MonitorVia`). Exact: the subagents runtime's own worker pid,
  published in process on the `subagents:workers-snapshot` event and **never written to disk**
  (`worker-pid`); a `claude --resume` / `--session-id` uuid — a worker's session id, or a hosted
  session's Claude Code provider (`session-id`); a pi worker's own live record (`live-record`); a
  member-mcp helper's team env (`team-env`); the environment the agent itself puts on its tool
  children — pi's bash tool sets `PI_SESSION_FILE`, Claude Code sets `CLAUDE_CODE_SESSION_ID` and
  `CLAUDE_PID` — read once per process, ignoring values the server inherited itself (`env`); anything below a charged process
  (`descendant`); and **sid memory** — a session id seen under a charged process keeps its owner
  after the process is backgrounded, `nohup`'d, `setsid`'d or reparented (`sid`).
- **Hosted sessions** run inside the server, so their bash tools are the server's own children.
  The tool's `PI_SESSION_FILE` charges them, and everything they start, to their session exactly.
  Two matches are **heuristics**, and the screen labels them as such: CPU of server children that
  exited between two ticks (seen only through the server's `cutime`), charged to the one hosted
  session that was running a tool in that window, else to nobody (`exited-tools`); and a process
  whose cwd lies in exactly one hosted session's cwd (`cwd`).
- **A worker row** shows its **whole subtree's** CPU% and memory, and opens to its heaviest
  descendants by short command (`java … clojure.main`).
- **What is left over is named, not dropped.** `unownedWorkers` are workers whose session no join
  found; `unattributed` are server descendants charged to nobody (an esbuild, a git probe); and,
  under a systemd unit, `escaped` are the unit's processes no longer under the server (a
  Playwright browser, a dev server, a benchmark run), each charged by sid memory or cwd where that
  can say.
- **The limits are said.** Short-lived processes are visible only through their parent's CPU,
  never by name, unless a tick caught them alive; a process reaped by the subreaper after it
  escaped is lost; the Overseer, baton and project-overseer runtimes carry only their own inline
  extension (§app.baton/goal-and-loadout), so their workers are matched without `worker-pid`, by
  the other joins; a remote-target session's tools run on the target and only the local ssh,
  claude and pi cost is seen; a mesh peer is a separate server with its own monitor.

## §app.resource-monitor/screen — The screen

A `.scrim` plus `.modal.modal-wide` (§design/deviations's Settings precedent) with `role="dialog"`,
`aria-modal="true"` and focus trapped (`trapFocus`), closed by Esc, the scrim, or its Close
button, focus returning to the opener. Under 768px the same markup is a sheet with its grip.

- **Head.** The title "Resource monitor", what is measured ("Everything in
  `sova-runtime.service`", or "This server's process tree only"), and the time of the reading in
  mono, 24-hour: "as of `14:06:05`".
- **Meters, number first** (§design/ground-rules, never a bar alone): load against cores, memory
  — under a unit, its `anon` against total RAM, never `memory.current`, which counts page cache;
  the context line gives both — swap (a ghost meter saying so when the machine has none), CPU
  pressure, and the server's event-loop p99.
- **One strip chart** of the last hour: plain inline SVG, no animation, no chart library. CPU is
  stacked by session in neutral steps, never hue — the legend and the table carry the names — and
  memory is one dashed line. Pressing or dragging picks a moment; the arrow keys step through
  ticks, Home and End jump to the ends. A picked moment re-draws the table as that tick ("At
  `14:06:05`", with **Back to Now**).
- **Sessions → workers table.** One table whose rows add up to the total: each session with its
  totals and an **Open Session** link, its own tools (a hosted session's bash tools, its Claude
  Code provider) on one expandable line, then its workers — backend, status, how long idle,
  process count, CPU%, memory, swap — each expanding to its heaviest descendants. After the
  sessions come the **Sova server** itself, **Workers of no known session**, **Escaped
  processes** (under a unit: each with who it is charged to, how, and its cwd) and **Not
  attributed**. Idle workers are summed above the table ("2 idle workers hold 600 MB; 2
  working."). A heuristic match carries a **Guess** chip, its reason in the chip's title. Under
  520px of table the Swap column goes, rather than stacking the rows: the session → worker →
  process indent is the information.
- **Names.** The client names a session as the sidebar does, from the session list the app
  already holds, by path; then by the snapshot's `title` — Sova's in-memory display title, renames
  included, with no I/O per tick (else pi's own session name). History keeps the
  label of a session that has since exited or been archived; then "Untitled session in {folder}". A file name or path is
  never a label. Legend names stop at 32ch with an ellipsis, the full name in their `title`.
- **Transient work in this window.** Processes that were among a tick's busiest and aren't running
  now, attributed, with their peak CPU and when last seen; repeated runs of one command by one
  owner fold into one row ("`vite build` ×8").
- **What this can't see.** The snapshot's `notes`, as a short list.
- **This tab.** Where the browser exposes `performance.memory` (Chrome), one client-only line with
  this tab's JS heap; elsewhere the line is absent, not zero.
- **Footer.** The sampler's own cost in small type: "Sampling every 5s · last tick 2.1 ms ·
  average 1.8 ms · 142 processes".
- **Only while open** does the screen poll (§app.resource-monitor/sampling-and-history), and not
  while the tab is hidden.

## §app.resource-monitor/platform-fallback — Platform fallback

- **Under a systemd unit** (`/proc/self/cgroup` ends in `.service` **and** the server is the
  unit's main process: its `SYSTEMD_EXEC_PID` is its own pid and its parent is the systemd
  manager; `scope: "unit"`): the whole
  cgroup is measured, with the unit's own counters (CPU, `memory.current` split into anon, file
  and shmem, peak, swap, OOM kills, pressure) and the **Escaped** section.
- **Anywhere else on Linux** (`scope: "tree"`, e.g. dev or hermetic servers, including one
  started or backgrounded from a shell inside the live unit, which inherits the unit's cgroup
  without being its main process): only the server's
  process tree is measured; the unit panel is absent and the screen says the numbers cover this
  server's process tree only.
- **No `/proc`** (`scope: "none"`, not Linux): only the server's own Node numbers (memory, heap,
  event-loop delay, load average where the OS has one); the screen says process details need
  Linux.
- Each limit a snapshot has is also listed in its `notes`.

## §app.resource-monitor/lightness-budget — Lightness budget

"Should not cause any additional strain on resources."

- **Per tick, only cheap reads:** `/proc/<pid>/stat` for the measured processes plus a few cgroup,
  pressure and loadavg files. **Never** `smaps` or PSS. In tree scope each tick follows each
  process's main-thread `children` file, and every 30s every thread's, for children forked off
  the main thread.
- **Nothing is read twice that needn't be.** Processes are keyed by `(pid, starttime)`. A new pid
  waits one tick before its first `stat`: if it exits meanwhile its CPU reaches its parent's
  `cutime` and is charged there, and if it lives its first read counts its whole life — only the
  **name** of a process that lives under about one tick is lost. argv and environment are read
  once per process, on its second sighting, and at once only for the server's direct children,
  escaped processes and the tick's top 10 by CPU. `cwd` is read once, only for an unowned process
  that outlived a tick. A process idle for two reads is re-read every 6th tick, staggered; what it
  spent meanwhile lands at its next read, so totals stay exact and only the moment an idle
  process wakes is coarser. `VmSwap` is read only while the host has swap in use, and then at most
  every 30s per process.
- **The event loop never waits long:** `stat` and `status` reads are synchronous into one reused
  buffer, in batches of 48 that yield between them. Reads that can hang on a stuck process (argv,
  environment, `cwd`) are asynchronous. The event-loop delay is sampled at 200 ms resolution: by the runtime's histogram where it measures
  whole timer intervals, else by a timer-drift sampler (§app.server-runtime/quirks).
- **Measured cost:** at 131 processes, an average tick of **3.6–4.0 ms**, and the whole server
  at **~0.12% ± 0.03 of one core** over an idle baseline, across 6 runs. The tick stays at 5s; if
  the cost ever has to fall, a 10s tick is the lever, before anything else is cut. The snapshot
  reports the sampler's own cost (`sampler.lastTickMs`, `avgTickMs`), and the screen shows it.
- **Client:** no polling while the modal is closed; no new dependency anywhere.
- **When the budget is tight, cosmetic features are cut first — never attribution.**
