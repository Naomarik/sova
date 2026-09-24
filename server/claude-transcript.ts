// Reading the session files of claude-code subagents.
//
// A worker on the claude-code backend has no pi session file; it writes its own Claude Code
// transcript at ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl. The live record gives us only
// the session id (WorkerInfo.sessionId), so we find the file by scanning the project dirs.
//
// Everything here is read-only. The JSONL is Claude Code's own format (pinned to CLI 2.1.278 by
// the fixtures in claude-transcript.test.ts), so normalizeClaudeEntries translates it into the
// same TranscriptItem rows server/transcript.ts produces for pi sessions — including a synthetic,
// pi-shaped `raw` message, so the existing frontend renders these rows with no special case.

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
  Write: "write",
  Glob: "glob",
  Grep: "grep",
};

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

/** Text blocks of a string-or-array `content`, joined. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b?.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
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

function item(id: string, kind: EntryKind, rawEntry: unknown, text?: string, toolCallId?: string): TranscriptItem {
  const it: TranscriptItem = { id, kind, raw: rawEntry };
  if (text !== undefined) it.text = text;
  if (toolCallId !== undefined) it.toolCallId = toolCallId;
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
        raw(time, { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: b.input }] }),
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
    return results.map((b, i) => {
      const text = contentText(b.content);
      const callId = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
      const isError = b.is_error === true;
      return item(
        `${id}:${i}`,
        "tool-result",
        raw(time, { role: "toolResult", toolCallId: callId, isError, content: [{ type: "text", text }] }),
        truncate(text, RESULT_TEXT_MAX),
        callId,
      );
    });
  }
  const text = contentText(content);
  if (!text.trim()) return [];
  return [item(id, "user", raw(time, { role: "user", content: [{ type: "text", text }] }), text)];
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
