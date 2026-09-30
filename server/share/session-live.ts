import { existsSync, watch, type FSWatcher } from "node:fs";
import { closeLink, pushView, sweepViewers, viewerCount } from "../session-share-presence";
import { sessionShareView, sourceReadable } from "../session-share-view";
import { getShare, linkByHash, linkState, listShares, type ShareRecord } from "../session-shares";
import { sourceKey, sourceOf } from "./session-routes";

/**
 * The live side of session shares (§app.session-share/snapshot): open pages get a `view` push when
 * what they show changed, and pages of a link that died are closed.
 *
 * - Follow live: while a live share has an open page, the minting host watches its session file
 *   (TUI-owned sessions too: only the file is read). Appends are debounced by LIVE_DEBOUNCE_MS and
 *   the view is rebuilt from whole entries, then pushed; it never streams a reply as it is written.
 *   A watch starts and stops on the reconcile tick (RECONCILE_MS), so a share with no open page
 *   costs nothing.
 * - Update to now, a mode switch and a title change push the new view at once (pushShareView).
 * - Every SWEEP_MS, open pages whose link expired or was turned off, or whose share no longer reads
 *   (the file gone or unparseable, the cut no longer in it), close with 4410.
 */

export const LIVE_DEBOUNCE_MS = 1000;
export const RECONCILE_MS = 2000;
export const SWEEP_MS = 30_000;

const watching = new Map<string, { path: string; watcher: FSWatcher; timer: NodeJS.Timeout | null }>();

/** Per share, the newest build started: an older one that finishes later is never sent. */
const builds = new Map<string, number>();
let buildSeq = 0;

/**
 * Rebuild a share's view (its newest page) and push it to its open pages. The build is bound to
 * the share's source as it was when it started (sourceKey: mode, cut, title, stopped): after the
 * await, a share that narrowed or changed meanwhile (live → snapshot, a new cut, stopped) gets
 * nothing from this build (the change pushes its own), and a build overtaken by a newer one is
 * dropped. Right before sending, every open page whose link no longer reads is closed first.
 */
export async function pushShareView(shareId: string): Promise<void> {
  if (!viewerCount(shareId)) return;
  const hit = getShare(shareId);
  if (!hit || hit.share.stoppedAt) return;
  const mine = ++buildSeq;
  builds.set(shareId, mine);
  const key = sourceKey(hit.share);
  const view = await sessionShareView(sourceOf(hit.share)).catch(() => null);
  if (builds.get(shareId) !== mine) return; // a newer build owns the push
  builds.delete(shareId);
  const now = getShare(shareId);
  if (!view || !now || now.share.stoppedAt || sourceKey(now.share) !== key) return;
  closeDeadViewers();
  pushView(shareId, view);
}

function unwatch(shareId: string): void {
  const w = watching.get(shareId);
  if (!w) return;
  if (w.timer) clearTimeout(w.timer);
  w.watcher.close();
  watching.delete(shareId);
}

function watchShare(share: ShareRecord): void {
  const current = watching.get(share.id);
  if (current?.path === share.sessionPath) return;
  unwatch(share.id);
  let watcher: FSWatcher;
  try {
    watcher = watch(share.sessionPath, { persistent: false });
  } catch {
    return; // the file is gone: its pages answer the dead page on their next read
  }
  const entry = { path: share.sessionPath, watcher, timer: null as NodeJS.Timeout | null };
  watcher.on("change", () => {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void pushShareView(share.id);
    }, LIVE_DEBOUNCE_MS);
    entry.timer.unref();
  });
  watcher.on("error", () => unwatch(share.id));
  watching.set(share.id, entry);
}

/** Watch exactly the live shares that have an open page. */
export function reconcileLiveWatches(): void {
  const want = new Map<string, ShareRecord>();
  for (const s of listShares().shares) if (s.mode === "live" && !s.stoppedAt && viewerCount(s.id) > 0) want.set(s.id, s);
  for (const id of [...watching.keys()]) if (!want.has(id)) unwatch(id);
  for (const s of want.values()) watchShare(s);
}

/** Close the open pages whose link no longer opens (store state only; synchronous). */
function closeDeadViewers(now = Date.now(), unreadable: ReadonlySet<string> = new Set()): number {
  return sweepViewers((key) => {
    const hit = linkByHash(key.hash);
    if (!hit) return { ok: false };
    // A session file that is gone, or a cut no longer in it, answers the dead page: its pages close.
    if (unreadable.has(hit.share.id) || !existsSync(hit.share.sessionPath)) return { ok: false };
    const state = linkState(hit.link, hit.share, now);
    return state === "live" ? { ok: true } : state === "expired" ? { ok: false, why: "expired" } : { ok: false };
  });
}

/** Close the open pages of every link that no longer opens, and of every share whose source no
    longer reads (its file unparseable, its cut gone): the same dead page its API answers. */
export async function sweepSessionViewers(now = Date.now()): Promise<number> {
  const unreadable = new Set<string>();
  const shares = listShares().shares.filter((s) => !s.stoppedAt && viewerCount(s.id) > 0);
  await Promise.all(
    shares.map(async (s) => {
      if (!(await sourceReadable(sourceOf(s)).catch(() => false))) unreadable.add(s.id);
    }),
  );
  return closeDeadViewers(now, unreadable);
}

/** Close the open pages of these links now (a revoke or relink). */
export function closeLinks(hashes: readonly string[]): void {
  for (const h of hashes) closeLink(h);
}

let timers: NodeJS.Timeout[] = [];

export function startSessionShareLive(): void {
  if (timers.length) return;
  timers = [setInterval(reconcileLiveWatches, RECONCILE_MS), setInterval(() => void sweepSessionViewers().catch(() => 0), SWEEP_MS)];
  for (const t of timers) t.unref();
}

export function stopSessionShareLive(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
  for (const id of [...watching.keys()]) unwatch(id);
}

/** Shares whose file is watched now (tests). */
export const watchedShares = (): string[] => [...watching.keys()];
