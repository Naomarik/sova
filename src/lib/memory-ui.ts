// The memory minor mode's words, as the web shows them (§chat.mode-menu/memory-panel,
// §chat.composer/memory-status, §app.subagents-pane/memory-outline). Pure, so each string is tested
// against the state it must not be said in.

import type { ChatMemoryChoice, MemoryLine, MemoryMessageKind, MemoryOutline, MemoryStatus, MemoryType, MemoryTypeInfo } from "../../shared/protocol";
import { MEMORY_SIZES, MEMORY_TYPE_INFO, memoryTypeInfo } from "../../shared/memory";

/** The types as the server listed them, else the shared copy (an older or unreachable server). */
export const typesOf = (listed: readonly MemoryTypeInfo[] | undefined): MemoryTypeInfo[] => (listed?.length ? [...listed] : [...MEMORY_TYPE_INFO]);

/** One type's copy, from the listed ones first. */
export const typeInfo = (listed: readonly MemoryTypeInfo[] | undefined, type: MemoryType): MemoryTypeInfo =>
  listed?.find((t) => t.id === type) ?? memoryTypeInfo(type);

/** A whole number of KB as a person reads it: no trailing ".0". */
const kb = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}`;

/**
 * A size as the panel reads it. UniiChat's view grows to the size and merges down to half of it,
 * so it reads as the range it keeps ("64–128 KB"); zoomable compaction's is the size the compacted
 * lines get ("32 KB").
 */
export function sizeLabel(type: MemoryType, size: number): string {
  return type === "uniichat" ? `${kb(size / 2)}–${kb(size)} KB` : `${kb(size)} KB`;
}

/** The sizes the panel offers: the suggested ones, plus the chat's own when it isn't one of them. */
export function sizeChoices(sizes: readonly number[] | undefined, current: number | undefined): number[] {
  const list = sizes?.length ? [...sizes] : [...MEMORY_SIZES];
  if (current !== undefined && !list.includes(current)) list.push(current);
  return list.sort((a, b) => a - b);
}

/** "120 of 480 messages" with digits; one total reads "1 message". */
const ofMessages = (done: number, total: number) => `${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${total === 1 ? "message" : "messages"}`;

export const UPDATING_WORDS = "Updating memory…";

/** The turn's rare-state words while it waits for the newest summaries; null in any other state. */
export function memoryTurnWords(status: MemoryStatus | null): string | null {
  return status?.state === "updating" ? UPDATING_WORDS : null;
}

/**
 * The run-status row's memory piece: a problem first (it says why nothing advances), then
 * preparing's count. Ready, updating (the turn's own words say it) and off show nothing.
 */
export function memoryRowWords(status: MemoryStatus | null): { text: string; problem: boolean } | null {
  if (!status || status.state === "off") return null;
  // The problem's own sentence, named as memory's unless it already says so.
  if (status.problem) return { text: /^memory\b/i.test(status.problem) ? status.problem : `Memory: ${status.problem}`, problem: true };
  if (status.state === "preparing") return { text: `Preparing memory: ${ofMessages(status.done, status.total)}`, problem: false };
  return null;
}

/** A line's messages: "40–47", or "12" for one. */
export const lineRange = (line: Pick<MemoryLine, "id" | "n">): string => (line.n === 1 ? `${line.id}` : `${line.id}–${line.id + line.n - 1}`);

/** The open button's name. */
export const openLineLabel = (line: Pick<MemoryLine, "id" | "n">): string => (line.n === 1 ? `Open message ${line.id}` : `Open messages ${lineRange(line)}`);

export const KIND_LABEL: Record<MemoryMessageKind, string> = {
  user: "You",
  sova: "Sova",
  tool: "Tool call",
  echo: "Tool result",
  work: "Worker",
  note: "Note",
};

/** A byte count in KB, as the outline's heading reads it. */
export function kbOf(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  const k = bytes / 1024;
  return k < 1 ? "under 1 KB" : k < 10 ? `${k.toFixed(1).replace(/\.0$/, "")} KB` : `${Math.round(k)} KB`;
}

/** Whether the Session tab shows a Memory section: on, or off with lines kept from when it was on. */
export const outlineShown = (o: MemoryOutline | null | undefined): boolean => !!o && (o.on || o.lines.length > 0);

/** The section's heading after "Memory": "UniiChat · 312 lines · 96 KB of 128 KB". */
export function outlineHeading(o: MemoryOutline, types?: readonly MemoryTypeInfo[]): string {
  const name = typeInfo(types, o.type).label;
  const lines = `${o.lines.length.toLocaleString("en-US")} ${o.lines.length === 1 ? "line" : "lines"}`;
  return [o.on ? name : `${name}, off`, lines, `${kbOf(o.bytes)} of ${o.size} KB`].join(" · ");
}

/** The sentence over the lines, or null when the lines speak for themselves. */
export function outlineNote(o: MemoryOutline): string | null {
  if (!o.on) return "Memory is off, so the model sees the whole chat. These lines are kept for when it's back on.";
  if (o.status.state === "preparing")
    return `Preparing memory: ${ofMessages(o.status.done, o.status.total)}. Until it's ready the model sees the chat as usual.`;
  if (o.lines.length > 0) return null;
  if (o.messages === 0) return "No messages yet.";
  if (o.type === "zoomable")
    return `${o.messages.toLocaleString("en-US")} ${o.messages === 1 ? "message" : "messages"} summarized so far. Nothing has compacted yet, so the model sees the chat as usual.`;
  return "No lines yet.";
}

/** The mode row's description and detail line for a chat's choice (the detail only while on). */
export function memoryRowText(types: readonly MemoryTypeInfo[] | undefined, choice: ChatMemoryChoice | undefined, on: boolean): { description: string; detail: string | null } {
  const t = typeInfo(types, choice?.type ?? "uniichat");
  return { description: t.rowDescription, detail: on ? t.detail : null };
}

/** Whether a chat's memory choice is the saved default; unknown on either side is not. */
export const sameMemoryChoice = (a: ChatMemoryChoice | null | undefined, b: ChatMemoryChoice | null | undefined): boolean =>
  !!a && !!b && a.type === b.type && a.size === b.size;
