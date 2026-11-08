// The Context tab's arithmetic and words: what fills a chat's window, as groups biggest first. The parts
// are estimates (CHARS_PER_TOKEN); the total is the last reply's own usage. "Other" is what the estimates
// don't explain (total minus the groups, floored at 0); the room left is the headline's and the fill bar's
// empty end, never a line. Pure (no DOM, no Solid), so it tests under tsx.

import type { SessionContextView, WorkerInfo } from "../../shared/protocol";
import { formatPercent, formatTokens } from "./context";
import { languageForPath } from "./markdown";

export type ContextPartGroup = "instructions" | "subfolder" | "mode" | "rules" | "skills" | "tools" | "conversation";

/** One part of the window, flattened from the server's read. A file part opens by `path`
    (/api/sessions/context/file); a part with `text` opens that; a part with neither (a conversation
    count) doesn't open. */
export interface ContextPart {
  id: string;
  group: ContextPartGroup;
  label: string;
  tokens: number;
  path?: string;
  text?: string;
  /** A skill's description. */
  detail?: string;
  /** Subfolder files: the folder, relative to cwd, and whether it is in the window now. */
  folder?: string;
  loaded?: boolean;
  /** Skills: all of it loaded since the latest compaction; else how many of its SKILL.md's `lines` did. */
  read?: boolean;
  linesRead?: number;
  lines?: number;
  /** Conversation counts: how many messages of that kind. */
  count?: number;
  /** The compaction summary: when that compaction ran (ISO). */
  at?: string;
}

/** The server's read as one list of parts, in the order the window is built (ids prefixed by
    group, so two groups never collide). Conversation counts of 0 are left out. Pure. */
export function flatParts(v: Extract<SessionContextView, { state: "ok" }>): ContextPart[] {
  const of = (
    group: ContextPartGroup,
    ps: readonly { id: string; label: string; tokens: number; path?: string; text?: string; detail?: string; read?: boolean; linesRead?: number; lines?: number }[],
  ): ContextPart[] =>
    ps.map((p) => ({
      id: `${group}:${p.id}`,
      group,
      label: p.label,
      tokens: p.tokens,
      ...(p.path !== undefined ? { path: p.path } : {}),
      ...(p.text !== undefined ? { text: p.text } : {}),
      ...(p.detail ? { detail: p.detail } : {}),
      ...(p.read !== undefined ? { read: p.read } : {}),
      ...(p.linesRead ? { linesRead: p.linesRead } : {}),
      ...(p.linesRead && p.lines ? { lines: p.lines } : {}),
    }));
  const t = v.talk;
  const tallies: ContextPart[] = t
    ? [
        { id: "conversation:toolResults", group: "conversation" as const, label: "Tool results", ...t.toolResults },
        { id: "conversation:replies", group: "conversation" as const, label: "Replies", ...t.replies },
        { id: "conversation:user", group: "conversation" as const, label: "Your messages", ...t.user },
        { id: "conversation:other", group: "conversation" as const, label: "Other messages", ...t.other },
      ].filter((p) => p.count > 0)
    : [];
  return [
    ...of("instructions", v.instructions),
    ...v.nested.map((n) => ({ id: `subfolder:${n.abs}`, group: "subfolder" as const, label: n.path, tokens: n.tokens, path: n.abs, folder: n.folder, loaded: n.loaded })),
    ...of("mode", v.mode ? [v.mode] : []),
    ...of("rules", v.rules),
    ...of("skills", v.skills),
    ...of("tools", v.tools),
    ...tallies,
    ...(t?.summary ? [{ id: "conversation:summary", group: "conversation" as const, label: "Compaction summary", tokens: t.summary.tokens, text: t.summary.text, ...(t.summary.at ? { at: t.summary.at } : {}) }] : []),
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

/** How a part reads: a tool's declaration is JSON, a file goes by its path, and anything else Sova
    composed is markdown. Pure. */
export function partLang(p: Pick<ContextPart, "group" | "path">): string {
  if (p.group === "tools") return "json";
  return p.path ? languageForPath(p.path) : "markdown";
}

/** Whether a part opens: it has something to read. A conversation count doesn't. Pure. */
export const partOpens = (p: Pick<ContextPart, "path" | "text">): boolean => p.path !== undefined || p.text !== undefined;

/** A part in the window now: every part but a subfolder file not yet loaded. Pure. */
export const inWindow = (p: ContextPart): boolean => p.group !== "subfolder" || p.loaded === true;

/** What the lines are worked out from. */
export interface ContextSizes {
  parts: readonly ContextPart[];
  /** ≈ the messages since the last compaction. */
  conversation: number;
  /** The last reply's usage (input + cacheRead + cacheWrite); null before the first reply. */
  total: number | null;
  window: number | null;
}

export type ContextLineKind = "instructions" | "mode" | "rules" | "skills" | "tools" | "conversation";

/** One group of the window: a top line of the tab, and what its sheet lists. */
export interface ContextLine {
  id: ContextLineKind;
  kind: ContextLineKind;
  label: string;
  /** What it adds to the window: its parts in the window (Conversation: the server's estimate). */
  tokens: number;
  /** The short line under its name. */
  meta: string;
  /** Its parts as the sheet lists them: biggest first, Conversation's summary last, and (Instruction
      files) the files not yet loaded at the end. */
  parts: ContextPart[];
  /** Instruction files only: the first part that isn't in the window, or -1. */
  notLoadedFrom: number;
}

/** The tab's whole layout: the groups biggest first, Other apart, and the room left. */
export interface ContextLayout {
  lines: ContextLine[];
  /** The total less every line, floored at 0; null before a reply has given a total. */
  other: number | null;
  /** The window less the total; null unless both are known. */
  free: number | null;
}

const GROUPS: readonly { kind: ContextLineKind; label: string; of: readonly ContextPartGroup[] }[] = [
  { kind: "instructions", label: "Instruction files", of: ["instructions", "subfolder"] },
  { kind: "mode", label: "Mode", of: ["mode"] },
  { kind: "rules", label: "Rules and docs", of: ["rules"] },
  { kind: "skills", label: "Skills offered", of: ["skills"] },
  { kind: "tools", label: "Tools", of: ["tools"] },
  { kind: "conversation", label: "Conversation", of: ["conversation"] },
];

/** "3 tools", "1 tool". Pure. */
export const counted = (n: number, one: string, many: string): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A group's short line. Pure. */
function lineMeta(kind: ContextLineKind, parts: readonly ContextPart[]): string {
  switch (kind) {
    case "instructions": {
      const loaded = parts.filter(inWindow).length;
      const not = parts.length - loaded;
      return not > 0 ? `${loaded} loaded · ${not} not yet loaded` : `${loaded} loaded`;
    }
    case "mode":
      return parts.map((p) => p.label).join(" · ");
    case "rules":
      return counted(parts.length, "section", "sections");
    case "skills":
      return `${counted(parts.length, "skill", "skills")} · ${parts.filter((p) => p.read).length} read`;
    case "tools":
      return counted(parts.length, "tool", "tools");
    case "conversation": {
      if (parts.length === 0) return ""; // an older server sends no tallies
      const n = parts.reduce((s, p) => s + (p.count ?? 0), 0);
      const msgs = counted(n, "message", "messages");
      return parts.some((p) => p.id === "conversation:summary") ? `Since the last compaction · ${msgs}` : msgs;
    }
  }
}

const bySize = (a: ContextPart, b: ContextPart) => b.tokens - a.tokens;

/** The tab's groups, biggest first: every part of the window in exactly one, each file once. A group at
    0 is left out, except Instruction files while it lists a file not yet loaded. Other is what the total
    leaves unexplained once a reply has given one; the lines and Other add up to the total whenever the
    estimates don't overshoot it. Pure. */
export function contextLayout(s: ContextSizes): ContextLayout {
  const lines: ContextLine[] = [];
  for (const g of GROUPS) {
    const mine = s.parts.filter((p) => g.of.includes(p.group));
    const counts = mine.filter((p) => inWindow(p) && p.id !== "conversation:summary").sort(bySize);
    const later = mine.filter((p) => !inWindow(p)).sort(bySize);
    const summary = mine.filter((p) => p.id === "conversation:summary");
    const parts = [...counts, ...summary, ...later];
    const tokens = g.kind === "conversation" ? s.conversation : mine.filter(inWindow).reduce((n, p) => n + p.tokens, 0);
    if (tokens <= 0 && later.length === 0) continue;
    lines.push({ id: g.kind, kind: g.kind, label: g.label, tokens, meta: lineMeta(g.kind, mine), parts, notLoadedFrom: later.length ? parts.length - later.length : -1 });
  }
  lines.sort((a, b) => b.tokens - a.tokens);
  const known = lines.reduce((n, l) => n + l.tokens, 0);
  return {
    lines,
    other: s.total === null ? null : Math.max(0, s.total - known),
    free: s.total !== null && s.window ? Math.max(0, s.window - s.total) : null,
  };
}

/** The fill bar's parts: each line's, then Other's, as a share of the window (percent, summing to at
    most 100); none unless the window and the total are known. Pure. */
export function meterShares(l: ContextLayout, window: number | null): { id: string; pct: number }[] {
  if (!window || l.free === null) return [];
  let left = 100;
  const out: { id: string; pct: number }[] = [];
  for (const [id, tokens] of [...l.lines.map((x) => [x.id, x.tokens] as const), ["other", l.other ?? 0] as const]) {
    const pct = Math.min(left, (tokens / window) * 100);
    if (pct <= 0) continue;
    out.push({ id, pct });
    left -= pct;
  }
  return out;
}

/** A row's share bar, in percent of the window; null when it draws none (no window, or a file not yet
    loaded). A part with any size shows at least a sliver. Pure. */
export function shareOf(tokens: number, window: number | null, counts = true): number | null {
  if (!window || !counts) return null;
  return tokens > 0 ? Math.min(100, Math.max(0.5, (tokens / window) * 100)) : 0;
}

/** Where an instruction file sits, from its name: the chat's own folder, the home folder, or the folder
    its path names. Pure. */
export function fileFolder(p: Pick<ContextPart, "group" | "label" | "folder">): string {
  if (p.group === "subfolder") return `${p.folder ?? ""}/`;
  const i = p.label.lastIndexOf("/");
  const dir = i < 0 ? "" : p.label.slice(0, i);
  if (dir === "") return "This chat's folder";
  if (dir === "~") return "Your home folder";
  return `${dir}/`;
}

/** "14:06", the local 24-hour clock of an ISO time; "" when unreadable. Pure. */
export function clockOf(iso: string | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A skill's chip: Read only for the whole SKILL.md, the count when part of it loaded, else Not read yet. Pure. */
export function skillChip(p: Pick<ContextPart, "read" | "linesRead" | "lines">): { word: string; done: boolean } {
  if (p.read) return { word: "Read", done: true };
  if (p.linesRead) return { word: p.lines ? `Read ${p.linesRead} of ${p.lines} lines` : `Read ${counted(p.linesRead, "line", "lines")}`, done: false };
  return { word: "Not read yet", done: false };
}

/** A part's short line: a chip (Loaded, Read, Read n of m lines, Not read yet) and the words beside it. Pure. */
export function partMeta(p: ContextPart): { chip?: { word: string; done: boolean }; text: string } {
  switch (p.group) {
    case "instructions":
      return { chip: { word: "Loaded", done: true }, text: fileFolder(p) };
    case "subfolder":
      return p.loaded ? { chip: { word: "Loaded", done: true }, text: fileFolder(p) } : { text: fileFolder(p) };
    case "skills":
      return { chip: skillChip(p), text: p.detail ?? "" };
    case "conversation": {
      if (p.id === "conversation:summary") {
        const at = clockOf(p.at);
        return { text: at ? `Kept from the compaction at ${at}` : "Kept from the latest compaction" };
      }
      const n = p.count ?? 0;
      if (p.id === "conversation:toolResults") return { text: counted(n, "result", "results") };
      if (p.id === "conversation:replies") return { text: counted(n, "reply", "replies") };
      return { text: counted(n, "message", "messages") };
    }
    default:
      return { text: "" };
  }
}

/** The subtitle a part reads under: its full path (a file, a skill), else its group's name. Pure. */
export const partSubtitle = (p: ContextPart, line: Pick<ContextLine, "label">): string => p.path ?? line.label;

/** A part's own note in the sheet, if any: when a file not yet loaded would load, or what a skill's
    size counts. Pure. */
export function partNote(p: ContextPart): string | null {
  if (p.group === "subfolder" && !p.loaded) return `Not counted yet. It loads the first time the agent reads, edits or writes a file in ${p.folder ?? ""}.`;
  if (p.group === "skills") return "Its size counts only what the model is offered: name and description. The full SKILL.md loads when the agent reads it, then counts under Conversation.";
  return null;
}

/** The note on a group's sheet for files not yet loaded. */
export const NOT_LOADED_NOTE = "Each loads the first time the agent reads, edits or writes a file in its folder.";
/** Other's short line. */
export const OTHER_META = "What the estimates don't explain, such as Claude Code's own prompt.";

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
