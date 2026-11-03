// The Context tab's arithmetic: what fills a chat's window, as lines biggest first. The parts are
// estimates (CHARS_PER_TOKEN); the total is the last reply's own usage. "Other" is what the
// estimates don't explain (total minus the parts, floored at 0); "Free" is the room left. Pure (no
// DOM, no Solid), so it tests under tsx.

import type { SessionContextView, WorkerInfo } from "../../shared/protocol";
import { formatPercent, formatTokens } from "./context";

export type ContextPartGroup = "instructions" | "subfolder" | "mode" | "rules" | "skills" | "tools";

/** One part of the window, flattened from the server's read. A file part opens by `path`
    (/api/sessions/context/file); any other carries its `text`. */
export interface ContextPart {
  id: string;
  group: ContextPartGroup;
  label: string;
  tokens: number;
  path?: string;
  text?: string;
  /** Subfolder files: the folder, relative to cwd, and whether it is in the window now. */
  folder?: string;
  loaded?: boolean;
}

/** The server's read as one list of parts, in the order the window is built (ids prefixed by
    group, so two groups never collide). Pure. */
export function flatParts(v: Extract<SessionContextView, { state: "ok" }>): ContextPart[] {
  const of = (group: ContextPartGroup, ps: readonly { id: string; label: string; tokens: number; path?: string; text?: string }[]): ContextPart[] =>
    ps.map((p) => ({ id: `${group}:${p.id}`, group, label: p.label, tokens: p.tokens, path: p.path, text: p.text }));
  return [
    ...of("instructions", v.instructions),
    ...v.nested.map((n) => ({ id: `subfolder:${n.abs}`, group: "subfolder" as const, label: n.path, tokens: n.tokens, path: n.abs, folder: n.folder, loaded: n.loaded })),
    ...of("mode", v.mode ? [v.mode] : []),
    ...of("rules", v.rules),
    ...of("skills", v.skills),
    ...of("tools", v.tools),
  ];
}

/** A worker's reply-end signal, from the pane's own worker list: it changes when a reply ends
    (its reply count, the fill that reply reported, or its end), never while one streams. The
    Context tab re-reads a picked worker on it, since the parent's file may not move. Pure. */
export function workerReplyKey(w: Pick<WorkerInfo, "turns" | "context" | "endedAt"> | undefined): string {
  if (!w) return "";
  const c = w.context === "compacted" ? "c" : w.context ? String(w.context.tokens) : "";
  return `${w.turns ?? ""}:${c}:${w.endedAt ?? ""}`;
}

/** What the lines are worked out from. */
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

/** An estimate's words: "≈1.2k". Pure. */
export const approxTokens = (n: number): string => `≈${formatTokens(n)}`;
