import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "../state-root";

/**
 * A standing project chat's record (the Setup chat's `setup-chats.json`, the Project verbs chat's `verbs-chats.json`):
 * one JSON file under the state root holding, per project, its current chat and the earlier ones (the newest
 * HISTORY_MAX), written whole through a temporary file and a rename.
 */

export interface ChatRecord<C, H> {
  current?: C;
  history: H[];
}

/** The most earlier chats a project's record keeps. */
export const HISTORY_MAX = 20;

export interface ChatRecordStore<C, H> {
  /** The record file. */
  file: () => string;
  /** Every project's record, as the file holds it ({} when it is missing or not a JSON object). */
  all: () => Record<string, ChatRecord<C, H>>;
  /** One project's record, its history always a list. */
  of: (projectId: string) => ChatRecord<C, H>;
  /** Write one project's record, keeping its newest HISTORY_MAX earlier chats. */
  save: (projectId: string, r: ChatRecord<C, H>) => void;
}

/** The store of `<state>/<name>`; `cache` keeps the last read while the file's mtime is unchanged. */
export function chatRecordStore<C, H>(name: string, opts: { cache?: boolean } = {}): ChatRecordStore<C, H> {
  type All = Record<string, ChatRecord<C, H>>;
  const file = (): string => join(stateRoot(), name);
  let cache: { mtimeMs: number; all: All } | null = null;

  const all = (): All => {
    try {
      const mtimeMs = opts.cache ? statSync(file()).mtimeMs : 0;
      if (opts.cache && cache && cache.mtimeMs === mtimeMs) return cache.all;
      const raw = JSON.parse(readFileSync(file(), "utf8")) as All;
      const read = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      if (opts.cache) cache = { mtimeMs, all: read };
      return read;
    } catch {
      return {};
    }
  };

  const writeAll = (next: All): void => {
    const f = file();
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, f);
    cache = null;
  };

  const of = (projectId: string): ChatRecord<C, H> => {
    const r = all()[projectId];
    return { ...(r?.current ? { current: r.current } : {}), history: Array.isArray(r?.history) ? r.history : [] };
  };

  const save = (projectId: string, r: ChatRecord<C, H>): void => {
    const next = { ...all() };
    next[projectId] = { ...(r.current ? { current: r.current } : {}), history: r.history.slice(-HISTORY_MAX) };
    writeAll(next);
  };

  return { file, all, of, save };
}

/** One earlier chat as a new chat's first message lists it. Pure. */
export function historyLine(h: { path: string; startedAt: string; endedAt: string; why: "fresh" | "ended"; branch?: string }): string {
  return `- ${h.path} (started ${h.startedAt}, ${h.why === "fresh" ? "closed by Start Fresh" : "ended"} ${h.endedAt}${h.branch ? `, branch ${h.branch}` : ""})`;
}
