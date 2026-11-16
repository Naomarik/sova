// The Creative Director's chat with its prompt items: what each design was told, and how the Full
// Prompt changed, in time order among its messages (shared/design.ts DesignHistoryItem, kept by the
// server). The Creative Director's own tool rows that made an item fold into it, so nothing shows
// twice. Pure: no DOM, no Solid.
import type { DesignHistoryItem } from "../../shared/design";
import type { LookbookHistoryRow } from "../../shared/lookbook-words";
import type { TranscriptItem } from "../../shared/protocol";

/** A row the page made for a history item (never one a session's socket sends): its item. */
export type LookbookItemRow = TranscriptItem & { lookbookItem: LookbookHistoryRow };
export const lookbookItemOf = (it: TranscriptItem): LookbookHistoryRow | undefined => (it as Partial<LookbookItemRow>).lookbookItem;

/** The history as transcript rows: each prompt revision knows the one before it, for what changed. */
export function historyRows(items: readonly DesignHistoryItem[]): TranscriptItem[] {
  const lastPrompt = new Map<string, string>();
  return items.map((item) => {
    const row: LookbookHistoryRow = { item };
    if (item.kind === "prompt" && item.text !== undefined) {
      const key = item.runId ?? "";
      const prev = lastPrompt.get(key);
      if (prev !== undefined) row.prev = prev;
      lastPrompt.set(key, item.text);
    }
    const out: LookbookItemRow = { id: `lookbook-${item.id}`, kind: "info", at: item.at, lookbookItem: row };
    return out;
  });
}

/** The Creative Director's tool calls the history already shows as items. */
export const foldedCalls = (items: readonly DesignHistoryItem[]): Set<string> => new Set(items.flatMap((i) => (i.toolCallId ? [i.toolCallId] : [])));

/**
 * The chat's rows with the history's among them: a call an item already shows (and its result) goes,
 * and each item stands before the first row written after it. A row with no time keeps its place.
 */
export function mergeHistory(rows: readonly TranscriptItem[], extra: readonly TranscriptItem[], folded: ReadonlySet<string>): TranscriptItem[] {
  const kept = folded.size ? rows.filter((r) => !((r.kind === "tool-call" || r.kind === "tool-result") && r.toolCallId && folded.has(r.toolCallId))) : rows.slice();
  if (!extra.length) return kept;
  const out: TranscriptItem[] = [];
  let i = 0;
  for (const r of kept) {
    if (r.at) while (i < extra.length && extra[i]!.at! <= r.at) out.push(extra[i++]!);
    out.push(r);
  }
  while (i < extra.length) out.push(extra[i++]!);
  return out;
}

/** What changed between two Full Prompts, line by line: removed lines, then added ones, in order. */
export function promptChanges(prev: string, next: string): { sign: "+" | "−"; line: string }[] {
  const a = prev.split("\n");
  const b = next.split("\n");
  // Lines shared at both ends never count as changed; the middle is compared whole.
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) (ea--, eb--);
  const am = a.slice(s, ea);
  const bm = b.slice(s, eb);
  // A longest common run of lines, when the middle is small enough to compare whole.
  if (am.length * bm.length <= 250_000) {
    const L = Array.from({ length: am.length + 1 }, () => new Uint16Array(bm.length + 1));
    for (let i = am.length - 1; i >= 0; i--) for (let j = bm.length - 1; j >= 0; j--) L[i]![j] = am[i] === bm[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    const out: { sign: "+" | "−"; line: string }[] = [];
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) (i++, j++);
      else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ sign: "−", line: am[i++]! });
      else out.push({ sign: "+", line: bm[j++]! });
    }
    while (i < am.length) out.push({ sign: "−", line: am[i++]! });
    while (j < bm.length) out.push({ sign: "+", line: bm[j++]! });
    return out.filter((c) => c.line.trim());
  }
  return [...am.map((line) => ({ sign: "−" as const, line })), ...bm.map((line) => ({ sign: "+" as const, line }))].filter((c) => c.line.trim());
}

const list = (labels: readonly string[]): string => (labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`);
const byWho = (by: DesignHistoryItem["by"]): string => (by === "user" ? "you" : by === "coordinator" ? "the Creative Director" : by === "main" ? "the main chat" : "Sova");

/** Who a message to a design came from, as its line names it. */
function sender(i: DesignHistoryItem): string {
  if (i.via === "refine") return "your Refine";
  if (i.via === "chat") return "from you";
  if (i.via === "fix" || i.by === "server") return "from Sova";
  if (i.via === "main" || i.by === "main") return "passed on by the main chat";
  if (i.by === "user") return "from you";
  return "from the Creative Director";
}

/** An item's folded line: its title, and a short preview after it. */
export function historyLine(i: DesignHistoryItem): { title: string; preview: string } {
  const first = (t?: string) => (t ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
  switch (i.kind) {
    case "prompt":
      return { title: `Full Prompt · revision ${i.rev ?? "?"} · ${i.by === "user" ? "yours" : `by ${byWho(i.by)}`}`, preview: first(i.text) };
    case "start": {
      const labels = (i.designs ?? []).map((d) => d.label);
      return { title: `Started ${list(labels)}`, preview: `Full Prompt revision ${i.rev ?? "?"}, each with its own style${(i.designs ?? []).some((d) => d.layout) ? " and layout" : ""}` };
    }
    case "message":
      return { title: `To ${i.label} · ${sender(i)}`, preview: i.via === "fix" || i.by === "server" ? "Its page didn't land; asked to fix it" : first(i.text) };
    case "new":
      return { title: `${i.label} made from ${i.parents?.length ? list(i.parents) : "the brief"}`, preview: first(i.text) };
    case "again":
      return { title: `${i.label} started again · by ${byWho(i.by)}`, preview: "" };
    case "stop":
      return { title: `Stopped ${i.label} · by ${byWho(i.by)}`, preview: "" };
    case "remove":
      return { title: `Removed ${i.label} · by ${byWho(i.by)}`, preview: "" };
    case "restore":
      return { title: `Restored ${i.label} · by ${byWho(i.by)}`, preview: "" };
  }
}
