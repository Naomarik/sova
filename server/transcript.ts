import { readFile } from "node:fs/promises";
import type { EntryKind, TranscriptItem } from "../shared/protocol";

// We parse JSONL ourselves instead of using SessionManager.open(): open() is not
// read-only (it appends "\n" to a trailing partial line and rewrites the file when
// migrating old versions), and these files may be owned by a running TUI.

type Entry = Record<string, any>;

const RESULT_TEXT_MAX = 2000;

/** Parse JSONL text into objects, skipping blank/malformed lines. */
export function parseLines(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") out.push(v);
    } catch {
      // malformed line: skip
    }
  }
  return out;
}

/**
 * Active branch = walk parentId from the leaf (last entry in file order, same rule
 * as SessionManager._buildIndex) back to the root. Returned root-first.
 * Legacy v1 files without ids are linear: return them as-is.
 */
export function activeBranch(entries: Entry[]): Entry[] {
  const body = entries.filter((e) => e.type !== "session");
  if (body.length === 0) return [];
  if (body.some((e) => typeof e.id !== "string")) return body;
  const byId = new Map<string, Entry>();
  for (const e of body) byId.set(e.id, e);
  const path: Entry[] = [];
  const seen = new Set<string>();
  let cur: Entry | undefined = body[body.length - 1];
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

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

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function item(id: string, kind: EntryKind, raw: unknown, text?: string, toolCallId?: string): TranscriptItem {
  const it: TranscriptItem = { id, kind, raw };
  if (text !== undefined) it.text = text;
  if (toolCallId !== undefined) it.toolCallId = toolCallId;
  return it;
}

function normalizeMessage(entry: Entry, id: string): TranscriptItem[] {
  const m = entry.message ?? {};
  switch (m.role) {
    case "user":
      return [item(id, "user", entry, contentText(m.content))];
    case "assistant": {
      // One item per content block; ids are `${entryId}:${blockIndex}` so they stay unique.
      const out: TranscriptItem[] = [];
      const blocks: any[] = Array.isArray(m.content) ? m.content : [];
      blocks.forEach((b, i) => {
        const bid = `${id}:${i}`;
        if (b?.type === "text") {
          if (b.text?.trim()) out.push(item(bid, "assistant-text", entry, b.text));
        } else if (b?.type === "thinking") {
          if (b.thinking?.trim()) out.push(item(bid, "thinking", entry, b.thinking));
        } else if (b?.type === "toolCall") {
          out.push(item(bid, "tool-call", entry, String(b.name ?? "tool"), b.id));
        } else {
          out.push(item(bid, "unknown", entry));
        }
      });
      if (m.stopReason === "error" || m.stopReason === "aborted") {
        const why = m.errorMessage ? `: ${m.errorMessage}` : "";
        out.push(item(`${id}:stop`, "info", entry, `${m.stopReason === "error" ? "Error" : "Aborted"}${why}`));
      }
      return out;
    }
    case "toolResult":
      return [item(id, "tool-result", entry, truncate(contentText(m.content), RESULT_TEXT_MAX), m.toolCallId)];
    case "bashExecution":
      return [item(id, "info", entry, truncate(`$ ${m.command ?? ""}\n${m.output ?? ""}`, RESULT_TEXT_MAX))];
    case "custom":
      return m.display === false ? [] : [item(id, "info", entry, contentText(m.content))];
    case "branchSummary":
      return [item(id, "info", entry, `Branch summary: ${m.summary ?? ""}`)];
    case "compactionSummary":
      return [item(id, "info", entry, `Compaction summary: ${m.summary ?? ""}`)];
    default:
      return [item(id, "unknown", entry)];
  }
}

/** Normalize one parsed JSONL entry into 0..n TranscriptItems. The header line yields none. */
export function normalizeEntry(entry: Entry, fallbackId = "?"): TranscriptItem[] {
  const id = typeof entry.id === "string" ? entry.id : fallbackId;
  switch (entry.type) {
    case "session":
      return [];
    case "message":
      return normalizeMessage(entry, id);
    case "model_change":
      return [item(id, "info", entry, `Model: ${entry.provider}/${entry.modelId}`)];
    case "thinking_level_change":
      return [item(id, "info", entry, `Thinking: ${entry.thinkingLevel}`)];
    case "session_info":
      return [item(id, "info", entry, `Session name: ${entry.name ?? ""}`)];
    case "label":
      return [item(id, "info", entry, entry.label ? `Label "${entry.label}" on ${entry.targetId}` : `Label cleared on ${entry.targetId}`)];
    case "compaction":
      return [item(id, "info", entry, `Compacted (${entry.tokensBefore ?? "?"} tokens): ${entry.summary ?? ""}`)];
    case "branch_summary":
      return [item(id, "info", entry, `Branch summary: ${entry.summary ?? ""}`)];
    case "custom":
      return []; // extension state, not displayable (docs/session-format.md)
    case "custom_message":
      return entry.display === false ? [] : [item(id, "info", entry, contentText(entry.content))];
    default:
      return [item(id, "unknown", entry)];
  }
}

export function normalizeEntries(entries: Entry[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  entries.forEach((e, i) => out.push(...normalizeEntry(e, `line${i}`)));
  return out;
}

/** Read a session file and return normalized active-branch items. */
export async function readTranscript(path: string): Promise<TranscriptItem[]> {
  const text = await readFile(path, "utf8");
  return normalizeEntries(activeBranch(parseLines(text)));
}
