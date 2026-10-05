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
import type { HEntry } from "../shared/harness";
import { joinedText, rawOf, toHEntry, typedText } from "./harness/pi/reader";
import { metaOf, withoutSignatures } from "./harness/pi/wire";
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

// The parse, the branch rule and the context rule live in the pi adapter's reader and usage modules
// (§app.harness/reader); rows are built from the neutral history they give (`rowsOf`).

export type Entry = Record<string, any>;

const RESULT_TEXT_MAX = 2000;

/** An extension message's content (a string or blocks) as text: text blocks joined, an image block
    "[image]". */
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

/** An entry's text blocks joined by newlines (an image block "[image]" unless `images` is false); "" for
    an entry with no blocks. */
const textOf = (h: HEntry | undefined, images = true): string => (h ? joinedText(h, { images }) : "");

// ---- What a row carries (§chat.transcript/slim-rows) ---------------------------------------------
// A row never carries its source entry over the wire. The server keeps it on the row, as a hidden
// (non-enumerable) property that JSON never sees, for its own readers of whole content (the Overseer's session reads,
// the tool-content route): `sourceOf(row)`, the neutral entry (shared/harness-history.ts) it was
// made from, whatever wrote it (pi's reader, or the Claude Code transcript's rows).

const SOURCE = Symbol("source");
/** Kept on the row itself as a non-enumerable property (JSON, spreads and deep equality never see it): a
    WeakMap over every cached row cost each GC more than the rows did. */
const sources = {
  get: (it: TranscriptItem | undefined): HEntry | undefined => (it as { [SOURCE]?: HEntry } | undefined)?.[SOURCE],
  set(it: TranscriptItem, h: HEntry): void {
    SOURCE_DESC.value = h;
    Object.defineProperty(it, SOURCE, SOURCE_DESC);
    SOURCE_DESC.value = undefined;
  },
};
/** One descriptor for every row's source (defineProperty reads it at the call): no object per row. */
const SOURCE_DESC: PropertyDescriptor = { value: undefined, writable: true, configurable: true };

/** The entry a row was made from (server-side only; never serialized). */
export const sourceOf = (it: TranscriptItem): HEntry | undefined => sources.get(it);

/** The raw pi entry a row was made from, for the readers not yet on `sourceOf`; undefined for a row no pi
    entry made (a Claude Code row). */
export function entryOf(it: TranscriptItem): Entry | undefined {
  const h = sources.get(it);
  return h && rawOf(h);
}

/** Keep `h` as `it`'s source; `at` is the entry's time. */
export function withSource(it: TranscriptItem, h: HEntry | null | undefined): TranscriptItem {
  if (h) {
    sources.set(it, h);
    if (typeof h.at === "string") it.at = h.at;
  }
  return it;
}

/** Keep a raw pi entry as `it`'s source (rows made by hand, in tests). */
export function sourced(it: TranscriptItem, entry: unknown): TranscriptItem {
  return withSource(it, toHEntry(entry));
}

/** An entry's facts, as its first row carries them on wire 1 (EntryMeta): a pi entry's as pi wrote them
    (the adapter's metaOf: pi's own fields, its raw usage among them), else the neutral entry's (a Claude
    Code row's). A wire-2 consumer gets them mapped (server/wire-rows.ts). */
function factsOf(h: HEntry): EntryMeta {
  const raw = rawOf(h);
  return raw ? metaOf(raw) : neutralFacts(h);
}

/** The facts of an entry no pi entry made, in pi's words as a message of its kind would carry them. */
function neutralFacts(h: HEntry): EntryMeta {
  const meta: EntryMeta = { type: "message" };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const put = <K extends keyof EntryMeta>(k: K, v: EntryMeta[K] | undefined) => {
    if (v !== undefined) meta[k] = v;
  };
  switch (h.kind) {
    case "user":
      meta.role = "user";
      break;
    case "assistant":
      meta.role = "assistant";
      put("provider", str(h.provider));
      put("model", str(h.model));
      put("stopReason", str(h.stop));
      put("errorMessage", str(h.error));
      break;
    case "tool-result":
      meta.role = "toolResult";
      put("toolName", str(h.tool));
      put("toolCallId", str(h.callId));
      if (typeof h.isError === "boolean") meta.isError = h.isError;
      break;
    case "note":
      meta.role = "custom";
      put("customType", str(h.noteType));
      break;
    default:
      return { type: "unknown" };
  }
  return meta;
}

/** The call block a tool-call row stands for: the first `toolCall` with its id, as the card finds it. */
function callBlock(h: HEntry | undefined, toolCallId: string | undefined): { arguments: unknown } | undefined {
  if (!h || !("blocks" in h)) return undefined;
  return h.blocks.find((b) => b.type === "toolCall" && b.id === toolCallId) as { arguments: unknown } | undefined;
}

/** A result row's output as the card shows it: its text blocks joined, else the row's own text. */
function resultOutput(h: HEntry | undefined, text: string | undefined): string {
  return cardText(h && "blocks" in h ? h.blocks : undefined) || text || "";
}

/** The tool result a row was made from, if it was made from one. */
const resultEntry = (h: HEntry | undefined) => (h?.kind === "tool-result" ? h : undefined);

const sizeOf = (v: unknown): number => (v === undefined ? 0 : (JSON.stringify(v)?.length ?? 0));

/** A tool row's `tool`, from its source entry: the folded card's facts, and the whole content only
    for EAGER_TOOLS. A lazy result row loses its `text` (the content's 2,000-character cut). */
function slimTool(it: TranscriptItem, h: HEntry | undefined): void {
  if (it.kind === "tool-call") {
    const name = it.text ?? "tool";
    const args = callBlock(h, it.toolCallId)?.arguments;
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
  const r = resultEntry(h);
  const name = typeof r?.tool === "string" ? r.tool : "";
  const details = r?.details;
  const output = resultOutput(h, it.text);
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
  let prev: HEntry | undefined;
  for (const it of rows) {
    const h = sources.get(it);
    if (h && h !== prev) it.meta = factsOf(h);
    prev = h;
    if (it.kind === "tool-call" || it.kind === "tool-result") slimTool(it, h);
    else if (it.kind === "unknown" && h) {
      // The Unrecognized entry card shows the entry as the harness wrote it.
      const raw = rawOf(h);
      if (raw) it.entry = withoutSignatures(raw);
    }
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
    const h = sources.get(r);
    const t = resultEntry(h);
    const out: NonNullable<ToolContent["result"]> = { output: resultOutput(h, r.text ?? fullCut(h)), isError: t?.isError === true };
    if (t && t.details !== undefined) out.details = t.details;
    // A pi entry that recorded its edit as Claude Code's own `toolUseResult` beside the message (the
    // Changes viewer's fallback when the message has no details object).
    const raw = h && rawOf(h);
    if (!isObj(t?.details) && isObj(raw?.toolUseResult)) out.toolUseResult = raw!.toolUseResult;
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
function fullCut(h: HEntry | undefined): string {
  return truncate(textOf(h, false), RESULT_TEXT_MAX);
}

function item(
  id: string,
  kind: EntryKind,
  h: HEntry,
  text?: string,
  toolCallId?: string,
  images?: string[],
): TranscriptItem {
  const it: TranscriptItem = { id, kind };
  if (text !== undefined) it.text = text;
  if (toolCallId !== undefined) it.toolCallId = toolCallId;
  if (images) it.images = images;
  return withSource(it, h);
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

type NoteEntry = Extract<HEntry, { kind: "note" }>;
type StateEntry = Extract<HEntry, { kind: "state" }>;

/** An extension message: a report row when it's a subagent report or long/multi-line, else an info row. */
function customRow(id: string, h: NoteEntry): TranscriptItem {
  const text = contentText(h.content);
  const source = typeof h.noteType === "string" ? h.noteType : "";
  // A coordinated team's report or question: a report row whatever its length, with the header
  // and trailer peeled off. Unparsed, it falls through to the generic row below.
  const team = parseTeamMessage(source, text);
  if (team) {
    const it = withPaths(item(id, "report", h, team.body), team.body);
    it.report = { source, body: team.body, preview: previewLine(team.body), truncated: team.truncated, team: team.team };
    return it;
  }
  if (!isReport(source, text)) return withPaths(item(id, "info", h, text), text);
  const report = parseReport(source, text);
  const it = withPaths(item(id, "report", h, report.body), report.body);
  it.report = report;
  return it;
}

/** A user message's rows: a wake-up, a link message, a topic batch, or the user's own words. */
function userRow(id: string, h: Extract<HEntry, { kind: "user" }>): TranscriptItem[] {
  const raw = textOf(h, false);
  const wake = parseWakeNudge(raw);
  if (wake) {
    const it = item(id, "wake", h, raw);
    it.wake = wake;
    return [it];
  }
  // A partner's message over a link (§mesh.links/transcript): the model's, never the user's.
  // Its own kind, so the thread renders nothing for it while the turn logic still sees a start.
  const link = parseLinkMessage(raw);
  if (link) {
    const it = item(id, "link", h, raw);
    it.link = link;
    return [it];
  }
  // Notes other sessions pushed to a topic this session opened (§chat.topics/row): never "You".
  const topic = parseTopicBatch(raw);
  if (topic) {
    const it = item(id, "topic", h, raw);
    it.topic = topic;
    return [it];
  }
  const it = item(id, "user", h, undefined, undefined, contentImages(h.blocks));
  // pi 0.87's image resize notes are for the model: the row shows the text as typed.
  const { text, attachments } = inlineTmpImages(typedText(raw, h), true);
  if (text !== undefined) it.text = text;
  if (attachments) it.attachments = attachments;
  return [it];
}

/** A reply's rows: one item per content block, ids `${entryId}:${blockIndex}` so they stay unique, and
    a stop row for an error or an abort. */
function assistantRows(id: string, h: Extract<HEntry, { kind: "assistant" }>, state?: { model?: string }): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  // This row's producer: the message's own provider/model, else the last model change seen.
  const model = (typeof h.provider === "string" && typeof h.model === "string" ? `${h.provider}/${h.model}` : undefined) ?? state?.model;
  // A reply whose content pi wrote as a string (it never does) has had no block rows; the reader reads
  // such content as one text block.
  const blocks: any[] = typeof rawOf(h)?.message?.content === "string" ? [] : h.blocks;
  blocks.forEach((b, i) => {
    const bid = `${id}:${i}`;
    if (b?.type === "text") {
      if (b.text?.trim()) out.push(withModel(withPaths(item(bid, "assistant-text", h, b.text), b.text), model));
    } else if (b?.type === "thinking") {
      if (b.thinking?.trim()) out.push(withModel(item(bid, "thinking", h, b.thinking), model));
    } else if (b?.type === "toolCall") {
      out.push(withModel(item(bid, "tool-call", h, String(b.name ?? "tool"), b.id), model));
    } else {
      out.push(item(bid, "unknown", h));
    }
  });
  if (h.stop === "error" || h.stop === "aborted") {
    const why = h.error ? `: ${h.error}` : "";
    // withModel: the turn's own provider rides the row (the limit row keys on it).
    out.push(withModel(item(`${id}:stop`, "info", h, `${h.stop === "error" ? "Error" : "Aborted"}${why}`), model));
  }
  return out;
}

/** A tool result's row, or an align row for an align call that changed an alignment, or recorded an
    exemption (§chat.alignment/card): its checked details are the row. A failed call, a `get` or
    unreadable details stay a plain tool result, inside their call's card. */
function toolResultRow(id: string, h: Extract<HEntry, { kind: "tool-result" }>): TranscriptItem[] {
  const align = h.tool === "align" ? alignResultOf(rawOf(h)) : undefined;
  if (align && (align.doc || align.exempt)) {
    const it = item(id, "align", h, textOf(h, false), h.callId);
    it.align = align;
    return [it];
  }
  const text = textOf(h, false);
  return [withPaths(item(id, "tool-result", h, truncate(text, RESULT_TEXT_MAX), h.callId, contentImages(h.blocks)), text)];
}

/**
 * pi-config mode extension marker: `{mode}` for a major switch, `{minor, on}` for a minor one,
 * `{strict}` for the strict toggle. Newer entries also carry an `active` snapshot (what the
 * session restores from); it is state, not a message, so it is never rendered.
 */
function modeMarker(h: StateEntry, id: string): TranscriptItem[] {
  const d: any = h.data;
  if (d && typeof d.minor === "string" && typeof d.on === "boolean") return [item(id, "info", h, `Minor mode: ${d.minor} ${d.on ? "on" : "off"}`)];
  if (d && typeof d.mode === "string") return [item(id, "info", h, `Mode → ${d.mode}`)];
  if (d && typeof d.strict === "boolean") return [item(id, "info", h, `Strict mode ${d.strict ? "on" : "off"}`)];
  return [];
}

/** A pi-btw side-channel exchange. Hidden custom state in the TUI (it lives in the overlay);
    the web has no overlay, so show it as a report row or /btw answers would be silent. */
function btwRow(id: string, h: StateEntry): TranscriptItem[] {
  const d: any = h.data;
  const answer = typeof d?.answer === "string" ? d.answer : "";
  if (!answer.trim()) return []; // still running or malformed: stay hidden like the TUI
  const question = typeof d.question === "string" ? d.question.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  const model = typeof d.provider === "string" && typeof d.model === "string" ? `${d.provider}/${d.model}` : undefined;
  const it = withPaths(item(id, "report", h, answer), answer);
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

function isAlignDoc(h: HEntry): boolean {
  return h.kind === "state" && h.key === ALIGN_DOC;
}

/** The mode extension's align document: data {version: 1, doc: AlignDoc | null}, a full snapshot
    per revision; align.ts is the only parser, so this reads the payload and never the markdown. doc
    null (cleared) or without markdown, a questions array or a title yields no row; normalizeEntries keeps only
    the newest align-doc entry on the branch. */
function alignRow(id: string, h: StateEntry): TranscriptItem[] {
  const doc: any = (h.data as any)?.doc;
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
  const it = withPaths(item(id, "report", h, markdown), markdown);
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
function explainRow(id: string, h: StateEntry): TranscriptItem[] {
  const d: any = h.data;
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
  const it = withPaths(item(id, "report", h, explain.summary), explain.summary);
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
function handoffRunRow(id: string, h: StateEntry): TranscriptItem[] {
  const d: any = h.data;
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
  const it = item(id, "info", h, text);
  it.handoffRun = run;
  return [it];
}

/** The dedupe key of an entry rendered once per run id (explain-doc, compact-handoff-run), or null. */
function runKey(h: HEntry): string | null {
  if (h.kind !== "state" || (h.key !== EXPLAIN_DOC && h.key !== HANDOFF_RUN)) return null;
  const d: any = h.data;
  return d && typeof d === "object" && typeof d.id === "string" ? `${h.key}:${d.id}` : null;
}

/** The Overseer sent the user message `targetId`: a row that renders nothing itself — the client
    tags that user row "Overseer", matching by id in either arrival order. */
function overseerSentRow(id: string, h: StateEntry): TranscriptItem[] {
  const d: any = h.data;
  if (!d || typeof d.targetId !== "string" || !d.targetId) return [];
  const it = item(id, "info", h);
  it.overseerMark = { kind: "sent", targetId: d.targetId };
  return [it];
}

/** Another session sent the user message `targetId` (§chat.profiles/delivery): renders nothing
    itself; the client draws the sender header above that row. */
function sessionSentRow(id: string, h: StateEntry): TranscriptItem[] {
  const d: any = h.data;
  if (!d || typeof d.targetId !== "string" || !d.targetId || typeof d.from?.sessionId !== "string") return [];
  const it = item(id, "info", h);
  it.sessionMark = { kind: "sent", targetId: d.targetId, from: { sessionId: d.from.sessionId, title: typeof d.from.title === "string" ? d.from.title : "" }, hop: typeof d.hop === "number" ? d.hop : 1 };
  return [it];
}

/** The session's profile entry (§chat.profiles/after-first-message): the client draws its row only
    once a user message is on the branch. */
function profileRow(id: string, h: StateEntry): TranscriptItem[] {
  const d = profileOnBranch([rawOf(h) as { type: string; customType?: string; data?: unknown }]);
  if (!d) return [];
  const field = profileField(d) ?? null;
  const it = item(id, "info", h, field ? `Profile: ${field.label}${field.singleton ? " · One at a time" : ""}` : "Profile: Default");
  it.profileMark = { profile: field };
  return [it];
}

/** The Overseer answered an extension dialog: the machine row "Overseer chose: X". */
function overseerAnswerRow(id: string, h: StateEntry): TranscriptItem[] {
  const d: any = h.data;
  const answer = d && typeof d.answer === "string" ? d.answer : "";
  const title = d && typeof d.title === "string" ? d.title : "";
  const it = item(id, "info", h, `Overseer chose: ${answer}`);
  it.overseerMark = { kind: "dialog-answer", title, answer };
  return [it];
}

/** A baton marker (§app.baton/attribution): the sender of a user row (renders nothing itself), or a
    hand-off, decision or done card. Undecodable: nothing. */
function batonRow(id: string, h: StateEntry): TranscriptItem[] {
  const d: any = h.data;
  if (!d || typeof d !== "object") return [];
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const it = item(id, "info", h);
  switch (h.key) {
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
function claudeLoginRow(id: string, h: StateEntry): TranscriptItem[] {
  const d = h.data as { from?: unknown; text?: unknown } | undefined;
  if (!d || typeof d.from !== "string" || typeof d.text !== "string" || !d.text.trim()) return [];
  return [item(id, "info", h, d.text.slice(0, 300))];
}

/** A subagents team event (handover, retire, pause, resume, wrap-up): one machine row, like a
    model change, in both webapp-owned and watched sessions. Undecodable: nothing. */
function teamEventRow(id: string, h: StateEntry): TranscriptItem[] {
  const ev = teamEventOf(h, id);
  if (!ev) return [];
  const it = item(id, "info", h, `Team: ${ev.text}`);
  it.teamEvent = ev;
  return [it];
}

/** A neutral entry's rows (0..n TranscriptItems), as they go over the wire (slimRows); `state` carries the
    running model. An id-less entry's rows are keyed by `fallbackId`. */
export function rowsOfEntry(h: HEntry, fallbackId = "?", state?: { model?: string }): TranscriptItem[] {
  return slimRows(entryRows(h, fallbackId, state));
}

/** Normalize one parsed pi entry into 0..n TranscriptItems, as they go over the wire (slimRows). The
    header line yields none. */
export function normalizeEntry(entry: Entry, fallbackId = "?", state?: { model?: string }): TranscriptItem[] {
  const h = toHEntry(entry);
  return h ? rowsOfEntry(h, fallbackId, state) : [];
}

function entryRows(h: HEntry, fallbackId: string, state?: { model?: string }): TranscriptItem[] {
  const id = h.id ?? fallbackId;
  switch (h.kind) {
    case "usage-record":
      // pi 0.86.0+: model-attributed usage outside the conversation (e.g. kind
      // "cache_warm"). Never a row: what it spent is in the usage ledger (recorded when the
      // call ended, llm-inflight), and unknown `kind` values are still usage.
      return [];
    case "context-edit":
      // pi 0.87.0+: an append-only edit (omit, or replace the content of) to what an earlier
      // entry sends the MODEL. pi writes one itself on every retried error and overflow recovery
      // (`_omitRecoveryAttempt`), and emits it as entry_appended. Raw history, usage and the
      // chat are unchanged — pi's own chat shows nothing for it, only /tree lists it — so the
      // edited message keeps its row and the edit renders nothing, not an unknown row.
      return [];
    case "system":
      // pi 0.86.0+: the prompt/tool loadout state replayed from the transcript
      // (content, sections, toolsAdded/Removed). The TUI does not show it as
      // conversation either, so neither do we.
      return [];
    case "user":
      return userRow(id, h);
    case "assistant":
      return assistantRows(id, h, state);
    case "tool-result":
      return toolResultRow(id, h);
    case "shell":
      return [item(id, "info", h, truncate(`$ ${h.command ?? ""}\n${h.output ?? ""}`, RESULT_TEXT_MAX))];
    case "note":
      if (!h.display) return [];
      // The worktrees extension's merge card; details it can't read fall back to the plain row.
      if (!h.inMessage && h.noteType === WORKTREE_MERGE_MESSAGE) {
        const merge = mergeInfoOf(h.details);
        if (merge) {
          const it = item(id, "worktree-merge", h, contentText(h.content));
          it.worktreeMerge = merge;
          return [it];
        }
      }
      return [customRow(id, h)];
    case "summary":
      return [item(id, "info", h, `${h.of === "branch" ? "Branch" : "Compaction"} summary: ${h.summary ?? ""}`)];
    case "setting":
      switch (h.what) {
        case "model":
          if (state) state.model = `${h.provider}/${h.modelId}`;
          return [item(id, "info", h, `Model: ${h.provider}/${h.modelId}`)];
        case "thinking":
          return [item(id, "info", h, `Thinking: ${h.level}`)];
        case "name":
          return [item(id, "info", h, `Session name: ${h.name ?? ""}`)];
        case "label":
          return [item(id, "info", h, h.label ? `Label "${h.label}" on ${h.targetId}` : `Label cleared on ${h.targetId}`)];
      }
      return [];
    case "compaction":
      return [item(id, "info", h, `Compacted (${h.tokensBefore ?? "?"} tokens): ${h.summary ?? ""}`)];
    case "state":
      return stateRows(id, h);
    case "unknown":
      // Never dropped silently: the Unrecognized entry row, its entry as written (§app.harness/unknown-entries;
      // the reader counted it).
      return [item(id, "unknown", h)];
  }
}

/** Extension state, not displayable (docs/session-format.md). Exceptions: the mode extension's switch
    marker, which the TUI draws in the transcript too; and pi-btw's thread entries, which the TUI shows in
    its overlay but the web can only show here; and the align document, which the TUI opens in its viewer
    overlay; a finished /explain, whose page the TUI can only point at but the web can open inline; and a
    team event. */
function stateRows(id: string, h: StateEntry): TranscriptItem[] {
  if (h.key === "mode") return modeMarker(h, id);
  if (h.key === "btw-thread-entry") return btwRow(id, h);
  if (h.key === ALIGN_DOC) return alignRow(id, h);
  if (h.key === EXPLAIN_DOC) return explainRow(id, h);
  if (h.key === HANDOFF_RUN) return handoffRunRow(id, h);
  if (h.key === OVERSEER_SENT_ENTRY) return overseerSentRow(id, h);
  if (h.key === SESSION_SENT_ENTRY) return sessionSentRow(id, h);
  if (h.key === PROFILE_ENTRY) return profileRow(id, h);
  if (h.key === OVERSEER_DIALOG_ANSWER_ENTRY) return overseerAnswerRow(id, h);
  if (h.key === TEAM_EVENT_TYPE) return teamEventRow(id, h);
  if (h.key === "claude-login") return claudeLoginRow(id, h);
  if (BATON_ROWS.has(h.key)) return batonRow(id, h);
  return [];
}

/** The rows of a run of history; `line(i)` is the position an id-less entry's rows are keyed by. */
function historyRows(history: readonly HEntry[], line: (i: number) => number): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const state: { model?: string } = {}; // running model change, for assistant rows without their own
  // Align-doc entries are revisions of one document: only the newest renders (none if it's cleared).
  let newestAlign = -1;
  history.forEach((h, i) => { if (isAlignDoc(h)) newestAlign = i; });
  // Each /explain and /compact-handoff run appends a running entry at its start and a final one
  // (same data.id) at settle: per id, only the newest renders, so a settled run is one row.
  // Entries without a string id are no key (their rows drop them anyway).
  const newestRun = new Map<string, number>();
  history.forEach((h, i) => { const k = runKey(h); if (k !== null) newestRun.set(k, i); });
  history.forEach((h, i) => {
    if (isAlignDoc(h) && i !== newestAlign) return;
    const k = runKey(h);
    if (k !== null && newestRun.get(k) !== i) return;
    out.push(...rowsOfEntry(h, `line${line(i)}`, state));
  });
  return out;
}

/** The rows of a run of neutral history (a branch, or any slice of one), as they go over the wire. */
export function rowsOf(history: readonly HEntry[]): TranscriptItem[] {
  return historyRows(history, (i) => i);
}

/** The rows of parsed pi entries (a branch, or any slice of one); an id-less entry's rows are keyed by its
    place in `entries`, the header's place included. */
export function normalizeEntries(entries: Entry[]): TranscriptItem[] {
  const history: HEntry[] = [];
  const lines: number[] = [];
  entries.forEach((e, i) => {
    const h = toHEntry(e);
    if (h) history.push(h), lines.push(i);
  });
  return historyRows(history, (i) => lines[i]!);
}
