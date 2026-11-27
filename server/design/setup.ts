// A Setup card's contents: what the main chat filled in, against the models the user allows for workers.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { periodAt, priceUsage, resolvePriceRef, type Aliases, type PriceTable } from "../../shared/model-prices/prices";
import { stateRoot } from "../state-root";
import { DESIGN_DEFAULT_EFFORT, designEffortOf, designLinksIn, designPlan, designRouteOf, type DesignLeftOut, type DesignModelChoice, type DesignRun, type DesignSetup } from "../../shared/design";
import { DESIGN_NEVER_IDS, DESIGN_NEVER_REFS, designInGroup, designModelOrder, designSectionOf, designSectionOfWord } from "../../shared/design-models";
import { modelStanding, readHiddenSections, readStandings, type StandingReadings } from "./standing";
import { retiredModelRefs } from "../harness/pi/model-sync";
import { DESIGN_DEFAULT_DIRECTION_SETS, DESIGN_DIRECTIONS, DESIGN_LAYOUTS } from "../../pi-config/extensions/mode/design-guide.ts";
import { listModels } from "../models";
import { modelAllowed, modelDenial, readModelPolicy } from "../model-policy";
import type { ModelInfo, ModelPolicy } from "../../shared/protocol";
import type { DesignParent } from "./batch";
import { linksFromText } from "./brief";
import { changeDesigns } from "./store";
import { chatHandle } from "../chat-handle";
import { runSkills, type SkillLister } from "./skills";

const PRICES_DIR = join(import.meta.dirname, "..", "..", "shared", "model-prices");
const PAGE_OUTPUT_TOKENS = 18_000;
/** A page's first message is a Full Prompt plus Sova's additions, around 8 to 10 thousand tokens. */
const PAGE_INPUT_TOKENS = 10_000;
const priceFile = <T>(f: string): T | null => {
  try {
    return JSON.parse(readFileSync(f, "utf8")) as T;
  } catch {
    return null;
  }
};

/** May a design session run on this model: allowed at all, not barred for workers, not one that can only fail
    (`retired`: the refs Sova's Ollama Cloud check found retired). */
export function designModelAllowed(policy: ModelPolicy, ref: string, retired: ReadonlySet<string> = new Set()): boolean {
  if (!modelAllowed(policy, ref)) return false;
  const slash = ref.indexOf("/");
  const provider = ref.slice(0, slash).toLowerCase();
  const id = ref.slice(slash + 1);
  if (DESIGN_NEVER_IDS.has(id) || DESIGN_NEVER_REFS.has(ref) || retired.has(ref)) return false;
  return !policy.subagentDisabledProviders.includes(provider) && !policy.subagentDisabledModels.includes(ref.toLowerCase());
}

/** Why a design may not run on this model, in words for the Creative Director's card; null when it may. */
export function designModelRefusal(policy: ModelPolicy, ref: string, retired: ReadonlySet<string> = new Set()): string | null {
  if (designModelAllowed(policy, ref, retired)) return null;
  if (!modelAllowed(policy, ref)) return modelDenial(policy, ref) ?? `${ref} isn't allowed in Settings → Models.`;
  const id = ref.slice(ref.indexOf("/") + 1);
  if (DESIGN_NEVER_IDS.has(id) || DESIGN_NEVER_REFS.has(ref) || retired.has(ref)) return `${ref} can't write a design: Sova knows it can only fail.`;
  return `${ref} is barred for workers in Settings, so no design can run on it.`;
}

/** One model a design may run on, as the Creative Director lists and names them. */
export interface DesignModelOption {
  ref: string;
  name: string;
  vision: boolean;
  route: DesignModelChoice["route"];
  /** The thinking levels it supports, in order. */
  efforts: string[];
  /** Ticked for design on the run's Setup card. */
  onSetup: boolean;
}

/** Every model a design may run on, ticked at Setup or not: what the user is allowed to use, best first. */
export function designModelOptions(listed: readonly ModelInfo[], policy: ModelPolicy, retired: ReadonlySet<string>, setup?: Pick<DesignSetup, "models">): DesignModelOption[] {
  const ticked = new Set((setup?.models ?? []).filter((m) => m.design).map((m) => m.ref));
  return designModelOrder(listed.filter((m) => designModelAllowed(policy, m.ref, retired))).map((m) => ({ ref: m.ref, name: m.id, vision: !!m.input?.includes("image"), route: designRouteOf(m.ref), efforts: m.thinkingLevels ?? [], onSetup: ticked.has(m.ref) }));
}

/** The model a new design runs on, from a provider/id or a bare id, and its thinking level: the one named, else low for a
    model ticked at Setup (as its designs run) and the model's own default for any other. A string when it can't. */
export function resolveDesignModel(listed: readonly ModelInfo[], policy: ModelPolicy, retired: ReadonlySet<string>, setup: Pick<DesignSetup, "models">, asked: string, effort?: string): { ref: string; name: string; vision: boolean; route: DesignModelChoice["route"]; effort?: string | null } | string {
  const want = asked.trim().toLowerCase();
  const ticked = setup.models.filter((m) => m.design);
  // A bare id goes to a model the Setup card ticked first, then to the first in the picker's order.
  const known = listed.find((m) => m.ref.toLowerCase() === want) ?? (want.includes("/") ? undefined : (listed.find((m) => m.id.toLowerCase() === want && ticked.some((t) => t.ref === m.ref)) ?? designModelOrder(listed.filter((m) => m.id.toLowerCase() === want))[0]));
  if (!known) {
    const onCard = ticked.find((m) => m.ref.toLowerCase() === want || m.name.toLowerCase() === want);
    if (!onCard) return `there is no model ${asked} on this computer. design_models lists the ones you can use.`;
    // On the card but no longer listed (its provider is offline): the card's own record still names it.
    const refusal = designModelRefusal(policy, onCard.ref, retired);
    if (refusal) return refusal;
    return { ref: onCard.ref, name: onCard.name, vision: onCard.vision, route: onCard.route, ...(effort ? { effort } : launchEffortField(onCard)) };
  }
  const refusal = designModelRefusal(policy, known.ref, retired);
  if (refusal) return refusal;
  const levels = known.thinkingLevels ?? [];
  if (effort && !levels.includes(effort)) return `${known.ref} doesn't take the effort ${effort}${levels.length ? `; it takes ${levels.join(", ")}` : ""}.`;
  const row = ticked.find((m) => m.ref === known.ref);
  // A model ticked at Setup runs at the effort its row names there, as the Setup's own designs do.
  return { ref: known.ref, name: known.id, vision: !!known.input?.includes("image"), route: designRouteOf(known.ref), ...(effort ? { effort } : row ? launchEffortField(row) : { effort: null }) };
}

/** The effort a design on a Setup row is recorded with: absent (low) on a row from before efforts, else the row's level,
    or null (the model's own) for a model that offers none. */
export function launchEffortField(row: Pick<DesignModelChoice, "effort" | "efforts">): { effort?: string | null } {
  if (row.efforts === undefined) return row.effort ? { effort: row.effort } : {};
  const e = designEffortOf(row);
  return e === DESIGN_DEFAULT_EFFORT ? {} : { effort: e };
}

export interface SetupInput {
  brief?: string;
  models?: string[];
  modelGroups?: string[];
  directions?: string[];
  /** Layouts the user named; none by default (Designer's Choice). */
  layouts?: string[];
  coordinator?: string;
  /** Skills the user named for this run: a folder holding SKILL.md (an absolute or ~ path) or a skill's name. */
  skills?: string[];
}

/** What the main chat's request says beyond its fields: the model the chat itself runs on, provider/modelId. */
export interface SetupContext {
  chatModel?: string;
}

const providerOf = (ref: string): string => ref.slice(0, ref.indexOf("/")).toLowerCase();

/**
 * The one model each name means. A provider/id names exactly that model. A bare id that more than one provider
 * offers goes to a provider the same request names (another model's provider/id, or a group), else to the chat's
 * own model's provider, else to the first in the picker's order: never to two models.
 */
function resolveNames(available: readonly ModelInfo[], names: readonly string[], groups: readonly string[], context: SetupContext): string[] {
  const exact = names.filter((n) => n.includes("/")).map((n) => available.find((m) => m.ref.toLowerCase() === n.toLowerCase())?.ref).filter((r): r is string => !!r);
  const named = new Set(exact.map(providerOf));
  const inGroup = (ref: string) => groups.some((g) => designInGroup(ref, g));
  const chat = context.chatModel?.includes("/") ? providerOf(context.chatModel) : null;
  const out = [...exact];
  for (const n of names.filter((x) => !x.includes("/"))) {
    const candidates = available.filter((m) => m.id.toLowerCase() === n.toLowerCase());
    const pick = candidates.find((m) => out.includes(m.ref)) ?? candidates.find((m) => named.has(providerOf(m.ref))) ?? candidates.find((m) => inGroup(m.ref)) ?? candidates.find((m) => providerOf(m.ref) === chat) ?? candidates[0];
    if (pick && !out.includes(pick.ref)) out.push(pick.ref);
  }
  return out;
}

/** The card's model rows from the models this server has: only what may run, best first per provider, with the
    main chat's picks ticked and exactly one coordinator. */
export function setupModels(listed: readonly ModelInfo[], policy: ModelPolicy, retired: ReadonlySet<string>, input: Pick<SetupInput, "models" | "modelGroups" | "coordinator">, context: SetupContext = {}, hidden: readonly string[] = []): DesignModelChoice[] {
  // Best first within each provider's section, favorites leading: the order the card keeps.
  const available = designModelOrder(listed.filter((m) => designModelAllowed(policy, m.ref, retired)));
  const groups = input.modelGroups ?? [];
  const shown = (ref: string) => !hidden.includes(designSectionOf(ref).id);
  const named = new Set(resolveNames(available, input.models ?? [], groups, context));
  const coordinatorRef = input.coordinator ? resolveNames(available, [input.coordinator], groups, context)[0] : undefined;
  const models: DesignModelChoice[] = available.map((m) => ({
    ref: m.ref,
    name: m.id,
    // A section the user hid keeps its rows, unticked and not drawn.
    design: shown(m.ref) && (named.has(m.ref) || groups.some((g) => designInGroup(m.ref, g))),
    coordinator: false,
    vision: !!m.input?.includes("image"),
    route: designRouteOf(m.ref),
    ...(m.favorite ? { favorite: true } : {}),
    efforts: m.thinkingLevels ?? [],
  }));
  const chosenCoordinator = (coordinatorRef && shown(coordinatorRef) ? coordinatorRef : undefined) ?? models.find((m) => m.design)?.ref ?? models.find((m) => shown(m.ref))?.ref ?? models[0]?.ref;
  for (const m of models) m.coordinator = m.ref === chosenCoordinator;
  return models;
}

/** A Setup card's model list with what it leaves out: providers that can't run (by `readings`) and sections the user hid. */
export interface CardModels {
  models: DesignModelChoice[];
  leftOut: DesignLeftOut[];
  hiddenSections: string[];
  hiddenAsked: string[];
}

/**
 * The card's rows as setupModels builds them from only the models that can run, and the rest said: each section none of
 * whose models can run (or with models not downloaded) is left out with why, naming what the chat asked for in it; the
 * sections the user hid keep their rows, unticked, and the names asked for in them are kept to say so. Hidden sections
 * that would leave nothing to show are shown after all.
 */
export function setupCardModels(listed: readonly ModelInfo[], policy: ModelPolicy, retired: ReadonlySet<string>, input: Pick<SetupInput, "models" | "modelGroups" | "coordinator">, context: SetupContext = {}, card: { readings?: StandingReadings; hidden?: readonly string[] } = {}): CardModels {
  const allowed = listed.filter((m) => designModelAllowed(policy, m.ref, retired));
  const why = new Map(allowed.map((m) => [m.ref, card.readings ? modelStanding(m.ref, card.readings) : null] as const));
  const runnable = allowed.filter((m) => !why.get(m.ref));
  const dropped = allowed.filter((m) => why.get(m.ref));
  const asked = [...(input.models ?? []), ...(input.coordinator ? [input.coordinator] : [])];
  const askedIn = (refs: readonly string[], section: string): string[] => {
    const own = allowed.filter((m) => refs.includes(m.ref));
    const names = asked.filter((n) => own.some((m) => m.ref.toLowerCase() === n.toLowerCase() || m.id.toLowerCase() === n.toLowerCase()) && !runnable.some((m) => designSectionOf(m.ref).id !== section && (m.ref.toLowerCase() === n.toLowerCase() || m.id.toLowerCase() === n.toLowerCase())));
    const words = (input.modelGroups ?? []).filter((g) => designSectionOfWord(g) === section || own.some((m) => designInGroup(m.ref, g)));
    return [...new Set([...names, ...words])];
  };
  const leftOut: DesignLeftOut[] = [];
  for (const section of [...new Set(dropped.map((m) => designSectionOf(m.ref).id))]) {
    const gone = dropped.filter((m) => designSectionOf(m.ref).id === section);
    const reasons = gone.map((m) => why.get(m.ref)!);
    const whole = !runnable.some((m) => designSectionOf(m.ref).id === section);
    if (!whole && !reasons.includes("not-downloaded")) continue;
    const models = askedIn(gone.map((m) => m.ref), section);
    leftOut.push({ section, name: designSectionOf(gone[0]!.ref).name, why: whole ? reasons[0]! : "not-downloaded", ...(models.length ? { models } : {}) });
  }
  const present = [...new Set(runnable.map((m) => designSectionOf(m.ref).id))];
  let hiddenSections = present.filter((s) => (card.hidden ?? []).includes(s));
  if (hiddenSections.length && hiddenSections.length === present.length) hiddenSections = [];
  const models = setupModels(runnable, policy, retired, input, context, hiddenSections);
  const hiddenAsked = hiddenSections.flatMap((s) => askedIn(runnable.filter((m) => designSectionOf(m.ref).id === s).map((m) => m.ref), s));
  return { models, leftOut, hiddenSections, hiddenAsked: [...new Set(hiddenAsked)] };
}

/** The Setup card as the main chat's words fill it. Every model that can run is listed so the user can change anything. */
export async function setupFrom(input: SetupInput, context: SetupContext = {}): Promise<DesignSetup> {
  return (await setupCardFrom(input, context)).setup;
}

/** setupFrom, with what the card leaves out: the providers that can't run now and the sections the user hid. */
export async function setupCardFrom(input: SetupInput, context: SetupContext = {}): Promise<{ setup: DesignSetup } & Omit<CardModels, "models">> {
  const listed = await listModels();
  const readings = await readStandings(listed.map((m) => m.ref));
  const { models, ...card } = setupCardModels(listed, readModelPolicy(), retiredModelRefs(), input, context, { readings, hidden: readHiddenSections() });
  return { setup: setupWith(input, models), ...card };
}

function setupWith(input: SetupInput, models: DesignModelChoice[]): DesignSetup {
  const asked = (input.directions ?? []).map((d) => d.toLowerCase());
  const known = DESIGN_DIRECTIONS.filter((d) => asked.includes(d.name.toLowerCase())).map((d) => d.name);
  const on = known.length ? known : [...DESIGN_DEFAULT_DIRECTION_SETS[Math.floor(Math.random() * DESIGN_DEFAULT_DIRECTION_SETS.length)]!];
  const layoutsAsked = (input.layouts ?? []).map((d) => d.toLowerCase());
  const brief = input.brief?.trim() ?? "";
  return {
    brief,
    models,
    directions: DESIGN_DIRECTIONS.map((d) => ({ name: d.name, on: on.includes(d.name), ...(d.family ? { family: d.family } : {}) })),
    layouts: DESIGN_LAYOUTS.map((d) => ({ name: d.name, on: layoutsAsked.includes(d.name.toLowerCase()) })),
    combine: "pair",
    links: linksFromText(brief, undefined, designLinksIn(brief)),
  };
}

export async function createRun(parent: DesignParent, cwd: string, input: SetupInput, lister?: SkillLister): Promise<DesignRun> {
  // A bare model id resolves toward the provider the chat itself runs on.
  const chatModel = chatHandle(parent.path)?.mirror.model?.ref;
  const card = await setupCardFrom(input, chatModel ? { chatModel } : {});
  const setup = card.setup;
  // The ones the user named, on the run, so each run carries its own; the main chat's edit may change them until Start on the brief.
  const { skills, missing } = await runSkills(cwd, input.skills ?? [], lister);
  const now = new Date().toISOString();
  const run: DesignRun = {
    id: randomUUID().slice(0, 8),
    setup,
    phase: "setup",
    labels: [],
    ...(skills.length ? { skills } : {}),
    ...(missing.length ? { skillsMissing: missing } : {}),
    ...(card.leftOut.length ? { leftOut: card.leftOut } : {}),
    ...(card.hiddenSections.length ? { hiddenSections: card.hiddenSections } : {}),
    ...(card.hiddenAsked.length ? { hiddenAsked: card.hiddenAsked } : {}),
    createdAt: now,
    updatedAt: now,
  };
  changeDesigns(parent.sessionId, (s) => {
    s.runs.push(run);
    s.parentPath = parent.path;
    s.cwd = cwd;
  });
  return run;
}

/** Replace a run's Setup with what the card holds, keeping only models and directions the server offered.
    With the brief open (`briefOpen`) only the models and directions change: Change on its summary line reopens just those. */
export function cleanSetup(previous: DesignSetup, next: unknown, briefOpen = false, hidden: readonly string[] = []): DesignSetup | string {
  const n = next as Partial<DesignSetup> | null;
  if (!n || typeof n !== "object" || typeof n.brief !== "string" || !Array.isArray(n.models) || !Array.isArray(n.directions)) return "Expected a whole Setup { brief, models, directions }.";
  if (n.brief.length > 20_000) return "The brief is too long.";
  const offered = new Map(previous.models.map((m) => [m.ref, m]));
  let refused: string | null = null;
  const models = previous.models.map((m) => {
    const sent = (n.models as unknown[]).find((x) => (x as { ref?: unknown })?.ref === m.ref) as { design?: unknown; coordinator?: unknown; effort?: unknown } | undefined;
    if (!sent) return m;
    // A hidden section's rows aren't drawn, so a save can't mean them: they stay as the server has them.
    const isHidden = hidden.includes(designSectionOf(m.ref).id);
    // The coordinator is already running by then: its seat stays where it is.
    const row: DesignModelChoice = { ...m, design: isHidden ? m.design : !!sent.design, coordinator: briefOpen || isHidden ? m.coordinator : !!sent.coordinator };
    // Absent: as it was; null: back to the default; a level: one the model offers.
    if (sent.effort === null) delete row.effort;
    else if (sent.effort !== undefined) {
      const e = effortProblem(m, sent.effort);
      if (e) refused ??= e;
      else if (sent.effort === DESIGN_DEFAULT_EFFORT) delete row.effort;
      else row.effort = sent.effort as string;
    }
    return row;
  });
  if (refused) return refused;
  // A save made before a Hide moved the Creative Director names none that is shown: the seat stays where the server put it.
  if (!models.some((m) => m.coordinator)) for (const [i, m] of models.entries()) m.coordinator = previous.models[i]!.coordinator;
  if (n.models.some((x) => !offered.has((x as { ref?: string })?.ref ?? ""))) return "That model isn't on this card.";
  if (models.filter((m) => m.coordinator).length > 1) return "Only one model can be the Creative Director.";
  const ticks = (offered: readonly { name: string; on: boolean }[], sentList: unknown) =>
    offered.map((d) => {
      const sent = (Array.isArray(sentList) ? sentList : []).find((x) => (x as { name?: unknown })?.name === d.name) as { on?: unknown } | undefined;
      return sent ? { ...d, on: !!sent.on } : d;
    });
  const directions = ticks(previous.directions, n.directions);
  if (n.layouts !== undefined && !Array.isArray(n.layouts)) return "layouts must be a list.";
  // Only the layouts this card offered; a run made before layouts offers none.
  const offeredLayouts = previous.layouts ?? [];
  if ((n.layouts ?? []).some((x) => !offeredLayouts.some((d) => d.name === (x as { name?: unknown })?.name))) return "That layout isn't on this card.";
  if (n.combine !== undefined && n.combine !== "pair" && n.combine !== "every") return 'combine is "pair" or "every".';
  if (n.pairSeed !== undefined && (typeof n.pairSeed !== "number" || !Number.isInteger(n.pairSeed) || n.pairSeed < 0 || n.pairSeed > 0xffffffff)) return "pairSeed must be a whole number.";
  const combos = {
    ...(previous.layouts ? { layouts: ticks(previous.layouts, n.layouts) } : {}),
    combine: n.combine ?? previous.combine ?? "pair",
    ...((n.pairSeed ?? previous.pairSeed) ? { pairSeed: n.pairSeed ?? previous.pairSeed } : {}),
  } satisfies Partial<DesignSetup>;
  if (briefOpen) return { ...previous, models, directions, ...combos };
  return { brief: n.brief, models, directions, ...combos, links: linksFromText(n.brief, previous.links, designLinksIn(n.brief), n.links) };
}

/** Why a Setup row can't take `effort`, in the words resolveDesignModel uses; null when it can. */
export function effortProblem(m: Pick<DesignModelChoice, "ref" | "name" | "efforts">, effort: unknown): string | null {
  if (typeof effort !== "string" || !effort) return "effort is a thinking level, such as low or high.";
  const levels = (m.efforts ?? []).filter((l) => l !== "off");
  if (!levels.length) return `${m.ref} has no effort to pick.`;
  return levels.includes(effort) ? null : `${m.ref} doesn't take the effort ${effort}; it takes ${levels.join(", ")}.`;
}

/** Roughly how much more a page writes at each thinking level than at low: thinking is billed as output. */
export const EFFORT_OUTPUT_FACTOR: Readonly<Record<string, number>> = { off: 0.85, minimal: 0.9, low: 1, medium: 1.35, high: 1.9, xhigh: 2.6, max: 3.2 };

/** About what one page costs on `ref`, in dollars, or null when its price isn't known (report E1: output dominates). */
function pagePrice(ref: string, table: PriceTable, aliases: Aliases, now: number, extraInput = 0, effort: string | null = DESIGN_DEFAULT_EFFORT): number | null {
  const slash = ref.indexOf("/");
  const r = resolvePriceRef(table, aliases, { provider: ref.slice(0, slash), model: ref.slice(slash + 1) }, now);
  if ("free" in r) return 0;
  if (!("key" in r) || !table.models[r.key]) return null;
  const p = periodAt(table.models[r.key]!, now);
  const factor = (effort && EFFORT_OUTPUT_FACTOR[effort]) || 1;
  return p ? (PAGE_OUTPUT_TOKENS * factor * p.rates.output + (PAGE_INPUT_TOKENS + extraInput) * p.rates.input) / 1_000_000 : null;
}

let rates: { at: number; table: PriceTable | null; aliases: Aliases | null } | null = null;
/** The price tables, read at most once a minute: a page in progress asks several times a second. */
function priceTables(now: number): { table: PriceTable | null; aliases: Aliases | null } {
  if (!rates || now - rates.at > 60_000) {
    const table = priceFile<PriceTable>(join(stateRoot(), "model-prices.json")) ?? priceFile<PriceTable>(join(PRICES_DIR, "seed.json"));
    const aliases = priceFile<Aliases>(join(PRICES_DIR, "aliases.json"));
    // A file caught mid-rewrite reads as nothing: keep the last good tables rather than drop every estimate for a minute.
    rates = { at: now, table: table ?? rates?.table ?? null, aliases: aliases ?? rates?.aliases ?? null };
  }
  return rates;
}

/** About what a reply's input is when nothing has said yet: a first message, which is a page's whole brief. */
export const FIRST_INPUT_TOKENS = PAGE_INPUT_TOKENS;

/** Dollars per input and output token on `ref`, or null when it has no price (a local or unpriced model: no estimate, never $0). */
export function tokenRates(ref: string, now = Date.now()): { input: number; output: number } | null {
  const { table, aliases } = priceTables(now);
  if (!table || !aliases) return null;
  const slash = ref.indexOf("/");
  const r = resolvePriceRef(table, aliases, { provider: ref.slice(0, slash), model: ref.slice(slash + 1) }, now);
  if (!("key" in r) || !table.models[r.key]) return null;
  const p = periodAt(table.models[r.key]!, now);
  return p && p.rates.output > 0 ? { input: (p.rates.input ?? 0) / 1_000_000, output: p.rates.output / 1_000_000 } : null;
}

/** One reply's cost by Sova's own price table, as the usage ledger counts it (API prices on a subscription too), or
    null when the table has no price for it. The card's cost and its estimate while writing come from the same place. */
export function replyCost(ref: { provider: string; model: string }, u: { input: number; output: number; cacheRead: number; cacheWrite: number }, at: number): number | null {
  const { table, aliases } = priceTables(Date.now());
  if (!table || !aliases) return null;
  const p = priceUsage(table, aliases, ref, { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite5m: u.cacheWrite, cacheWrite1h: 0 }, at);
  return p.status === "priced" ? p.usd.total : null;
}

/** What a run should cost, for the question above the free limit, each design priced at its model's effort; null when a price is missing. `skillTokens`: what each
    design is reckoned to read of the run's design skills (skillReadTokens), added to its input. */
export function estimateUsd(setup: DesignSetup, now = Date.now(), skillTokens = 0): number | null {
  const table = priceFile<PriceTable>(join(stateRoot(), "model-prices.json")) ?? priceFile<PriceTable>(join(PRICES_DIR, "seed.json"));
  const aliases = priceFile<Aliases>(join(PRICES_DIR, "aliases.json"));
  if (!table || !aliases) return null;
  let total = 0;
  const each = new Map<string, number | null>();
  const rows = new Map(setup.models.map((m) => [m.ref, m]));
  for (const item of designPlan(setup).items) {
    // Priced at the effort its designs run at: a row from before efforts runs at low.
    const row = rows.get(item.model);
    const effort = row ? (row.efforts === undefined ? (row.effort ?? DESIGN_DEFAULT_EFFORT) : designEffortOf(row)) : DESIGN_DEFAULT_EFFORT;
    if (!each.has(item.model)) each.set(item.model, pagePrice(item.model, table, aliases, now, skillTokens, effort));
    const price = each.get(item.model)!;
    if (price === null) return null;
    total += price;
  }
  return total;
}
