import { readFile } from "node:fs/promises";
import type { EntryKind, TranscriptItem } from "../shared/protocol";
import { inlineTmpImages } from "./attachments";
import { isReport, parseReport } from "./reports";

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

/** Text blocks joined; image blocks become "[image]" unless the caller renders them as images. */
function contentText(content: unknown, imagePlaceholder = true): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b?.type === "image" && imagePlaceholder) parts.push("[image]");
  }
  return parts.join("\n");
}

/** ImageContent blocks ({type:"image", data, mimeType}) as data URLs, or undefined if none. */
function contentImages(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: string[] = [];
  for (const b of content) {
    if (b?.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
      out.push(`data:${b.mimeType};base64,${b.data}`);
    }
  }
  return out.length ? out : undefined;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function item(
  id: string,
  kind: EntryKind,
  raw: unknown,
  text?: string,
  toolCallId?: string,
  images?: string[],
): TranscriptItem {
  const it: TranscriptItem = { id, kind, raw };
  if (text !== undefined) it.text = text;
  if (toolCallId !== undefined) it.toolCallId = toolCallId;
  if (images) it.images = images;
  return it;
}

/** Set `model` (the producing "provider/model") on an assistant-derived row, when known. */
function withModel(it: TranscriptItem, model: string | undefined): TranscriptItem {
  if (model !== undefined) it.model = model;
  return it;
}

/** Attach the /tmp image paths named in `source` (the row's full text); the text stays as-is. */
function withPaths(it: TranscriptItem, source: string): TranscriptItem {
  const { attachments } = inlineTmpImages(source);
  if (attachments) it.attachments = attachments;
  return it;
}

/** An extension message: a report row when it's a subagent report or long/multi-line, else an info row. */
function customRow(id: string, entry: Entry, customType: unknown, content: unknown): TranscriptItem {
  const text = contentText(content);
  const source = typeof customType === "string" ? customType : "";
  if (!isReport(source, text)) return withPaths(item(id, "info", entry, text), text);
  const report = parseReport(source, text);
  const it = withPaths(item(id, "report", entry, report.body), report.body);
  it.report = report;
  return it;
}

function normalizeMessage(entry: Entry, id: string, state?: { model?: string }): TranscriptItem[] {
  const m = entry.message ?? {};
  switch (m.role) {
    case "user": {
      const it = item(id, "user", entry, undefined, undefined, contentImages(m.content));
      const { text, attachments } = inlineTmpImages(contentText(m.content, false), true);
      if (text !== undefined) it.text = text;
      if (attachments) it.attachments = attachments;
      return [it];
    }
    case "assistant": {
      // One item per content block; ids are `${entryId}:${blockIndex}` so they stay unique.
      const out: TranscriptItem[] = [];
      // This row's producer: the message's own provider/model, else the last model_change seen.
      const model =
        (typeof m.provider === "string" && typeof m.model === "string" ? `${m.provider}/${m.model}` : undefined) ?? state?.model;
      const blocks: any[] = Array.isArray(m.content) ? m.content : [];
      blocks.forEach((b, i) => {
        const bid = `${id}:${i}`;
        if (b?.type === "text") {
          if (b.text?.trim()) out.push(withModel(withPaths(item(bid, "assistant-text", entry, b.text), b.text), model));
        } else if (b?.type === "thinking") {
          if (b.thinking?.trim()) out.push(withModel(item(bid, "thinking", entry, b.thinking), model));
        } else if (b?.type === "toolCall") {
          out.push(withModel(item(bid, "tool-call", entry, String(b.name ?? "tool"), b.id), model));
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
    case "toolResult": {
      const text = contentText(m.content, false);
      return [withPaths(item(id, "tool-result", entry, truncate(text, RESULT_TEXT_MAX), m.toolCallId, contentImages(m.content)), text)];
    }
    case "bashExecution":
      return [item(id, "info", entry, truncate(`$ ${m.command ?? ""}\n${m.output ?? ""}`, RESULT_TEXT_MAX))];
    case "custom":
      return m.display === false ? [] : [customRow(id, entry, m.customType, m.content)];
    case "branchSummary":
      return [item(id, "info", entry, `Branch summary: ${m.summary ?? ""}`)];
    case "compactionSummary":
      return [item(id, "info", entry, `Compaction summary: ${m.summary ?? ""}`)];
    default:
      return [item(id, "unknown", entry)];
  }
}

/** pi-config mode extension marker: `{mode}` for a major switch, `{minor, on}` for a minor one. */
function modeMarker(entry: Entry, id: string): TranscriptItem[] {
  const d = entry.data;
  if (d && typeof d.minor === "string" && typeof d.on === "boolean") return [item(id, "info", entry, `Minor mode: ${d.minor} ${d.on ? "on" : "off"}`)];
  if (d && typeof d.mode === "string") return [item(id, "info", entry, `Mode → ${d.mode}`)];
  return [];
}

/** Normalize one parsed JSONL entry into 0..n TranscriptItems. The header line yields none. */
export function normalizeEntry(entry: Entry, fallbackId = "?", state?: { model?: string }): TranscriptItem[] {
  const id = typeof entry.id === "string" ? entry.id : fallbackId;
  switch (entry.type) {
    case "session":
      return [];
    case "message":
      return normalizeMessage(entry, id, state);
    case "model_change":
      if (state) state.model = `${entry.provider}/${entry.modelId}`;
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
      // Extension state, not displayable (docs/session-format.md). One exception: the mode
      // extension's switch marker, which the TUI draws in the transcript too.
      return entry.customType === "mode" ? modeMarker(entry, id) : [];
    case "custom_message":
      return entry.display === false ? [] : [customRow(id, entry, entry.customType, entry.content)];
    default:
      return [item(id, "unknown", entry)];
  }
}

export function normalizeEntries(entries: Entry[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const state: { model?: string } = {}; // running model_change, for assistant rows without their own
  entries.forEach((e, i) => out.push(...normalizeEntry(e, `line${i}`, state)));
  return out;
}

/** Read a session file and return its active-branch entries (root-first). */
export async function readActiveBranch(path: string): Promise<Entry[]> {
  return activeBranch(parseLines(await readFile(path, "utf8")));
}

/** Context fill before the window lookup: tokens + the model ("provider/id") that produced them. */
export interface BranchContext {
  tokens: number;
  model: string | null;
}

/**
 * Context fill = input + cacheRead + cacheWrite of the LAST assistant message with usage on the
 * branch. A compaction after it makes that number stale, so we return null until the next reply.
 * The model is the assistant message's own provider/model, else the last model_change before it,
 * else the session's first model_change.
 */
export function contextForBranch(branch: Entry[]): BranchContext | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type === "compaction" || (e.type === "message" && e.message?.role === "compactionSummary")) return null;
    const m = e.type === "message" ? e.message : undefined;
    const u = m?.role === "assistant" ? m.usage : undefined;
    if (!u) continue;
    const tokens = (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
    let model = m.provider && m.model ? `${m.provider}/${m.model}` : null;
    if (!model) {
      const change = branch.slice(0, i).reverse().find((x) => x.type === "model_change")
        ?? branch.find((x) => x.type === "model_change");
      if (change) model = `${change.provider}/${change.modelId}`;
    }
    return { tokens, model };
  }
  return null;
}
