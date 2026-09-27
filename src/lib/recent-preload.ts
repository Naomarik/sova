// The sidebar's Recent sessions, kept in memory so opening any of them paints at once.
//
// The store (lib/transcript-cache) pins Recent's view keys: their rows stay while they are in
// Recent, beside the last few sessions opened. This module fills the pinned ones this tab hasn't
// got, and refreshes the ones whose file moved since, in the background: one at a time, once the
// open session has painted, while the browser is idle, never while a turn runs in an open session,
// and never on a connection that asked to save data. What they add up to is capped
// (`CACHE_BUDGET`): past it, the largest go first.
//
// The rows come from `GET /api/transcript`: the same normalization as the chat's hello and the
// watch snapshot, read from the file with no runtime opened and nothing written (unlike /ws/chat,
// which constructs one). Opening the session still reconciles them with its own hello or snapshot.

import { createEffect, createMemo, onCleanup } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { fetchTranscriptForCache } from "./api";
import { hostOf, sessionViewKey } from "./mesh";
import { recentCount, recentSessions } from "./recent";
import { transcripts, type TranscriptStore } from "./transcript-cache";

/** A Recent row, as the preloader needs it. */
export interface PreloadTarget {
  key: string;
  path: string;
  /** `lastActiveAt`: the file's mtime. */
  stamp: string;
  /** A turn is running in it: its file keeps moving, so it waits until the turn ends. */
  working: boolean;
}

/** How long an open view may go without rows before the preloader stops waiting on its paint. */
export const PAINT_WAIT_MS = 10_000;

const isWorking = (s: Pick<SessionSummary, "activity">): boolean => s.activity?.state === "working";

export const targetOf = (s: SessionSummary): PreloadTarget => ({
  key: sessionViewKey(hostOf(s.path), s.path),
  path: s.path,
  stamp: s.lastActiveAt,
  working: isWorking(s),
});

/** Whether rows kept `as of` (ISO, or null: unknown) are older than a file stamped `stamp`. */
const olderThan = (asOf: string | null | undefined, stamp: string): boolean =>
  asOf == null || !(Date.parse(asOf) >= Date.parse(stamp));

/**
 * The next Recent session to fetch, in Recent's order, or null: one no view shows, not mid-turn,
 * whose kept rows are missing or older than its file, that didn't already fail at this stamp, and
 * that wasn't already dropped as too big for the budget beside what is kept now.
 */
export function nextPreload(
  recent: readonly PreloadTarget[],
  store: Pick<TranscriptStore, "peek" | "stamp" | "showing" | "wouldKeep">,
  failed: ReadonlyMap<string, string>,
): PreloadTarget | null {
  for (const t of recent) {
    if (t.working || store.showing(t.key) || failed.get(t.key) === t.stamp) continue;
    if (!store.wouldKeep(t.key)) continue; // fetched before and too big to keep beside the rest
    if (!store.peek(t.key) || olderThan(store.stamp(t.key), t.stamp)) return t;
  }
  return null;
}

/**
 * Why the preloader must wait now, or null: an open view hasn't painted its rows yet (for up to
 * `PAINT_WAIT_MS`), or a turn is running in an open session.
 */
export function preloadBlocked(
  store: Pick<TranscriptStore, "shown" | "peek" | "shownSince">,
  workingKeys: ReadonlySet<string>,
  now: number,
): "painting" | "streaming" | null {
  const shown = store.shown();
  if (shown.some((k) => workingKeys.has(k))) return "streaming";
  if (shown.some((k) => !store.peek(k) && now - (store.shownSince(k) ?? now) < PAINT_WAIT_MS)) return "painting";
  return null;
}

/** The connection asked to save data (Chromium's `navigator.connection.saveData`). */
const saveData = (): boolean => (navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true;

const idle = (fn: () => void): (() => void) => {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(fn, { timeout: 2_000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 200); // Safari: no idle callback
  return () => clearTimeout(id);
};

/**
 * Pins Recent's sessions in the store and keeps them filled. `sessions`: the sidebar's rows (this
 * host's and every peer's); Recent is taken from them unfiltered, so a search never evicts.
 * Call once, from a component that lives as long as the app.
 */
export function startRecentPreload(sessions: () => readonly SessionSummary[] | undefined): void {
  const recent = createMemo(() => recentSessions(sessions() ?? [], recentCount()).map(targetOf));
  const workingKeys = createMemo(
    () => new Set((sessions() ?? []).filter(isWorking).map((s) => sessionViewKey(hostOf(s.path), s.path))),
  );
  const failed = new Map<string, string>();
  let running = false;
  let cancel: (() => void) | null = null;
  let disposed = false;

  const schedule = (delay = 0) => {
    if (cancel || running || disposed) return;
    const t = setTimeout(() => {
      const c = idle(() => {
        cancel = null;
        void pump();
      });
      cancel = c;
    }, delay);
    cancel = () => clearTimeout(t);
  };

  const pump = async () => {
    if (running || disposed || saveData()) return;
    const blocked = preloadBlocked(transcripts, workingKeys(), Date.now());
    if (blocked) return schedule(1_000); // nothing reactive says "painted" or "turn over": look again
    transcripts.trim(); // a session a view filled may have become budgeted since
    const next = nextPreload(recent(), transcripts, failed);
    if (!next) return;
    running = true;
    try {
      const got = await fetchTranscriptForCache(next.path, (size) => transcripts.wouldKeep(next.key, size));
      if (disposed) return;
      if ("tooBig" in got) transcripts.noteSize(next.key, got.tooBig);
      else transcripts.preload(next.key, got.items, next.stamp, got.size);
    } catch {
      if (disposed) return;
      failed.set(next.key, next.stamp); // again once the file moves
    } finally {
      running = false;
    }
    schedule();
  };

  createEffect(() => {
    const list = recent();
    transcripts.pin(list.map((t) => t.key));
    workingKeys();
    schedule();
  });
  onCleanup(() => {
    disposed = true;
    cancel?.();
    transcripts.pin([]);
  });
}
