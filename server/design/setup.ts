// A Setup card's contents: what the main chat filled in, against the models the user allows for workers.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { periodAt, priceUsage, resolvePriceRef, type Aliases, type PriceTable } from "../../shared/model-prices/prices";
import { stateRoot } from "../state-root";
import { designLinksIn, designPlan, designRouteOf, type DesignModelChoice, type DesignRun, type DesignSetup } from "../../shared/design";
import { DESIGN_NEVER_IDS, DESIGN_NEVER_REFS, designInGroup, designModelOrder } from "../../shared/design-models";
import { retiredModelRefs } from "../harness/pi/model-sync";
import { DESIGN_DEFAULT_DIRECTION_SETS, DESIGN_DIRECTIONS, DESIGN_LAYOUTS } from "../../pi-config/extensions/mode/design-guide.ts";
import { listModels } from "../models";
import { modelAllowed, readModelPolicy } from "../model-policy";
import type { ModelInfo, ModelPolicy } from "../../shared/protocol";
import type { DesignParent } from "./batch";
import { linksFromText } from "./brief";
import { changeDesigns } from "./store";
import { chatHandle } from "../chat-handle";

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

export interface SetupInput {
  brief?: string;
  models?: string[];
  modelGroups?: string[];
  directions?: string[];
  /** Layouts the user named; none by default (Designer's Choice). */
  layouts?: string[];
  coordinator?: string;
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
export function setupModels(listed: readonly ModelInfo[], policy: ModelPolicy, retired: ReadonlySet<string>, input: Pick<SetupInput, "models" | "modelGroups" | "coordinator">, context: SetupContext = {}): DesignModelChoice[] {
  // Best first within each provider's section, favorites leading: the order the card keeps.
  const available = designModelOrder(listed.filter((m) => designModelAllowed(policy, m.ref, retired)));
  const groups = input.modelGroups ?? [];
  const named = new Set(resolveNames(available, input.models ?? [], groups, context));
  const coordinatorRef = input.coordinator ? resolveNames(available, [input.coordinator], groups, context)[0] : undefined;
  const models: DesignModelChoice[] = available.map((m) => ({
    ref: m.ref,
    name: m.id,
    design: named.has(m.ref) || groups.some((g) => designInGroup(m.ref, g)),
    coordinator: false,
    vision: !!m.input?.includes("image"),
    route: designRouteOf(m.ref),
    ...(m.favorite ? { favorite: true } : {}),
  }));
  const chosenCoordinator = coordinatorRef ?? models.find((m) => m.design)?.ref ?? models[0]?.ref;
  for (const m of models) m.coordinator = m.ref === chosenCoordinator;
  return models;
}

/** The Setup card as the main chat's words fill it. Every model is listed so the user can change anything. */
export async function setupFrom(input: SetupInput, context: SetupContext = {}): Promise<DesignSetup> {
  const models = setupModels(await listModels(), readModelPolicy(), retiredModelRefs(), input, context);
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

export async function createRun(parent: DesignParent, cwd: string, input: SetupInput): Promise<DesignRun> {
  // A bare model id resolves toward the provider the chat itself runs on.
  const chatModel = chatHandle(parent.path)?.mirror.model?.ref;
  const setup = await setupFrom(input, chatModel ? { chatModel } : {});
  const now = new Date().toISOString();
  const run: DesignRun = { id: randomUUID().slice(0, 8), setup, phase: "setup", labels: [], createdAt: now, updatedAt: now };
  changeDesigns(parent.sessionId, (s) => {
    s.runs.push(run);
    s.parentPath = parent.path;
    s.cwd = cwd;
  });
  return run;
}

/** Replace a run's Setup with what the card holds, keeping only models and directions the server offered.
    With the brief open (`briefOpen`) only the models and directions change: Change on its summary line reopens just those. */
export function cleanSetup(previous: DesignSetup, next: unknown, briefOpen = false): DesignSetup | string {
  const n = next as Partial<DesignSetup> | null;
  if (!n || typeof n !== "object" || typeof n.brief !== "string" || !Array.isArray(n.models) || !Array.isArray(n.directions)) return "Expected a whole Setup { brief, models, directions }.";
  if (n.brief.length > 20_000) return "The brief is too long.";
  const offered = new Map(previous.models.map((m) => [m.ref, m]));
  const models = previous.models.map((m) => {
    const sent = (n.models as unknown[]).find((x) => (x as { ref?: unknown })?.ref === m.ref) as { design?: unknown; coordinator?: unknown } | undefined;
    if (!sent) return m;
    // The coordinator is already running by then: its seat stays where it is.
    return { ...m, design: !!sent.design, coordinator: briefOpen ? m.coordinator : !!sent.coordinator };
  });
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

/** About what one page costs on `ref`, in dollars, or null when its price isn't known (report E1: output dominates). */
function pagePrice(ref: string, table: PriceTable, aliases: Aliases, now: number): number | null {
  const slash = ref.indexOf("/");
  const r = resolvePriceRef(table, aliases, { provider: ref.slice(0, slash), model: ref.slice(slash + 1) }, now);
  if ("free" in r) return 0;
  if (!("key" in r) || !table.models[r.key]) return null;
  const p = periodAt(table.models[r.key]!, now);
  return p ? (PAGE_OUTPUT_TOKENS * p.rates.output + PAGE_INPUT_TOKENS * p.rates.input) / 1_000_000 : null;
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

/** What a run should cost, for the question above the free limit; null when a price is missing. */
export function estimateUsd(setup: DesignSetup, now = Date.now()): number | null {
  const table = priceFile<PriceTable>(join(stateRoot(), "model-prices.json")) ?? priceFile<PriceTable>(join(PRICES_DIR, "seed.json"));
  const aliases = priceFile<Aliases>(join(PRICES_DIR, "aliases.json"));
  if (!table || !aliases) return null;
  let total = 0;
  const each = new Map<string, number | null>();
  for (const item of designPlan(setup).items) {
    if (!each.has(item.model)) each.set(item.model, pagePrice(item.model, table, aliases, now));
    const price = each.get(item.model)!;
    if (price === null) return null;
    total += price;
  }
  return total;
}
