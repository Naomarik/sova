# perf-load — sidebar churn reproduction harness

A small, fast harness that reproduces a Sova frontend performance bug at will: when the session
list changes (the `/ws/watch?feed=sessions` feed's `list_changed`, plus the busy poll and the `now`
tick), the sidebar destroys and rebuilds every folder group and session row, even collapsed ones.
`src/lib/session-order.ts` builds new group objects each poll and `<For>` keys them by identity.

It is tooling only — it never edits `src/`, `server/` or `shared/`, and never touches `~/.pi`.

## One command

```sh
node scripts/perf-load/run.mjs --tree <checkout> --port 4840 [--rate 1] [--window 30]
```

From this worktree, against this worktree:

```sh
CHROMIUM_BIN=/usr/bin/google-chrome-stable node scripts/perf-load/run.mjs --tree "$PWD" --port 4841
```

What it does: builds `<tree>/.agent` (hermetic), seeds 480 synthetic session files across 40 cwds,
builds `<tree>/dist` if missing, starts `<tree>`'s server on the given port with
`PI_CODING_AGENT_DIR=<tree>/.agent`, runs `churn.mjs` (appends messages + flips fake live records),
and runs `probe.mjs`, which starts its **own** isolated headless browser (playwright skill, never a
shared one) and measures over the window:

- row and group survival (tagged elements still attached at the end). Folders start collapsed and
  build their rows only when first opened, so the probe first opens the first `--open` (default 6)
  folder sections by their summary; row survival is over the rows that exist at the window's start,
  which are those folders' rows,
- long tasks (one `PerformanceObserver`): count, total, max, and each task's start (ms from the window's start) and duration in `longTasks.list`,
- nodes added/removed per second (one `MutationObserver`),
- `Performance.getMetrics` Nodes/JSEventListeners, before and after `HeapProfiler.collectGarbage`.
- a session switch (`--big`, default 2: the seed adds that many long sessions in a real folder
  under the agent dir, and clears their stored drafts): open A, type in its composer, open B, force
  GC three times, then report whether A's `div.transcript-wrap` was released (a `WeakRef` the page
  holds), the detached `div.transcript-wrap` trees `DOM.getDetachedDomNodes` still finds, and the
  post-GC Nodes. A retained transcript fails the run.

- the Overseer, long (`--overseer-big <rows>`, default 0 = off; 5300 matches the user's): the seed
  writes a marked Overseer conversation of about that many rows, with 40 `sova_card` cards whose
  newest snapshots sit far above the tail (c_1–c_20 reopened, c_21–c_30 dropped, c_31–c_40 open)
  and a last reply naming `[c_35](#c_35)`, plus one earlier conversation (1,500 rows), and makes
  it current before the server starts. The probe then, each phase from a fresh page load:
  opens `#/overseer` and reports the built `.thread .entry` count every 500 ms for 20 s, the long
  tasks from the document's start, the `/api/transcript` fetches (each by its asking parameters),
  a window of the list's length with the churn on, post-GC Nodes, and a scroll-up check (the row
  at the top of the view, read before the scroll event builds and 2.5 s after: `driftPx`);
  jumps by the card chip to c_1 and by the `[c_35]` reference (in view, how long, rows built);
  scrolls to the top in steps until every row is built; and opens the earlier conversation for
  10 s. It FAILs when more than 600 rows are built after 20 s, a card jump misses, the top row
  moves by 2 px or more, or the top isn't reached.

It prints one JSON summary and a `RESULT: PASS|FAIL` line. **FAIL** when fewer than 95% of rows
survive, the window's long-task total exceeds 300 ms, or the switch leaves A's transcript alive. Exit code 1 on FAIL.

**Browser.** Run it with `CHROMIUM_BIN=/usr/bin/google-chrome-stable`, the Chrome the user runs Sova in. Without
it, `start-browser.sh` takes Playwright's Chromium, else the first `chromium` on `PATH`, and results differ by
browser: a switch-check fix once passed on Chromium 148 and failed on Chrome 154. The JSON's `browser` field
(`binary`, `product`, `userAgent`) says which one ran; check both when a fix touches browser internals.

Ports are 4840–4859 only; the browser's CDP port is one the skill claims (9300–9999), never 9222.
Everything written lands under `<tree>/.agent`.

## Baseline

Build a baseline from master (the buggy code) and point the same harness at it:

```sh
git archive master | tar -x -C ~/.cache/sova-perf/baseline
cd ~/.cache/sova-perf/baseline && mise trust . && pnpm install --frozen-lockfile
node /path/to/worktree/scripts/perf-load/run.mjs --tree ~/.cache/sova-perf/baseline --port 4842
```

The harness runs from this worktree; `--tree` may be this worktree or any archive. Same numbers
before and after a fix are the point.
