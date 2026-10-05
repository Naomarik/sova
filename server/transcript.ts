import { readFile } from "node:fs/promises";
import {
  EAGER_TOOLS,
  OVERSEER_DIALOG_ANSWER_ENTRY,
  OVERSEER_SENT_ENTRY,
  type AlignReportInfo,
  type EntryKind,
  type EntryMeta,
  type ExplanationInfo,
  type HandoffRunInfo,
  type ToolContent,
  type ToolRowInfo,
  type TranscriptItem,
} from "../shared/protocol";
import { PROFILE_ENTRY, SESSION_SENT_ENTRY } from "../shared/profiles";
import { profileField, profileOnBranch } from "./session-profile";
import {
  BATON_DECISION_ENTRY,
  BATON_DONE_ENTRY,
  BATON_HANDOFF_ENTRY,
  BATON_LEASE_ENTRY,
  BATON_OFFER_ENTRY,
  BATON_PROPOSAL_ENTRY,
  BATON_SENT_ENTRY,
  BATON_WRAPUP_ENTRY,
} from "../shared/baton";

const BATON_ROWS = new Set([
  BATON_SENT_ENTRY,
  BATON_HANDOFF_ENTRY,
  BATON_DECISION_ENTRY,
  BATON_DONE_ENTRY,
  BATON_OFFER_ENTRY,
  BATON_LEASE_ENTRY,
  BATON_PROPOSAL_ENTRY,
  BATON_WRAPUP_ENTRY,
]);
import { stripImageNotes } from "../shared/image-note";
import { parseLinkMessage } from "../shared/link-message";
import { parseTopicBatch } from "../shared/topic-message";
import { parseWakeNudge } from "../shared/wake";
import { inlineTmpImages } from "./attachments";
import { isReport, parseReport, parseTeamMessage, previewLine, TEAM_EVENT_TYPE, teamEventOf } from "./reports";
import { mergeInfoOf, WORKTREE_MERGE_MESSAGE } from "./worktrees-state";
import { alignResultOf } from "../pi-config/extensions/mode/align.ts";
// The folded tool card's own readers (src/lib/message.ts, src/lib/tool-diff-stats.ts, both DOM- and
// import-free): a slim row's line and "+n −m" are what the card would compute from the whole entry.
import { argsSummary, contentText as cardText, isObj, SPAWN_TOOLS, spawnName } from "../src/lib/message";
import { summaryStats } from "../src/lib/tool-diff-stats";

// We parse JSONL ourselves instead of using SessionManager.open(): open() is not
// read-only (it appends "\n" to a trailing partial line and rewrites the file when
// migrating old versions), and these files may be owned by a running TUI.

export type Entry = Record<string, any>;

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

// ---- What a row carries (§chat.transcript/slim-rows) ---------------------------------------------
// A row never carries its source entry over the wire. The server keeps it beside the row, in a
// WeakMap that JSON never sees, for its own readers of whole content (the Overseer's session reads,
// the tool-content route): `entryOf(row)`.

const sources = new WeakMap<TranscriptItem, Entry>();

/** The entry a row was made from (server-side only; never serialized). */
export const entryOf = (it: TranscriptItem): Entry | undefined => sources.get(it);

/** Keep `entry` as `it`'s source; `at` is the entry's timestamp. */
export function sourced(it: TranscriptItem, entry: unknown): TranscriptItem {
  if (entry && typeof entry === "object") {
    sources.set(it, entry as Entry);
    const at = (entry as Entry).timestamp;
    if (typeof at === "string") it.at = at;
  }
  return it;
}

const SIGNATURE_KEYS = new Set(["thinkingSignature", "textSignature", "thoughtSignature"]);

/** `v` without any provider signature (encrypted reasoning) at any depth; `v` itself when it holds
    none, so the common case copies nothing. */
export function withoutSignatures<T>(v: T): T {
  if (Array.isArray(v)) {
    let out: unknown[] | null = null;
    v.forEach((x, i) => {
      const y = withoutSignatures(x);
      if (y !== x) (out ??= v.slice())[i] = y;
    });
    return (out ?? v) as T;
  }
  if (!v || typeof v !== "object") return v;
  let out: Record<string, unknown> | null = null;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (SIGNATURE_KEYS.has(k)) {
      out ??= { ...(v as Record<string, unknown>) };
      delete out[k];
      continue;
    }
    const y = withoutSignatures(x);
    if (y !== x) (out ??= { ...(v as Record<string, unknown>) })[k] = y;
  }
  return (out ?? v) as T;
}

/** An entry's facts, as its first row carries them (EntryMeta). */
export function metaOf(entry: Entry): EntryMeta {
  const meta: EntryMeta = { type: typeof entry.type === "string" ? entry.type : "unknown" };
  if (typeof entry.customType === "string") meta.customType = entry.customType;
  if (entry.type === "compaction") {
    if (typeof entry.tokensBefore === "number") meta.tokensBefore = entry.tokensBefore;
    if (typeof entry.summary === "string") meta.summary = entry.summary;
    if (entry.details !== undefined) meta.details = entry.details;
  }
  const m = entry.message;
  if (isObj(m)) {
    const s = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : undefined);
    const put = <K extends keyof EntryMeta>(k: K, v: EntryMeta[K] | undefined) => {
      if (v !== undefined) meta[k] = v;
    };
    put("role", s("role"));
    put("provider", s("provider"));
    put("model", s("model"));
    if (m.usage !== undefined) meta.usage = m.usage;
    put("stopReason", s("stopReason"));
    put("errorMessage", s("errorMessage"));
    put("toolName", s("toolName"));
    put("toolCallId", s("toolCallId"));
    if (typeof m.isError === "boolean") meta.isError = m.isError;
    if (meta.customType === undefined) put("customType", s("customType"));
  }
  return meta;
}

/** The call block a tool-call row stands for: the first `toolCall` with its id, as the card finds it. */
function callBlock(entry: Entry | undefined, toolCallId: string | undefined): Record<string, unknown> | undefined {
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return undefined;
  const b = content.find((c) => isObj(c) && c.type === "toolCall" && c.id === toolCallId);
  return isObj(b) ? b : undefined;
}

/** A result row's output as the card shows it: its text blocks joined, else the row's own text. */
function resultOutput(entry: Entry | undefined, text: string | undefined): string {
  return cardText(entry?.message?.content) || text || "";
}

const sizeOf = (v: unknown): number => (v === undefined ? 0 : (JSON.stringify(v)?.length ?? 0));

/** A tool row's `tool`, from its source entry: the folded card's facts, and the whole content only
    for EAGER_TOOLS. A lazy result row loses its `text` (the content's 2,000-character cut). */
function slimTool(it: TranscriptItem, entry: Entry | undefined): void {
  if (it.kind === "tool-call") {
    const name = it.text ?? "tool";
    const args = callBlock(entry, it.toolCallId)?.arguments;
    const tool: ToolRowInfo = {};
    const summary = argsSummary(args);
    // Whole: the folded line's tooltip shows all of it (a heredoc's, at times, many KB).
    if (summary) tool.summary = summary;
    if (SPAWN_TOOLS.has(name)) {
      const spawn = spawnName(args);
      if (spawn) tool.spawn = spawn;
    }
    if (EAGER_TOOLS.has(name)) {
      if (args !== undefined) tool.args = args;
    } else {
      tool.lazy = true;
      tool.bytes = sizeOf(args);
    }
    it.tool = tool;
    return;
  }
  if (it.kind !== "tool-result") return;
  const m = entry?.message;
  const name = isObj(m) && typeof m.toolName === "string" ? m.toolName : "";
  const details = isObj(m) ? m.details : undefined;
  const output = resultOutput(entry, it.text);
  const tool: ToolRowInfo = {};
  // Counted whatever the result's own name (a Claude Code worker's result names no tool): the card
  // shows it only on an edit or write call, as it would have counted it.
  const stats = summaryStats("edit", details);
  if (stats) tool.stats = stats;
  if (EAGER_TOOLS.has(name)) {
    tool.output = output;
    if (details !== undefined) tool.details = details;
  } else {
    tool.lazy = true;
    tool.bytes = output.length + sizeOf(details);
    delete it.text;
  }
  it.tool = tool;
}

/**
 * Rows as they go over the wire: each source entry's first row gets the entry's facts (`meta`),
 * tool rows their `tool`, an unknown row its entry without signatures. Rows made from one entry
 * share it, so a reply's later blocks carry no meta of their own.
 */
export function slimRows(rows: TranscriptItem[]): TranscriptItem[] {
  let prev: Entry | undefined;
  for (const it of rows) {
    const entry = sources.get(it);
    if (entry && entry !== prev) it.meta = metaOf(entry);
    prev = entry;
    if (it.kind === "tool-call" || it.kind === "tool-result") slimTool(it, entry);
    else if (it.kind === "unknown" && entry) it.entry = withoutSignatures(entry);
  }
  return rows;
}

/**
 * The whole content of tool rows (GET /api/transcript/tool), from rows made by normalizeEntries or
 * normalizeClaudeEntries (their sources kept): for each asked id that is a tool-call or tool-result
 * row, its arguments and its result, as the opened card shows them.
 */
export function toolContents(rows: readonly TranscriptItem[], ids: readonly string[]): Record<string, ToolContent> {
  const want = new Set(ids);
  const results = new Map<string, TranscriptItem>();
  for (const it of rows) if (it.kind === "tool-result" && it.toolCallId) results.set(it.toolCallId, it);
  const resultOf = (r: TranscriptItem): ToolContent["result"] => {
    const entry = sources.get(r);
    const m = entry?.message;
    const out: NonNullable<ToolContent["result"]> = { output: resultOutput(entry, r.text ?? fullCut(entry)), isError: isObj(m) && m.isError === true };
    if (isObj(m) && m.details !== undefined) out.details = m.details;
    // An entry that recorded its edit as Claude Code's own `toolUseResult` beside the message (the
    // Changes viewer's fallback when the message has no details object).
    if (!(isObj(m) && isObj(m.details)) && isObj(entry?.toolUseResult)) out.toolUseResult = entry!.toolUseResult;
    return out;
  };
  const out: Record<string, ToolContent> = {};
  for (const it of rows) {
    if (!want.has(it.id)) continue;
    if (it.kind === "tool-call") {
      const c: ToolContent = {};
      const args = callBlock(sources.get(it), it.toolCallId)?.arguments;
      if (args !== undefined) c.args = args;
      const r = it.toolCallId ? results.get(it.toolCallId) : undefined;
      if (r) c.result = resultOf(r);
      out[it.id] = c;
    } else if (it.kind === "tool-result") {
      out[it.id] = { result: resultOf(it) };
    }
  }
  return out;
}

/** The 2,000-character cut a result row's text was, for a row that no longer carries it. */
function fullCut(entry: Entry | undefined): string {
  return truncate(contentText(entry?.message?.content, false), RESULT_TEXT_MAX);
}

function item(
  id: string,
  kind: EntryKind,
  entry: unknown,
  text?: string,
  toolCallId?: string,
  images?: string[],
): TranscriptItem {
  const it: TranscriptItem = { id, kind };
  if (text !== undefined) it.text = text;
  if (toolCallId !== undefined) it.toolCallId = toolCallId;
  if (images) it.images = images;
  return sourced(it, entry);
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
  // A coordinated team's report or question: a report row whatever its length, with the header
  // and trailer peeled off. Unparsed, it falls through to the generic row below.
  const team = parseTeamMessage(source, text);
  if (team) {
    const it = withPaths(item(id, "report", entry, team.body), team.body);
    it.report = { source, body: team.body, preview: previewLine(team.body), truncated: team.truncated, team: team.team };
    return it;
  }
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
      const raw = contentText(m.content, false);
      const wake = parseWakeNudge(raw);
      if (wake) {
        const it = item(id, "wake", entry, raw);
        it.wake = wake;
        return [it];
      }
      // A partner's message over a link (§mesh.links/transcript): the model's, never the user's.
      // Its own kind, so the thread renders nothing for it while the turn logic still sees a start.
      const link = parseLinkMessage(raw);
      if (link) {
        const it = item(id, "link", entry, raw);
        it.link = link;
        return [it];
      }
      // Notes other sessions pushed to a topic this session opened (§chat.topics/row): never "You".
      const topic = parseTopicBatch(raw);
      if (topic) {
        const it = item(id, "topic", entry, raw);
        it.topic = topic;
        return [it];
      }
      const it = item(id, "user", entry, undefined, undefined, contentImages(m.content));
      // pi 0.87's image resize notes are for the model: the row shows the text as typed.
      const { text, attachments } = inlineTmpImages(stripImageNotes(raw, m.content), true);
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
        // withModel: the turn's own provider rides the row (the limit row keys on it).
        out.push(withModel(item(`${id}:stop`, "info", entry, `${m.stopReason === "error" ? "Error" : "Aborted"}${why}`), model));
      }
      return out;
    }
    case "toolResult": {
      // An align call that changed an alignment, or recorded an exemption (§chat.alignment/card):
      // its checked details are the row. A failed call, a `get` or unreadable details stay a plain
      // tool result, inside their call's card.
      const align = m.toolName === "align" ? alignResultOf(entry) : undefined;
      if (align && (align.doc || align.exempt)) {
        const it = item(id, "align", entry, contentText(m.content, false), m.toolCallId);
        it.align = align;
        return [it];
      }
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
    case "system":
      // pi 0.86.0+: the prompt/tool loadout state replayed from the transcript
      // (content, sections, toolsAdded/Removed). The TUI does not show it as
      // conversation either, so neither do we.
      return [];
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

/** An /explain run, in one of two shapes (the extension appends both, same `id`; normalizeEntries
    renders only the newest per id):
    - running: appended at spawn with `status: "running"` and summary "". The row carries
      `explain.status = "running"`; there is no page yet, so nothing may link to it.
    - finished: the ExplanationInfo the explainer wrote alongside its page in the store
      (server/explanations.ts), with no status at all. Old sessions hold only this shape.
    - interrupted: a running run whose parent stopped, settled later with `status: "interrupted"`
      and a `note` (the page is there) or an `error` (it isn't); read like any finished entry.
    The row carries the data verbatim for the gallery/strip; `preview` is the topic and `body` the
    summary, so the collapsed row reads without opening the page. Entries without an id, a topic
    or a createdAt are the extension mid-write: no row. */
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
  if (d.status === "running" || d.status === "interrupted") explain.status = d.status;
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

const HANDOFF_RUN = "compact-handoff-run";
const HANDOFF_STATUSES: readonly HandoffRunInfo["status"][] = ["running", "saved", "failed", "cancelled", "interrupted"];

/** A /compact-handoff run's row (§chat.slash-commands/compact-handoff-row): the extension appends
    `{v: 1, id, status, at, focus?, path?, error?}` (pi-config/extensions/compact-handoff/run.ts)
    at the fork's start (`running`) and again, same id, when the run ends; normalizeEntries renders
    only the newest per id. An entry this version can't read: no row. */
function handoffRunRow(id: string, entry: Entry): TranscriptItem[] {
  const d: any = entry.data;
  if (!d || d.v !== 1 || typeof d.id !== "string" || !d.id || !HANDOFF_STATUSES.includes(d.status)) return [];
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  const run: HandoffRunInfo = { id: d.id, status: d.status };
  if (s(d.focus)) run.focus = s(d.focus);
  if (s(d.path)) run.path = s(d.path);
  if (s(d.error)) run.error = s(d.error);
  const text =
    run.status === "running" ? `Writing a handoff note${run.focus ? `: ${run.focus}` : ""}`
    : run.status === "saved" ? `Handoff note saved${run.path ? `: ${run.path}` : ""}`
    : run.status === "failed" ? `Handoff note failed${run.error ? `: ${run.error}` : ""}`
    : run.status === "cancelled" ? "Handoff cancelled"
    : "Handoff interrupted";
  const it = item(id, "info", entry, text);
  it.handoffRun = run;
  return [it];
}

/** The dedupe key of an entry rendered once per run id (explain-doc, compact-handoff-run), or null. */
function runKey(entry: Entry): string | null {
  if (entry.type !== "custom" || (entry.customType !== EXPLAIN_DOC && entry.customType !== HANDOFF_RUN)) return null;
  const d: any = entry.data;
  return d && typeof d === "object" && typeof d.id === "string" ? `${entry.customType}:${d.id}` : null;
}

/** The Overseer sent the user message `targetId`: a row that renders nothing itself — the client
    tags that user row "Overseer", matching by id in either arrival order. */
function overseerSentRow(id: string, entry: Entry): TranscriptItem[] {
  const d: any = entry.data;
  if (!d || typeof d.targetId !== "string" || !d.targetId) return [];
  const it = item(id, "info", entry);
  it.overseerMark = { kind: "sent", targetId: d.targetId };
  return [it];
}

/** Another session sent the user message `targetId` (§chat.profiles/delivery): renders nothing
    itself; the client draws the sender header above that row. */
function sessionSentRow(id: string, entry: Entry): TranscriptItem[] {
  const d: any = entry.data;
  if (!d || typeof d.targetId !== "string" || !d.targetId || typeof d.from?.sessionId !== "string") return [];
  const it = item(id, "info", entry);
  it.sessionMark = { kind: "sent", targetId: d.targetId, from: { sessionId: d.from.sessionId, title: typeof d.from.title === "string" ? d.from.title : "" }, hop: typeof d.hop === "number" ? d.hop : 1 };
  return [it];
}

/** The session's profile entry (§chat.profiles/after-first-message): the client draws its row only
    once a user message is on the branch. */
function profileRow(id: string, entry: Entry): TranscriptItem[] {
  const d = profileOnBranch([entry as { type: string; customType?: string; data?: unknown }]);
  if (!d) return [];
  const field = profileField(d) ?? null;
  const it = item(id, "info", entry, field ? `Profile: ${field.label}${field.singleton ? " · One at a time" : ""}` : "Profile: Default");
  it.profileMark = { profile: field };
  return [it];
}

/** The Overseer answered an extension dialog: the machine row "Overseer chose: X". */
function overseerAnswerRow(id: string, entry: Entry): TranscriptItem[] {
  const d: any = entry.data;
  const answer = d && typeof d.answer === "string" ? d.answer : "";
  const title = d && typeof d.title === "string" ? d.title : "";
  const it = item(id, "info", entry, `Overseer chose: ${answer}`);
  it.overseerMark = { kind: "dialog-answer", title, answer };
  return [it];
}

/** A baton marker (§app.baton/attribution): the sender of a user row (renders nothing itself), or a
    hand-off, decision or done card. Undecodable: nothing. */
function batonRow(id: string, entry: Entry): TranscriptItem[] {
  const d: any = entry.data;
  if (!d || typeof d !== "object") return [];
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const it = item(id, "info", entry);
  switch (entry.customType) {
    case BATON_SENT_ENTRY:
      if (!s(d.targetId) || !s(d.by)) return [];
      it.batonMark = { kind: "sent", targetId: d.targetId, by: d.by };
      return [it];
    case BATON_HANDOFF_ENTRY:
      if (typeof d.n !== "number") return [];
      it.batonMark = { kind: "handoff", n: d.n, from: s(d.from), to: s(d.to), question: s(d.question), briefing: s(d.briefing) };
      it.text = `Hand-off ${d.n}: ${s(d.question)}`;
      return [it];
    case BATON_DECISION_ENTRY:
      it.batonMark = { kind: "decision", by: s(d.by), area: s(d.area), statement: s(d.statement), quote: s(d.quote) };
      it.text = `Decision (${s(d.area)}): ${s(d.statement)}`;
      return [it];
    case BATON_DONE_ENTRY:
      it.batonMark = { kind: "done", summary: s(d.summary) };
      it.text = `Done: ${s(d.summary)}`;
      return [it];
    case BATON_OFFER_ENTRY: {
      if (typeof d.n !== "number" || !Array.isArray(d.to)) return [];
      const to = d.to.filter((x: unknown): x is string => typeof x === "string");
      it.batonMark = { kind: "offer", n: d.n, offerId: s(d.offerId), from: s(d.from), to, question: s(d.question), briefing: s(d.briefing) };
      it.text = `Offer ${d.n} to ${to.length} people: ${s(d.question)}`;
      return [it];
    }
    case BATON_LEASE_ENTRY:
      if (typeof d.n !== "number" || (d.event !== "claimed" && d.event !== "expired")) return [];
      it.batonMark = { kind: "lease", n: d.n, offerId: s(d.offerId), event: d.event, by: s(d.by) };
      it.text = d.event === "claimed" ? "Offer taken" : "Offer back in the pool";
      return [it];
    case BATON_PROPOSAL_ENTRY:
      if (!s(d.personId)) return [];
      it.batonMark = { kind: "proposal", personId: d.personId, name: s(d.name), role: s(d.role), why: s(d.why), by: s(d.by) };
      it.text = `Proposed for the roster: ${s(d.name)}`;
      return [it];
    case BATON_WRAPUP_ENTRY:
      if (d.phase === "start") {
        it.batonMark = { kind: "wrapup", phase: "start" };
        it.text = "Wrap-up started";
        return [it];
      }
      if (d.phase !== "end") return [];
      it.batonMark = {
        kind: "wrapup",
        phase: "end",
        applied: Array.isArray(d.applied) ? d.applied : [],
        refused: Array.isArray(d.refused) ? d.refused : [],
        ...(s(d.error) ? { error: s(d.error) } : {}),
      };
      it.text = `Wrap-up: ${Array.isArray(d.applied) ? d.applied.length : 0} profile updates`;
      return [it];
  }
  return [];
}

/** The claude-code provider's `claude-login` entry (§app.claude-logins/failover): the login a
    session runs on. Only a switch (it names the login it left) is a row, its notice as written;
    the plain record renders nothing. */
function claudeLoginRow(id: string, entry: Entry): TranscriptItem[] {
  const d = entry.data as { from?: unknown; text?: unknown } | undefined;
  if (!d || typeof d.from !== "string" || typeof d.text !== "string" || !d.text.trim()) return [];
  return [item(id, "info", entry, d.text.slice(0, 300))];
}

/** A subagents team event (handover, retire, pause, resume, wrap-up): one machine row, like a
    model change, in both webapp-owned and watched sessions. Undecodable: nothing. */
function teamEventRow(id: string, entry: Entry): TranscriptItem[] {
  const ev = teamEventOf(entry, id);
  if (!ev) return [];
  const it = item(id, "info", entry, `Team: ${ev.text}`);
  it.teamEvent = ev;
  return [it];
}

/** Normalize one parsed JSONL entry into 0..n TranscriptItems, as they go over the wire
    (slimRows). The header line yields none. */
export function normalizeEntry(entry: Entry, fallbackId = "?", state?: { model?: string }): TranscriptItem[] {
  return slimRows(entryRows(entry, fallbackId, state));
}

function entryRows(entry: Entry, fallbackId: string, state?: { model?: string }): TranscriptItem[] {
  const id = typeof entry.id === "string" ? entry.id : fallbackId;
  switch (entry.type) {
    case "session":
      return [];
    case "usage":
      // pi 0.86.0+: model-attributed usage outside the conversation (e.g. kind
      // "cache_warm"). Never a row: what it spent is in the usage ledger (recorded when the
      // call ended, llm-inflight), and unknown `kind` values are still usage.
      return [];
    case "context_edit":
      // pi 0.87.0+: an append-only edit (omit, or replace the content of) to what an earlier
      // entry sends the MODEL. pi writes one itself on every retried error and overflow recovery
      // (`_omitRecoveryAttempt`), and emits it as entry_appended. Raw history, usage and the
      // chat are unchanged — pi's own chat shows nothing for it, only /tree lists it — so the
      // edited message keeps its row and the edit renders nothing, not an unknown row.
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
      // the align document, which the TUI opens in its viewer overlay; a finished /explain,
      // whose page the TUI can only point at but the web can open inline; and a team event.
      if (entry.customType === "mode") return modeMarker(entry, id);
      if (entry.customType === "btw-thread-entry") return btwRow(id, entry);
      if (entry.customType === ALIGN_DOC) return alignRow(id, entry);
      if (entry.customType === EXPLAIN_DOC) return explainRow(id, entry);
      if (entry.customType === HANDOFF_RUN) return handoffRunRow(id, entry);
      if (entry.customType === OVERSEER_SENT_ENTRY) return overseerSentRow(id, entry);
      if (entry.customType === SESSION_SENT_ENTRY) return sessionSentRow(id, entry);
      if (entry.customType === PROFILE_ENTRY) return profileRow(id, entry);
      if (entry.customType === OVERSEER_DIALOG_ANSWER_ENTRY) return overseerAnswerRow(id, entry);
      if (entry.customType === TEAM_EVENT_TYPE) return teamEventRow(id, entry);
      if (entry.customType === "claude-login") return claudeLoginRow(id, entry);
      if (BATON_ROWS.has(entry.customType)) return batonRow(id, entry);
      return [];
    case "custom_message":
      if (entry.display === false) return [];
      // The worktrees extension's merge card; details it can't read fall back to the plain row.
      if (entry.customType === WORKTREE_MERGE_MESSAGE) {
        const merge = mergeInfoOf(entry.details);
        if (merge) {
          const it = item(id, "worktree-merge", entry, contentText(entry.content));
          it.worktreeMerge = merge;
          return [it];
        }
      }
      return [customRow(id, entry, entry.customType, entry.content)];
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
  // Each /explain and /compact-handoff run appends a running entry at its start and a final one
  // (same data.id) at settle: per id, only the newest renders, so a settled run is one row.
  // Entries without a string id are no key (their rows drop them anyway).
  const newestRun = new Map<string, number>();
  entries.forEach((e, i) => { const k = runKey(e); if (k !== null) newestRun.set(k, i); });
  entries.forEach((e, i) => {
    if (isAlignDoc(e) && i !== newestAlign) return;
    const k = runKey(e);
    if (k !== null && newestRun.get(k) !== i) return;
    out.push(...normalizeEntry(e, `line${i}`, state));
  });
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
 * Tokens in context as one assistant message reports them (input + cacheRead + cacheWrite), or
 * null when it says nothing about the context: no usage, an error or aborted reply, or a usage of
 * zero (a request that failed before the model read anything). Mirrored by src/lib/context.ts
 * messageContextTokens.
 */
export function messageContextTokens(m: unknown): number | null {
  if (!m || typeof m !== "object") return null;
  const msg = m as Record<string, any>;
  if (msg.role !== "assistant" || msg.stopReason === "error" || msg.stopReason === "aborted") return null;
  const u = msg.usage;
  if (!u || typeof u !== "object") return null;
  const tokens = (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
  return tokens > 0 ? tokens : null;
}

/**
 * Context fill = messageContextTokens of the LAST assistant message on the branch that reports
 * one; an error reply or a zero usage is passed over, so it never shows as an empty context. A
 * compaction after it makes that number stale, so we return null until the next reply.
 * The model is the assistant message's own provider/model, else the last model_change before it,
 * else the session's first model_change.
 */
export function contextForBranch(branch: Entry[]): BranchContext | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type === "compaction" || (e.type === "message" && e.message?.role === "compactionSummary")) return null;
    const m = e.type === "message" ? e.message : undefined;
    const tokens = messageContextTokens(m);
    if (tokens === null) continue;
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
