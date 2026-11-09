// A project card's Runtime group and progress zone (§app.projects/home-cards), from one glance answer
// (GET /api/projects/glance, §app.projects/home-glance). Pure and DOM-free: the words, the pips, the bar's share and
// the progress rows; OverviewProjects draws them.
import type { RunStep } from "../../shared/merge-queue";
import type { ProjectGlance, ProjectGlanceQueue, ProjectGlanceRelease } from "../../shared/projects";
import type { ReleaseRecord } from "../../shared/release";
import { runSegments, type SegmentState } from "./landing-bar";
import { mins } from "./merge-queue";
import { bytesWord } from "./project-software";
import { releaseChip, visibleSteps } from "./releases";

export const DASH = "—";
/** A served project's Ready while its queue's first view is being read. */
export const READING = "…";

export interface ReadyRow {
  /** "2", "0", "…" (served, its first view being read), or "—" (unserved, or the glance not read yet). */
  count: string;
  /** It opens the Merge Queue tab: only while the queue serves the project. */
  link: boolean;
  /** "· 1 in line", while approved branches wait or are checked. */
  inLine: string | null;
  /** The success dot: while above 0. */
  dot: boolean;
  muted: boolean;
}

/** What one usable place is, as its pip draws it. `unchecked`: other programs couldn't be looked at, so never "free". */
export type PlaceLook = "running" | "stopped" | "elsewhere" | "free" | "unchecked";

export interface SlotsRow {
  /** One per usable place, grouped: running, stopped, used elsewhere, then free (or not checked). */
  pips: PlaceLook[];
  /** "3 running", "12 at limit". */
  text: string;
  /** The hover's sentences, which the row's accessible name carries too. */
  title: string;
  muted: boolean;
}

export interface MemoryRow {
  /** "640 MB", "2.4 GB", "0 MB idle", or "—". */
  text: string;
  /** The bar's two parts, each 0–1 of the bar's width: the mix of chats and running copies in the total, filling the
   *  whole bar whenever anything is used, a nonzero part never thinner than MIN_BAR_PART. Idle: both 0 (an empty bar);
   *  null: no bar (not read). */
  bar: { chats: number; slots: number } | null;
  /** The exact parts, for hover and the row's accessible name: "Chats 1.5 GB · Copies 2.7 GB"; null when nothing is used or not read. */
  parts: string | null;
  muted: boolean;
}

/** A nonzero part of the memory bar is never drawn thinner than this share of the bar, so a small part stays visible. */
export const MIN_BAR_PART = 0.12;

const partWord = (n: number): string => (n > 0 ? bytesWord(n) : "0 MB");

/** The memory bar's two parts from each one's bytes: the mix, chats/total and slots/total, so the bar is full whenever
 *  the total is above 0; a nonzero part at least MIN_BAR_PART wide, taken from the larger part. Total 0: both 0. */
export function memoryBar(chatsBytes: number, copiesBytes: number): { chats: number; slots: number } {
  const total = chatsBytes + copiesBytes;
  if (total <= 0) return { chats: 0, slots: 0 };
  let chats = chatsBytes / total;
  if (chatsBytes > 0 && copiesBytes > 0) chats = Math.min(1 - MIN_BAR_PART, Math.max(MIN_BAR_PART, chats));
  const round = (w: number) => Math.round(w * 1000) / 1000;
  return { chats: round(chats), slots: round(1 - chats) };
}

export interface ProgressRow {
  kind: "landing" | "frozen" | "release";
  /** The tab it opens. */
  tab: "merge-queue" | "releases";
  /** The bold lead: "Landing", "Merge queue", "Release". */
  lead: string;
  /** "feat/x · check 3 of 8", "Frozen for a release", "v0.42 · Step 3 of 10". */
  text: string;
  /** Right of the text: "~4 min left", "2 waiting". */
  meta: string | null;
  /** The release's state chip. */
  chip: { word: string; tone: "info" | "success" | "warn" | "error" | "accent" | undefined } | null;
  /** The segmented meter: one per check (or step). */
  segments: SegmentState[];
  /** The line under it. */
  detail: string;
}

export interface CardRuntime {
  /** The Runtime caption's right side: "2.4 GB", "idle", "no project setup", or "" before the first glance. */
  caption: string;
  ready: ReadyRow;
  /** null: "—" (no project file, or not read yet). */
  slots: SlotsRow | null;
  memory: MemoryRow;
  /** Whether the project has a project file (Copies and Memory then open the Branches tab). */
  hasSetup: boolean;
  progress: ProgressRow[];
}

const UNREAD: CardRuntime = {
  caption: "",
  ready: { count: DASH, link: false, inLine: null, dot: false, muted: true },
  slots: null,
  memory: { text: DASH, bar: null, parts: null, muted: true },
  hasSetup: false,
  progress: [],
};

const ago = (iso: string, now: number): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "just now";
  const m = Math.floor(Math.max(0, now - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)}h ago`;
};

/** The Landing row, while the queue checks a branch. `frozen`: the release whose own check this is, its waiting count. */
function landingRow(q: ProjectGlanceQueue, now: number): ProgressRow | null {
  const l = q.landing;
  if (!l) return null;
  const run = { steps: l.steps as unknown as RunStep[], checks: l.checks as unknown as { id: string; label: string; source: "required" }[], startedAt: l.startedAt };
  // Counted as the landing bar counts (runNow): every segment the meter draws, so N of M matches the meter.
  const segs = runSegments(run);
  let i = segs.map((s) => s.state).lastIndexOf("running");
  if (i < 0) {
    const last = segs.reduce((n, s, k) => (s.state !== "waiting" && s.state !== "skipped" ? k : n), -1);
    i = last < 0 ? -1 : segs.findIndex((s, k) => k > last && s.state === "waiting");
  }
  const place = i >= 0 ? `step ${i + 1} of ${segs.length}` : "starting";
  const left = l.takesMs !== null ? l.takesMs - (now - Date.parse(l.startedAt)) : NaN;
  const parts = [`started ${ago(l.startedAt, now)}`];
  if (l.takesMs !== null) parts.push(`takes ~${mins(l.takesMs)}`);
  if (l.release && q.frozen) parts.push(`${q.frozen.waiting} waiting for ${q.frozen.tag ?? q.frozen.version ?? "the release"}`);
  else if (q.waiting > 0) parts.push(`${q.waiting} in line`);
  return {
    kind: "landing",
    tab: "merge-queue",
    lead: "Landing",
    text: `${l.branch} · ${place}`,
    meta: Number.isFinite(left) && left > 0 ? `~${mins(left)} left` : null,
    chip: null,
    segments: segs.map((s) => s.state),
    detail: parts.join(" · "),
  };
}

/** The Frozen row: a release holds the queue and landings wait on it, with no run of its own going. */
function frozenRow(q: ProjectGlanceQueue): ProgressRow | null {
  const f = q.frozen;
  if (!f || f.waiting <= 0 || q.landing) return null;
  const name = f.tag ? `release ${f.tag}` : f.version ? `release ${f.version}` : "a release";
  return { kind: "frozen", tab: "merge-queue", lead: "Merge queue", text: "Frozen for a release", meta: `${f.waiting} waiting`, chip: null, segments: [], detail: `${q.target} is frozen for ${name}` };
}

const STEP_SEGMENT: Record<ProjectGlanceRelease["steps"][number]["state"], SegmentState> = { done: "passed", skipped: "skipped", running: "running", failed: "failed", held: "held", waiting: "waiting" };

/** The Release row, while a release is open or its after-publish (after-withdraw) steps still run. */
export function releaseRow(r: ProjectGlanceRelease): ProgressRow {
  const rec = r as unknown as ReleaseRecord;
  const steps = visibleSteps(rec);
  const settled = (s: { state: string }) => s.state === "done" || s.state === "skipped";
  const now = steps.find((s) => s.state === "running" || s.state === "held" || s.state === "failed") ?? steps.find((s) => s.state === "waiting");
  const i = now ? steps.indexOf(now) + 1 : steps.length;
  const held = now?.state === "held";
  const chip = held
    ? { word: "Held for you", tone: "warn" as const }
    : r.state === "published"
      ? { word: "Published, finishing", tone: "success" as const }
      : r.state === "withdrawn"
        ? { word: "Withdrawn, finishing", tone: "warn" as const }
        : (({ word, tone }) => ({ word, tone }))(releaseChip(rec));
  const label = now ? (held ? `${now.label}, held for you` : now.label) : "Every step done";
  return {
    kind: "release",
    tab: "releases",
    lead: "Release",
    text: `${r.tag ?? "New release"} · Step ${i} of ${steps.length}`,
    meta: null,
    chip,
    segments: steps.map((s) => STEP_SEGMENT[s.state]),
    detail: `${label} · ${steps.filter(settled).length} done`,
  };
}

/** The Copies row: `running` is the copy limit's own count (the figure and hover), `runningPlaces` the running pips. */
function slotsRow({ running, cap, usable, runningPlaces, stopped, elsewhere, free }: NonNullable<ProjectGlance["slots"]>): SlotsRow {
  const unchecked = free === null ? Math.max(0, usable - runningPlaces - stopped - elsewhere) : 0;
  const pips: PlaceLook[] = [
    ...Array<PlaceLook>(runningPlaces).fill("running"),
    ...Array<PlaceLook>(stopped).fill("stopped"),
    ...Array<PlaceLook>(elsewhere).fill("elsewhere"),
    ...Array<PlaceLook>(free ?? 0).fill("free"),
    ...Array<PlaceLook>(unchecked).fill("unchecked"),
  ];
  const counts = `${running} running, ${stopped} stopped but holding a place, ${elsewhere} used elsewhere${free === null ? "" : `, ${free} free`}.`;
  const title = [
    `${counts} Up to ${cap} can run at once.`,
    elsewhere > 0 ? "Used elsewhere: another program has the ports these places need, so a new copy can't go there. Stopping this project's copies won't free them." : null,
    free === null ? "Other programs were not checked." : null,
  ]
    .filter(Boolean)
    .join(" ");
  return { pips, text: running >= cap ? `${running} at limit` : `${running} running`, title, muted: running === 0 };
}

/** A card's Runtime rows and progress zone from its glance; `undefined` (not read yet, or the read failed) reads "—". */
export function cardRuntime(g: ProjectGlance | undefined, now: number): CardRuntime {
  if (!g) return UNREAD;
  const q = g.queue;
  const ready: ReadyRow =
    g.merge === "served" && q
      ? { count: String(q.ready), link: true, inLine: q.inLine > 0 ? `· ${q.inLine} in line` : null, dot: q.ready > 0, muted: q.ready === 0 }
      : { count: g.merge === "reading" ? READING : DASH, link: g.merge === "reading", inLine: null, dot: false, muted: true };
  const slots = g.slots ? slotsRow(g.slots) : null;
  const { chatsBytes, copiesBytes } = g.memory;
  const total = chatsBytes + copiesBytes;
  const memory: MemoryRow = {
    text: total > 0 ? bytesWord(total) : "0 MB idle",
    bar: memoryBar(chatsBytes, copiesBytes),
    parts: total > 0 ? `Chats ${partWord(chatsBytes)} · Copies ${partWord(copiesBytes)}` : null,
    muted: total === 0,
  };
  const progress = [q ? landingRow(q, now) : null, q ? frozenRow(q) : null, g.release ? releaseRow(g.release) : null].filter((r): r is ProgressRow => !!r);
  return { caption: !g.slots ? "no project setup" : total > 0 ? bytesWord(total) : "idle", ready, slots, memory, hasSetup: !!g.slots, progress };
}
