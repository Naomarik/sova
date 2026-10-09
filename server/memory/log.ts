// The memory log (§chat.memory/log): a chat's active branch as numbered messages, derived again from the
// neutral history whenever it is needed, never kept as a second append-only log. Pure.
import type { HBlock, HEntry } from "../../shared/harness";
import type { MemoryMessageKind } from "../../shared/protocol";

/** A tool's output is clipped to its head and tail, this many characters in all. */
export const TOOL_CLIP = 30_000;
/** A longer text is logged as several messages in a row, never cut. */
export const PAGE = 16_000;

export interface LogMessage {
  /** The message's number in the log: its place on the branch. */
  i: number;
  kind: MemoryMessageKind;
  text: string;
  /** UTF-8 bytes of `text`. */
  size: number;
  /** Where it came from: the entry's id and the message's part of it ("<entry id>:<part>"); a leaf
      records it, so a stored summary is known to still match the branch. */
  src: string;
  entryId: string | null;
  /** The entry's ISO time. */
  at?: string;
  page?: { index: number; of: number };
}

const bytes = (s: string): number => Buffer.byteLength(s);

function clipTool(text: string): string {
  if (text.length <= TOOL_CLIP) return text;
  const half = TOOL_CLIP / 2;
  return `${text.slice(0, half)}\n… [${text.length - TOOL_CLIP} characters clipped] …\n${text.slice(-half)}`;
}

function blocksText(blocks: readonly HBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push(b.text);
    else if (b.type === "image") out.push("[image]");
  }
  return out.join("\n");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return blocksText(content.filter((b): b is HBlock => !!b && typeof b === "object" && typeof (b as { type?: unknown }).type === "string"));
  return "";
}

function json(v: unknown): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "{}";
  }
}

/** What one entry contributes to the log, in order, before paging: kind and text. */
export function entryMessages(h: HEntry): { kind: MemoryMessageKind; text: string }[] {
  switch (h.kind) {
    case "user": {
      const text = blocksText(h.blocks);
      return text.trim() ? [{ kind: "user", text }] : [];
    }
    case "assistant": {
      const out: { kind: MemoryMessageKind; text: string }[] = [];
      // Thoughts are never logged (Taelin §1): only the reply's words and its tool calls.
      const text = h.blocks.filter((b): b is Extract<HBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n");
      if (text.trim()) out.push({ kind: "sova", text });
      for (const b of h.blocks) if (b.type === "toolCall") out.push({ kind: "tool", text: `${b.name} ${json(b.arguments)}` });
      return out;
    }
    case "tool-result":
      return [{ kind: "echo", text: clipTool(`${h.tool ?? "tool"}${h.isError ? " (failed)" : ""}: ${blocksText(h.blocks)}`) }];
    case "shell":
      return [{ kind: "echo", text: clipTool(`user ran: $ ${h.command ?? ""}\n${h.output ?? ""}`) }];
    case "note": {
      // A message an extension shows in the transcript (a worker's report, a topic delivery) is logged;
      // a hidden note (mode notes, alignment state, nudges) is per-turn state, never memory.
      if (!h.display) return [];
      const text = contentText(h.content);
      return text.trim() ? [{ kind: "work", text }] : [];
    }
    case "summary":
      return h.of === "branch" && h.summary?.trim() ? [{ kind: "note", text: h.summary }] : [];
    default:
      return [];
  }
}

/** The log of a branch (root first): every message, numbered, long texts paged. */
export function messagesOf(branch: readonly HEntry[]): LogMessage[] {
  const out: LogMessage[] = [];
  branch.forEach((h, at) => {
    const parts = entryMessages(h);
    let part = 0;
    const id = h.id ?? `@${at}`;
    for (const m of parts) {
      const pages = m.text.length <= PAGE ? [m.text] : Array.from({ length: Math.ceil(m.text.length / PAGE) }, (_, k) => m.text.slice(k * PAGE, (k + 1) * PAGE));
      pages.forEach((text, k) => {
        out.push({
          i: out.length,
          kind: m.kind,
          text,
          size: bytes(text),
          src: `${id}:${part++}`,
          entryId: h.id,
          ...(h.at ? { at: h.at } : {}),
          ...(pages.length > 1 ? { page: { index: k + 1, of: pages.length } } : {}),
        });
      });
    }
  });
  return out;
}

/**
 * Where a run's input starts on a branch: just after its last reply (an assistant message or a tool
 * result). The messages from there on are the turn itself (the message that started it, steers, a
 * worker's report), sent whole after the view; everything before is the view's.
 */
export function inputStart(branch: readonly HEntry[]): number {
  for (let k = branch.length - 1; k >= 0; k--) {
    const kind = branch[k]!.kind;
    if (kind === "assistant" || kind === "tool-result") return k + 1;
  }
  return 0;
}

/** The number of log messages that come from `branch[0..end)`. */
export function messagesBefore(branch: readonly HEntry[], end: number): number {
  let n = 0;
  for (let k = 0; k < end && k < branch.length; k++) {
    for (const m of entryMessages(branch[k]!)) n += m.text.length <= PAGE ? 1 : Math.ceil(m.text.length / PAGE);
  }
  return n;
}
