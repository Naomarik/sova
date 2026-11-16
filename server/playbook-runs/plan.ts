// The card a run draws and the plan Start freezes, from the
// playbook's description, the run's draft and what this computer can run now. Pure: the environment (which
// models can run, their names, your profile's routes, team defaults, the prompt pages) comes in as `CardEnv`.
import { choiceOfRef, CYCLE_MAX, EACH_SLOT, MAIN_ROLE, refOfChoice, type InputValue, type PlaybookFlowItem, type PlaybookInput, type PlaybookModel, type PlaybookRole, type PlaybookSpec, type PlaybookStep } from "../../shared/playbook-format";
import type { ChainEntry, KindRoute, ResolvedRoleModel } from "../../shared/playbook-models";
import { HELPER_LIMIT, mergeEdits, type PlaybookCardEdits, type PlaybookChoiceView, type PlaybookModelPick, type PlaybookModelSource, type PlaybookModelView, type PlaybookRoleView, type PlaybookRunView, type PlaybookStepView, type PlaybookTeamView } from "../../shared/playbook-run";
import type { DelegateProfileId, WorkerChoice } from "../../shared/protocol";
import type { PlaybookRef, PlaybookRunRecord } from "./store";

export interface CardEnv {
  /** Why this folder can't run the playbook (its run.needs: a project, one the merge queue serves), or null. */
  needs: string | null;
  /** Why this model can't run here now, for a helper (a worker) or for the main chat; null: it can. */
  denial(c: WorkerChoice, as: "main" | "helper"): string | null;
  /** "GLM 5.3", and the provider's id ("zai", "claude-code"). */
  name(c: WorkerChoice): { label: string; provider: string };
  /** Your profile's routes by kind of work; null: it routes none. */
  routes: Partial<Record<DelegateProfileId, KindRoute>> | null;
  /** The conducting chat's own model now (null: unknown, or no chat yet). */
  chat: WorkerChoice | null;
  /** The coordinator and monitor Sova adds to every team, on their models from Settings. */
  team: { coordinator: { model: string; effort?: string }; monitor: { model: string; effort?: string } };
  /** Each role's prompt page as written (main: the recipe page's body), or why it can't be read. */
  prompts: Record<string, string | { error: string }>;
  /** A catalogue command's label. */
  commandLabel(id: string): string;
  /** Whether a catalogue command changes things (only those are shown and listed: looking ones are free). */
  commandChanges(id: string): boolean;
  /** The model resolver (shared/playbook-models.ts resolveRoleModel). */
  resolve(input: { pick?: WorkerChoice | null; list: readonly WorkerChoice[]; only: boolean; kind?: DelegateProfileId }, as: "main" | "helper"): ResolvedRoleModel;
  /** A choice's value checked against its input: why it is wrong, or null (shared/playbook-format.ts). */
  checkValue(input: PlaybookInput, value: unknown): string | null;
  /** A choice's value as the words a prompt's {{slot}} takes. */
  valueText(input: PlaybookInput, value: unknown): string;
}

// ── the draft, as it stands ─────────────────────────────────────────────────────────────────────

/** The card's values now: its first values, with every edit the person made on top. */
export function effectiveEdits(r: Pick<PlaybookRunRecord, "initial" | "edits">): PlaybookCardEdits {
  const base: PlaybookCardEdits = { choices: r.initial.choices, ...(r.initial.roles ? { roles: r.initial.roles } : {}), ...(r.initial.stops ? { stops: r.initial.stops } : {}), ...(r.initial.cycle ? { cycle: r.initial.cycle } : {}) };
  return mergeEdits(base, r.edits);
}

/** Every plain step in order, each with the cycle it sits in. */
export function flatSteps(items: readonly PlaybookFlowItem[]): { step: PlaybookStep; cycle?: string }[] {
  const out: { step: PlaybookStep; cycle?: string }[] = [];
  for (const it of items) {
    if (it.kind === "cycle") for (const s of it.steps) out.push({ step: s, cycle: it.id });
    else out.push({ step: it });
  }
  return out;
}

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** The value an input has on the card now: the edits', else none. */
const valueOf = (edits: PlaybookCardEdits, input: PlaybookInput): unknown => edits.choices?.[input.id] ?? null;

/** How many helpers of a role: its count (a number, or a number input's value), else one per item of its `per` input. */
export function roleCount(role: PlaybookRole, spec: PlaybookSpec, edits: PlaybookCardEdits): { n: number; items?: string[] } {
  if (role.per) {
    const input = spec.inputs.find((i) => i.id === role.per!.input);
    const v = input ? valueOf(edits, input) : null;
    const items = Array.isArray(v) ? v.map((x) => itemWords(x, input?.type === "multi" ? input.options : undefined)) : [];
    return { n: items.length, items };
  }
  if (role.count && "n" in role.count) return { n: role.count.n };
  if (role.count && "input" in role.count) {
    const input = spec.inputs.find((i) => i.id === (role.count as { input: string }).input);
    const v = input ? valueOf(edits, input) : null;
    return { n: typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0 };
  }
  return { n: 1 };
}

const roleOn = (role: PlaybookRole, edits: PlaybookCardEdits): boolean => role.id === MAIN_ROLE || !role.optional || (edits.roles?.[role.id]?.on ?? !role.startsOff);

const stopOn = (step: PlaybookStep, edits: PlaybookCardEdits): boolean => step.stop === "always" || (step.stop === "optional" && (edits.stops?.[step.id] ?? !step.startsOff));

/** One item of a list, multi or models value, in the words a prompt's {{each}} takes. */
function itemWords(x: unknown, options?: readonly { id: string; label: string }[]): string {
  if (typeof x === "string") return options?.find((o) => o.id === x)?.label ?? x;
  if (x && typeof x === "object" && "ref" in x) {
    const m = x as PlaybookModel;
    return m.choice.effort ? `${m.ref} (${m.choice.effort})` : m.ref;
  }
  if (x && typeof x === "object" && "model" in x) {
    const m = x as PlaybookModelPick;
    return m.effort ? `${m.model} (${m.effort})` : m.model;
  }
  return String(x);
}

/** What Start knows beside the choices: the built-in slots (shared/playbook-format.ts RUN_SLOTS, EACH_SLOT). */
export interface SlotContext {
  /** The run folder; before Start, words saying it is made then. */
  run?: string;
  /** The playbook's own folder. */
  folder: string;
  /** Which helper this is: the item of its `per` input, or "2 of 3". */
  each?: string;
}

const RUN_FOLDER_LATER = "(the run folder, made at Start)";

/** A role's prompt with its {{slots}} filled: each input by its id, the built-in run, folder, note and each. */
export function fillSlots(text: string, spec: PlaybookSpec, edits: PlaybookCardEdits, env: Pick<CardEnv, "valueText">, ctx: SlotContext & { note?: string }): string {
  // With no note, a line that only carries the note goes, rather than reading as a dangling label.
  const lines = ctx.note ? text : text.split("\n").filter((l) => !/\{\{\s*note\s*\}\}/.test(l)).join("\n");
  return lines.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (whole, id: string) => {
    if (id === "run") return ctx.run ?? RUN_FOLDER_LATER;
    if (id === "folder") return ctx.folder;
    if (id === "note") return ctx.note ?? "";
    if (id === EACH_SLOT) return ctx.each ?? "";
    const input = spec.inputs.find((i) => i.id === id);
    if (input) {
      const v = valueOf(edits, input);
      return isEmpty(v) ? "(not set)" : env.valueText(input, v);
    }
    if (spec.facts.some((f) => f.id === id)) return "(not looked up)";
    return whole;
  });
}

/** The exact brief a helper gets: its prompt filled in, the blind rule when it judges blind, and your note
    when the prompt doesn't place it itself with {{note}}. */
export function briefOf(role: PlaybookRole, spec: PlaybookSpec, edits: PlaybookCardEdits, env: Pick<CardEnv, "valueText" | "prompts">, ctx: SlotContext): string {
  const raw = env.prompts[role.id];
  const note = edits.roles?.[role.id]?.note?.trim() ?? "";
  const text = typeof raw === "string" ? fillSlots(raw, spec, edits, env, { ...ctx, note }) : `(${raw?.error ?? "No prompt page."})`;
  const parts = [text.replace(/\s+$/, "")];
  if (role.sees === "blind") parts.push("You judge blind: you are never told which arm or version produced what you are given, and you must not try to find out.");
  if (note && !(typeof raw === "string" && /\{\{\s*note\s*\}\}/.test(raw))) parts.push(`Note for this run: ${note}`);
  return `${parts.join("\n\n")}\n`;
}

/** Each helper of a role: its {{each}} words and a file-name part. */
export function helpersOf(role: PlaybookRole, spec: PlaybookSpec, edits: PlaybookCardEdits): { each?: string; key: string }[] {
  const count = roleCount(role, spec, edits);
  if (count.items) return count.items.map((item, k) => ({ each: item, key: `${k + 1}-${slug(item)}` }));
  if (count.n <= 1) return [{ key: "" }];
  return Array.from({ length: count.n }, (_, k) => ({ each: `${k + 1} of ${count.n}`, key: String(k + 1) }));
}

// ── models ─────────────────────────────────────────────────────────────────────────────────────

const pickOf = (role: PlaybookRole, edits: PlaybookCardEdits): WorkerChoice | null => {
  const p = edits.roles?.[role.id]?.pick;
  return p ? choiceOfRef(p.model, p.effort) : null;
};

const asPick = (c: WorkerChoice): PlaybookModelPick => ({ model: refOfChoice(c), ...(c.effort ? { effort: c.effort } : {}) });

function modelView(e: ChainEntry, env: CardEnv): PlaybookModelView {
  const n = env.name(e.choice);
  return { ...asPick(e.choice), label: n.label, provider: n.provider, usable: !e.why, ...(e.why ? { why: e.why } : {}) };
}

const SOURCE: Record<string, PlaybookModelSource> = { pick: "card", list: "list", profile: "profile", chat: "chat" };

export function resolveRole(role: PlaybookRole, edits: PlaybookCardEdits, env: CardEnv): ResolvedRoleModel {
  const as = role.id === MAIN_ROLE ? "main" : "helper";
  return env.resolve({ pick: pickOf(role, edits), list: role.models.map((m) => m.choice), only: role.only, ...(role.kind ? { kind: role.kind } : {}) }, as);
}

// ── the view ───────────────────────────────────────────────────────────────────────────────────

function choiceView(input: PlaybookInput, r: Pick<PlaybookRunRecord, "initial" | "edits">, edits: PlaybookCardEdits): PlaybookChoiceView {
  const value = valueOf(edits, input);
  const origin = r.edits.choices && input.id in r.edits.choices ? "you" : (r.initial.origins[input.id] ?? "default");
  return {
    id: input.id,
    label: input.label,
    ...(input.help ? { help: input.help } : {}),
    type: input.type,
    ...(input.type === "choice" || input.type === "multi" ? { options: input.options.map((o) => ({ value: o.id, label: o.label })) } : {}),
    ...(input.type === "number" && input.min !== undefined ? { min: input.min } : {}),
    ...(input.type === "number" && input.max !== undefined ? { max: input.max } : {}),
    value: input.type === "models" && Array.isArray(value) ? (value as (PlaybookModel | PlaybookModelPick)[]).map((m) => ("ref" in m ? { model: m.ref, ...(m.choice.effort ? { effort: m.choice.effort } : {}) } : m)) : value,
    origin,
    required: input.required,
    ask: input.ask,
    ...(input.each === "cycle" ? { eachCycle: true } : {}),
  };
}

/** Which helper roles a step uses (main never counts as a helper). */
const helperRoles = (step: PlaybookStep, spec: PlaybookSpec, edits: PlaybookCardEdits): PlaybookRole[] =>
  step.roles.filter((id) => id !== MAIN_ROLE).map((id) => spec.roles.find((r) => r.id === id)).filter((r): r is PlaybookRole => !!r && roleOn(r, edits));

export interface BuiltCard {
  view: PlaybookRunView;
  /** Each role resolved (on roles only). */
  resolved: Record<string, ResolvedRoleModel>;
}

export function runCard(r: PlaybookRunRecord, spec: PlaybookSpec, env: CardEnv, opts: { mainMessage?: string; runFolder?: string } = {}): BuiltCard {
  const edits = effectiveEdits(r);
  const choices = spec.inputs.map((i) => choiceView(i, r, edits));
  const resolved: Record<string, ResolvedRoleModel> = {};
  const steps = flatSteps(spec.steps);
  const teamOf = new Map<string, string>();
  for (const { step } of steps) if (step.team) for (const role of helperRoles(step, spec, edits)) if (!teamOf.has(role.id)) teamOf.set(role.id, step.id);

  const roles: PlaybookRoleView[] = spec.roles.map((role) => {
    const on = roleOn(role, edits);
    const res = resolveRole(role, edits, env);
    if (on) resolved[role.id] = res;
    const count = role.id === MAIN_ROLE ? { n: 1 } : roleCount(role, spec, edits);
    const names = res.use ? env.name(res.use) : null;
    const note = edits.roles?.[role.id]?.note ?? "";
    const prompt = role.id === MAIN_ROLE ? (opts.mainMessage ?? (typeof env.prompts[MAIN_ROLE] === "string" ? (env.prompts[MAIN_ROLE] as string) : "")) : briefOf(role, spec, edits, env, { folder: r.playbook.dir, ...(helpersOf(role, spec, edits)[0]?.each ? { each: helpersOf(role, spec, edits)[0]!.each } : {}), ...(opts.runFolder ? { run: opts.runFolder } : {}) });
    return {
      id: role.id,
      label: role.id === MAIN_ROLE ? role.label || "Main chat" : role.label,
      main: role.id === MAIN_ROLE,
      ...(role.kind ? { kind: role.kind } : {}),
      count: count.n,
      ...(role.per ? { per: spec.inputs.find((i) => i.id === role.per!.input)?.label ?? role.per.input } : {}),
      optional: role.optional,
      on,
      only: role.only,
      chain: [...(pickOf(role, edits) ? [asPick(pickOf(role, edits)!)] : []), ...role.models.map((m) => asPick(m.choice))],
      models: res.chain.map((e) => modelView(e, env)),
      options: role.models.map((m) => asPick(m.choice)),
      resolved: res.use && names ? { model: refOfChoice(res.use), modelLabel: names.label, provider: names.provider, ...(res.use.effort ? { effort: res.use.effort } : {}), source: SOURCE[res.source] ?? "chat", ...(res.reason ? { reason: res.reason } : {}) } : null,
      runnable: !!res.use,
      note,
      prompt,
      ...(teamOf.has(role.id) ? { team: teamOf.get(role.id) } : {}),
    };
  });

  const teams: PlaybookTeamView[] = [];
  const stepViews: PlaybookStepView[] = steps.map(({ step, cycle }) => {
    const helpers = helperRoles(step, spec, edits);
    if (step.team && helpers.length) {
      const c = env.name(choiceOfRef(env.team.coordinator.model, env.team.coordinator.effort));
      const m = env.name(choiceOfRef(env.team.monitor.model, env.team.monitor.effort));
      teams.push({
        id: step.id,
        label: step.label,
        roles: helpers.map((h) => h.id),
        coordinator: { modelLabel: c.label, ...(env.team.coordinator.effort ? { effort: env.team.coordinator.effort } : {}) },
        monitor: { modelLabel: m.label, ...(env.team.monitor.effort ? { effort: env.team.monitor.effort } : {}) },
      });
    }
    return {
      id: step.id,
      title: step.label,
      stop: step.stop ?? "never",
      stopOn: stopOn(step, edits),
      runs: !helpers.length ? "main" : step.team ? "team" : "helpers",
      ...(step.team && helpers.length ? { team: step.id } : {}),
      roles: step.roles,
      ...(step.report ? { report: step.report } : {}),
      ...(cycle ? { cycle: true } : {}),
    };
  });

  const group = spec.steps.find((s): s is Extract<PlaybookFlowItem, { kind: "cycle" }> => s.kind === "cycle");
  const cycle = group
    ? {
        steps: group.steps.map((s) => s.id),
        max: edits.cycle?.max ?? group.settings.max,
        maxCap: CYCLE_MAX,
        askEvery: edits.cycle?.askEvery ?? group.settings.askEvery,
        until: edits.cycle?.until ?? group.settings.until,
        ...(group.rule ? { rule: group.rule } : {}),
      }
    : null;

  // Every helper the plan starts, once each, plus each team's coordinator and monitor.
  const helperTotal = roles.filter((x) => !x.main && x.on).reduce((n, x) => n + x.count, 0) + 2 * teams.length;
  const view: PlaybookRunView = {
    id: r.id,
    revision: r.revision,
    playbook: { source: r.playbook.source, id: r.playbook.id, title: r.playbook.title, dir: r.playbook.dir },
    state: r.state,
    choices,
    roles,
    teams,
    steps: stepViews,
    cycle,
    howItRuns: howItRuns(spec, r),
    commands: spec.commands.filter((id) => env.commandChanges(id)).map((id) => env.commandLabel(id)),
    helpers: { total: helperTotal, limit: HELPER_LIMIT },
    startBlocked: null,
    ...(r.started ? { started: r.started } : {}),
    ...(r.startError ? { startError: r.startError } : {}),
  };
  view.startBlocked = blocked(view, spec, edits, env, teams);
  return { view, resolved };
}

/** Whether the run goes to a new chat: the playbook asks for one (its own powers always do), or no chat showed the card. */
export const runsInNewChat = (spec: PlaybookSpec, r: Pick<PlaybookRunRecord, "shownIn">): boolean => spec.run.where === "new-chat" || !!spec.run.permissions || !r.shownIn;

function howItRuns(spec: PlaybookSpec, r: PlaybookRunRecord): string {
  const parts: string[] = [];
  if (!runsInNewChat(spec, r)) parts.push("Runs in this chat");
  else if (spec.run.permissions) parts.push("Runs in a new chat set up with the powers this playbook asks for");
  else parts.push("Runs in a new chat");
  if (spec.run.worktree === "new") parts.push("in a new worktree");
  if (spec.run.mode === "delegate") parts.push("in Delegate mode");
  return `${parts.join(", ")}.`;
}

function blocked(view: PlaybookRunView, spec: PlaybookSpec, edits: PlaybookCardEdits, env: CardEnv, teams: PlaybookTeamView[]): string | null {
  if (view.state !== "draft") return view.state === "starting" ? "Starting…" : "This run has started.";
  if (env.needs) return env.needs;
  for (const input of spec.inputs) {
    const v = valueOf(edits, input);
    if (isEmpty(v)) {
      if (input.required) return `Fill in ${input.label} first.`;
      continue;
    }
    const why = env.checkValue(input, v);
    if (why) return why;
  }
  for (const role of view.roles) {
    if (!role.on) continue;
    if (!role.runnable) return `${role.label} has no model that can run here: ${role.models.map((m) => `${m.label} (${m.why ?? "can't run"})`).join(", ") || "its list is empty"}.`;
    if (!role.main && role.count < 1) return `${role.label} has nobody to run: ${role.per ? `pick at least one in ${role.per}` : "its count is 0"}.`;
    const p = env.prompts[role.id];
    if (!role.main && typeof p !== "string") return `${role.label}'s prompt can't be read: ${p?.error ?? "no prompt page"}.`;
  }
  if (view.helpers.total > view.helpers.limit) return `The plan needs ${view.helpers.total} helpers, and one chat runs at most ${view.helpers.limit} at once.`;
  for (const t of teams) {
    const seats = view.roles.filter((x) => t.roles.includes(x.id)).reduce((n, x) => n + x.count, 0) + 2;
    if (seats > HELPER_LIMIT) return `The team "${t.label}" needs ${seats} seats, and a team seats at most ${HELPER_LIMIT}.`;
  }
  if (view.cycle && (view.cycle.max < 1 || view.cycle.max > CYCLE_MAX || view.cycle.askEvery < 1 || view.cycle.askEvery > view.cycle.max)) return `The cycle settings don't fit: at most 1 to ${CYCLE_MAX} cycles, asking every 1 to that many.`;
  return null;
}

// ── the frozen plan ────────────────────────────────────────────────────────────────────────────

export interface PlanModel {
  /** As a playbook writes it: "provider/id", or "claude-code/<id>". */
  model: string;
  backend: WorkerChoice["backend"];
  effort?: string;
  /** Where it came from in the chain. */
  from: "card" | "list" | "profile" | "chat";
  /** Why it couldn't run at Start; absent: it could. */
  why?: string;
}

export interface PlanRole {
  id: string;
  label: string;
  main: boolean;
  kind?: string;
  count: number;
  /** One helper per item: the items. */
  items?: string[];
  only: boolean;
  /** The whole ordered chain; `use` is the index of the one it starts on. */
  chain: PlanModel[];
  use: number;
  reason?: string;
  note?: string;
  sees: "all" | "blind";
  fresh: "run" | "cycle";
  /** Brief files, relative to the run folder: one, or one per item. */
  briefs: string[];
  team?: string;
}

export interface PlanStep {
  id: string;
  label: string;
  roles: string[];
  runs: "main" | "team" | "helpers";
  team?: string;
  /** It stops here and asks you. */
  stop: boolean;
  asks: string[];
  report?: string;
  phase?: string;
  cycle?: string;
}

export interface PlanTeam {
  id: string;
  label: string;
  roles: string[];
  /** team_create's argument, relative to the run folder. */
  file: string;
}

export interface PlaybookPlan {
  v: 1;
  runId: string;
  revision: number;
  at: string;
  playbook: PlaybookRef;
  /** Your choices as frozen: id → label, value and its words. */
  choices: { id: string; label: string; value: InputValue | null; text: string }[];
  roles: PlanRole[];
  teams: PlanTeam[];
  steps: PlanStep[];
  cycle: { id: string; label: string; max: number; askEvery: number; until: "rule" | "max"; rule?: string; carry?: string; steps: string[] } | null;
  run: { chat: "this" | "new"; worktree: "none" | "new"; mode?: string; minorModes?: string[]; permissions: boolean };
  commands: string[];
  /** Your words typed after /<id>. */
  text?: string;
  /** The card as it was drawn at Start: the record a started run's card shows. */
  view: PlaybookRunView;
}

export interface PlanFiles {
  plan: PlaybookPlan;
  /** Files to write in the run folder: relative path → text. */
  files: Record<string, string>;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";

/** Freeze the card: the plan, and every file the run folder gets (briefs, team layouts, the plan itself). */
export function freezePlan(r: PlaybookRunRecord, spec: PlaybookSpec, env: CardEnv, card: BuiltCard, newChat: boolean, at: string, folder: string): PlanFiles {
  const edits = effectiveEdits(r);
  const files: Record<string, string> = {};
  const roles: PlanRole[] = [];
  for (const role of spec.roles) {
    const res = card.resolved[role.id];
    if (!res || !roleOn(role, edits)) continue;
    const count = role.id === MAIN_ROLE ? { n: 1 } : roleCount(role, spec, edits);
    const chain: PlanModel[] = res.chain.map((e) => ({ model: refOfChoice(e.choice), backend: e.choice.backend, ...(e.choice.effort ? { effort: e.choice.effort } : {}), from: SOURCE[e.source] ?? "chat", ...(e.why ? { why: e.why } : {}) }));
    const use = res.use ? res.chain.findIndex((e) => e.choice.backend === res.use!.backend && e.choice.model === res.use!.model && !e.why) : -1;
    const briefs: string[] = [];
    if (role.id !== MAIN_ROLE)
      for (const h of helpersOf(role, spec, edits)) {
        const f = `briefs/${role.id}${h.key ? `.${h.key}` : ""}.md`;
        files[f] = briefOf(role, spec, edits, env, { folder: r.playbook.dir, run: folder, ...(h.each ? { each: h.each } : {}) });
        briefs.push(f);
      }
    const view = card.view.roles.find((v) => v.id === role.id);
    roles.push({
      id: role.id,
      label: view?.label ?? role.label,
      main: role.id === MAIN_ROLE,
      ...(role.kind ? { kind: role.kind } : {}),
      count: count.n,
      ...(count.items ? { items: count.items } : {}),
      only: role.only,
      chain,
      use,
      ...(res.reason ? { reason: res.reason } : {}),
      ...(edits.roles?.[role.id]?.note?.trim() ? { note: edits.roles[role.id]!.note!.trim() } : {}),
      sees: role.sees,
      fresh: role.fresh,
      briefs,
      ...(view?.team ? { team: view.team } : {}),
    });
  }

  const steps: PlanStep[] = flatSteps(spec.steps).map(({ step, cycle }) => {
    const v = card.view.steps.find((s) => s.id === step.id)!;
    return {
      id: step.id,
      label: step.label,
      roles: step.roles,
      runs: v.runs,
      ...(v.team ? { team: v.team } : {}),
      stop: v.stopOn,
      asks: step.asks,
      ...(step.report ? { report: step.report } : {}),
      ...(step.phase ? { phase: step.phase } : {}),
      ...(cycle ? { cycle } : {}),
    };
  });

  const teams: PlanTeam[] = card.view.teams.map((t) => {
    const file = `teams/${t.id}.json`;
    const members = t.roles.flatMap((id) => {
      const p = roles.find((x) => x.id === id);
      if (!p) return [];
      const m = p.chain[p.use];
      const one = (brief: string, n: number) => ({
        role: p.count > 1 ? `${p.id}-${n}` : p.id,
        prompt: files[brief] ?? "",
        ...(m ? { backend: m.backend, model: m.backend === "claude-code" ? m.model.replace(/^claude-code\//, "") : m.model, ...(m.effort ? { effort: m.effort } : {}) } : {}),
        ...(p.kind ? { kind: p.kind } : {}),
      });
      return p.briefs.map((b, k) => one(b, k + 1));
    });
    files[file] = `${JSON.stringify({ name: `${r.playbook.id}-${t.id}`, objective: `${r.playbook.title}: ${t.label}`, members }, null, 2)}\n`;
    return { id: t.id, label: t.label, roles: t.roles, file };
  });

  const group = spec.steps.find((s): s is Extract<PlaybookFlowItem, { kind: "cycle" }> => s.kind === "cycle");
  const plan: PlaybookPlan = {
    v: 1,
    runId: r.id,
    revision: r.revision,
    at,
    playbook: r.playbook,
    choices: spec.inputs.map((input) => {
      const v = valueOf(edits, input);
      return { id: input.id, label: input.label, value: isEmpty(v) ? null : (v as InputValue), text: isEmpty(v) ? "(not set)" : env.valueText(input, v) };
    }),
    roles,
    teams,
    steps,
    cycle: group && card.view.cycle ? { id: group.id, label: group.label, max: card.view.cycle.max, askEvery: card.view.cycle.askEvery, until: card.view.cycle.until ?? group.settings.until, ...(group.rule ? { rule: group.rule } : {}), ...(group.carry ? { carry: group.carry } : {}), steps: group.steps.map((s) => s.id) } : null,
    run: { chat: newChat ? "new" : "this", worktree: spec.run.worktree, ...(spec.run.mode ? { mode: spec.run.mode } : {}), ...(spec.run.minorModes ? { minorModes: [...spec.run.minorModes] } : {}), permissions: !!spec.run.permissions },
    commands: spec.commands.filter((id) => env.commandChanges(id)),
    ...(r.text?.trim() ? { text: r.text.trim() } : {}),
    view: card.view,
  };
  const { view: _view, ...onDisk } = plan;
  files["plan.json"] = `${JSON.stringify(onDisk, null, 2)}\n`;
  return { plan, files };
}
