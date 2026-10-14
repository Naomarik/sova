// Saved sessions (§chat/saved-sessions): the words and choices the Save Session dialog, the Sharing
// tab's Saved list and the new-session screen's Saved sessions section share. Pure: no DOM, no Solid.

import {
  SAVE_LIMIT_BYTES,
  SAVE_WARN_BYTES,
  type ContinueModel,
  type SavedBy,
  type SavedSessionRow,
  type SavedWorkerSummary,
  type SavePrepareResponse,
  type SaveReviewItem,
  type SaveScope,
} from "../../shared/session-bundle";
import { bytes } from "./mesh-details";

export type Decision = "keep" | "remove";

/** The bytes the chosen history and trim produce, or null when that choice doesn't exist (no summary yet). */
export function sizeFor(sizes: SavePrepareResponse["sizes"], scope: SaveScope, trim: boolean): number | null {
  if (scope === "whole") return trim ? sizes.wholeTrimmed : sizes.whole;
  return trim ? sizes.sinceSummaryTrimmed : sizes.sinceSummary;
}

/** The size with images left out: prepare's sizes keep every image, base64 in the transcript (about 4/3
    of each image's bytes). */
export function withoutImages(n: number | null, review: SaveReviewItem[], includeImages: boolean): number | null {
  if (n === null || includeImages) return n;
  const images = review.filter((r) => r.kind === "image").reduce((sum, r) => sum + Math.ceil((r.bytes * 4) / 3), 0);
  return Math.max(0, n - images);
}

/** How the size after cleaning reads: fine, worth a warning, or too big to save. */
export function sizeState(n: number): "ok" | "warn" | "over" {
  if (n > SAVE_LIMIT_BYTES) return "over";
  if (n > SAVE_WARN_BYTES) return "warn";
  return "ok";
}

/** The size line under the history choice, and its warning or error for the state. */
export const sizeLine = (n: number): string => `Size after cleaning: ${bytes(n)}`;
export function sizeNote(n: number): string | null {
  const s = sizeState(n);
  if (s === "over") return "Over the 50 MB limit. Choose only what the agent sees now, or trim long tool output.";
  if (s === "warn") return "That's large for a repository. A smaller choice above makes it lighter.";
  return null;
}

/** The review items that still need a keep-or-remove. With images left out, no image needs one. */
export function undecided(review: SaveReviewItem[], decisions: Record<string, Decision>, includeImages: boolean): SaveReviewItem[] {
  return review.filter((r) => !(r.kind === "image" && !includeImages) && !decisions[r.id]);
}

/** Every decision the save sends: the user's, and "remove" for each image while images are left out. */
export function decisionsToSend(review: SaveReviewItem[], decisions: Record<string, Decision>, includeImages: boolean): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  for (const r of review) {
    const d = r.kind === "image" && !includeImages ? "remove" : decisions[r.id];
    if (d) out[r.id] = d;
  }
  return out;
}

export interface SaveGate {
  title: string;
  branches: string[];
  size: number | null;
  review: SaveReviewItem[];
  decisions: Record<string, Decision>;
  includeImages: boolean;
  busy: boolean;
}

/** Why Save can't run yet, or null when it can: the disabled button's `title`. */
export function saveBlocked(g: SaveGate): string | null {
  if (g.busy) return "Saving…";
  if (g.branches.length === 0) return "Name at least one branch.";
  if (g.size !== null && sizeState(g.size) === "over") return "Over the 50 MB limit.";
  if (undecided(g.review, g.decisions, g.includeImages).length) return "Decide every possible secret and image first.";
  if (!g.title.trim()) return "Give it a title.";
  if (g.size === null) return "Choose how much history.";
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The cleaning card's automatic line: "{n} secrets removed · {n} paths made portable · thinking left
    out", each part only when it isn't zero. */
export function cleaningLine(c: SavePrepareResponse["cleaning"]): string {
  return [
    c.secretsRemoved ? `${plural(c.secretsRemoved, "secret")} removed` : null,
    c.pathsRewritten ? `${plural(c.pathsRewritten, "path")} made portable` : null,
    c.thinkingDropped ? "thinking left out" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The cleaning card's review line: "{n} possible secrets and {n} images to check", or "Everything is
    checked." once each has a decision. */
export function reviewLine(review: SaveReviewItem[], decisions: Record<string, Decision>, includeImages: boolean): string {
  const left = undecided(review, decisions, includeImages);
  if (!left.length) return "Everything is checked.";
  const secrets = left.filter((r) => r.kind === "possible-secret").length;
  const images = left.length - secrets;
  return `${[secrets ? plural(secrets, "possible secret") : null, images ? plural(images, "image") : null].filter(Boolean).join(" and ")} to check`;
}

/** An excerpt with its match marked as [[…]], split so the match can be drawn apart. */
export function excerptParts(excerpt: string): { text: string; match: boolean }[] {
  const out: { text: string; match: boolean }[] = [];
  const re = /\[\[([\s\S]*?)\]\]/g;
  let last = 0;
  for (let m = re.exec(excerpt); m; m = re.exec(excerpt)) {
    if (m.index > last) out.push({ text: excerpt.slice(last, m.index), match: false });
    out.push({ text: m[1]!, match: true });
    last = m.index + m[0].length;
  }
  if (last < excerpt.length) out.push({ text: excerpt.slice(last), match: false });
  return out;
}

/** "Omar" or "Omar <o@x>" on hover; the list shows the name. */
export const savedByName = (s: SavedBy): string => s.name || "Someone";

/** Rows the branch filter keeps: every row with no filter, else the rows tagged with that branch. */
export function filterRows(rows: SavedSessionRow[], branch: string | null): SavedSessionRow[] {
  return branch ? rows.filter((r) => r.branches.includes(branch)) : rows;
}

/** The new-session screen's Saved sessions card: its count line. Every
    saved session, then the New, Updated and unreadable ones and the merged branches to prune, parts at
    zero left out; "No saved sessions yet" with none, "Couldn't read them" when the list failed. */
export function cardLine(rows: SavedSessionRow[] | null, mergedBranches = 0): string {
  if (!rows) return "Couldn't read them";
  const count = (f: (r: SavedSessionRow) => boolean) => rows.filter(f).length;
  const parts: string[] = rows.length ? [`${rows.length} saved`] : ["No saved sessions yet"];
  const add = (n: number, word: string) => n > 0 && parts.push(`${n} ${word}`);
  add(count((r) => r.badge === "new"), "new");
  add(count((r) => r.badge === "updated"), "updated");
  add(count((r) => !!r.unreadable), "can't be read");
  add(mergedBranches, mergedBranches === 1 ? "branch merged" : "branches merged");
  return parts.join(" · ");
}

/** The row's badge word, or null. */
export const badgeWord = (b: SavedSessionRow["badge"]): string | null => (b === "new" ? "New" : b === "updated" ? "Updated" : null);

/** The model notice for Preview, Continue and the continuation note. */
export function modelLine(m: ContinueModel, saved?: { provider: string; id: string }): string {
  if (m.saved) return `Continues on ${m.id}, the model it was saved with.`;
  // The server names the saved model (savedId); a caller holding the card may pass it too.
  const was = m.savedId ?? saved?.id ?? "The saved model";
  const why = m.reason?.trim();
  return `${was} isn't available here, so it continues on ${m.id}, your default.${why ? ` ${/[.!?]$/.test(why) ? why : `${why}.`}` : ""}`;
}

/** The won't-fit warning. */
export const wontFitLine = (model: string): string => `Bigger than ${model} can hold: it continues from its last summary.`;

/** One worker's head line: "{role} · {how it ended}", the team in front for a team member. */
export function workerLine(w: SavedWorkerSummary): string {
  const who = w.kind === "team-member" && w.team ? `${w.team} · ${w.role}` : w.role;
  return `${who} · ${w.outcome}`;
}

/** The saved-list row's line: "{title} · v{n} · {time}". */
export const savedRowLine = (title: string, rev: number, time: string): string => `${title} · ${revWord(rev)} · ${time}`;

/** A row's meta line: "{name} · {branches} · {time} · {size}". */
export const savedMetaLine = (r: SavedSessionRow, time: string): string =>
  [r.savedBy?.name, r.branches.join(", "), r.savedAt ? time : "", r.bytes ? bytes(r.bytes) : ""].filter(Boolean).join(" · ");

/** "Oct 14": the short date the continuation note and Preview use. */
export const shortDate = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The version word in the Saved list: "v3". */
export const revWord = (rev: number): string => `v${rev}`;

