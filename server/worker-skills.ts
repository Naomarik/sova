/**
 * What each live worker loaded, read from that worker's own transcript.
 *
 * The subagents extension records nothing about skills — not in the live registry, the snapshots,
 * nor the completion reports (`pi-config/extensions/sessions/public/SCHEMA.md`) — so a worker's own
 * transcript is the only source. Two backends, two ways to find it:
 *
 *  - a pi worker has a session file of its own (`WorkerInfo.sessionFile`, published by the live
 *    registry) with the same JSONL shape as any pi session;
 *  - a Claude Code worker has only a session id (`WorkerInfo.sessionId`), which
 *    `server/claude-transcript.ts` resolves inside `~/.claude/projects`.
 *
 * Cost matters: `SessionInsight` is polled every 3 seconds while the pane is open, and a worker's
 * transcript is megabytes. So a file is parsed once per change — mtime + size keyed — and never
 * again until it moves. A settled worker's file does not move at all.
 *
 * Read-only throughout: nothing here writes to a session, and the SDK's `SessionManager.open` is
 * never used (it rewrites files; see CLAUDE.md).
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { SessionSkills, WorkerInfo } from "../shared/protocol";
import { resolveClaudeSession } from "./claude-transcript";
import { collectSkills, hasSkills } from "./skills";
import { activeBranch, parseLines } from "./transcript";

/** Parsed skills kept per file. Enough for several sessions' worth of workers at once. */
const CACHE_MAX = 64;

const cache = new Map<string, { key: string; skills: SessionSkills }>();

/** Where a worker's transcript lives, or null when we cannot tell. Injectable for tests. */
export type WorkerFile = (worker: WorkerInfo) => string | null;

const defaultWorkerFile: WorkerFile = (w) => {
  if (w.sessionFile && isAbsolute(w.sessionFile)) return w.sessionFile;
  if (w.sessionId) return resolveClaudeSession(w.sessionId);
  return null;
};

/** Nested agents' lines live in the parent's file too. They are their own agent's work, not this
    worker's, and attributing them here would credit a load to the wrong agent. */
const isNested = (entry: unknown): boolean => !!entry && typeof entry === "object" && (entry as { isSidechain?: unknown }).isSidechain === true;

/**
 * One file's skills. Returns null when the file is missing or unreadable: a worker we cannot read
 * is a worker we say nothing about, never an error the whole pane inherits.
 */
async function skillsOfFile(file: string): Promise<SessionSkills | null> {
  let key: string;
  try {
    const st = await stat(file);
    if (!st.isFile()) return null;
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.skills;

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  // `activeBranch` walks parentId for a pi file; a Claude Code file has no such links, and it
  // returns every entry as-is for those (its own legacy-file rule), which is what we want here.
  const entries = activeBranch(parseLines(text)).filter((e) => !isNested(e));
  const skills = collectSkills(entries);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(file, { key, skills });
  return skills;
}

/**
 * Skills per worker id, for the live workers given. Undefined when nobody loaded anything — the
 * insight omits the field rather than shipping a map of empties.
 */
export async function workerSkills(workers: readonly WorkerInfo[], file: WorkerFile = defaultWorkerFile): Promise<Record<string, SessionSkills> | undefined> {
  const found: Record<string, SessionSkills> = {};
  for (const w of workers) {
    const path = file(w);
    if (!path) continue;
    const skills = await skillsOfFile(path);
    if (skills && hasSkills(skills)) found[w.id] = skills;
  }
  return Object.keys(found).length > 0 ? found : undefined;
}

/** Drop one file's cached parse: exported for tests, and after a worker's transcript is rewritten. */
export function forgetWorkerSkills(file: string): void {
  cache.delete(file);
}
