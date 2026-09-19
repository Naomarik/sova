# pi-web wishlist

Deferred ideas from the 2026-09-19 build rounds. Ordered loosely by value.

## Big features

### Bridge: chat INTO a TUI-live session
Stock pi can't do this: no file locking means a second writer forks the tree, and
worse — the TUI's agent never sees the webapp's message (context follows *its* leaf;
the injected message dangles on a sibling branch). Hence today's read-only watch mode.

**Design (proven viable on paper):** the session JSONL is a fine message bus if the TUI
participates. A small bridge extension (`~/pi-config/extensions/`) watches its own session
file for webapp-tagged entries and injects them via `pi.sendMessage`/steer into the live
turn. Webapp gets a "Send to TUI" mode with its own chip; the write-guard gains a
provenance-marked exception that re-reads the leaf before appending. ~150-line extension +
webapp affordance. Requires boss approval (it edits the live pi-config).

### Web /tree — session tree navigator
The TUI `/tree` built-in can't run headless, but a web-native tree view can.
**Read-only tree view ≈ 0.5 day backend** (parse id/parentId ourselves, works even for
TUI-owned sessions, live-extends via /ws/watch appends). **Branch switching ≈ 1–2 days**
(`navigateTree` on the held runtime + all chat guards; transcript must read the runtime's
branch, not the file, until first append). Full analysis: `docs/tree-web-feasibility.md`.

## Smaller polish

- **Ended-team cards on #/agents.** Today they only get a plain "Team · N" chip on their
  session header. Frontend says the team card already supports an "Ended" chip — ~one line.
- **Multi-tab dialog sync.** An extension dialog answered in one browser tab stays open in
  others. Close siblings when one answers (server broadcasts the resolution).
- **TUI-modal slash commands in the menu.** Extension commands that open `ctx.ui.custom`
  modals (e.g. topic-outline's panel) visually no-op in the webapp. Detect/annotate them in
  the slash menu so it doesn't look broken; ideally render a minimal web equivalent.
- **Cross-tab Busy freshness.** Busy reflects instantly in the owning tab; other tabs see
  it via focus/refresh polling. A server push (WS nudge broadcast) would make it live.
- **Agent context-window metric.** Compute rough context fill from each worker's session
  jsonl size (≈ bytes/4 tokens vs window) and show it on the Agents page per member.
  We did this by hand today; the data obviously supports it.

## Ops / upstream

- **Merge `fix/steer-delivery-timeout`** (pi-config) — the ag_05-killer fix, verified.
  Takes effect on next pi restart.
- **Upstreamable to Claude Code:** document `command_lifecycle` as the message-receipt
  channel; document CLI self-started turns after background tasks in stream-json mode;
  give those turns a correlation id.
- **Outline topic ordering** isn't time-ordered (follows the extension's storage order) —
  consider sorting display by `at`.
- Session-name assignment from the webapp (pi has session_info entries / `--name`).
