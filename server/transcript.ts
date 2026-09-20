import { readFile } from "node:fs/promises";
import type { AlignReportInfo, EntryKind, ExplanationInfo, TranscriptItem } from "../shared/protocol";
import { inlineTmpImages } from "./attachments";
import { isReport, parseReport, previewLine } from "./reports";

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

/**
 * pi-config mode extension marker: `{mode}` for a major switch, `{minor, on}` for a minor one,
 * `{strict}` for the strict toggle. Newer entries also carry an `active` snapshot (what the
 * session restores from); it is state, not a message, so it is never rendered.
 */
function modeMarker(entry: Entry, id: string): TranscriptItem[] {
  const d = entry.data;
  if (d && typeof d.minor === "string" && typeof d.on === "boolean") return [item(id, "info", entry, `Minor mode: ${d.minor} ${d.on ? "on" : "off"}`)];
  if (d && typeof d.mode === "string") return [item(id, "info", entry, `Mode → ${d.mode}`)];
  if (d && typeof d.strict === "boolean") return [item(id, "info", entry, `Strict mode ${d.strict ? "on" : "off"}`)];
  return [];
}

/** A pi-btw side-channel exchange. Hidden custom state in the TUI (it lives in the overlay);
    the web has no overlay, so show it as a report row or /btw answers would be silent. */
function btwRow(id: string, entry: Entry): TranscriptItem[] {
  const d: any = entry.data;
  const answer = typeof d?.answer === "string" ? d.answer : "";
  if (!answer.trim()) return []; // still running or malformed: stay hidden like the TUI
  const question = typeof d.question === "string" ? d.question.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  const model = typeof d.provider === "string" && typeof d.model === "string" ? `${d.provider}/${d.model}` : undefined;
  const it = withPaths(item(id, "report", entry, answer), answer);
  it.report = {
    source: "btw-thread-entry",
    agent: { id: "btw", name: question || "side question", status: "done" },
    body: answer,
    preview: previewLine(answer),
    truncated: false,
  };
  if (model) it.model = model;
  return [it];
}

const ALIGN_DOC = "align-doc";

function isAlignDoc(entry: Entry): boolean {
  return entry.type === "custom" && entry.customType === ALIGN_DOC;
}

/** The mode extension's align document: data {version: 1, doc: AlignDoc | null}, a full snapshot
    per revision; align.ts is the only parser, so this reads the payload and never the markdown. doc
    null (cleared) or without markdown, a questions array or a title yields no row; normalizeEntries keeps only
    the newest align-doc entry on the branch. */
function alignRow(id: string, entry: Entry): TranscriptItem[] {
  const doc: any = entry.data?.doc;
  if (!doc || typeof doc !== "object" || typeof doc.markdown !== "string" || !doc.markdown.trim()) return [];
  if (!Array.isArray(doc.questions) || typeof doc.title !== "string") return [];
  const markdown: string = doc.markdown;
  const total: number = doc.questions.length;
  const open: number = doc.questions.filter((q: any) => q?.checked !== true).length;
  const status: AlignReportInfo["status"] =
    doc.explicitStatus === "implementing" || doc.explicitStatus === "confirmed" ? doc.explicitStatus
    : open > 0 ? "questions-open"
    : total > 0 ? "ready"
    : "aligning";
  const it = withPaths(item(id, "report", entry, markdown), markdown);
  it.report = {
    source: ALIGN_DOC,
    body: markdown,
    preview: previewLine(markdown),
    truncated: false,
    align: {
      status,
      title: doc.title,
      lines: markdown.split("\n").length,
      open,
      settled: total - open,
      total,
      revision: typeof doc.revision === "number" ? doc.revision : 0,
    },
  };
  return [it];
}

const EXPLAIN_DOC = "explain-doc";

/** A finished /explain: data is the ExplanationInfo the explainer wrote alongside its page in the
    store (server/explanations.ts). The row carries it verbatim for the gallery/strip; `preview` is
    the topic and `body` the summary, so the collapsed row reads without opening the page. Entries
    without an id, a topic or a createdAt are the extension mid-write: no row. */
function explainRow(id: string, entry: Entry): TranscriptItem[] {
  const d: any = entry.data;
  if (!d || typeof d !== "object") return [];
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  const explain: ExplanationInfo = {
    id: s(d.id),
    topic: s(d.topic),
    summary: s(d.summary),
    createdAt: s(d.createdAt),
    parentSessionId: s(d.parentSessionId),
  };
  if (!explain.id || !explain.topic || !explain.createdAt) return [];
  // The two halves of "the run went wrong" (pi-config/extensions/explain/store.ts
  // ExplainEntryData), at most one ever set. `error` is fatal — no page was written, nothing to
  // open — and also goes on `report.error`, where every other report row puts its failure, so
  // the row reads as a failure without special-casing. `note` is advisory: the page is there and
  // opens, the run just broke afterwards, so it stays linkable and is NOT a report error.
  // The child's model, recorded by the extension alongside the page. Tolerate its absence:
  // entries written before the field existed simply don't carry it.
  const model = s(d.model);
  if (model) explain.model = model;
  const err = s(d.error);
  const note = s(d.note);
  if (err) explain.error = err;
  else if (note) explain.note = note;
  const it = withPaths(item(id, "report", entry, explain.summary), explain.summary);
  it.report = { source: EXPLAIN_DOC, body: explain.summary, preview: explain.topic, truncated: false, explain };
  if (err) it.report.error = err;
  return [it];
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
      // Extension state, not displayable (docs/session-format.md). Exceptions: the mode
      // extension's switch marker, which the TUI draws in the transcript too; and pi-btw's
      // thread entries, which the TUI shows in its overlay but the web can only show here; and
      // the align document, which the TUI opens in its viewer overlay; and a finished /explain,
      // whose page the TUI can only point at but the web can open inline.
      if (entry.customType === "mode") return modeMarker(entry, id);
      if (entry.customType === "btw-thread-entry") return btwRow(id, entry);
      if (entry.customType === ALIGN_DOC) return alignRow(id, entry);
      if (entry.customType === EXPLAIN_DOC) return explainRow(id, entry);
      return [];
    case "custom_message":
      return entry.display === false ? [] : [customRow(id, entry, entry.customType, entry.content)];
    default:
      return [item(id, "unknown", entry)];
  }
}

export function normalizeEntries(entries: Entry[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const state: { model?: string } = {}; // running model_change, for assistant rows without their own
  // Align-doc entries are revisions of one document: only the newest renders (none if it's cleared).
  let newestAlign = -1;
  entries.forEach((e, i) => { if (isAlignDoc(e)) newestAlign = i; });
  entries.forEach((e, i) => { if (!isAlignDoc(e) || i === newestAlign) out.push(...normalizeEntry(e, `line${i}`, state)); });
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
