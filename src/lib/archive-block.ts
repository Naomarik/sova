// Why a session can't be archived right now: the rules the server enforces, said before a write.
// Pure, so it runs under `tsx --test`. The drop overlay's Archive tile (drag-archive.ts) and the
// Agents board's Archive read it.

import type { SessionSummary } from "../../shared/protocol";
import { sessionWorking } from "./workers";

/** What the rule needs of a row. Callers pass whole summaries; the tests pass this. */
export type ArchivableSession = Pick<SessionSummary, "path" | "id" | "title" | "archived" | "origin" | "busy" | "live" | "workers">;

/**
 * Why this session can't be archived right now, or null when it can. Four rules, all enforced by
 * the route with a 409 (`archiveSession` in server/sessions-index.ts); the session pane's Archive
 * button also states the TUI and subagent ones before it asks (SessionDetails' ArchiveAction).
 * This is the list's view, a poll old: a subagent started since is caught by the route, and its
 * sentence comes back as a failure. An archived session is never blocked: unarchiving is always
 * allowed.
 */
export function archiveBlockReason(s: ArchivableSession): string | null {
  if (s.archived) return null;
  if (s.live) return "open in a TUI";
  if (s.origin !== "web") return "not started in Sova";
  if (s.busy) return "mid-turn";
  // No count of its own: a reason may follow a count of sessions ("1 with subagents working"),
  // and "1 2 subagents working" would read as nonsense.
  if (sessionWorking(s) > 0) return "with subagents working";
  return null;
}
