import type { Decision } from "./approvals";

/**
 * Optimistic decisions (Approve, Disallow, Allow): a row shows its new state at the click while the
 * save runs. The overlay holds each clicked item's decision, by its key, until the server has it:
 * - a save that fails drops its entries, so the rows go back to what the server says;
 * - a save that succeeds marks its entries acked, and the first read of the list started after the
 *   ack (which then carries the decision) drops them. A read started earlier can't: it may predate
 *   the save, so the row would flip back and forth.
 * A newer click on the same item replaces its entry, and an older save then never touches it.
 * Pure, so it is tested once; the components hold it in a signal.
 */

export interface Pending {
  to: Decision;
  /** The save that carries it. */
  save: number;
  /** The read count when its save answered; absent while the save runs. */
  ackedAt?: number;
}
export type Overlay = Readonly<Record<string, Pending>>;

export const EMPTY: Overlay = Object.freeze({});

/** A save of these items starts. */
export function begin(o: Overlay, keys: readonly string[], to: Decision, save: number): Overlay {
  if (!keys.length) return o;
  return { ...o, ...Object.fromEntries(keys.map((k) => [k, { to, save }])) };
}

const keep = (o: Overlay, drop: (p: Pending) => boolean): Overlay => {
  const next = Object.entries(o).filter(([, p]) => !drop(p));
  return next.length === Object.keys(o).length ? o : Object.fromEntries(next);
};

/** The save answered: its entries wait for a read started after `reads` (the number started so far). */
export function acked(o: Overlay, save: number, reads: number): Overlay {
  if (!Object.values(o).some((p) => p.save === save)) return o;
  return Object.fromEntries(Object.entries(o).map(([k, p]) => [k, p.save === save ? { ...p, ackedAt: reads } : p]));
}

/** The save failed or was refused: its rows go back. */
export const failed = (o: Overlay, save: number): Overlay => keep(o, (p) => p.save === save);

/** A read of the list landed; `started` is its number (1 for the first read ever started). */
export const readLanded = (o: Overlay, started: number): Overlay => keep(o, (p) => p.ackedAt !== undefined && started > p.ackedAt);

/** The save answered with the whole list (a project card's PUT): its entries go at once. */
export const settled = failed;

/** Whether any save is still unconfirmed. */
export const pendingAny = (o: Overlay): boolean => Object.keys(o).length > 0;

/** Whether a save the server hasn't answered yet is running. An answered one whose read hasn't
    landed still shows its rows, but the server has it. */
export const unanswered = (o: Overlay): boolean => Object.values(o).some((p) => p.ackedAt === undefined);

/**
 * The new chat's hold on Send (lib/approval-hold), from what still waits (by kind) and the saves
 * not yet answered ("Saving…"): null when nothing holds it. A save once answered never holds it,
 * even while the read after it fails.
 */
export function setupHold(waiting: readonly { kind: "context" | "skill" }[], o: Overlay): { context: number; skills: number; saving?: true } | null {
  const busy = unanswered(o);
  if (!waiting.length && !busy) return null;
  return { context: waiting.filter((r) => r.kind === "context").length, skills: waiting.filter((r) => r.kind === "skill").length, ...(busy ? { saving: true as const } : {}) };
}

/** The queue a folder's saves share, from the folder as each surface knows it (shared/approvals keys). */
export const projectQueue = (id: string): string => `p:${id}`;
export const folderQueue = (root: string): string => `d:${root}`;
export const queueOf = (f: { kind: "project"; id: string } | { kind: "folder"; path: string }): string => (f.kind === "project" ? projectQueue(f.id) : folderQueue(f.path));

/**
 * A folder's saves run one at a time, in click order, whichever surface made them (the new chat's
 * rows and its notice, the project page's cards, the folder's dialog, a chat's mid-chat lines): two
 * PUTs into one list never race, and an older answer never lands over a newer one. Other folders'
 * saves don't wait.
 *
 * A save that hasn't answered `ms` after its click fails for its caller like a refused one: its rows
 * go back with the toast and Send is no longer held. The queue still waits for its real answer, so
 * nothing after it lands out of order; one that never answers holds its folder's later saves, each
 * of which then times out and reverts in turn. A save timed out before it went out never goes. One
 * that answers after its time calls `late` with its outcome, so its surface can read again.
 */
const tails = new Map<string, Promise<unknown>>();
/** How long a save may take from its click (a save first rebuilds the folder's unstarted chats). */
export const SAVE_TIMEOUT_MS = 90_000;
export function inOrder<T>(queue: string, run: () => Promise<T>, opts: { ms?: number; late?: (ok: boolean) => void } = {}): Promise<T> {
  const ms = opts.ms ?? SAVE_TIMEOUT_MS;
  let timedOut = false;
  let started = false;
  const real = (tails.get(queue) ?? Promise.resolve()).then(() => {
    if (timedOut) throw new Error("timed out before it went out");
    started = true;
    return run();
  });
  const tail = real.then(
    () => {
      if (timedOut && started) opts.late?.(true);
    },
    () => {
      if (timedOut && started) opts.late?.(false);
    },
  );
  tails.set(queue, tail);
  // The last one out clears its folder's entry.
  void tail.then(() => {
    if (tails.get(queue) === tail) tails.delete(queue);
  });
  return new Promise<T>((ok, fail) => {
    const t = setTimeout(() => {
      timedOut = true;
      fail(new Error(`It didn't answer in ${Math.round(ms / 1000)} s.`));
    }, ms);
    real.then(
      (v) => {
        clearTimeout(t);
        if (!timedOut) ok(v);
      },
      (e) => {
        clearTimeout(t);
        if (!timedOut) fail(e);
      },
    );
  });
}

/**
 * A chat's folder queue, for its mid-chat lines: the chat says its folder (ChatView, from its
 * summary), and the folder's list names the key once per folder, as the server files the decision.
 * Read when the line is drawn, so a click queues at once; until then, or when it can't be read, the
 * chat's own queue.
 */
const chatCwds = new Map<string, string>();
const folderKeys = new Map<string, Promise<string>>();
export const noteChatFolder = (path: string, cwd: string): void => void chatCwds.set(path, cwd);
export function chatQueue(path: string, read: (cwd: string) => Promise<{ folder: { projectId?: string; root: string } }>): Promise<string> {
  const own = `chat:${path}`;
  const cwd = chatCwds.get(path);
  if (!cwd) return Promise.resolve(own);
  let key = folderKeys.get(cwd);
  if (!key) {
    key = read(cwd).then(
      ({ folder }) => (folder.projectId ? projectQueue(folder.projectId) : folderQueue(folder.root)),
      () => {
        folderKeys.delete(cwd);
        return own;
      },
    );
    folderKeys.set(cwd, key);
  }
  return key;
}
