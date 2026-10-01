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
node scripts/perf-load/run.mjs --tree "$PWD" --port 4841
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
- long tasks (one `PerformanceObserver`),
- nodes added/removed per second (one `MutationObserver`),
- `Performance.getMetrics` Nodes/JSEventListeners, before and after `HeapProfiler.collectGarbage`.

It prints one JSON summary and a `RESULT: PASS|FAIL` line. **FAIL** when fewer than 95% of rows
survive, or the window's long-task total exceeds 300 ms. Exit code 1 on FAIL.

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
