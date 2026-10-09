// The memory minor mode's shared vocabulary (§chat/memory): its two types as the menu shows them, the
// sizes, the recall tools' names and the line a recall's slim row folds to. Imports nothing at runtime,
// so the server, the web app and tests read one copy.
import type { ChatMemoryChoice, MemoryType, MemoryTypeInfo } from "./protocol";

/** The recall tools (§chat.memory/recall): open a line, and a message's date. */
export const MEMORY_ZOOM_TOOL = "zoom";
export const MEMORY_DATE_TOOL = "date";
export const MEMORY_TOOLS: readonly string[] = [MEMORY_ZOOM_TOOL, MEMORY_DATE_TOOL];

export const MEMORY_TYPES: readonly MemoryType[] = ["uniichat", "zoomable"];

export const MEMORY_TYPE_INFO: readonly MemoryTypeInfo[] = [
  {
    id: "uniichat",
    label: "UniiChat",
    by: "by Victor Taelin",
    description: "One chat that never ends: every message kept, summarized into lines the model can open",
    rowDescription: "Endless chat: the model works from a summary of the whole chat and opens any part of it word for word",
    detail: "UniiChat — by Victor Taelin",
    link: "https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449",
    defaultSize: 128,
  },
  {
    id: "zoomable",
    label: "Zoomable compaction",
    by: "Sova",
    description: "The chat stays as it is; when it would compact, older turns become summary lines the model can open instead of a one-off summary",
    rowDescription: "Compaction the model can undo: when the chat compacts, older turns become summary lines it can open word for word",
    detail: "Zoomable compaction — Sova",
    defaultSize: 32,
  },
];

/** The Memory type panel's suggested view sizes, in KB (the view merges from the size down to half of it). */
export const MEMORY_SIZES: readonly number[] = [16, 32, 64, 128, 256];

export const isMemoryType = (v: unknown): v is MemoryType => typeof v === "string" && (MEMORY_TYPES as readonly string[]).includes(v);

export function memoryTypeInfo(type: MemoryType): MemoryTypeInfo {
  return MEMORY_TYPE_INFO.find((t) => t.id === type) ?? MEMORY_TYPE_INFO[0]!;
}

/** What a chat with no choice of its own uses (before Save as default wrote one). */
export const BUILTIN_MEMORY_CHOICE: ChatMemoryChoice = { type: "uniichat", size: 128 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPow2 = (n: number) => Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0;

/**
 * The folded line of a recall's slim row (§chat.memory/recall): "Recalled messages 40–47" for
 * zoom(40, 8), "Recalled message 40" for zoom(40, 1), "Date of message 40" for date(40). undefined for
 * any other tool, or arguments the tool would refuse.
 */
export function recallSummary(name: string | undefined, args: unknown): string | undefined {
  if (!isObj(args)) return undefined;
  const id = args.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) return undefined;
  if (name === MEMORY_DATE_TOOL) return `Date of message ${id}`;
  if (name !== MEMORY_ZOOM_TOOL) return undefined;
  const n = args.n;
  if (typeof n !== "number" || !isPow2(n)) return undefined;
  return n === 1 ? `Recalled message ${id}` : `Recalled messages ${id}–${id + n - 1}`;
}
