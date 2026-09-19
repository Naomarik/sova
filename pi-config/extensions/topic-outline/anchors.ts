/**
 * Anchor helpers: map session entries to fullscreen transcript rows.
 *
 * Pi's fullscreen transcript prefixes user messages and tool-call-free assistant
 * messages with an OSC 133 prompt marker (\x1b]133;A\x07). Markers appear in
 * buildContextEntries() order, so the k-th marked message renders at the k-th
 * marker row. Anchors store entryId + role + fingerprint; the marker ordinal is
 * recomputed lazily at jump time because compaction rewrites entry ids and drops
 * transcript rows.
 *
 * Rows are markdown-rendered and wrapped, so fingerprints are compared as
 * case-folded letter/number runs only (see fingerprintKey), joined across rows.
 */

export const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;

/** Letters/numbers kept in a fingerprint; short enough to survive markdown quirks. */
export const FINGERPRINT_LENGTH = 32;

/** Rows scanned after a marker when it's the last one (bounded for huge messages). */
const MAX_SEGMENT_ROWS = 400;

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
}

interface MessageLike {
  role?: string;
  content?: ContentBlock[] | string | null;
  stopReason?: string;
}

/** Mirrors pi's parseSkillBlock (core/agent-session.js): only the trailing user text renders as a user message. */
const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/**
 * Text pi renders inside the marked component, mirroring interactive-mode's
 * getUserMessageText (text blocks joined with "") and AssistantMessageComponent.
 */
export function visibleTextOf(message: MessageLike): string {
  if (message.role === "user") {
    const text = typeof message.content === "string" ? message.content
      : Array.isArray(message.content)
        ? message.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text as string).join("")
        : "";
    const skill = SKILL_BLOCK.exec(text);
    return skill ? (skill[4]?.trim() ?? "") : text;
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    return message.content
      .filter(block => block?.type === "text" && typeof block.text === "string" && block.text.trim())
      .map(block => (block.text as string).trim())
      .join("\n");
  }
  return "";
}

/** Does this message get an OSC 133 marker in the transcript? Mirrors pi's components. */
export function isMarkedMessage(message: MessageLike): boolean {
  if (message.role === "user") return visibleTextOf(message).trim().length > 0;
  if (message.role === "assistant") {
    if (!Array.isArray(message.content)) return false;
    const blocks = message.content;
    if (blocks.some(block => block?.type === "toolCall")) return false;
    // Truncated/aborted/errored replies render a notice line even with no content.
    if (message.stopReason === "length" || message.stopReason === "aborted" || message.stopReason === "error") return true;
    return blocks.some(block =>
      (block?.type === "text" && (block.text ?? "").trim()) ||
      (block?.type === "thinking" && (block.thinking ?? "").trim()));
  }
  return false;
}

/** Visible text of a message (user text or assistant final text; never thinking). */
export function textOf(message: MessageLike): string {
  if (typeof message.content === "string") return message.role === "user" ? message.content : "";
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text as string)
    .join("\n");
}

/**
 * Comparison form shared by stored fingerprints and rendered rows: markdown link
 * targets dropped (pi renders only the label), then case-folded letters/numbers
 * only, so heading markers, emphasis, bullets, wrapping, and emoji don't matter.
 */
export function fingerprintKey(value: string): string {
  return value
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Stable short fingerprint for verifying a transcript row. */
export function fingerprintOf(message: MessageLike): string {
  return fingerprintKey(visibleTextOf(message)).slice(0, FINGERPRINT_LENGTH);
}

/** Shortest prefix accepted when one fingerprint was cut shorter (older raw-text form). */
const MIN_PREFIX_MATCH = 12;

/** Do two fingerprints (current or older raw-text form, cut at 48 raw chars) name the same message? */
export function sameFingerprint(a: string, b: string): boolean {
  const left = fingerprintKey(a).slice(0, FINGERPRINT_LENGTH);
  const right = fingerprintKey(b).slice(0, FINGERPRINT_LENGTH);
  if (!left || !right) return false;
  if (left === right) return true;
  const [short, long] = left.length < right.length ? [left, right] : [right, left];
  return short.length >= MIN_PREFIX_MATCH && long.startsWith(short);
}

export function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Strip ANSI/OSC/APC sequences from a rendered transcript line before matching. */
export function stripAnsi(value: string): string {
  return value
    // OSC (incl. OSC 8 hyperlinks, which pi terminates with ESC \ rather than BEL).
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x1b]*\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export interface AnchorRow {
  /** Index into markerRows. */
  ordinal: number;
  fingerprint: string;
}

/**
 * Assign marker ordinals to entries of the current context view.
 * Calls the entry iterator in buildContextEntries() order; yields only marked messages.
 */
export function markerOrdinalIndex<T extends { id: string; type: string; message?: MessageLike }>(
  entries: T[],
): Map<string, AnchorRow> {
  const result = new Map<string, AnchorRow>();
  let ordinal = 0;
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    if (!isMarkedMessage(entry.message)) continue;
    result.set(entry.id, { ordinal, fingerprint: fingerprintOf(entry.message) });
    ordinal++;
  }
  return result;
}

/** Row indices of OSC 133 prompt starts in rendered lines. */
export function markerRows(lines: string[]): number[] {
  const rows: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (OSC133_PROMPT_START.test(lines[i])) rows.push(i);
  }
  return rows;
}

/** Does the fingerprint appear in the rows of the message starting at markerRow (up to the next marker)? */
export function verifyRow(lines: string[], markerRow: number, fingerprint: string, end?: number): boolean {
  const key = fingerprintKey(fingerprint).slice(0, FINGERPRINT_LENGTH);
  if (!key) return true;
  const stop = Math.min(lines.length, end ?? lines.length, markerRow + MAX_SEGMENT_ROWS);
  let text = "";
  for (let i = markerRow; i < stop; i++) text += fingerprintKey(stripAnsi(lines[i]));
  return text.includes(key);
}

export interface MarkerLocation {
  row?: number;
  /** Rendered text confirmed the row (false: ordinal trusted on a matching marker count). */
  fingerprintMatched: boolean;
  markers: number;
}

/**
 * Locate a marker row: the expected ordinal if its text matches, else the matching
 * marker nearest that ordinal. When nothing matches (e.g. an extension markdown
 * transformer rewrote the text) the ordinal is trusted only if the transcript has
 * exactly the expected number of markers (+1 for a reply still streaming).
 */
export function locateMarker(lines: string[], ordinal: number, fingerprint: string, expectedMarkers?: number): MarkerLocation {
  const rows = markerRows(lines);
  const markers = rows.length;
  const segmentEnd = (index: number) => rows[index + 1] ?? lines.length;
  const direct = rows[ordinal];
  if (direct !== undefined && verifyRow(lines, direct, fingerprint, segmentEnd(ordinal))) {
    return { row: direct, fingerprintMatched: true, markers };
  }
  let best: number | undefined;
  if (fingerprintKey(fingerprint)) {
    for (let index = 0; index < rows.length; index++) {
      if (index === ordinal || !verifyRow(lines, rows[index], fingerprint, segmentEnd(index))) continue;
      if (best === undefined || Math.abs(index - ordinal) < Math.abs(best - ordinal)) best = index;
    }
  }
  if (best !== undefined) return { row: rows[best], fingerprintMatched: true, markers };
  if (direct !== undefined && expectedMarkers !== undefined && (markers === expectedMarkers || markers === expectedMarkers + 1)) {
    return { row: direct, fingerprintMatched: false, markers };
  }
  return { fingerprintMatched: false, markers };
}

/** Row-only convenience wrapper around locateMarker. */
export function locateMarkerRow(lines: string[], ordinal: number, fingerprint: string, expectedMarkers?: number): number | undefined {
  return locateMarker(lines, ordinal, fingerprint, expectedMarkers).row;
}
