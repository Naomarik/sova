// A Lookbook's history: each Full Prompt revision, each Start, every message a design is given (who sent it, when, the
// words, and the version it led to), each new design and what it was made from, and each stop, removal and restore.
// Kept beside the chat's state in history.json, in the chat's design folder, so it is deleted with the chat. Its own
// file: Full Prompts are long, and state.json is rewritten on every small change. Never a page's code.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignHistory, DesignHistoryItem } from "../../shared/design";
import { announceDesignChange, designChatDeleted, designDirOf, readDesigns } from "./store";

/** The most items kept, and the most characters among them: the oldest go first. */
export const HISTORY_LIMITS = Object.freeze({ items: 400, chars: 2_000_000 });

interface HistoryFile {
  v: 1;
  /** Ids given so far: never goes down, so an id is never given twice. */
  seq: number;
  items: DesignHistoryItem[];
  trimmed?: true;
}

const files = new Map<string, HistoryFile>();
const fileOf = (sessionId: string): string => join(designDirOf(sessionId), "history.json");

function load(sessionId: string): HistoryFile | null {
  if (designChatDeleted(sessionId)) {
    files.delete(sessionId);
    return null;
  }
  const have = files.get(sessionId);
  if (have) return have;
  try {
    const f = JSON.parse(readFileSync(fileOf(sessionId), "utf8")) as HistoryFile;
    if (f?.v !== 1 || !Array.isArray(f.items)) return null;
    files.set(sessionId, f);
    return f;
  } catch {
    return null;
  }
}

function save(sessionId: string, f: HistoryFile): void {
  files.set(sessionId, f);
  if (designChatDeleted(sessionId)) return;
  mkdirSync(designDirOf(sessionId), { recursive: true, mode: 0o700 });
  const path = fileOf(sessionId);
  writeFileSync(`${path}.tmp`, JSON.stringify(f), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  announceDesignChange(sessionId);
}

const size = (i: DesignHistoryItem): number => (i.text?.length ?? 0) + 200;

/** Add one item; its id back. Within the limits, the oldest items go. */
export function recordHistory(sessionId: string, item: Omit<DesignHistoryItem, "id" | "at"> & { at?: string }): string {
  if (designChatDeleted(sessionId)) return "";
  const f = load(sessionId) ?? { v: 1 as const, seq: 0, items: [] };
  const id = `h${++f.seq}`;
  f.items.push({ id, at: item.at ?? new Date().toISOString(), ...item } as DesignHistoryItem);
  let chars = f.items.reduce((n, i) => n + size(i), 0);
  while (f.items.length > 1 && (f.items.length > HISTORY_LIMITS.items || chars > HISTORY_LIMITS.chars)) {
    chars -= size(f.items.shift()!);
    f.trimmed = true;
  }
  save(sessionId, f);
  return id;
}

/** The version an item led to, once it landed. */
export function historyVersion(sessionId: string, id: string, version: number): void {
  const f = load(sessionId);
  const item = f?.items.find((i) => i.id === id);
  if (!f || !item || item.version !== undefined) return;
  item.version = version;
  save(sessionId, f);
}

/** The newest Full Prompt this history holds for a run, to tell whether a brief's prompt is a new revision. */
export function lastPrompt(sessionId: string, runId: string): string | null {
  const items = load(sessionId)?.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === "prompt" && items[i]!.runId === runId) return items[i]!.text ?? null;
  return null;
}

/** The history's count and newest id, for the view: the page fetches the items again when either moves. */
export function historyMark(sessionId: string): { count: number; last?: string } {
  const f = load(sessionId);
  const last = f?.items.at(-1)?.id;
  return { count: f?.items.length ?? 0, ...(last ? { last } : {}) };
}

/** The history in time order. A Lookbook made before it was kept shows what can be rebuilt: each run's current Full
    Prompt and its Start, marked recovered; everything after is recorded as it happens. */
export function readHistory(sessionId: string): DesignHistory {
  const f = load(sessionId);
  const recorded = f?.items ?? [];
  const s = readDesigns(sessionId);
  const recovered: DesignHistoryItem[] = [];
  for (const run of s.runs) {
    const b = run.brief;
    if (!b?.prompt) continue;
    // Rebuilt only for a run the history never saw: one recorded from its start has its own items.
    if (recorded.some((i) => i.runId === run.id)) continue;
    const at = b.startedAt ?? run.updatedAt;
    recovered.push({ id: `r-${run.id}-prompt`, at, kind: "prompt", by: b.promptBy ?? "coordinator", runId: run.id, rev: b.textRev, text: b.prompt, recovered: true });
    if (b.startedAt) {
      const designs = s.designs.filter((d) => d.runId === run.id && !d.parents.length && run.labels.includes(d.label));
      recovered.push({ id: `r-${run.id}-start`, at: b.startedAt, kind: "start", by: "user", runId: run.id, rev: b.textRev, designs: designs.map((d) => ({ label: d.label, direction: d.direction, ...(d.layout ? { layout: d.layout } : {}), model: d.model })), recovered: true });
    }
  }
  const items = recovered.length ? [...recovered, ...recorded].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) : recorded;
  return { v: 1, items, ...(f?.trimmed ? { trimmed: true as const } : {}) };
}

/** Tests: drop the kept copies, so the next read comes from disk (a restart). */
export function forgetHistoryCache(): void {
  files.clear();
}
