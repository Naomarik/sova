# Web /tree (session tree navigator): feasibility (pi 0.85.1)

**Read-only view: easy (~0.5 day backend).** Every JSONL entry has `id`/`parentId`, so our own
parser (`server/transcript.ts` `parseLines`) can build the whole tree without `SessionManager.open()`
(which is not read-only). A `GET /api/tree?path=` could return nodes `{id, parentId, type, role?,
preview, timestamp, label?, childCount}` plus `leafId` (= last entry in file order, the same rule
SessionManager uses on load) and the active-path ids. Labels come from `label` entries (last one per
`targetId` wins). Works for TUI-owned sessions too, since it only reads. `/ws/watch` appends already
stream new nodes, so the UI can extend the tree live.

**Switching branches: medium (~1–2 days incl. UI), write path, needs the full chat guard set.**
- `SessionManager.branch(id)` / `AgentSession.navigateTree(targetId, {summarize?, label?})` only move
  the in-memory leaf. Nothing is persisted until the next append (its `parentId` records the switch).
  With `summarize: true` pi first runs an LLM summary and appends a `branch_summary` entry (a real
  write). Landing on a user message returns `editorText` (the TUI puts it back in the editor).
- So a web "switch" = `navigateTree` on our held runtime (chat-only: TUI-live → busy, recent →
  force), then the next prompt writes. Our transcript rule (leaf = last line) would still show the
  old branch until that append; the UI must use the runtime's `getBranch()` (hello-style) instead of
  re-reading the file, or we persist the switch explicitly (e.g. a `label` entry on the target).
- Caveat: a TUI's un-persisted `/tree` switch is invisible to us for the same reason (leaf lives only
  in its memory until it appends), so the watch view may briefly show a different branch.

**Estimate:** read-only tree endpoint + collapsible tree UI ≈ 1–1.5 days total. Branch switching adds
≈ 1–2 days: a WS `navigate` message + guards, a summary option, and editorText handling.
