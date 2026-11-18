// The card a run draws and the plan Start freezes, from the
// playbook's description, the run's draft and what this computer can run now. Pure: the environment (which
// models can run, their names, your profile's routes, team defaults) comes in as `CardEnv`.
import { choiceOfRef, CYCLE_MAX, fillSlots, isPageRef, refOfChoice, type InputValue, type PlaybookFlowItem, type PlaybookInput, type PlaybookMember, type PlaybookModel, type PlaybookSpec, type PlaybookStep, type PlaybookTeam } from "../../shared/playbook-format";
import { playbookFlowSource, type FlowProgress, type FlowSource } from "../../shared/playbook-flow";
import type { ChainEntry, KindRoute, ResolvedRoleModel } from "../../shared/playbook-models";
import { HELPER_LIMIT, mergeEdits, type PlaybookCardEdits, type PlaybookChoiceView, type PlaybookModelPick, type PlaybookModelSource, type PlaybookMemberView, type PlaybookModelView, type PlaybookRunView, type PlaybookStepView, type PlaybookTeamView } from "../../shared/playbook-run";
import type { DelegateProfileId, WorkerChoice } from "../../shared/protocol";
import type { PlaybookRef, PlaybookRunRecord } from "./store";

export interface CardEnv {
  /** Why this folder can't run the playbook (its run.needs: a project, one the merge queue serves), or null. */
  needs: string | null;
  /** Why this model can't run here now, for a helper (a worker); null: it can. */
  denial(c: WorkerChoice, as: "main" | "helper"): string | null;
  /** "GLM 5.3", and the provider's id ("zai", "claude-code"). */
  name(c: WorkerChoice): { label: string; provider: string };
  /** Your profile's routes by kind of work; null: it routes none. */
  routes: Partial<Record<DelegateProfileId, KindRoute>> | null;
  /** The conducting chat's own model now (null: unknown, or no chat yet). */
  chat: WorkerChoice | null;
  /** The coordinator and monitor Sova adds to every team, on their models from Settings. */
  team: { coordinator: { model: string; effort?: string }; monitor: { model: string; effort?: string } };
  /** A page of the playbook's folder (relative), or null when it can't be read. */
  page(rel: string): string | null;
  /** A catalogue command's label. */
  commandLabel(id: string): string;
  /** Whether a catalogue command changes things (only those are shown and listed: looking ones are free). */
  commandChanges(id: string): boolean;
  /** The model resolver (shared/playbook-models.ts resolveRoleModel). */
  resolve(input: { pick?: WorkerChoice | null; list: readonly WorkerChoice[]; only: boolean; kind?: DelegateProfileId }, as: "main" | "helper"): ResolvedRoleModel;
  /** A choice's value checked against its input: why it is wrong, or null (shared/playbook-format.ts). */
  checkValue(input: PlaybookInput, value: unknown): string | null;
  /** A choice's value as the words a goal's or brief's {{slot}} takes. */
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

/** How many helpers of a member: its count (a number, or a number input's value), else one per item of its `per` input. */
export function roleCount(role: PlaybookMember, spec: PlaybookSpec, edits: PlaybookCardEdits): { n: number; items?: string[] } {
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

const roleOn = (role: PlaybookMember, edits: PlaybookCardEdits): boolean => !role.optional || (edits.roles?.[role.id]?.on ?? !role.startsOff);

const stopOn = (step: PlaybookStep, edits: PlaybookCardEdits): boolean => step.stop === "always" || (step.stop === "optional" && (edits.stops?.[step.id] ?? !step.startsOff));

/** One item of a list, multi or models value, in words. */
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

/** A goal's or brief's {{slots}} filled from your choices; a slot with no value yet, or a fact not looked up, stays as written. */
export function filled(text: string, spec: PlaybookSpec, edits: PlaybookCardEdits, env: Pick<CardEnv, "valueText">): string {
  const words: Record<string, string> = {};
  for (const input of spec.inputs) {
    const v = valueOf(edits, input);
    if (!isEmpty(v)) words[input.id] = env.valueText(input, v);
  }
  return fillSlots(text, words);
}

/** The one-line notes on the card: trimmed, empty when none. */
const noteOf = (n: string | undefined): string => n?.trim() ?? "";

// ── models ─────────────────────────────────────────────────────────────────────────────────────

const pickOf = (role: PlaybookMember, edits: PlaybookCardEdits): WorkerChoice | null => {
  const p = edits.roles?.[role.id]?.pick;
  return p ? choiceOfRef(p.model, p.effort) : null;
};

const asPick = (c: WorkerChoice): PlaybookModelPick => ({ model: refOfChoice(c), ...(c.effort ? { effort: c.effort } : {}) });

function modelView(e: ChainEntry, env: CardEnv): PlaybookModelView {
  const n = env.name(e.choice);
  return { ...asPick(e.choice), label: n.label, provider: n.provider, usable: !e.why, ...(e.why ? { why: e.why } : {}) };
}

const SOURCE: Record<string, PlaybookModelSource> = { pick: "card", list: "list", profile: "profile", chat: "chat" };

export function resolveRole(role: PlaybookMember, edits: PlaybookCardEdits, env: CardEnv): ResolvedRoleModel {
  return env.resolve({ pick: pickOf(role, edits), list: role.models.map((m) => m.choice), only: role.only, ...(role.kind ? { kind: role.kind } : {}) }, "helper");
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
    ...(input.type === "text" && input.multiline ? { multiline: true as const } : {}),
  };
}

export interface BuiltCard {
  view: PlaybookRunView;
  /** Each member turned on, resolved. */
  resolved: Record<string, ResolvedRoleModel>;
}

export function runCard(r: PlaybookRunRecord, spec: PlaybookSpec, env: CardEnv): BuiltCard {
  const edits = effectiveEdits(r);
  const choices = spec.inputs.map((i) => choiceView(i, r, edits));
  const resolved: Record<string, ResolvedRoleModel> = {};
  const steps = flatSteps(spec.steps);

  const memberView = (m: PlaybookMember): PlaybookMemberView => {
    const on = roleOn(m, edits);
    const res = resolveRole(m, edits, env);
    if (on) resolved[m.id] = res;
    const names = res.use ? env.name(res.use) : null;
    const pick = pickOf(m, edits);
    return {
      id: m.id,
      label: m.label,
      brief: filled(m.brief, spec, edits, env),
      ...(m.notes ? { notes: m.notes } : {}),
      ...(m.kind ? { kind: m.kind } : {}),
      count: roleCount(m, spec, edits).n,
      ...(m.per ? { per: spec.inputs.find((i) => i.id === m.per!.input)?.label ?? m.per.input } : {}),
      optional: m.optional,
      on,
      only: m.only,
      chain: [...(pick ? [asPick(pick)] : []), ...m.models.map((x) => asPick(x.choice))],
      models: res.chain.map((e) => modelView(e, env)),
      options: m.models.map((x) => asPick(x.choice)),
      resolved: res.use && names ? { model: refOfChoice(res.use), modelLabel: names.label, provider: names.provider, ...(res.use.effort ? { effort: res.use.effort } : {}), source: SOURCE[res.source] ?? "chat", ...(res.reason ? { reason: res.reason } : {}) } : null,
      runnable: !!res.use,
      note: edits.roles?.[m.id]?.note ?? "",
    };
  };

  const teams: PlaybookTeamView[] = spec.teams.map((t) => ({
    id: t.id,
    label: t.label,
    goal: filled(t.goal, spec, edits, env),
    steps: steps.filter(({ step }) => step.teams.includes(t.id)).map(({ step }) => step.id),
    note: edits.teams?.[t.id]?.note ?? "",
    members: t.members.map(memberView),
  }));

  const stepViews: PlaybookStepView[] = steps.map(({ step, cycle }) => ({
    id: step.id,
    title: step.label,
    ...(step.goal ? { goal: filled(step.goal, spec, edits, env) } : {}),
    stop: step.stop ?? "never",
    stopOn: stopOn(step, edits),
    teams: [...step.teams],
    ...(step.report ? { report: step.report } : {}),
    ...(cycle ? { cycle: true } : {}),
  }));

  const group = spec.steps.find((s): s is Extract<PlaybookFlowItem, { kind: "cycle" }> => s.kind === "cycle");
  const cycle = group
    ? {
        steps: group.steps.map((s) => s.id),
        max: edits.cycle?.max ?? group.settings.max,
        maxCap: CYCLE_MAX,
        askEvery: edits.cycle?.askEvery ?? group.settings.askEvery,
        until: edits.cycle?.until ?? group.settings.until,
        ...(group.rule ? { rule: ruleWords(group.rule, env) } : {}),
      }
    : null;

  const flow = cardFlow(spec, edits);

  // Every helper the plan starts, once each, plus each team's coordinator and monitor (never shown as rows).
  const on = teams.flatMap((t) => t.members.filter((m) => m.on));
  const helperTotal = on.reduce((n, m) => n + m.count, 0) + 2 * teams.length;
  const view: PlaybookRunView = {
    id: r.id,
    revision: r.revision,
    playbook: { source: r.playbook.source, id: r.playbook.id, title: r.playbook.title, dir: r.playbook.dir },
    state: r.state,
    choices,
    teams,
    who: { teams: teams.length, members: on.length },
    steps: stepViews,
    cycle,
    flow,
    howItRuns: howItRuns(spec, r),
    commands: spec.commands.filter((id) => env.commandChanges(id)).map((id) => env.commandLabel(id)),
    helpers: { total: helperTotal, limit: HELPER_LIMIT },
    startBlocked: null,
    ...(r.started ? { started: r.started } : {}),
    ...(r.startError ? { startError: r.startError } : {}),
  };
  view.startBlocked = r.aligning ? "Waiting for the alignment to be decided in the chat." : blocked(view, spec, edits, env);
  if (r.aligning) view.aligning = true;
  return { view, resolved };
}

/** The card's flow drawing: its cycle settings and optional stops as they stand. A started run's record knows only
    that it started (not the step, nor whether it stopped or finished), and its drawing says so. */
export function cardFlow(spec: PlaybookSpec, edits: PlaybookCardEdits, progress?: FlowProgress): FlowSource {
  const group = spec.steps.find((s): s is Extract<PlaybookFlowItem, { kind: "cycle" }> => s.kind === "cycle");
  const cycle = group ? { max: edits.cycle?.max ?? group.settings.max, askEvery: edits.cycle?.askEvery ?? group.settings.askEvery, until: edits.cycle?.until ?? group.settings.until } : null;
  const stops = Object.fromEntries(flatSteps(spec.steps).filter(({ step }) => step.stop === "optional").map(({ step }) => [step.id, stopOn(step, edits)]));
  return playbookFlowSource(spec, { ...(cycle ? { cycle } : {}), stops, ...(progress ? { progress } : {}) });
}

/** A cycle's stop rule in words: written out, or a page's first paragraph, plain. */
export function ruleWords(rule: string, env: Pick<CardEnv, "page">): string {
  if (!isPageRef(rule)) return rule;
  const text = env.page(rule);
  if (!text) return rule;
  const plain = (p: string) => p.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]+/g, "");
  const paras = text
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#"));
  if (!paras.length) return rule;
  let words = plain(paras[0]!).replace(/\s+/g, " ").trim();
  // A lead-in ("…when any of these holds:") takes the list after it.
  if (words.endsWith(":") && paras[1]) words += ` ${plain(paras[1]).split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim().replace(/\.$/, "")).filter(Boolean).join("; ")}.`;
  return words;
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

function blocked(view: PlaybookRunView, spec: PlaybookSpec, edits: PlaybookCardEdits, env: CardEnv): string | null {
  if (view.state !== "draft") return view.state === "starting" ? "Starting…" : "This run has started.";
  if (env.needs) return env.needs;
  for (const input of spec.inputs) {
    const v = valueOf(edits, input);
    if (isEmpty(v)) {
      if (input.required) return input.ask === "chat" ? `Work out ${input.label} with the chat first.` : `Fill in ${input.label} first.`;
      continue;
    }
    const why = env.checkValue(input, v);
    if (why) return why;
  }
  for (const t of view.teams)
    for (const m of t.members) {
      if (!m.on) continue;
      if (!m.runnable) return `${m.label} has no model that can run here: ${m.models.map((x) => `${x.label} (${x.why ?? "can't run"})`).join(", ") || "its list is empty"}.`;
      if (m.count < 1) return `${m.label} has nobody to run: ${m.per ? `pick at least one in ${m.per}` : "its count is 0"}.`;
    }
  if (view.helpers.total > view.helpers.limit) return `The plan needs ${view.helpers.total} helpers, and one chat runs at most ${view.helpers.limit} at once.`;
  for (const t of view.teams) {
    const seats = t.members.filter((m) => m.on).reduce((n, m) => n + m.count, 0) + 2;
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

export interface PlanMember {
  id: string;
  label: string;
  team: string;
  /** One line: why it is on the team, your choices filled in. */
  brief: string;
  /** Its working notes page, relative to the playbook's folder. */
  notes?: string;
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
}

export interface PlanStep {
  id: string;
  label: string;
  goal?: string;
  /** The teams that work in it; none: the main chat alone. */
  teams: string[];
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
  goal: string;
  note?: string;
  /** The steps it works in. */
  steps: string[];
  /** Its required members turned on, by id (each in `members`). */
  members: string[];
}

export interface PlaybookPlan {
  v: 1;
  runId: string;
  revision: number;
  at: string;
  playbook: PlaybookRef;
  /** Your choices as frozen: id → label, value and its words. */
  choices: { id: string; label: string; value: InputValue | null; text: string }[];
  teams: PlanTeam[];
  members: PlanMember[];
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

/** Freeze the card: the plan, and the file the run folder gets. No member prompt is filled in: each team's
    coordinator writes its members' instructions from the team's goal and their briefs. */
export function freezePlan(r: PlaybookRunRecord, spec: PlaybookSpec, env: CardEnv, card: BuiltCard, newChat: boolean, at: string): PlanFiles {
  const edits = effectiveEdits(r);
  const members: PlanMember[] = [];
  const teams: PlanTeam[] = spec.teams.map((t: PlaybookTeam) => {
    const tv = card.view.teams.find((x) => x.id === t.id)!;
    const ids: string[] = [];
    for (const m of t.members) {
      const res = card.resolved[m.id];
      if (!res || !roleOn(m, edits)) continue;
      const count = roleCount(m, spec, edits);
      const chain: PlanModel[] = res.chain.map((e) => ({ model: refOfChoice(e.choice), backend: e.choice.backend, ...(e.choice.effort ? { effort: e.choice.effort } : {}), from: SOURCE[e.source] ?? "chat", ...(e.why ? { why: e.why } : {}) }));
      const use = res.use ? res.chain.findIndex((e) => e.choice.backend === res.use!.backend && e.choice.model === res.use!.model && !e.why) : -1;
      const note = noteOf(edits.roles?.[m.id]?.note);
      members.push({
        id: m.id,
        label: m.label,
        team: t.id,
        brief: filled(m.brief, spec, edits, env),
        ...(m.notes ? { notes: m.notes } : {}),
        ...(m.kind ? { kind: m.kind } : {}),
        count: count.n,
        ...(count.items ? { items: count.items } : {}),
        only: m.only,
        chain,
        use,
        ...(res.reason ? { reason: res.reason } : {}),
        ...(note ? { note } : {}),
        sees: m.sees,
        fresh: m.fresh,
      });
      ids.push(m.id);
    }
    const note = noteOf(edits.teams?.[t.id]?.note);
    return { id: t.id, label: t.label, goal: tv.goal, ...(note ? { note } : {}), steps: tv.steps, members: ids };
  });

  const steps: PlanStep[] = flatSteps(spec.steps).map(({ step, cycle }) => {
    const v = card.view.steps.find((s) => s.id === step.id)!;
    return {
      id: step.id,
      label: step.label,
      ...(v.goal ? { goal: v.goal } : {}),
      teams: [...step.teams],
      stop: v.stopOn,
      asks: step.asks,
      ...(step.report ? { report: step.report } : {}),
      ...(step.phase ? { phase: step.phase } : {}),
      ...(cycle ? { cycle } : {}),
    };
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
    teams,
    members,
    steps,
    cycle: group && card.view.cycle ? { id: group.id, label: group.label, max: card.view.cycle.max, askEvery: card.view.cycle.askEvery, until: card.view.cycle.until ?? group.settings.until, ...(group.rule ? { rule: group.rule } : {}), ...(group.carry ? { carry: group.carry } : {}), steps: group.steps.map((s) => s.id) } : null,
    run: { chat: newChat ? "new" : "this", worktree: spec.run.worktree, ...(spec.run.mode ? { mode: spec.run.mode } : {}), ...(spec.run.minorModes ? { minorModes: [...spec.run.minorModes] } : {}), permissions: !!spec.run.permissions },
    commands: spec.commands.filter((id) => env.commandChanges(id)),
    ...(r.text?.trim() ? { text: r.text.trim() } : {}),
    view: card.view,
  };
  const { view: _view, ...onDisk } = plan;
  return { plan, files: { "plan.json": `${JSON.stringify(onDisk, null, 2)}\n` } };
}
