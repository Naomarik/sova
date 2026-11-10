/** Pure derivations behind the Design card and the Gallery: no DOM, no Solid, so they are unit-tested. */
import { designModelOrder, designSectionOf, type DesignSection } from "../../shared/design-models";
import { designPlan, type DesignCaps, type DesignChatView, type DesignCombine, type DesignCoordinatorView, type DesignModelChoice, type DesignPlan, type DesignRecord, type DesignRun, type DesignSetup, type DesignStatus } from "../../shared/design";

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

export function toggleLayout(setup: DesignSetup, name: string, on: boolean): DesignSetup {
  return { ...setup, layouts: (setup.layouts ?? []).map((d) => (d.name === name ? { ...d, on } : d)) };
}

export const setCombine = (setup: DesignSetup, combine: DesignCombine): DesignSetup => ({ ...setup, combine });

export type DesignSetupCount = DesignPlan & { designs: number };

/** The plan's figures, for the count line, the limits and Start. */
export function setupCount(setup: DesignSetup): DesignSetupCount {
  const plan = designPlan(setup);
  return { ...plan, designs: plan.items.length };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "6 designs · 3 pairs · 2 models", "18 designs · 3 styles × 3 layouts · 2 models", or with no layout
    "6 designs · 3 styles · 2 models". */
export function setupSummary(c: DesignSetupCount): string {
  const how = !c.layouts ? plural(c.styles, "style") : c.combine === "every" ? `${plural(c.styles, "style")} × ${plural(c.layouts, "layout")}` : plural(c.pairs, "pair");
  return `${plural(c.designs, "design")} · ${how} · ${plural(c.models, "model")}`;
}

/** A row's ticked names on one line, or what it reads with none. */
export const tickedLine = (list: readonly { name: string; on: boolean }[], none: string): string => list.filter((d) => d.on).map((d) => d.name).join(", ") || none;

/** The pairs a Pair Up run deals, per model, in order; with no model ticked, as one model would deal them. */
function pairsByModel(setup: DesignSetup): { model: string; pairs: string[] }[] {
  const designing = setup.models.some((m) => m.design);
  const plan = designPlan(designing ? setup : { ...setup, models: [{ ref: "", name: "", design: true, coordinator: false, vision: true, route: "tool" }] });
  const out: { model: string; pairs: string[] }[] = [];
  for (const i of plan.items) {
    let held = out.find((x) => x.model === i.model);
    if (!held) out.push((held = { model: i.model, pairs: [] }));
    held.pairs.push(`${i.style} + ${i.layout}`);
  }
  return out;
}

/** The combine row's line, and its full text for the title: what the plan will make of styles and layouts. */
export function pairsLine(setup: DesignSetup): { text: string; full: string } {
  const styles = setup.directions.filter((d) => d.on).length;
  const layouts = (setup.layouts ?? []).filter((d) => d.on).length;
  if (!layouts) {
    const text = "No layout ticked: each designer arranges its own page.";
    return { text, full: text };
  }
  if (!styles) {
    const text = "Tick a style to pair with these layouts.";
    return { text, full: text };
  }
  if (setup.combine === "every") {
    const text = `Every style in every layout: ${plural(styles * layouts, "design")} for each model.`;
    return { text, full: text };
  }
  const per = pairsByModel(setup);
  const seen = new Set<string>();
  const unique = per.flatMap((m) => m.pairs).filter((p) => !seen.has(p) && !!seen.add(p));
  const names = new Map(setup.models.map((m) => [m.ref, m.name]));
  const full = per.length > 1 ? per.map((m) => `${names.get(m.model) ?? m.model}: ${m.pairs.join(" · ")}`).join("\n") : unique.join(" · ");
  return { text: unique.join(" · "), full };
}

/** Whether Shuffle can deal anything different: Pair Up, with 2 or more of both styles and layouts. */
export function canShuffle(setup: DesignSetup): boolean {
  if (setup.combine === "every") return false;
  return setup.directions.filter((d) => d.on).length > 1 && (setup.layouts ?? []).filter((d) => d.on).length > 1;
}

/** Shuffle: a new seed whose pairs differ from the ones shown, when any other dealing exists. */
export function shufflePairs(setup: DesignSetup, random: () => number = Math.random): DesignSetup {
  const now = pairsLine(setup).full;
  for (let i = 0; i < 32; i++) {
    const pairSeed = 1 + Math.floor(random() * 0xfffffffe);
    const next = { ...setup, pairSeed };
    if (pairsLine(next).full !== now) return next;
  }
  return setup;
}

/** Why Start Coordinator can't be pressed yet, or null. */
export function setupBlocked(setup: DesignSetup, caps: DesignCaps): string | null {
  const c = setupCount(setup);
  if (!setup.brief.trim()) return "Say what to design first.";
  if (c.models === 0) return "Pick at least 1 model to design.";
  if (c.styles === 0) return "Pick at least 1 style.";
  if (c.designs > caps.batchMax) return `${c.designs} designs is more than 1 run can make (${caps.batchMax}). Choose fewer models, styles or layouts.`;
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

/** A launched run's size, worded as Setup's count line: "6 designs · 3 pairs · 2 models". Designs made from others
    count as designs; only the run's own styles and layouts count as styles and layouts. */
export function batchLine(designs: readonly DesignRecord[], combine?: DesignCombine): string {
  const own = designs.filter((d) => d.parents.length === 0);
  const styles = new Set(own.map((d) => d.direction)).size;
  const layouts = new Set(own.flatMap((d) => (d.layout ? [d.layout] : []))).size;
  const models = new Set(designs.map((d) => d.model)).size;
  const how = !layouts ? plural(styles, "style") : combine === "every" ? `${plural(styles, "style")} × ${plural(layouts, "layout")}` : plural(Math.max(styles, layouts), "pair");
  return `${plural(designs.length, "design")} · ${how} · ${plural(models, "model")}`;
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
