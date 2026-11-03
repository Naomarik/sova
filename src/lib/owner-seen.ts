/**
 * "New since your last visit" on the owner page (§app.owner-page/content): what changed after this browser's previous
 * visit carries a `New` chip. The previous visit is remembered per organization in the browser's own storage (the
 * share address's `localStorage`); the starting point is pinned for the tab's session (`sessionStorage`), so a reload
 * keeps the marks, and a browser's first visit marks nothing. Pure: the page hands it its storages.
 */

export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LAST = "sova-owner:last-visit:";
const BASE = "sova-owner:visit-base:";

/** The time this tab's marks start from (ms), or null: nothing is new (a first visit, or no storage). Records this
    visit as the next one's starting point. */
export function visitBaseline(org: string, local: KeyStore | null, session: KeyStore | null, now = Date.now()): number | null {
  const pinned = safeGet(session, BASE + org);
  let base: number | null;
  if (pinned !== null) base = pinned === "none" ? null : numberOr(pinned);
  else {
    base = numberOr(safeGet(local, LAST + org));
    safeSet(session, BASE + org, base === null ? "none" : String(base));
  }
  safeSet(local, LAST + org, String(now));
  return base;
}

/** Whether something at `at` (ISO) is newer than the baseline. */
export const isNewSince = (at: string | undefined, base: number | null): boolean => {
  if (base === null || !at) return false;
  const t = Date.parse(at);
  return Number.isFinite(t) && t > base;
};

const numberOr = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
function safeGet(s: KeyStore | null, k: string): string | null {
  try {
    return s?.getItem(k) ?? null;
  } catch {
    return null;
  }
}
function safeSet(s: KeyStore | null, k: string, v: string): void {
  try {
    s?.setItem(k, v);
  } catch {
    // storage full or blocked: no marks
  }
}
