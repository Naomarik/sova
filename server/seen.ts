import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";

/**
 * When the user last had each session in front of them: `<stateRoot>/seen.json`, `{[id]: ms}`.
 *
 * There is no "viewed" event in Sova, so a socket is the proxy: a pane mounts only while it is on
 * screen, and every pane opens a /ws/chat or /ws/watch socket. The stamp is written when a socket
 * ATTACHES and when it DETACHES, and while any socket is open the session counts as seen now
 * (`isViewing`). A background tab keeps its socket, so it counts as looking — an imperfect proxy,
 * and the Overseer's tool description says so.
 *
 * Same store rules as web-sessions.ts: re-read and merge before writing, atomic tmp+rename, so two
 * servers never drop each other's stamps (the newer stamp wins per id).
 */
const seenFile = () => join(stateRoot(), "seen.json");

/** A stamp never goes backwards: a slower writer's older stamp loses to a newer one. */
function load(file: string): Record<string, number> {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, t] of Object.entries(v)) if (typeof t === "number" && Number.isFinite(t)) out[k] = t;
    return out;
  } catch {
    return {};
  }
}

let cache: { file: string; at: number; map: Record<string, number> } | null = null;
const CACHE_MS = 1000;

/** The whole store; cached ~1s, since every listing reads it. */
export function readSeen(file = seenFile()): Record<string, number> {
  const now = Date.now();
  if (cache && cache.file === file && now - cache.at < CACHE_MS) return cache.map;
  const map = load(file);
  cache = { file, at: now, map };
  return map;
}

export function markSeen(id: string, at = Date.now(), file = seenFile()): void {
  if (!id) return;
  try {
    const next = load(file);
    if ((next[id] ?? 0) >= at) return;
    next[id] = at;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, file);
    cache = { file, at: Date.now(), map: next };
  } catch (err) {
    console.warn("[seen] write failed:", err instanceof Error ? err.message : String(err));
  }
}

/** Open chat/watch sockets per session id on this server. */
const viewing = new Map<string, number>();

/** A socket attached (+1) or detached (-1): stamps the session seen either way. */
export function trackViewer(id: string, delta: 1 | -1): void {
  if (!id) return;
  const n = Math.max(0, (viewing.get(id) ?? 0) + delta);
  if (n === 0) viewing.delete(id);
  else viewing.set(id, n);
  markSeen(id);
}

/** A socket is open on it right now: it is in front of the user, so it is seen as of now. */
export function isViewing(id: string): boolean {
  return (viewing.get(id) ?? 0) > 0;
}

/**
 * Something new since the user last looked: the last assistant reply is newer than the stamp, and
 * the session is idle (a reply in a running turn is not "finished"). A session never stamped is
 * never unread — otherwise every old session would light up the day this store appeared.
 */
export function isUnread(opts: { seenAt: number | undefined; lastReplyAt: number | undefined; viewing: boolean; running: boolean }): boolean {
  if (opts.viewing || opts.running) return false;
  if (opts.seenAt === undefined || opts.lastReplyAt === undefined) return false;
  return opts.lastReplyAt > opts.seenAt;
}
