// The landing bar's store (al_1): every project's newest merge queue view and release view, by the project's main
// checkout. The summary read (GET /api/merge-queue/landing-summary) gives the starting picture at page open and at
// every reconnect of the session feed; the feed's `merge_queue` and `release` frames carry it on from there. The
// reduction to the bar is lib/landing-bar.ts; the first-seen times of what it showed are kept in localStorage, so a
// landing seen for its minute isn't shown again after a reload.
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { LandingSummary, MergeQueueView } from "../../shared/merge-queue";
import type { ReleaseView } from "../../shared/release";
import { getLandingSummary } from "./api";
import { reduceLanding, type LandingBarModel, type LandingProjectInput, type LandingQueueCut, type LandingReleaseCut } from "./landing-bar";

interface Slot {
  id: string;
  root: string;
  name: string;
  queue: LandingQueueCut | null;
  release: LandingReleaseCut | null;
}

const [slots, setSlots] = createSignal<ReadonlyMap<string, Slot>>(new Map());
/** Each root's release frame count: a summary that started before a frame never overwrites it. */
const releaseFrames = new Map<string, number>();
let frameSeq = 0;

const baseName = (root: string): string => root.replace(/\/+$/, "").split("/").pop() || root;
const newer = (a: LandingQueueCut | null, b: LandingQueueCut | null): LandingQueueCut | null => {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.at) >= Date.parse(a.at) ? b : a;
};

function put(root: string, f: (s: Slot) => Slot, seed: () => Slot): void {
  setSlots((m) => {
    const next = new Map(m);
    next.set(root, f(m.get(root) ?? seed()));
    return next;
  });
}

/** The feed's `merge_queue` frame: a project's whole queue view (its `project` is the id). */
export function noteLandingQueue(view: MergeQueueView): void {
  put(
    view.root,
    (s) => ({ ...s, id: s.id || view.project, queue: newer(s.queue, view) }),
    () => ({ id: view.project, root: view.root, name: baseName(view.root), queue: null, release: null }),
  );
}

/** The feed's `release` frame: a project's whole release view (its `project` is the root). */
export function noteLandingRelease(view: ReleaseView): void {
  releaseFrames.set(view.project, ++frameSeq);
  put(
    view.project,
    (s) => ({ ...s, release: view }),
    () => ({ id: "", root: view.project, name: baseName(view.project), queue: null, release: null }),
  );
}

/** Take a summary read's answer: `since` the frame count when it was asked for. */
export function adoptLandingSummary(sum: LandingSummary, since: number): void {
  setSlots((m) => {
    const next = new Map<string, Slot>();
    for (const p of sum.projects) {
      const had = m.get(p.root);
      const frameWon = (releaseFrames.get(p.root) ?? 0) > since;
      next.set(p.root, {
        id: p.id,
        root: p.root,
        name: p.name || baseName(p.root),
        queue: newer(p.queue, had?.queue ?? null) ?? null,
        release: frameWon ? (had?.release ?? null) : p.release,
      });
    }
    // A project a frame named after the read began (it is newer than the answer) stays.
    for (const [root, s] of m) if (!next.has(root) && ((releaseFrames.get(root) ?? 0) > since || (s.queue && Date.parse(s.queue.at) > Date.parse(sum.at)))) next.set(root, s);
    return next;
  });
}

let inflight: Promise<void> | null = null;
let again = false;
/** Read the starting picture (the feed opened or reopened). A read asked for while one runs runs once after it. */
export function refreshLandingSummary(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  const since = frameSeq;
  inflight = getLandingSummary()
    .then((sum) => adoptLandingSummary(sum, since))
    // An older server has no such read: the frames alone carry the bar.
    .catch(() => {})
    .finally(() => {
      inflight = null;
      if (again) {
        again = false;
        void refreshLandingSummary();
      }
    });
  return inflight;
}

// ---- first-seen times ----------------------------------------------------------------------------

const SEEN_KEY = "sova.landing-bar.seen";
const SEEN_KEEP_MS = 7 * 24 * 3600_000;
function readSeen(): Map<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, unknown>;
    const now = Date.now();
    return new Map(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number" && (e[1] === 0 || now - e[1] < SEEN_KEEP_MS)));
  } catch {
    return new Map();
  }
}
function writeSeen(m: ReadonlyMap<string, number>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries([...m].slice(-200))));
  } catch {
    /* private mode: the minute starts over after a reload */
  }
}

/** The bar for the calling owner (the sidebar): the reduction, ticking each second while it shows. */
export function useLandingBar(): Accessor<LandingBarModel | null> {
  const [seen, setSeen] = createSignal<ReadonlyMap<string, number>>(readSeen());
  const [now, setNow] = createSignal(Date.now());
  const inputs = createMemo((): LandingProjectInput[] => [...slots().values()].filter((s) => s.id).map((s) => ({ id: s.id, root: s.root, name: s.name, queue: s.queue, release: s.release })));
  const reduced = createMemo(() => reduceLanding(inputs(), now(), seen()));
  // Remember what was shown when it was first shown, and what the next run retired.
  createEffect(() => {
    const r = reduced();
    const m = seen();
    let next: Map<string, number> | null = null;
    for (const k of r.shown) if (!m.has(k)) (next ??= new Map(m)).set(k, now());
    for (const k of r.retire) if (m.get(k) !== 0) (next ??= new Map(m)).set(k, 0);
    if (next) {
      setSeen(next);
      writeSeen(next);
    }
  });
  // A second's tick while the bar shows (its times, its countdown, its minute); none while hidden.
  const showing = createMemo(() => !!reduced().bar);
  createEffect(() => {
    if (!showing()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });
  // A frame wakes a hidden bar with the time it arrived.
  createEffect(() => {
    slots();
    setNow(Date.now());
  });
  return createMemo(() => reduced().bar);
}
