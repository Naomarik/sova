/**
 * Which model each playbook role gets: one pure resolver, used by the card, by
 * Start (the frozen plan) and later by every scheduled fire. The order, first usable wins:
 *
 *   1. your pick on the card (or your saved default for this playbook);
 *   2. the playbook's list for the role, in order, skipping what Settings → Models turns off;
 *   3. your profile's model for the role's kind of work (its primary, then its fallback);
 *   4. the chat's own model.
 *
 * Every pick that isn't the first choice says why ("Opus 5.5 is turned off in Settings → Models, so
 * Fable 5.2"). A role marked "only these models" never falls past step 2 (nor takes a card pick
 * outside its list): with none usable it has no model and blocks Start. The resolved role keeps its
 * whole ordered chain, so a run can move down it when a model stops working mid-run.
 *
 * Pure: whether a model can run here is the caller's (`denial`, the server's live check), and so is
 * how a model is named in words (`name`).
 */
import type { DelegateProfileId, WorkerChoice } from "./protocol";
import type { PlaybookSpec } from "./playbook-format";

/** Your profile's route for one kind of work (Delegate's settings shape). */
export interface KindRoute {
  primary: WorkerChoice;
  fallback: WorkerChoice | null;
}

export interface ResolveRoleInput {
  /** Your pick on the card, or your saved default; null/absent: none. */
  pick?: WorkerChoice | null;
  /** The playbook's list for the role, in order. */
  list: readonly WorkerChoice[];
  only: boolean;
  kind?: DelegateProfileId;
}

export interface ResolveContext {
  /** Your profile's routes by kind (null: the profile routes nothing, e.g. Off). */
  routes: Partial<Record<DelegateProfileId, KindRoute>> | null;
  /** The chat's own model (the conductor's); null: unknown. */
  chat: WorkerChoice | null;
  /** Why a model can't run here now, as the rest of a sentence that starts with the model's name
      ("is turned off in Settings → Models", "isn't signed in on this computer"); null: usable. */
  denial: (c: WorkerChoice) => string | null;
  /** A model in words with its provider ("GLM 5.3 · ZAI"); default: its id. */
  name?: (c: WorkerChoice) => string;
}

/** Where the model came from: your pick, the playbook's list, your profile, the chat's own; none: blocked. */
export type ModelSource = "pick" | "list" | "profile" | "chat" | "none";

/** One entry of a role's chain with whether it could run at resolve time. */
export interface ChainEntry {
  choice: WorkerChoice;
  source: Exclude<ModelSource, "none">;
  /** Why it can't run now; absent: usable. */
  why?: string;
}

export interface ResolvedRoleModel {
  /** The model the role gets; null only for an only-role with nothing usable (Start is blocked). */
  use: WorkerChoice | null;
  source: ModelSource;
  /** Why this isn't the first choice, in words; absent when it is (or for the chat's own model on a
      role that names nothing at all and no kind). */
  reason?: string;
  /** Why Start is blocked by this role ("No model on Grader's list can run here"); with `use: null`. */
  blocked?: string;
  /** The whole ordered chain (pick, list, then — unless only — profile and chat), each with its
      denial; the frozen plan keeps it so a run moves to the next usable entry mid-run. */
  chain: ChainEntry[];
}

const same = (a: WorkerChoice, b: WorkerChoice) => a.backend === b.backend && a.model === b.model && a.effort === b.effort;
const sameModel = (a: WorkerChoice, b: WorkerChoice) => a.backend === b.backend && a.model === b.model;
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** One role's model. */
export function resolveRoleModel(input: ResolveRoleInput, ctx: ResolveContext): ResolvedRoleModel {
  const name = ctx.name ?? ((c: WorkerChoice) => c.model);
  const chain: ChainEntry[] = [];
  const add = (choice: WorkerChoice, source: ChainEntry["source"], forced?: string) => {
    if (chain.some((e) => same(e.choice, choice))) return;
    const why = forced ?? ctx.denial(choice) ?? undefined;
    chain.push({ choice, source, ...(why ? { why } : {}) });
  };
  if (input.pick) add(input.pick, "pick", input.only && !input.list.some((c) => sameModel(c, input.pick!)) ? "isn't one of this role's models (only these models)" : undefined);
  for (const c of input.list) add(c, "list");
  const route = input.kind ? ctx.routes?.[input.kind] : undefined;
  if (!input.only) {
    if (route) {
      add(route.primary, "profile");
      if (route.fallback) add(route.fallback, "profile");
    }
    if (ctx.chat) add(ctx.chat, "chat");
  }
  const at = chain.findIndex((e) => !e.why);
  if (at < 0) {
    const blocked = input.only
      ? `None of its models can run here (only these models): ${chain.filter((e) => e.source === "list").map((e) => `${name(e.choice)} ${e.why}`).join("; ")}.`
      : "No model can run it here.";
    return { use: null, source: "none", blocked, chain };
  }
  const use = chain[at]!;
  const out: ResolvedRoleModel = { use: use.choice, source: use.source, chain };
  if (at > 0) out.reason = reasonText(chain.slice(0, at), use, name);
  else if (use.source === "chat" && input.kind && !input.list.length) out.reason = `Your profile has no model for ${input.kind} work, so this chat's model`;
  return out;
}

/** "Opus 5.5 is turned off in Settings → Models, so Fable 5.2"; "None of this playbook's models can run, so your profile's model". */
function reasonText(skipped: ChainEntry[], use: ChainEntry, name: (c: WorkerChoice) => string): string {
  const parts: string[] = [];
  const pick = skipped.find((e) => e.source === "pick");
  if (pick) parts.push(`your pick, ${name(pick.choice)}, ${pick.why}`);
  const list = skipped.filter((e) => e.source === "list");
  if (use.source === "list" || list.length === 1) parts.push(...list.slice(0, 2).map((e) => `${name(e.choice)} ${e.why}`), ...(list.length > 2 ? [`${list.length - 2} more can't run`] : []));
  else if (list.length) parts.push("none of this playbook's models can run");
  if (use.source === "chat" && skipped.some((e) => e.source === "profile")) parts.push("your profile's model can't run either");
  const who = use.source === "profile" ? `your profile's model, ${name(use.choice)}` : use.source === "chat" ? `this chat's model, ${name(use.choice)}` : name(use.choice);
  return `${cap(parts.join(", and "))}, so ${who}`;
}

/** Every role of a playbook, resolved: `picks` are your card picks (or saved defaults) by role id. */
export function resolveCast(spec: Pick<PlaybookSpec, "roles">, picks: Readonly<Record<string, WorkerChoice | null | undefined>>, ctx: ResolveContext): Record<string, ResolvedRoleModel> {
  const out: Record<string, ResolvedRoleModel> = {};
  for (const r of spec.roles) {
    out[r.id] = resolveRoleModel({ pick: picks[r.id] ?? null, list: r.models.map((m) => m.choice), only: r.only, ...(r.kind ? { kind: r.kind } : {}) }, ctx);
  }
  return out;
}
