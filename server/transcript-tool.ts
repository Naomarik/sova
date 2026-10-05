// The whole content of tool rows on demand: `GET /api/transcript/tool` (ToolContentResponse in
// shared/protocol.ts, §chat.transcript/slim-rows). A row carries only what its folded card draws;
// the card's arguments, output and details come from here when it is opened, or about to be.
// Read-only: rows come from the file through transcript-rows' parse cache (by size and mtime), and
// a hosted session's newest rows, not on disk yet, from its runtime's branch.

import { readFile, stat } from "node:fs/promises";
import { TOOL_CONTENT_MAX_IDS, type ToolContent, type TranscriptItem } from "../shared/protocol";
import { normalizeClaudeText } from "./claude-transcript";
import { historyOf } from "./harness/pi/reader";
import { rowsOf as historyRows, toolContents, type Entry } from "./transcript";
import { rowsOf } from "./transcript-rows";

/** `ids=` as asked: comma-separated row ids, blanks dropped, at most TOOL_CONTENT_MAX_IDS. */
export function parseToolIds(raw: string | undefined): string[] | null {
  const ids = [...new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  return ids.length === 0 || ids.length > TOOL_CONTENT_MAX_IDS ? null : ids;
}

/** A pi session's tool rows: from its file, and for ids the file doesn't hold yet, from `branch`
    (the hosted runtime's pi entries, when there is one). */
export async function piToolContent(path: string, ids: readonly string[], branch?: () => Entry[] | undefined): Promise<Record<string, ToolContent>> {
  const out = toolContents((await rowsOf(path)).items, ids);
  const missing = ids.filter((id) => !(id in out));
  if (missing.length === 0) return out;
  const live = branch?.();
  return live ? { ...out, ...toolContents(historyRows(historyOf(live)), missing) } : out;
}

/** Claude Code workers' files, parsed once per size and mtime (a worker's file only grows): at most
    CLAUDE_KEEP files and CLAUDE_BYTES of file size; the newest is kept whatever its size. */
const claudeCache = new Map<string, { stamp: string; items: TranscriptItem[]; bytes: number }>();
const CLAUDE_KEEP = 3;
const CLAUDE_BYTES = 8 * 1024 * 1024;

/** A Claude Code worker's tool rows, from its own file. */
export async function claudeToolContent(file: string, ids: readonly string[]): Promise<Record<string, ToolContent>> {
  const st = await stat(file);
  const stamp = `${st.size}:${st.mtimeMs}`;
  let had = claudeCache.get(file);
  if (!had || had.stamp !== stamp) {
    had = { stamp, items: normalizeClaudeText(await readFile(file, "utf8")), bytes: st.size };
    claudeCache.delete(file);
    claudeCache.set(file, had);
    let total = 0;
    for (const c of claudeCache.values()) total += c.bytes;
    while (claudeCache.size > 1 && (claudeCache.size > CLAUDE_KEEP || total > CLAUDE_BYTES)) {
      const oldest = claudeCache.keys().next().value!;
      total -= claudeCache.get(oldest)!.bytes;
      claudeCache.delete(oldest);
    }
  }
  return toolContents(had.items, ids);
}
