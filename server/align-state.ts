import { open } from "node:fs/promises";
import type { SessionAlign } from "../shared/protocol";
import { alignResultOf, foldAlignments, openDocsOf, openQuestionsOf, type AlignDocument } from "../pi-config/extensions/mode/align.ts";
import { restoreActive } from "../pi-config/extensions/mode/state.ts";
import { isLinkMessage } from "../shared/link-message";
import { parseWakeNudge } from "../shared/wake";
import { activeBranch, type Entry } from "./transcript";

/**
 * The session list's side of alignments (§chat.alignment/session-mark): the mode extension's
 * `align` tool results, folded with the extension's own function (pi-config/extensions/mode/align.ts,
 * node builtins only), so the list, the transcript row (server/transcript.ts) and the TUI read one
 * shape.
 */

/** SessionSummary.align from a branch's documents, or undefined when none is open. */
export function sessionAlignOf(docs: readonly AlignDocument[]): SessionAlign | undefined {
  const open = openDocsOf(docs);
  if (open.length === 0) return undefined;
  const asking = open.filter((doc) => openQuestionsOf(doc).length > 0);
  const lead = asking[asking.length - 1];
  return {
    openDocs: open.length,
    openQuestions: asking.reduce((n, doc) => n + openQuestionsOf(doc).length, 0),
    questionDocs: asking.length,
    ...(lead ? { lead: { id: lead.id, title: lead.title } } : {}),
  };
}

/** A branch's open alignments (not done or dropped), each with its open and live (not dropped)
    question counts, in fold order: what `sova_session` prints (§app.overseer/session-truth).
    `entries` are raw session entries, root first. */
export function openAlignmentsOf(entries: readonly unknown[]): { id: string; title: string; open: number; total: number }[] {
  return openDocsOf(foldAlignments(entries).docs).map((doc) => ({
    id: doc.id,
    title: doc.title,
    open: openQuestionsOf(doc).length,
    total: doc.questions.filter((q) => !q.dropped).length,
  }));
}

/** The bytes every `align` tool result carries (JSON.stringify writes no space after the colon). */
const MARKER = Buffer.from('"toolName":"align"');
const CHUNK = 256 * 1024;

/**
 * One session entry, kept only as far as the list needs it: its tree position, and the payloads the
 * fold and the "waiting" rule read (an align result's details, an align-doc or mode entry's data,
 * whether it is the user's own prompt). Everything else is its type and ids.
 */
interface ScanEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  customType?: string;
  data?: unknown;
  message?: { role: "toolResult"; toolName: "align"; isError?: boolean; details?: unknown };
  /** A user prompt the user typed (not a wake nudge or a partner's link message). */
  userPrompt?: true;
}

/**
 * How far a file's align read got, kept with its cached summary. Files without an `align` result are
 * only searched for the marker, never parsed. Once one is seen, every entry is kept compact and each
 * later read parses only the lines appended since.
 */
export interface AlignScan {
  /** Bytes read: the marker search's reach, or (once found) the end of the last complete line. */
  size: number;
  /** A marker was seen somewhere before `size`. */
  found: boolean;
  /** The fold's answer at `size` (only computed once `found`). */
  summary: SessionAlign | undefined;
  /** Once found: the file's entries so far, compact. */
  entries?: ScanEntry[];
}

/** Whether [from, size) of the file contains the marker, reading raw bytes (no JSON parse). */
async function hasMarker(path: string, from: number, size: number): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    // Overlap each chunk by the marker's length so a marker split across two reads is still seen.
    let pos = Math.max(0, from - MARKER.length);
    const buf = Buffer.alloc(CHUNK + MARKER.length);
    while (pos < size) {
      const len = Math.min(buf.length, size - pos);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead <= 0) return false;
      if (buf.subarray(0, bytesRead).includes(MARKER)) return true;
      // The end, or a file that shrank since its size was read: a short read would make no
      // progress (it returns only the overlap), and the loop would never end.
      if (pos + bytesRead >= size || bytesRead < len) return false;
      pos += bytesRead - MARKER.length;
    }
    return false;
  } finally {
    await fh.close();
  }
}

/** pi writes type, id and parentId first; most lines need nothing more, so most are never JSON-parsed. */
const HEAD = /^\{"type":"([^"]+)","id":"([^"]+)","parentId":(?:null|"([^"]*)")/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A line as a ScanEntry, or null for a blank or malformed one. */
function compactLine(line: string): ScanEntry | null {
  const head = HEAD.exec(line);
  const wanted =
    line.includes('"toolName":"align"') ||
    line.includes('"customType":"align-doc"') ||
    line.includes('"customType":"mode"') ||
    line.includes('"message":{"role":"user"');
  if (head && !wanted) return { type: head[1]!, id: head[2]!, parentId: head[3] ?? null };
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(v) || typeof v.type !== "string") return null;
  const e: ScanEntry = { type: v.type };
  if (typeof v.id === "string") e.id = v.id;
  if (typeof v.parentId === "string" || v.parentId === null) e.parentId = v.parentId as string | null;
  if (v.type === "custom" && (v.customType === "align-doc" || v.customType === "mode")) {
    e.customType = v.customType;
    e.data = v.data;
  }
  const m = v.message;
  if (v.type === "message" && isRecord(m)) {
    if (m.role === "toolResult" && m.toolName === "align") e.message = { role: "toolResult", toolName: "align", isError: m.isError === true, details: m.details };
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : "")).join("\n") : "";
      if (parseWakeNudge(text) === null && !isLinkMessage(text)) e.userPrompt = true;
    }
  }
  return e;
}

/**
 * The list's answer for a branch: its open alignments, but only while the session waits on the user
 * with align on. Waiting = the newest align result that changed a document comes after the user's
 * last prompt; once the user has spoken again and the agent moved on without touching an alignment,
 * its questions stay on the card and the chip but leave Needs you, the row mark and push. Align off
 * (the newest `mode` entry on the branch says so) takes the tool away, so nothing could answer them.
 */
export function waitingAlignOf(branch: readonly ScanEntry[]): SessionAlign | undefined {
  const active = restoreActive(branch as { type: string; customType?: string; data?: unknown }[]);
  if (active && !active.minorModes.includes("align")) return undefined;
  let lastDoc = -1;
  let lastUser = -1;
  branch.forEach((e, i) => {
    if (e.userPrompt) lastUser = i;
    else if (alignResultOf(e)?.doc) lastDoc = i;
  });
  if (lastDoc < lastUser) return undefined;
  return sessionAlignOf(foldAlignments(branch).docs);
}

/** Reads [from, size) of the file and appends its complete lines to `into`; returns where they end. */
async function appendLines(path: string, from: number, size: number, into: ScanEntry[]): Promise<number> {
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
        if (line.trim() !== "") {
          const e = compactLine(line);
          if (e) into.push(e);
        }
        start = nl + 1;
      }
      consumed += start;
      carry = Buffer.from(data.subarray(start));
    }
    // A trailing partial line is left for the next read, which starts at its first byte.
    return consumed;
  } finally {
    await fh.close();
  }
}

/** Whether `offset` is still a line start in the file (the byte before it is a newline). */
async function atLineStart(path: string, offset: number): Promise<boolean> {
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

/**
 * A session file's alignments for the list, read incrementally. Until an `align` result appears the
 * file is only searched for the marker, resuming where the last search stopped. From then on its
 * entries are kept compact and only the complete lines appended since the last read are parsed; the
 * active branch is walked over the compact list. A file that shrank, or was rewritten so the last
 * read no longer ends at a line start, is read again from the beginning. Never throws: an
 * unreadable file has none.
 */
export async function readAlignScan(path: string, size: number, prev: AlignScan | null): Promise<AlignScan> {
  try {
    const grown = prev !== null && size >= prev.size;
    if (!(grown && prev.found)) {
      const found = await hasMarker(path, grown ? prev.size : 0, size);
      if (!found) return { size, found: false, summary: undefined };
    }
    let entries: ScanEntry[];
    let from: number;
    if (grown && prev.found && prev.entries && (await atLineStart(path, prev.size))) {
      entries = prev.entries;
      from = prev.size;
    } else {
      entries = [];
      from = 0;
    }
    const end = from === size ? size : await appendLines(path, from, size, entries);
    return { size: end, found: true, summary: waitingAlignOf(activeBranch(entries as Entry[]) as ScanEntry[]), entries };
  } catch {
    return { size, found: false, summary: undefined };
  }
}
