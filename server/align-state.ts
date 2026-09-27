import { open } from "node:fs/promises";
import type { SessionAlign } from "../shared/protocol";
import { foldAlignments, openDocsOf, openQuestionsOf, type AlignDocument } from "../pi-config/extensions/mode/align.ts";
import { activeBranch, parseLines } from "./transcript";

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

/** The bytes every `align` tool result carries (JSON.stringify writes no space after the colon). */
const MARKER = Buffer.from('"toolName":"align"');
const CHUNK = 256 * 1024;

/**
 * How far a file's align read got, kept with its cached summary: whether the file holds an `align`
 * tool result at all, and where the marker search stopped. Files without one are never parsed.
 */
export interface AlignScan {
  /** The file size the search reached. */
  size: number;
  /** A marker was seen somewhere before `size`. */
  found: boolean;
  /** The fold's answer at `size` (only computed once `found`). */
  summary: SessionAlign | undefined;
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
      if (pos + bytesRead >= size) return false;
      pos += bytesRead - MARKER.length;
    }
    return false;
  } finally {
    await fh.close();
  }
}

/**
 * A session file's open alignments for the list. The marker search is incremental while the file
 * only grows (`prev` covers its first `prev.size` bytes); once a marker is known, the whole file is
 * read and its active branch folded, only when the caller's (mtime, size) cache says it changed.
 * A file that shrank is searched again from the start. Never throws: an unreadable file has none.
 */
export async function readAlignScan(path: string, size: number, prev: AlignScan | null): Promise<AlignScan> {
  try {
    const grown = prev !== null && size >= prev.size;
    const found = (grown && prev.found) || (await hasMarker(path, grown ? prev.size : 0, size));
    if (!found) return { size, found: false, summary: undefined };
    const fh = await open(path, "r");
    let text: string;
    try {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, 0);
      text = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
    return { size, found: true, summary: sessionAlignOf(foldAlignments(activeBranch(parseLines(text))).docs) };
  } catch {
    return { size, found: false, summary: undefined };
  }
}
