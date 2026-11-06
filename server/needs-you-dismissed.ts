import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";

/**
 * Which chats' Needs you rows are dismissed (§app.session-list/needs-you-dismiss):
 * `<stateRoot>/needs-you-dismissed.json`, session path → what was covered. `since` is the newest item the
 * dismissal covers; a listed item newer than it brings the row back and ends the dismissal
 * (server/attention.ts buildDigest applies this). Sova's own record: never a byte goes into a session file.
 * Same store rules as seen.ts: re-read and merge before writing, atomic tmp+rename, tolerant on read:
 * a missing or unreadable file hides nothing.
 */
export interface Dismissal {
  /** ms epoch of the newest item the dismissal covers. */
  since: number;
  /** ms epoch it was pressed. */
  at: number;
}
export type Dismissals = Record<string, Dismissal>;

export const dismissedFile = () => join(stateRoot(), "needs-you-dismissed.json");

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function load(file: string): Dismissals {
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    const out: Dismissals = {};
    if (isRec(v)) for (const [k, d] of Object.entries(v)) if (isRec(d) && Number.isFinite(d.since) && Number.isFinite(d.at)) out[k] = { since: d.since as number, at: d.at as number };
    return out;
  } catch {
    return {};
  }
}

let cache: { file: string; data: Dismissals } | null = null;

/** The whole store. Only this module writes it, so the copy held stands until a write. */
export function readDismissed(file = dismissedFile()): Dismissals {
  if (cache?.file === file) return cache.data;
  const data = load(file);
  cache = { file, data };
  return data;
}

function update(file: string, fn: (d: Dismissals) => boolean): void {
  const data = load(file);
  if (!fn(data)) {
    cache = { file, data };
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
  cache = { file, data };
}

/** Dismiss a chat's row, covering what waits up to `since`. A second press never covers less. Throws when it can't be saved. */
export function dismissChat(path: string, since: number, at = Date.now(), file = dismissedFile()): Dismissal {
  let out: Dismissal = { since, at };
  update(file, (d) => {
    out = { since: Math.max(since, d[path]?.since ?? since), at };
    d[path] = out;
    return true;
  });
  return out;
}

/** Undone dismissals not yet read by the notification check, by session path. */
const undone = new Map<string, number>();

/** Undo: the row is back as if never dismissed. The next notification check hears of it (takeUndone), so what
    comes back is no new blocker. Throws when it can't be saved. */
export function undoDismissal(path: string, file = dismissedFile()): boolean {
  let was: Dismissal | undefined;
  update(file, (d) => {
    was = d[path];
    if (!was) return false;
    delete d[path];
    return true;
  });
  if (was) undone.set(path, was.since);
  return !!was;
}

/** What Undo brought back since the last call: session path → the newest item that dismissal covered. Taken before
    the check reads the digest: an Undo after this reaches the next check, and one before it the digest it reads. */
export function takeUndone(): Map<string, number> {
  const out = new Map(undone);
  undone.clear();
  return out;
}

/** End dismissals: the row came back, or there is nothing left to cover. A failure is logged: the next digest tries again. */
export function endDismissals(paths: readonly string[], file = dismissedFile()): void {
  if (!paths.length) return;
  try {
    update(file, (d) => {
      let moved = false;
      for (const p of paths) if (d[p]) (delete d[p], (moved = true));
      return moved;
    });
  } catch (err) {
    console.warn("[needs-you] dismissal not ended:", err instanceof Error ? err.message : String(err));
  }
}

/** The dismissals to end for good: a session whose file is gone (deleted), or one archived with nothing left that lists.
    `listed` holds the rows the listing carried; a path it doesn't name is only gone when its file is. */
export function prunable(dismissed: Dismissals, listed: ReadonlySet<string>, gone: (path: string) => boolean = (p) => !existsSync(p)): string[] {
  return Object.keys(dismissed).filter((p) => !listed.has(p) && gone(p));
}

/** A baton wait of a dismissed session, read outside the digest (org-routes.ts): covered unless newer. */
export const waitDismissed = (path: string | null | undefined, since: number | undefined, data = readDismissed()): boolean => {
  const d = path ? data[path] : undefined;
  return !!d && (since ?? 0) <= d.since;
};
