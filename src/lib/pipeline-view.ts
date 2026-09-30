// The project page's Pipeline (one row per gap: where it is, since when, whether it stalled, what it
// links to, Hold/Resume), each gap's timeline from the transition log, and a held act's words (the
// chart's acts that wait before they reach a person or the client's code, with Cancel).
//
// Pure on purpose, like `decisions-view`: the words and the order run under tsx --test, and the
// components only draw them.

import type { Tone } from "../components/ui";
import { duration } from "./format";

/** A phase's chip: its word and tone. `live` draws the live dot (a build working). */
export interface PhaseChip {
  word: string;
  tone?: Tone | "accent";
  live?: boolean;
}

/**
 * The phases a row names (§app.project-overseer/pipeline): open, gathering, deciding, promoted, done,
 * on hold. The chart's lane state under each is the row's detail word.
 */
export type Stage = "open" | "gathering" | "deciding" | "promoted" | "done" | "on-hold" | "dropped";

export const STAGES: Record<Stage, PhaseChip> = {
  open: { word: "Open" },
  gathering: { word: "Gathering", tone: "info" },
  deciding: { word: "Deciding", tone: "info" },
  promoted: { word: "Promoted", tone: "info" },
  done: { word: "Done", tone: "success" },
  "on-hold": { word: "On hold" },
  dropped: { word: "Dropped" },
};

/**
 * The lane's states, in pipeline order: the stage each belongs to and its detail word, and a tone
 * when it waits on the operator (warn) or failed (error). A state this table lacks reads as its
 * own id ("build-starting" → "Build starting") under the open stage, never as nothing.
 */
export const PHASES: Record<string, { stage: Stage; detail: string; tone?: Tone | "accent"; live?: boolean }> = {
  open: { stage: "open", detail: "Nobody asked yet" },
  "gather-starting": { stage: "gathering", detail: "Starting a gathering" },
  asking: { stage: "gathering", detail: "Asking" },
  "needs-operator": { stage: "gathering", detail: "Needs you", tone: "warn" },
  unreconciled: { stage: "deciding", detail: "Not compared yet" },
  conflicted: { stage: "deciding", detail: "In conflict", tone: "warn" },
  drafted: { stage: "deciding", detail: "Ready to promote" },
  "spec-edited": { stage: "deciding", detail: "Edited in the spec", tone: "warn" },
  "awaiting-build": { stage: "promoted", detail: "Waiting for a build" },
  "build-starting": { stage: "promoted", detail: "Starting a build" },
  working: { stage: "promoted", detail: "Building", tone: "accent", live: true },
  idle: { stage: "promoted", detail: "Built, not merged" },
  failed: { stage: "promoted", detail: "Build failed", tone: "error" },
  merged: { stage: "promoted", detail: "Merged, not yet verified" },
  done: { stage: "done", detail: "Built and verified" },
  "on-hold": { stage: "on-hold", detail: "On hold" },
  dropped: { stage: "dropped", detail: "Dropped" },
};

/** Where each phase sorts: the order a gap moves through. Unknown phases sort after the known ones. */
const ORDER = new Map(Object.keys(PHASES).map((p, i) => [p, i]));

const sentenceCase = (id: string) => {
  const s = id.replace(/[-_]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : "Unknown";
};

const phaseOf = (phase: string) => PHASES[phase] ?? { stage: "open" as Stage, detail: sentenceCase(phase) };

/** The row's chip: its stage word, in the lane state's tone when that waits on you or failed. */
export function phaseChip(phase: string): PhaseChip {
  const p = phaseOf(phase);
  const stage = STAGES[p.stage];
  return p.tone ? { word: stage.word, tone: p.tone, live: p.live } : stage;
}

/** The lane state's own words, beside the chip: "In conflict", "Building". */
export const phaseDetail = (phase: string): string => phaseOf(phase).detail;

/** Whether the lane state waits on the operator or failed: such rows list first. */
const urgent = (phase: string) => {
  const t = phaseOf(phase).tone;
  return t === "warn" || t === "error";
};

/** What a row needs to be ordered and described. */
export interface PipelineRowLike {
  itemId: string;
  title: string;
  phase: string;
  since: string;
  stalled?: { since: string } | null;
  held?: { since: string; from: string } | null;
}

/**
 * The rows as the section lists them: a dropped gap is not listed; what waits on the operator first
 * (Needs you, a conflict, a spec edit, a failed build), then stalled ones, then the rest by pipeline
 * order, on hold after them and done last. Ties: longest in its phase first, then title.
 */
export function pipelineOrder<T extends PipelineRowLike>(rows: readonly T[]): T[] {
  const rank = (r: T): number => {
    if (r.phase === "done") return 4;
    if (r.phase === "on-hold") return 3;
    if (urgent(r.phase)) return 0;
    if (r.stalled) return 1;
    return 2;
  };
  const at = (iso: string) => Date.parse(iso) || 0;
  return rows.filter((r) => r.phase !== "dropped").sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (ORDER.get(a.phase) ?? ORDER.size) - (ORDER.get(b.phase) ?? ORDER.size) ||
      at(a.since) - at(b.since) ||
      a.title.localeCompare(b.title) ||
      a.itemId.localeCompare(b.itemId),
  );
}

/** How long a gap has been in its phase: "for 2d 3h"; "just now" under a minute. */
export function inPhaseFor(since: string, now: number): string {
  const t = Date.parse(since);
  if (Number.isNaN(t)) return "";
  const ms = now - t;
  return ms < 60_000 ? "just now" : `for ${duration(ms)}`;
}

/** The stalled chip's title: how long nothing moved. */
export const stalledTitle = (row: Pick<PipelineRowLike, "phase" | "since" | "stalled">, now: number): string =>
  row.stalled ? `Waiting past its stall time: ${phaseDetail(row.phase).toLowerCase()} ${inPhaseFor(row.since, now)}. The overseer was asked to look.` : "";

/** An on-hold row's line: where it goes back to on Resume. */
export const heldFromLine = (row: Pick<PipelineRowLike, "held">): string =>
  row.held ? `Resume puts it back where it was: ${phaseDetail(row.held.from).toLowerCase()}.` : "";

/** The follow-up region's words (a gathering started once the gap was deciding or later); null when none runs. */
export function followUpLine(followUp: string | null | undefined): { text: string; warn: boolean } | null {
  if (followUp === "follow-up-asking" || followUp === "follow-up-starting") return { text: "A follow-up gathering is asking.", warn: false };
  if (followUp === "follow-up-needs-operator") return { text: "A follow-up gathering needs you.", warn: true };
  return null;
}

/** The section's line under its title, counting what the list holds. */
export function pipelineSummary(rows: readonly PipelineRowLike[]): string {
  const listed = rows.filter((r) => r.phase !== "dropped");
  const open = listed.filter((r) => r.phase !== "done");
  if (!listed.length) return "";
  const stalled = open.filter((r) => r.stalled).length;
  const held = open.filter((r) => r.phase === "on-hold").length;
  const parts = [`${open.length} ${open.length === 1 ? "gap" : "gaps"} open`];
  if (stalled) parts.push(`${stalled} stalled`);
  if (held) parts.push(`${held} on hold`);
  const done = listed.length - open.length;
  if (done) parts.push(`${done} done`);
  return `${parts.join(" · ")}.`;
}

// ---- held acts --------------------------------------------------------------------------------------

/** Whole minutes left, at least 1 while any time is left; 0 once it is due. */
export function minutesLeft(goesAt: number, now: number): number {
  const ms = goesAt - now;
  return ms <= 0 ? 0 : Math.max(1, Math.ceil(ms / 60_000));
}

const stripStop = (s: string) => s.trim().replace(/[.\s]+$/, "");

/**
 * A held act's sentence (decisions.md r2): "{what} starts in {n} min unless you cancel it." Once
 * due and not yet gone: "{what} is starting now."
 */
export function heldLine(what: string, goesAt: number, now: number): string {
  const n = minutesLeft(goesAt, now);
  return n > 0 ? `${stripStop(what)} starts in ${n} min unless you cancel it.` : `${stripStop(what)} is starting now.`;
}

/** What a held act waits on, from the wire (AttentionItem.held or HeldAct, times in ms). */
export interface HeldWait {
  what: string;
  goesAt: number;
  wait?: "hold" | "hours";
  person?: string;
  reviewSince?: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A send time on the operator's clock: "14:00" today, "Tue 09:00" within 6 days, else "Mar 4 09:00". */
export function sendAt(t: number, now: number): string {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const n = new Date(now);
  const day0 = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day0(d) - day0(n)) / 86_400_000);
  if (days === 0) return hm;
  if (days > 0 && days < 7) return `${WEEKDAYS[d.getDay()]} ${hm}`;
  return logStamp(d.toISOString(), now);
}

/** "in 6h", "in 25m", "in under a minute"; "" once due. */
function inWords(t: number, now: number): string {
  const ms = t - now;
  if (ms <= 0) return "";
  if (ms < 60_000) return "in under a minute";
  return `in ${duration(ms)}`;
}

/**
 * A held act's sentence, whatever it waits on: the hold (r2's sentence), a person's working hours
 * (r7), or, past its hold, the overseer's approval (r8: an act on the project's confirm list waits
 * for the overseer to approve or cancel it; the stall clock runs from the hold's end).
 */
export function heldWaitLine(h: HeldWait, now: number): string {
  const what = stripStop(h.what);
  if (h.reviewSince !== undefined) {
    return `${what} is waiting for the overseer's review, for ${duration(Math.max(0, now - h.reviewSince))}. It goes ahead only when the overseer approves it; you can cancel it.`;
  }
  if (h.wait === "hours") {
    const rel = inWords(h.goesAt, now);
    if (!rel) return `${what} is starting now.`;
    return `${what} waits for ${h.person ?? "their"}${h.person ? "'s" : ""} working hours: it starts at ${sendAt(h.goesAt, now)} (${rel}) unless you cancel it.`;
  }
  return heldLine(h.what, h.goesAt, now);
}

/** Cancel's own name, for its accessible name and title. */
export const cancelLabel = (what: string): string => `Cancel: ${stripStop(what)}`;

/** Said after a cancel went through. */
export const cancelledLine = (what: string): string => `Cancelled. ${stripStop(what)} won't happen.`;

// ---- the timeline -----------------------------------------------------------------------------------

export interface TimelineRowLike {
  at: string;
  by: string;
  /** How the operator's act reached the chart: "overseer" when they asked the global Overseer. */
  via?: string | null;
  line: string;
  refused?: string | null;
  from?: string | null;
  to?: string | null;
  quiet?: boolean;
}

/** Who did it, in words: the operator is "You" ("You via the Overseer"), the chart itself "Sova", a person their name. */
export function byWord(by: string, via?: string | null): string {
  if (by === "operator") return via === "overseer" ? "You via the Overseer" : "You";
  if (by === "overseer") return "Overseer";
  if (by === "chart" || by === "timer" || by === "sova" || by === "system") return "Sova";
  return by;
}

/** A timeline row's phase move, "asking → needs you", or "" when it didn't move. */
export function moveLine(r: Pick<TimelineRowLike, "from" | "to">): string {
  if (!r.from || !r.to || r.from === r.to) return "";
  return `${phaseDetail(r.from)} → ${phaseDetail(r.to)}`;
}

/** Newest first, ties keep the log's order reversed (the later write is newer). Quiet rows (r8a:
    a timer re-armed, a lease renewed, bookkeeping) moved nothing, so the timeline leaves them out. */
export function timelineOrder<T extends TimelineRowLike>(rows: readonly T[]): T[] {
  return rows
    .filter((r) => !r.quiet)
    .map((r, i) => ({ r, i, t: Date.parse(r.at) || 0 }))
    .sort((a, b) => b.t - a.t || b.i - a.i)
    .map((x) => x.r);
}

/** A log stamp: 24-hour "14:06" today, "Mar 4 14:06" before (Voice: 24-hour clock in logs). */
export function logStamp(iso: string, now: number): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  const n = new Date(now);
  const sameDay = t.getFullYear() === n.getFullYear() && t.getMonth() === n.getMonth() && t.getDate() === n.getDate();
  if (sameDay) return hm;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const year = t.getFullYear() === n.getFullYear() ? "" : ` ${t.getFullYear()}`;
  return `${months[t.getMonth()]} ${t.getDate()}${year} ${hm}`;
}
