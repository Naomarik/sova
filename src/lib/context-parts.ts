// The Context tab's arithmetic: what fills a chat's window, as lines biggest first. The parts are
// estimates (CHARS_PER_TOKEN); the total is the last reply's own usage. "Other" is what the
// estimates don't explain (total minus the parts, floored at 0); "Free" is the room left. Pure (no
// DOM, no Solid), so it tests under tsx.

import type { ContextPart } from "../../shared/protocol";
import { formatPercent, formatTokens } from "./context";

/** What the lines are worked out from: the server's read, `state: "ok"`. */
export interface ContextSizes {
  parts: readonly ContextPart[];
  /** ≈ the messages since the last compaction. */
  conversation: number;
  /** The last reply's usage (input + cacheRead + cacheWrite); null before the first reply. */
  total: number | null;
  window: number | null;
}

export type ContextLineKind = "instructions" | "mode" | "rules" | "skills" | "tools" | "conversation" | "other" | "free";

export interface ContextLine {
  id: string;
  kind: ContextLineKind;
  label: string;
  tokens: number;
  /** The part the line opens in the viewer (its first, for a summed line); none for Conversation, Other, Free. */
  opens?: string;
}

/** A part in the window now: every part but a subfolder file not yet loaded. Pure. */
export const inWindow = (p: ContextPart): boolean => p.group !== "subfolder" || p.loaded === true;

const SUMMED: readonly { kind: "mode" | "rules" | "skills" | "tools"; label: string }[] = [
  { kind: "mode", label: "Mode" },
  { kind: "rules", label: "Rules and docs" },
  { kind: "skills", label: "Skills offered" },
  { kind: "tools", label: "Tools" },
];

/** The tab's lines: one per instruction file in the window (subfolder files once loaded), the
    other groups summed, Conversation; then Other once a reply has reported a total. Biggest first,
    empty lines left out, Free last. They add up to the window when the estimates fit the total. Pure. */
export function contextLines(s: ContextSizes): ContextLine[] {
  const parts = s.parts.filter(inWindow);
  const lines: ContextLine[] = parts
    .filter((p) => p.group === "instructions" || p.group === "subfolder")
    .map((p) => ({ id: p.id, kind: "instructions" as const, label: p.label, tokens: p.tokens, opens: p.id }));
  for (const g of SUMMED) {
    const of = parts.filter((p) => p.group === g.kind);
    lines.push({ id: g.kind, kind: g.kind, label: g.label, tokens: of.reduce((n, p) => n + p.tokens, 0), opens: of[0]?.id });
  }
  lines.push({ id: "conversation", kind: "conversation", label: "Conversation", tokens: s.conversation });
  const shown = lines.filter((l) => l.tokens > 0);
  if (s.total !== null) {
    const known = shown.reduce((n, l) => n + l.tokens, 0);
    shown.push({ id: "other", kind: "other", label: "Other", tokens: Math.max(0, s.total - known) });
  }
  shown.sort((a, b) => b.tokens - a.tokens);
  if (s.total !== null && s.window) shown.push({ id: "free", kind: "free", label: "Free", tokens: Math.max(0, s.window - s.total) });
  return shown;
}

/** The top line: "12,345 of 200,000 tokens · 6%", or "Nothing sent yet" before the first reply. Pure. */
export function contextHeadline(total: number | null, window: number | null): string {
  if (total === null) return "Nothing sent yet";
  const t = total.toLocaleString("en-US");
  if (!window) return `${t} tokens · this model's limit is unknown`;
  return `${t} of ${window.toLocaleString("en-US")} tokens · ${formatPercent(total, window)}%`;
}

/** The room left, in words: "150k left", or null when it can't be said. Pure. */
export function contextRoom(total: number | null, window: number | null): string | null {
  if (total === null || !window) return null;
  return `${formatTokens(Math.max(0, window - total))} left`;
}

/** An estimate's words: "≈1.2k tokens". Pure. */
export const approxTokens = (n: number): string => `≈${formatTokens(n)} tokens`;
