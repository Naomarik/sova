import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { SessionShare } from "../../shared/session-share";
import type { SessionSummary } from "../../shared/protocol";
import { hostOf } from "./mesh";
import { listSessionShares, ShareApiError, shareLive, viewingNow } from "./session-shares";

/** A live share's presence is read again this often while the page is visible. */
export const SHARING_REFRESH_MS = 5_000;

/** Plain-JSON deep equality (a share is JSON off the wire). */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Keeps the previous object for a share nothing about changed, so <For> keeps its row. */
export function reuseShares(next: SessionShare[], prev: SessionShare[] | null): SessionShare[] {
  if (!prev) return next;
  const old = new Map(prev.map((s) => [s.id, s]));
  return next.map((s) => {
    const o = old.get(s.id);
    return o && same(o, s) ? o : s;
  });
}

/**
 * The session's shares, read once for the whole pane: the Sharing tab's list and its tab's
 * viewing-now badge render from this one read. Read on open (and when the session changes), after
 * the sheet changes something, and every SHARING_REFRESH_MS while a share is live and the page is
 * visible, from the host that holds the session.
 *
 * `summary` is App's row, a new object on every session-list refetch: only a new session id
 * resets the list to the placeholder, and a re-read keeps each unchanged share's object.
 */
export function paneShares(
  summary: () => SessionSummary | undefined,
  read: (host: string | null, id: string) => Promise<SessionShare[]> = listSessionShares,
) {
  const [shares, setShares] = createSignal<SessionShare[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let run = 0;
  const reload = async () => {
    const s = summary();
    if (!s) return;
    const mine = ++run;
    try {
      const next = await read(hostOf(s.path), s.id);
      if (mine !== run) return;
      setShares((prev) => reuseShares(next, prev));
      setError(null);
    } catch (x) {
      if (mine !== run) return;
      // An older host has no share routes: said once, never a retry loop of errors.
      setError(x instanceof ShareApiError && x.status === 404 && !x.code ? "This host can't share sessions yet. It needs an update." : `Couldn't read this session's shares. ${(x as Error).message}`);
    }
  };
  // on() re-runs whenever its source does, not when the value changes: the memo gates on the id.
  const sid = createMemo(() => summary()?.id);
  createEffect(
    on(sid, () => {
      run++;
      setShares(null);
      setError(null);
      void reload();
    }),
  );
  const tick = setInterval(() => {
    if (document.visibilityState === "visible" && (shares() ?? []).some(shareLive)) void reload();
  }, SHARING_REFRESH_MS);
  onCleanup(() => {
    run++;
    clearInterval(tick);
  });
  return { shares, error, reload: () => void reload(), viewing: () => viewingNow(shares() ?? []) };
}
