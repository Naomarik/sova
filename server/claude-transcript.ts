// Reading the session files of claude-code subagents.
//
// A worker on the claude-code backend has no pi session file; it writes its own Claude Code
// transcript at ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl. The live record gives us only
// the session id (WorkerInfo.sessionId), so we find the file by scanning the project dirs.
//
// Everything here is read-only. The JSONL is Claude Code's own format (pinned to CLI 2.1.278 by
// the fixtures in claude-transcript.test.ts), so normalizeClaudeEntries translates it into the
// same TranscriptItem rows server/transcript.ts produces for pi sessions — including a synthetic,
// pi-shaped `raw` message, so the existing frontend renders these rows with no special case. Edit,
// MultiEdit and Write take pi's edit/write argument names, and their results carry CC's own
// hunks as `details.structuredPatch` (pi's edit carries `details.patch` text instead).

import { existsSync } from "node:fs";
import { sep } from "node:path";
import { locateClaudeSession } from "../pi-config/extensions/claude-code/transcript-adapter.ts";
import { claudeProjectsRoot } from "../pi-config/extensions/claude-code/provider/session-records.ts";
import type { EntryKind, TranscriptItem } from "../shared/protocol";
import { parseLines } from "./transcript";

type Entry = Record<string, any>;

const RESULT_TEXT_MAX = 2000;

/** Line types that carry no conversation: CLI bookkeeping we never render. */
const SKIPPED_TYPES = new Set(["attachment", "cost-state", "queue-operation", "last-prompt", "atis-latch"]);

/** CC tool names that are the same tool pi has, so they get pi's icon and argument view. */
const TOOL_NAMES: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "write",
  Glob: "glob",
  Grep: "grep",
};

/**
 * CC's Edit / MultiEdit / Write arguments under pi's edit / write names, so the card reads them as
 * it reads pi's: `{path, edits: [{oldText, newText}], replaceAll?}` and `{path, content}`. Anything
 * else, or a malformed input, passes through as it is.
 */
export function piToolArgs(ccName: unknown, input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const a = input as Record<string, unknown>;
  if (typeof a.file_path !== "string") return input;
  if (ccName === "Write" && typeof a.content === "string") return { path: a.file_path, content: a.content };
  if (ccName === "Edit" && typeof a.old_string === "string" && typeof a.new_string === "string") {
    return { path: a.file_path, edits: [{ oldText: a.old_string, newText: a.new_string }], ...(a.replace_all === true ? { replaceAll: true } : {}) };
  }
  if (ccName === "MultiEdit" && Array.isArray(a.edits)) {
    const edits = a.edits.filter((e) => typeof e?.old_string === "string" && typeof e?.new_string === "string").map((e) => ({ oldText: e.old_string, newText: e.new_string }));
    if (edits.length === a.edits.length) return { path: a.file_path, edits };
  }
  return input;
}

/** One `structuredPatch` hunk as CC writes it (the `diff` package's hunk): lines keep their
    " " / "-" / "+" / "\\" prefix. */
interface CcHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

function isHunk(h: unknown): h is CcHunk {
  const o = h as CcHunk;
  return (
    !!o &&
    typeof o === "object" &&
    [o.oldStart, o.oldLines, o.newStart, o.newLines].every((n) => Number.isInteger(n) && n >= 0) &&
    Array.isArray(o.lines) &&
    o.lines.every((l) => typeof l === "string")
  );
}

/**
 * A successful Edit / MultiEdit / Write result's diff, from the line's `toolUseResult`, as the
 * synthetic tool result's `details`: `{structuredPatch}` verbatim (hunks only: never
 * `originalFile`), plus `created: true` for a Write that made the file. Undefined for anything
 * else (other tools' results, errors, shapes this version does not know).
 */
export function editDetailsOf(toolUseResult: unknown): { structuredPatch: CcHunk[]; created?: true } | undefined {
  const r = toolUseResult as { structuredPatch?: unknown; type?: unknown; filePath?: unknown } | null;
  if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.filePath !== "string") return undefined;
  const hunks = r.structuredPatch === undefined && r.type === "create" ? [] : r.structuredPatch;
  if (!Array.isArray(hunks) || !hunks.every(isHunk)) return undefined;
  const structuredPatch = hunks.map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: [...h.lines] }));
  return r.type === "create" ? { structuredPatch, created: true } : { structuredPatch };
}

/** id → resolved file. Session files never move, so a hit is only re-checked by the caller's read. */
const resolved = new Map<string, string>();

/**
 * The transcript file of a Claude Code session, or null: the claude-code transcript adapter's own
 * locator (a UUID only, realpath'd inside ~/.claude/projects or $CLAUDE_CONFIG_DIR/projects, so a
 * planted symlink can't read anything else), cached here because the insight poll asks every 3s.
 */
export function resolveClaudeSession(id: string): string | null {
  const cached = resolved.get(id);
  if (cached && existsSync(cached) && cached.startsWith(claudeProjectsRoot() + sep)) return cached;
  const file = locateClaudeSession(id);
  if (file) resolved.set(id, file);
  else resolved.delete(id);
  return file;
}

/** Test seam: forget cached lookups (the projects dir is per-process otherwise). */
export function clearClaudeSessionCache(): void {
  resolved.clear();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Text blocks of a string-or-array `content`, joined. Image blocks go to contentImages instead. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/**
 * Base64 image blocks (the API's `{type:"image", source:{type:"base64", media_type, data}}`) as
 * data URLs, or undefined if none: the same `images` field server/transcript.ts fills for pi.
 */
function contentImages(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: string[] = [];
  for (const b of content) {
    const src = b?.type === "image" ? b.source : undefined;
    if (src?.type === "base64" && typeof src.data === "string" && typeof src.media_type === "string") {
      out.push(`data:${src.media_type};base64,${src.data}`);
    }
  }
  return out.length ? out : undefined;
}

/**
 * A pi-shaped `message` entry for TranscriptItem.raw. The frontend reads `raw` for timestamps
 * (src/lib/message.ts timestampOf), tool arguments (toolCallArgs: a "toolCall" block with a
 * matching id) and tool output (toolResultView: the message's content text plus isError), so
 * CC rows carry a synthetic entry in exactly that shape instead of the CC line.
 */
function raw(timestamp: string | undefined, message: Record<string, unknown>): unknown {
  return { type: "message", timestamp, message };
}

function item(id: string, kind: EntryKind, rawEntry: unknown, text?: string, toolCallId?: string, images?: string[]): TranscriptItem {
  const it: TranscriptItem = { id, kind, raw: rawEntry };
  if (text !== undefined) it.text = text;
  if (toolCallId !== undefined) it.toolCallId = toolCallId;
  if (images) it.images = images;
  return it;
}

/** An assistant line: CC writes one content block per line, all sharing one message.id. */
function assistantItems(entry: Entry, id: string, time: string | undefined, model: string | undefined): TranscriptItem[] {
  const blocks: any[] = Array.isArray(entry.message?.content) ? entry.message.content : [];
  const out: TranscriptItem[] = [];
  blocks.forEach((b, i) => {
    const bid = `${id}:${i}`;
    if (b?.type === "text") {
      if (typeof b.text === "string" && b.text.trim()) {
        const it = item(bid, "assistant-text", raw(time, { role: "assistant", content: [{ type: "text", text: b.text }] }), b.text);
        if (model) it.model = model;
        out.push(it);
      }
    } else if (b?.type === "thinking") {
      // Redacted thinking arrives as an empty string with only a signature: nothing to show.
      if (typeof b.thinking === "string" && b.thinking.trim()) {
        const it = item(bid, "thinking", raw(time, { role: "assistant", content: [{ type: "thinking", thinking: b.thinking }] }), b.thinking);
        if (model) it.model = model;
        out.push(it);
      }
    } else if (b?.type === "tool_use") {
      const name = TOOL_NAMES[b.name] ?? (typeof b.name === "string" ? b.name : "tool");
      const callId = typeof b.id === "string" ? b.id : bid;
      const it = item(
        bid,
        "tool-call",
        raw(time, { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: piToolArgs(b.name, b.input) }] }),
        name,
        callId,
      );
      if (model) it.model = model;
      out.push(it);
    }
    // Any other block type (server_tool_use, …) has no row: the line is still on the record
    // through its neighbours, and an "unknown" card would only be noise.
  });
  return out;
}

/** A user line: tool results (one block per result) or the prompt itself. */
function userItems(entry: Entry, id: string, time: string | undefined): TranscriptItem[] {
  const content = entry.message?.content;
  const blocks: any[] = Array.isArray(content) ? content : [];
  const results = blocks.filter((b) => b?.type === "tool_result");
  if (results.length > 0) {
    // The line's toolUseResult belongs to its one result; with several it can't be paired.
    const details = results.length === 1 && results[0].is_error !== true ? editDetailsOf(entry.toolUseResult) : undefined;
    return results.map((b, i) => {
      const text = contentText(b.content);
      const callId = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
      const isError = b.is_error === true;
      return item(
        `${id}:${i}`,
        "tool-result",
        raw(time, { role: "toolResult", toolCallId: callId, isError, content: [{ type: "text", text }], ...(details ? { details } : {}) }),
        truncate(text, RESULT_TEXT_MAX),
        callId,
        contentImages(b.content),
      );
    });
  }
  const text = contentText(content);
  const images = contentImages(content);
  if (!text.trim() && !images) return [];
  return [item(id, "user", raw(time, { role: "user", content: [{ type: "text", text }] }), text.trim() ? text : undefined, undefined, images)];
}

/** Normalize one CC JSONL line into 0..n TranscriptItems. */
export function normalizeClaudeEntry(entry: Entry, fallbackId = "?"): TranscriptItem[] {
  if (!entry || typeof entry !== "object") return [];
  if (entry.isSidechain === true) return []; // a nested Task agent: its own transcript, not this one
  if (typeof entry.type === "string" && SKIPPED_TYPES.has(entry.type)) return [];
  const id = typeof entry.uuid === "string" ? entry.uuid : fallbackId;
  const time = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
  if (entry.type === "system") {
    // Only the compaction marker is worth a row; the rest is CLI chatter (hooks, notices).
    if (entry.subtype !== "compact_boundary") return [];
    const pre = entry.compactMetadata?.preTokens;
    const tokens = typeof pre === "number" ? ` (${pre} tokens)` : "";
    return [item(id, "info", raw(time, { role: "custom" }), `Compacted${tokens}`)];
  }
  if (!entry.message || typeof entry.message !== "object") return [];
  if (entry.type === "user") {
    if (entry.isMeta === true) return []; // injected context, not something the worker was told
    return userItems(entry, id, time);
  }
  if (entry.type === "assistant") {
    const model = typeof entry.message.model === "string" ? `claude/${entry.message.model}` : undefined;
    return assistantItems(entry, id, time, model);
  }
  return [];
}

/** Normalize a whole CC session, in file order (CC files are linear: no branch walk). */
export function normalizeClaudeEntries(entries: unknown[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  entries.forEach((e, i) => out.push(...normalizeClaudeEntry(e as Entry, `line${i}`)));
  return out;
}

/** A SessionTail `Normalize` for CC files: same work for a snapshot and for appended lines. */
export function normalizeClaudeText(text: string): TranscriptItem[] {
  return normalizeClaudeEntries(parseLines(text));
}
