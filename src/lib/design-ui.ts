/** Pure derivations behind the Design card and the Gallery: no DOM, no Solid, so they are unit-tested. */
import { designModelOrder, designSectionOf, type DesignSection } from "../../shared/design-models";
import type { DesignCaps, DesignChatView, DesignCoordinatorView, DesignModelChoice, DesignRecord, DesignRun, DesignSetup, DesignStatus } from "../../shared/design";

export type DesignRunView = DesignRun;
export type DesignCoordinatorInfo = DesignCoordinatorView;

export const coordinatorOf = (view: DesignChatView | null): DesignCoordinatorInfo | null => view?.coordinator ?? null;

/** One provider's section of the picker, as its closed row tells it. */
export interface DesignSectionState extends DesignSection {
  /** Its models' refs, best first. */
  refs: string[];
  count: number;
  on: number;
  /** "glm-5.3, glm-5.2, glm-5.3-highspeed, +4", or "None designing". */
  summary: string;
}

/** The picker's order: per provider, favorites, then the ranked list, then the rest newest first. */
export const orderedModels = (models: readonly DesignModelChoice[]): DesignModelChoice[] => designModelOrder(models);

/** The designing models of a section on one line: the first 3 by name, then how many more. */
export function sectionSummary(designing: readonly string[]): string {
  if (designing.length === 0) return "None designing";
  const shown = designing.slice(0, 3);
  return designing.length > 3 ? `${shown.join(", ")}, +${designing.length - 3}` : shown.join(", ");
}

/** The sections a setup's models fall into, in the picker's order. */
export function designSections(models: readonly DesignModelChoice[]): DesignSectionState[] {
  const out = new Map<string, DesignSectionState & { designing: string[] }>();
  for (const m of orderedModels(models)) {
    const sec = designSectionOf(m.ref);
    const held = out.get(sec.id) ?? { ...sec, refs: [], count: 0, on: 0, summary: "", designing: [] };
    held.refs.push(m.ref);
    held.count++;
    if (m.design) {
      held.on++;
      held.designing.push(m.name);
    }
    out.set(sec.id, held);
  }
  return [...out.values()].map(({ designing, ...s }) => ({ ...s, summary: sectionSummary(designing) }));
}

/** The models a search finds: every word of it in the name or the provider/id, in the picker's order. */
export function searchModels(models: readonly DesignModelChoice[], query: string): DesignModelChoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return orderedModels(models).filter((m) => {
    const hay = `${m.name} ${m.ref} ${designSectionOf(m.ref).name}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Moves the Coordinator mark to a model: exactly one holds it, whether or not that one designs. */
export function moveCoordinator(setup: DesignSetup, ref: string): DesignSetup {
  return { ...setup, models: setup.models.map((m) => ({ ...m, coordinator: m.ref === ref })) };
}

export function toggleModel(setup: DesignSetup, ref: string, on: boolean): DesignSetup {
  return { ...setup, models: setup.models.map((m) => (m.ref === ref ? { ...m, design: on } : m)) };
}

/** A section's All: Design on or off for every model in that section, and only those. */
export function toggleGroup(setup: DesignSetup, sectionId: string, on: boolean): DesignSetup {
  return { ...setup, models: setup.models.map((m) => (designSectionOf(m.ref).id === sectionId ? { ...m, design: on } : m)) };
}

export function toggleDirection(setup: DesignSetup, name: string, on: boolean): DesignSetup {
  return { ...setup, directions: setup.directions.map((d) => (d.name === name ? { ...d, on } : d)) };
}

export interface DesignSetupCount {
  models: number;
  directions: number;
  designs: number;
}

export function setupCount(setup: DesignSetup): DesignSetupCount {
  const models = setup.models.filter((m) => m.design).length;
  const directions = setup.directions.filter((d) => d.on).length;
  return { models, directions, designs: models * directions };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "6 designs · 2 models × 3 directions". */
export const setupSummary = (c: DesignSetupCount): string => `${plural(c.designs, "design")} · ${plural(c.models, "model")} × ${plural(c.directions, "direction")}`;

/** Why Start Coordinator can't be pressed yet, or null. */
export function setupBlocked(setup: DesignSetup, caps: DesignCaps): string | null {
  const c = setupCount(setup);
  if (!setup.brief.trim()) return "Say what to design first.";
  if (c.models === 0) return "Pick at least 1 model to design.";
  if (c.directions === 0) return "Pick at least 1 direction.";
  if (c.designs > caps.batchMax) return `${caps.batchMax} designs is the most 1 run makes. Turn off ${c.designs - caps.batchMax}.`;
  if (!setup.models.some((m) => m.coordinator)) return "Pick a model to be the coordinator.";
  return null;
}

/** The card's title: the first line of the brief, short enough for a head. */
export function briefTitle(brief: string): string {
  const line = brief.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 64 ? `${line.slice(0, 63).trimEnd()}…` : line || "New design";
}

/** A run's card title names its state: "Lookbook · Brief" until a design exists, then "Lookbook · 6 designs". */
export function lookbookTitle(designs: number): string {
  return `Lookbook · ${designs > 0 ? plural(designs, "design") : "Brief"}`;
}

export const STATUS_WORD: Record<DesignStatus, string> = { queued: "Queued", writing: "Writing", fixing: "Fixing", ready: "Ready", failed: "Failed" };

/** The word on a design's chip: what its session is doing now, which can be more than its page's status. */
export function designStatusWord(d: DesignRecord): string {
  if (d.delivery?.state === "queued") return "Queued";
  if (d.status === "writing" && d.thinking) return "Thinking";
  if (d.status === "ready" && d.workerState === "working") return "Working";
  return STATUS_WORD[d.status];
}

/** Whether that word stands for work going on (the chip's live dot). */
export const designIsBusy = (d: DesignRecord): boolean => d.status === "writing" || d.status === "fixing" || (d.status === "ready" && d.workerState === "working");

/** "The page was cut off. Fixing it, try 1 of 2.", for a design being repaired; else "". */
export function designFixLine(d: DesignRecord): string {
  if (d.status !== "fixing") return "";
  const why = d.fix?.reason ?? "";
  const tries = d.fix ? `try ${d.fix.attempt} of ${d.fix.of}` : "";
  return [why, tries ? `Fixing it, ${tries}.` : "Fixing it."].filter(Boolean).join(" ");
}

/** "That didn't change the page: …", for a design whose last request ended with no new version; else "". */
export function designUnchangedLine(d: DesignRecord): string {
  if (d.status !== "ready" || !d.unchanged) return "";
  const why = d.unchanged.reason.trim().replace(/\.$/, "");
  return why ? `That didn't change the page: ${why}.` : "That didn't change the page.";
}

/** What a card says under its title about work in hand: a repair, or a request that changed nothing. */
export const designNoteLine = (d: DesignRecord): string => designFixLine(d) || designUnchangedLine(d);

/** "$0.19"; a figure under a cent reads "under $0.01". */
const dollars = (usd: number): string => (usd < 0.005 ? "under $0.01" : `$${usd.toFixed(2)}`);

/** "2 ready · 1 writing · 3 queued", omitting what there are none of; failed counted last. */
export function statusCounts(designs: readonly DesignRecord[]): string {
  const of = (s: DesignStatus) => designs.filter((d) => d.status === s).length;
  const parts = (["ready", "writing", "fixing", "queued", "failed"] as const).map((s) => (of(s) ? `${of(s)} ${s}` : "")).filter(Boolean);
  return parts.join(" · ") || "0 designs";
}

/** "6 designs · 3 directions · 2 models". */
export function batchLine(designs: readonly DesignRecord[]): string {
  const dirs = new Set(designs.map((d) => d.direction)).size;
  const models = new Set(designs.map((d) => d.model)).size;
  return `${plural(designs.length, "design")} · ${plural(dirs, "direction")} · ${plural(models, "model")}`;
}

function shortCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The line under a card's title: model, tokens so far, what it has cost. */
export function designMeta(d: DesignRecord, liveChars?: number): string {
  const tokens = d.usage?.output || (liveChars ? Math.round(liveChars / 3.6) : 0);
  const parts = [d.modelName || d.model];
  if (tokens) parts.push(`${shortCount(tokens)} tokens`);
  // While a page is written its cost is an estimate; a model with no price shows none, never $0.
  if (d.live?.estimateUsd) parts.push(d.live.estimateUsd < 0.005 ? "under $0.01" : `about ${dollars(d.live.estimateUsd)}`);
  else if (d.usage?.cost) parts.push(dollars(d.usage.cost));
  return parts.join(" · ");
}

/** A page is being written for it: a first page, a Refine's next version, or a repair. */
export const designIsWriting = (d: DesignRecord): boolean => !!d.live || d.status === "writing" || d.status === "fixing";
/** It opens once it has a page, or one is being written to watch full size. */
export const designCanOpen = (d: DesignRecord): boolean => d.versions.length > 0 || designIsWriting(d);
/** The open view shows the page being written while it follows the newest version, not one picked by hand. */
export const designOpenFollowsLive = (d: DesignRecord, picked: number | null): boolean => designIsWriting(d) && picked === null;
/**
 * The page being written stays on show after its writing ends until the finished one has drawn. When
 * no new version came of it (a Refine that changed nothing, or one that failed), the hold ends at once:
 * the version on show is still the right one.
 */
export const designHoldEnds = (d: DesignRecord, latestAtStart: number): boolean => !designIsWriting(d) && designLatest(d) === latestAtStart;
export const designCanRefine = (d: DesignRecord): boolean => d.versions.length > 0 && d.status === "ready";
export const designLatest = (d: DesignRecord): number => d.versions.at(-1)?.n ?? 0;

/** Who a design was made from: "from A and C". */
export function parentsLine(parents: readonly string[]): string {
  if (parents.length === 0) return "";
  if (parents.length === 1) return `from ${parents[0]}`;
  return `from ${parents.slice(0, -1).join(", ")} and ${parents.at(-1)}`;
}

export const QUICK_PROMPTS = ["Check Phone Width", "Tighten Spacing", "Fix Contrast", "Make Content Real"] as const;
