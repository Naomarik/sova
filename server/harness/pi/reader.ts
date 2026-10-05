// pi's session files as Sova's neutral history (§app.harness/reader). The one place that knows pi's entry
// and message shapes: it parses a file, finds its active branch, and turns each entry into an HEntry
// (shared/harness-history.ts), keeping the raw entry beside it (`rawOf`) for the readers that have not
// moved yet. It only reads: never SessionManager.open(), which is not read-only (it appends "\n" to a torn
// last line and rewrites a file it migrates), and these files may be owned by a running TUI.
//
// The raw API (parseLines, activeBranch, readActiveBranch, rawOf) is counted by the boundary's reader
// ratchet wherever it is imported (server/harness/boundary-scan.ts RAW_SOURCES).
import { open, readFile, stat } from "node:fs/promises";
import type { AgentSession, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { EntryId, HBlock, HEntry, HHeader, HUsage, SessionRead } from "../../../shared/harness";
import { stripImageNotes } from "../../../shared/image-note";
import { parseJsonl, type JsonObject } from "../../jsonl";
import { messageContextTokens } from "./usage";

/** A raw pi entry, as parsed from its line. */
export type Entry = JsonObject;

// ---- The raw parse and branch rule (moved from server/transcript.ts, unchanged) --------------------

/** Parse JSONL text into objects, skipping blank/malformed lines. */
export const parseLines: (text: string) => Entry[] = parseJsonl;

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

/** Read a session file and return its active-branch entries (root-first). */
export async function readActiveBranch(path: string): Promise<Entry[]> {
  return activeBranch(parseLines(await readFile(path, "utf8")));
}

// ---- Neutral entries -------------------------------------------------------------------------------

const raws = new WeakMap<HEntry, Entry>();

/** TEMPORARY (M2 to M4): the raw entry an HEntry was made from, for the state folds that still read pi's
    custom entries. Counted by the boundary's reader ratchet. */
export function rawOf(h: HEntry): Entry {
  return raws.get(h)!;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

const BLOCKS = new Set(["text", "thinking", "toolCall", "image"]);

/** The block arrays made from a bare string content (legacy files), for `storedAsString`. */
const fromString = new WeakSet<HBlock[]>();

/** pi's content as blocks: pi's own array when every block is one Sova knows (no copy), else a copy with
    each unknown block wrapped; a string is one text block. */
function blocksOf(content: unknown): HBlock[] {
  if (typeof content === "string") {
    const blocks: HBlock[] = [{ type: "text", text: content }];
    fromString.add(blocks);
    return blocks;
  }
  if (!Array.isArray(content)) return [];
  if (content.every((b) => isObj(b) && BLOCKS.has(b.type as string))) return content as HBlock[];
  return content.map((b) => (isObj(b) && BLOCKS.has(b.type as string) ? (b as HBlock) : { type: "unknown", raw: b }));
}

/** A usage object as HUsage, each count read as the context rule reads it (`Number(x) || 0`); undefined
    when pi recorded none. */
function usageOf(u: unknown): HUsage | undefined {
  if (!isObj(u)) return undefined;
  const out: HUsage = { input: Number(u.input) || 0, output: Number(u.output) || 0, cacheRead: Number(u.cacheRead) || 0, cacheWrite: Number(u.cacheWrite) || 0 };
  if (typeof u.cacheWrite1h === "number") out.cacheWrite1h = u.cacheWrite1h;
  if (typeof u.cost?.total === "number") out.cost = u.cost.total;
  return out;
}

/** Every optional field present only when the entry has it, so an HEntry is as small as its entry. Values
    are pi's as written, unchecked: a reader that moves here keeps its output on a malformed file too. */
function put<T extends object>(o: T, k: string, v: unknown): void {
  if (v !== undefined) (o as Record<string, unknown>)[k] = v;
}

/** A message entry's body; null when it is not one Sova can read (no message, an unknown role). */
function messageOf(m: Record<string, any>, base: Record<string, unknown>): HEntry | null {
  const h = base as Record<string, any>;
  switch (m.role) {
    case "user":
      h.kind = "user";
      h.blocks = blocksOf(m.content);
      put(h, "sentAt", m.timestamp);
      return h as HEntry;
    case "assistant":
      h.kind = "assistant";
      h.blocks = blocksOf(m.content);
      put(h, "provider", m.provider);
      put(h, "model", m.model);
      put(h, "usage", usageOf(m.usage));
      put(h, "contextTokens", messageContextTokens(m) ?? undefined);
      put(h, "stop", m.stopReason);
      put(h, "error", m.errorMessage);
      put(h, "sentAt", m.timestamp);
      return h as HEntry;
    case "toolResult":
      h.kind = "tool-result";
      put(h, "callId", m.toolCallId);
      put(h, "tool", m.toolName);
      h.blocks = blocksOf(m.content);
      put(h, "details", m.details);
      if (typeof m.isError === "boolean") h.isError = m.isError;
      put(h, "sentAt", m.timestamp);
      return h as HEntry;
    case "bashExecution":
      h.kind = "shell";
      put(h, "command", m.command);
      put(h, "output", m.output);
      put(h, "sentAt", m.timestamp);
      return h as HEntry;
    case "custom":
      h.kind = "note";
      put(h, "noteType", m.customType);
      h.content = m.content;
      h.display = m.display !== false;
      put(h, "details", m.details);
      h.inMessage = true;
      return h as HEntry;
    case "branchSummary":
    case "compactionSummary":
      h.kind = "summary";
      h.of = m.role === "branchSummary" ? "branch" : "compaction";
      put(h, "summary", m.summary);
      h.inMessage = true;
      return h as HEntry;
    case "system":
      h.kind = "system";
      h.blocks = blocksOf(m.content);
      if (isObj(m.sections)) h.sections = m.sections;
      return h as HEntry;
    default:
      return null;
  }
}

/**
 * One raw pi entry as an HEntry, or null for the header (`session`) and anything that is not an object.
 * An entry type or message role pi 0.87.1 doesn't write becomes `kind: "unknown"`, keeps its place in the
 * tree, and is counted (`unknownEntries`); a known type with a malformed body keeps its kind, with the
 * fields it lacks left out.
 */
export function toHEntry(raw: unknown): HEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Entry;
  if (e.type === "session") return null;
  const base: Record<string, any> = { id: typeof e.id === "string" ? e.id : null, parentId: typeof e.parentId === "string" ? e.parentId : null };
  put(base, "at", e.timestamp);
  let h: HEntry | null = null;
  switch (e.type) {
    case "message":
      h = isObj(e.message) ? messageOf(e.message, base) : null;
      break;
    case "model_change":
      h = Object.assign(base, { kind: "setting", what: "model" }) as HEntry;
      put(h, "provider", e.provider);
      put(h, "modelId", e.modelId);
      break;
    case "thinking_level_change":
      h = Object.assign(base, { kind: "setting", what: "thinking" }) as HEntry;
      put(h, "level", e.thinkingLevel);
      break;
    case "session_info":
      h = Object.assign(base, { kind: "setting", what: "name" }) as HEntry;
      put(h, "name", e.name);
      break;
    case "label":
      h = Object.assign(base, { kind: "setting", what: "label" }) as HEntry;
      put(h, "label", e.label);
      put(h, "targetId", e.targetId);
      break;
    case "compaction":
      h = Object.assign(base, { kind: "compaction" }) as HEntry;
      put(h, "tokensBefore", e.tokensBefore);
      put(h, "summary", e.summary);
      put(h, "details", e.details);
      break;
    case "branch_summary":
      h = Object.assign(base, { kind: "summary", of: "branch" }) as HEntry;
      put(h, "summary", e.summary);
      put(h, "inMessage", false);
      break;
    case "usage":
      h = Object.assign(base, { kind: "usage-record" }) as HEntry;
      put(h, "provider", e.provider);
      put(h, "model", e.model);
      put(h, "usage", usageOf(e.usage));
      break;
    case "context_edit":
      h = Object.assign(base, { kind: "context-edit" }) as HEntry;
      break;
    case "custom":
      h = Object.assign(base, { kind: "state", key: e.customType, data: e.data }) as HEntry;
      break;
    case "custom_message":
      h = Object.assign(base, { kind: "note", content: e.content, display: e.display !== false, inMessage: false }) as HEntry;
      put(h, "noteType", e.customType);
      put(h, "details", e.details);
      break;
  }
  if (h === null) {
    const type = unknownTypeOf(e);
    h = Object.assign(base, { kind: "unknown", type }) as HEntry;
    noteUnknown(type, h.id);
  }
  raws.set(h, e);
  return h;
}

/** Raw entries (a file's, a branch's, a held session's) as HEntries, the header left out. */
export function historyOf(raw: readonly unknown[]): HEntry[] {
  const out: HEntry[] = [];
  for (const r of raw) {
    const h = toHEntry(r);
    if (h) out.push(h);
  }
  return out;
}

/** A header line's facts, or null when the entry is not a header. */
export function headerOf(raw: unknown): HHeader | null {
  if (!isObj(raw) || raw.type !== "session") return null;
  const h: HHeader = {};
  put(h, "id", raw.id);
  put(h, "cwd", raw.cwd);
  put(h, "version", raw.version);
  put(h, "parentSession", raw.parentSession);
  put(h, "at", raw.timestamp);
  return h;
}

export interface PiFile {
  /** The first header in the file, null when it has none. */
  header: HHeader | null;
  /** Every other entry, in file order. */
  entries: HEntry[];
}

/** A whole pi session file's text: today's parse (blank and malformed lines skipped). */
export function parsePi(text: string): PiFile {
  let header: HHeader | null = null;
  const entries: HEntry[] = [];
  for (const raw of parseLines(text)) {
    if (raw.type === "session") {
      header ??= headerOf(raw);
      continue;
    }
    const h = toHEntry(raw);
    if (h) entries.push(h);
  }
  return { header, entries };
}

export async function readPi(path: string): Promise<PiFile> {
  return parsePi(await readFile(path, "utf8"));
}

/**
 * The active branch, root first: activeBranch's rule over HEntries. The leaf is the last entry, walked up
 * by parentId; a cycle stops the walk and a later duplicate id wins. A file with any entry lacking an id
 * is legacy linear: every entry, in file order (pinned as it is, fixture `unknown-noid`).
 */
export function branchOf(entries: readonly HEntry[]): HEntry[] {
  if (entries.length === 0) return [];
  if (entries.some((h) => h.id === null)) return entries.slice();
  const byId = new Map<string, HEntry>();
  for (const h of entries) byId.set(h.id!, h);
  const path: HEntry[] = [];
  const seen = new Set<string>();
  let cur: HEntry | undefined = entries[entries.length - 1];
  while (cur && !seen.has(cur.id!)) {
    seen.add(cur.id!);
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

/**
 * A branch chosen strictly (the share view's, §app.session-share/never): root → `cutEntryId`, or,
 * with no cut, root → the file's last entry that has an id (the leaf, as activeBranch takes it).
 * Unlike transcript.ts's forgiving activeBranch, an id-less record never turns a branched file into
 * one flat list (every abandoned branch included): it is ignored. A genuine pre-id file (no entry
 * has an id, no header of version 2 or later) is linear, as transcript.ts reads it, and has no cut.
 * null, anything ambiguous: a cut not in the file, two entries with one id, a parent that isn't
 * there, a cycle. Strict about the parent as the file wrote it: only an explicit null is a root.
 */
export function strictBranchTo(file: PiFile, cutEntryId: string | null): HEntry[] | null {
  const body = file.entries.slice();
  const withId = body.filter((h): h is HEntry & { id: string } => typeof h.id === "string" && !!h.id);
  if (!withId.length) {
    const version = file.header?.version;
    return cutEntryId || (typeof version === "number" && version >= 2) ? null : body;
  }
  const byId = new Map<string, HEntry & { id: string }>();
  for (const h of withId) {
    if (byId.has(h.id)) return null;
    byId.set(h.id, h);
  }
  let cur = byId.get(cutEntryId ?? withId.at(-1)!.id);
  if (!cur) return null;
  const path: HEntry[] = [];
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    path.push(cur);
    const parent: unknown = rawOf(cur).parentId;
    if (parent === null) break;
    if (typeof parent !== "string") return null;
    cur = byId.get(parent);
    if (!cur) return null;
  }
  return path.reverse();
}

/** A session file's active branch as HEntries. */
export async function readBranch(path: string): Promise<HEntry[]> {
  return branchOf(parsePi(await readFile(path, "utf8")).entries);
}

/** The active branch as far as the file's last `maxBytes` show it (the first, cut line dropped): a recent
    turn's facts without reading a long file whole. */
export async function readTailBranch(path: string, maxBytes: number): Promise<HEntry[]> {
  const st = await stat(path);
  const start = Math.max(0, st.size - maxBytes);
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(st.size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return branchOf(parsePi(text).entries);
  } finally {
    await fh.close();
  }
}

// ---- Held sessions ---------------------------------------------------------------------------------

type ManagerLike = Pick<SessionManager, "getSessionId" | "getCwd" | "getLeafId" | "getBranch" | "getEntries" | "getEntry">;
/** Anything that carries a pi session manager (an AgentSession, an extension's context), or the manager. */
export type LiveOwner = Pick<AgentSession, "sessionManager"> | Pick<ExtensionContext, "sessionManager"> | ManagerLike;

/**
 * TEMPORARY (M2 to M5): a held pi session's history, read live (each call asks pi again). Counted as a
 * reach by the boundary's reader ratchet; the driving session (M5) replaces it.
 */
export function liveRead(owner: LiveOwner): SessionRead {
  const sm: ManagerLike = "sessionManager" in owner ? owner.sessionManager : owner;
  return {
    get id() {
      return sm.getSessionId();
    },
    get cwd() {
      return sm.getCwd();
    },
    leafId: () => sm.getLeafId() ?? null,
    branch: () => historyOf(sm.getBranch()),
    entries: () => historyOf(sm.getEntries()),
    entry: (id: EntryId) => toHEntry(sm.getEntry(id)) ?? undefined,
  };
}

// ---- Line scanners ---------------------------------------------------------------------------------
// For readers that look at a few lines of a long file, or keep a compact copy of it: pi's JSON spellings
// live here, nowhere else.

/** pi writes type, id and parentId first, so most lines need nothing more and are never JSON-parsed. */
const HEAD = /^\{"type":"([^"]+)","id":"([^"]+)","parentId":(?:null|"([^"]*)")/;

/** A line's place in the tree from its first bytes, or null when the line doesn't start the way pi writes. */
export function lineHead(line: string): { type: string; id: string; parentId: string | null } | null {
  const m = HEAD.exec(line);
  return m ? { type: m[1]!, id: m[2]!, parentId: m[3] ?? null } : null;
}

export type LineProbe = "header" | "user" | "assistant" | "toolResult" | { state: string } | { note: string } | { tool: string };

function needleOf(what: LineProbe): string {
  if (what === "header") return '"type":"session"';
  if (typeof what === "string") return `"role":"${what}"`;
  if ("tool" in what) return `"toolName":${JSON.stringify(what.tool)}`;
  return `"customType":${JSON.stringify("state" in what ? what.state : what.note)}`;
}

/** Whether a raw line may hold such an entry (a substring test: true can be wrong, false never is, for a
    line pi wrote). */
export function lineMay(line: string, what: LineProbe): boolean {
  return line.includes(needleOf(what));
}

/** lineMay's test as bytes, for a search over a file's raw chunks: a file whose bytes lack it holds no such entry. */
export const lineNeedle = (what: LineProbe): Buffer => Buffer.from(needleOf(what));

/** One raw line as an HEntry, or null for a blank, malformed or header line. */
export function lineEntry(line: string | Buffer): HEntry | null {
  const text = typeof line === "string" ? line : line.toString("utf8");
  if (!text.trim()) return null;
  try {
    return toHEntry(JSON.parse(text));
  } catch {
    return null;
  }
}

/** A file's first line as its header, or null. */
export function lineHeader(line: string | Buffer): HHeader | null {
  try {
    return headerOf(JSON.parse(typeof line === "string" ? line : line.toString("utf8")));
  } catch {
    return null;
  }
}

const CHUNK = 64 * 1024;

/** Reads [from, size) of a file and hands each complete, non-blank line to `onLine`; returns where the
    last complete line ends (a torn last line is left for the next read, which starts at its first byte). */
export async function appendLines(path: string, from: number, size: number, onLine: (line: string) => void): Promise<number> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    let pos = from;
    let carry = Buffer.alloc(0);
    let consumed = from;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let start = 0;
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        const line = data.toString("utf8", start, nl);
        if (line.trim() !== "") onLine(line);
        start = nl + 1;
      }
      consumed += start;
      carry = Buffer.from(data.subarray(start));
    }
    return consumed;
  } finally {
    await fh.close();
  }
}

/** Whether `offset` is still a line start in the file (the byte before it is a newline). */
export async function atLineStart(path: string, offset: number): Promise<boolean> {
  if (offset === 0) return true;
  const fh = await open(path, "r");
  try {
    const b = Buffer.alloc(1);
    const { bytesRead } = await fh.read(b, 0, 1, offset - 1);
    return bytesRead === 1 && b[0] === 10;
  } finally {
    await fh.close();
  }
}

/** What an incremental scan keeps of one line: its place in the tree, plus whatever the reader wants. */
export interface ScanItem {
  type?: string;
  id?: string;
  parentId?: string | null;
}

/**
 * A file read incrementally into compact items (`keep` turns a line into one, or null to skip it): each
 * `grow` parses only the complete lines appended since the last, and starts over when the file shrank or
 * the last read no longer ends at a line start. `branch()` is activeBranch's rule over the items.
 */
export class BranchScan<T extends ScanItem> {
  size = 0;
  items: T[] = [];
  constructor(private readonly keep: (line: string) => T | null) {}

  async grow(path: string, size: number): Promise<void> {
    if (!(size >= this.size && (await atLineStart(path, this.size)))) {
      this.size = 0;
      this.items = [];
    }
    if (this.size === size) return;
    this.size = await appendLines(path, this.size, size, (line) => {
      const it = this.keep(line);
      if (it) this.items.push(it);
    });
  }

  branch(): T[] {
    return activeBranch(this.items as Entry[]) as T[];
  }

  leafId(): string | null {
    const b = this.branch();
    return b.length ? (b[b.length - 1]!.id ?? null) : null;
  }
}

// ---- Display text ----------------------------------------------------------------------------------

/** `text` as the user typed it: for a user entry, without pi 0.87's image dimension notes (shared/image-note.ts);
    any other entry's text unchanged. */
export function typedText(text: string, h: HEntry): string {
  return h.kind === "user" ? stripImageNotes(text, h.blocks) : text;
}

const blocksOfEntry = (h: HEntry): HBlock[] => ("blocks" in h ? h.blocks : []);

/** The first text block's text (as typed, for a user entry), or undefined. */
export function firstText(h: HEntry): string | undefined {
  for (const b of blocksOfEntry(h)) if (b.type === "text" && typeof b.text === "string") return typedText(b.text, h);
  return undefined;
}

/** Whether the entry's content was stored as a bare string (legacy files, which pi's migration keeps so), not
    as blocks: a reader that has always read only block arrays (a session's title) reads no text there. */
export function storedAsString(h: HEntry): boolean {
  return "blocks" in h && fromString.has(h.blocks);
}

/** The text blocks joined by `sep` (default "\n"); an image block is "[image]" unless `images` is false.
    Image notes are not stripped: pass the result to `typedText` for that. */
export function joinedText(h: HEntry, opts: { sep?: string; images?: boolean } = {}): string {
  const parts: string[] = [];
  for (const b of blocksOfEntry(h)) {
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image" && opts.images !== false) parts.push("[image]");
  }
  return parts.join(opts.sep ?? "\n");
}

// ---- Unknown entries (§app.harness/unknown-entries) ------------------------------------------------

const PER_TYPE = 10_000;
const MAX_TYPES = 1_000;
const unknownIds = new Map<string, Set<string | null>>();

/** An unknown entry's name for the count and the log: its type, `message/<role>` for an unknown role, null
    when it has no type. */
export function unknownTypeOf(raw: unknown): string | null {
  const e = raw as Entry;
  if (!e || typeof e !== "object" || typeof e.type !== "string") return null;
  return e.type === "message" ? `message/${isObj(e.message) ? String(e.message.role) : "-"}` : e.type;
}

/** One unknown entry seen: counted once per (type, id), each type's ids capped; a type's first sighting
    logs its name once (never content). */
export function noteUnknown(type: string | null, id: EntryId | null): void {
  const key = type ?? "";
  let ids = unknownIds.get(key);
  if (!ids) {
    if (unknownIds.size >= MAX_TYPES) return;
    unknownIds.set(key, (ids = new Set()));
    logUnknownType(key);
  }
  if (ids.size < PER_TYPE) ids.add(id);
}

/** Distinct unknown entries seen since the process started (GET /api/health). */
export function unknownEntries(): number {
  let n = 0;
  for (const ids of unknownIds.values()) n += ids.size;
  return n;
}

/** For tests: forget every unknown entry seen. */
export function resetUnknownEntries(): void {
  unknownIds.clear();
}

let piVersion: Promise<string> | undefined;
function logUnknownType(type: string): void {
  const name = JSON.stringify(type.replace(/[^\w./:-]/g, "?").slice(0, 64));
  piVersion ??= import("@earendil-works/pi-coding-agent").then((pi) => String(pi.VERSION), () => "?");
  void piVersion.then((v) => console.warn(`[harness] unknown pi entry type ${name} (pi ${v})`));
}
