/**
 * What each worker loaded, read from that worker's own transcript.
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
 * never used (it rewrites files; see agents/server/harness/overview.md).
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { SessionSkills, WorkerInfo } from "../shared/protocol";
import { resolveClaudeSession } from "./claude-transcript";
import { branchOf, headerOf, historyOf } from "./harness/pi/reader";
import { parseJsonl } from "./jsonl";
import { claudeSkillLines, collectSkills, hasSkills, type SkillLine, skillLinesOf } from "./skills";

/** Parsed skills kept per file, least recently used dropped first. A parse is a few loads, so this holds
    several big sessions' worth of workers at once; and a call never drops a file it touched itself, so a
    session with more workers than this still parses each unchanged file once, not on every poll. */
const CACHE_MAX = 1024;

/** Insertion order is use order: a hit moves its file to the end, so the first key is the least recent. */
const cache = new Map<string, { key: string; skills: SessionSkills }>();
/** Files read and parsed since the server started: tests read it to see a poll re-read nothing. */
let parses = 0;
export const workerSkillsParses = (): number => parses;

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
 * A worker transcript's skill lines. A pi session file (it has a header) is read on its active branch;
 * a Claude Code file has no branch links, so every line counts, in order, except a nested agent's.
 */
function skillLinesOfText(text: string): SkillLine[] {
  const lines = parseJsonl(text);
  if (lines.some((l) => headerOf(l) !== null)) return skillLinesOf(branchOf(historyOf(lines)));
  return claudeSkillLines(lines.filter((e) => !isNested(e)));
}

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
  if (hit && hit.key === key) {
    cache.delete(file);
    cache.set(file, hit);
    return hit.skills;
  }

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  parses++;
  const skills = collectSkills(skillLinesOfText(text));
  cache.delete(file);
  cache.set(file, { key, skills });
  return skills;
}

/** Drop the least recently used files past the cap, but never one of the `keep` newest (this call's own). */
function trim(keep: number): void {
  const cap = Math.max(CACHE_MAX, keep);
  for (const file of cache.keys()) {
    if (cache.size <= cap) break;
    cache.delete(file);
  }
}

/**
 * Skills per worker id, for the live workers given. Undefined when nobody loaded anything — the
 * insight omits the field rather than shipping a map of empties.
 */
export async function workerSkills(workers: readonly WorkerInfo[], file: WorkerFile = defaultWorkerFile): Promise<Record<string, SessionSkills> | undefined> {
  const found: Record<string, SessionSkills> = {};
  let touched = 0;
  for (const w of workers) {
    const path = file(w);
    if (!path) continue;
    touched++;
    const skills = await skillsOfFile(path);
    if (skills && hasSkills(skills)) found[w.id] = skills;
  }
  trim(touched);
  return Object.keys(found).length > 0 ? found : undefined;
}

/** Drop one file's cached parse: exported for tests, and after a worker's transcript is rewritten. */
export function forgetWorkerSkills(file: string): void {
  cache.delete(file);
}
