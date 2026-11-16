/**
 * A playbook's declaration: the optional `playbook.json` beside its PLAYBOOK.md,
 * strictly parsed like an automation file (shared/automations.ts parseAutomation): every key known,
 * every type right, or the exact error. A playbook without one works exactly as before (text only).
 *
 * It declares four things: your choices (`inputs`, plus `facts` a look-up may fill), the cast
 * (`roles`, each with an ordered model chain), the flow (`steps` with stop points and at most one
 * repeating group, or an optional `machine`, never both), and how it runs (`run`). Plus `listed`
 * (false: only Sova starts it; hidden from the Playbooks list and the / rows) and `commands` (the
 * catalogue ids of the Sova commands that change things which the run may use).
 *
 * Pure and shared: no fs, no DOM. Checks that need the folder (does a prompt file exist) take the
 * folder's file list as an argument (validatePlaybookFiles).
 */
import { AUTOMATION_MINOR_MODES, parsePermissions, type AutomationMinorMode, type AutomationPermissions } from "./automations";
import { THINKING_LEVELS } from "./profiles";
import { findCommand } from "./commands-catalog";
import type { DelegateProfileId, WorkerChoice } from "./protocol";

export const PLAYBOOK_JSON = "playbook.json";
export const PLAYBOOK_FORMAT_VERSION = 1;

/** Delegate's four work kinds: a role's fallback to your profile's model for that kind of work. */
export const ROLE_KINDS = ["planning", "investigation", "routine", "complex"] as const satisfies readonly DelegateProfileId[];
export type RoleKind = (typeof ROLE_KINDS)[number];

/** The main chat's role id: always present, declared or not. */
export const MAIN_ROLE = "main";

// ── run ──────────────────────────────────────────────────────────────────────────────────────────

/** "this-chat": the chat where the card was opened conducts it; "new-chat": a new chat does. */
export type PlaybookWhere = "this-chat" | "new-chat";
export type PlaybookWorktree = "none" | "new";
/** What must be true before Start (checked by the card): a project folder; a project the merge queue serves. */
export const PLAYBOOK_NEEDS = ["project", "merge-queue"] as const;
export type PlaybookNeed = (typeof PLAYBOOK_NEEDS)[number];

export interface PlaybookRun {
  where: PlaybookWhere;
  /** True when the card may not switch `where`: a playbook with permissions always runs in a new
      chat (a chat's tools and powers are fixed at its first message). */
  whereFixed: boolean;
  worktree: PlaybookWorktree;
  mode?: "normal" | "delegate";
  /** Exactly these minor modes; absent: the chat's own. */
  minorModes?: AutomationMinorMode[];
  /** The automation file's shape (shared/automations.ts); absent: no change to the chat's powers. */
  permissions?: AutomationPermissions;
  needs: PlaybookNeed[];
}

// ── models ───────────────────────────────────────────────────────────────────────────────────────

/**
 * One entry of a model chain as written: `{"model": "provider/id", "effort": "high"}`. The provider
 * `claude-code` means Sova's Claude backend (`claude-code/claude-opus-5-5`); any other provider is a
 * pi model (`zai/glm-5.3`). `effort` absent: DEFAULT_EFFORT (the server may move it to the nearest
 * effort the model takes, and says so). A WorkerChoice built here never has an empty effort.
 */
export interface PlaybookModel {
  /** As written: "provider/id". */
  ref: string;
  /** In agent_spawn's terms (WorkerChoice); `effort` is DEFAULT_EFFORT when the entry names none. */
  choice: WorkerChoice;
}

/** A chain entry's effort when it names none: agent_spawn's own default for both backends. */
export const DEFAULT_EFFORT = "medium";

/** A model ref as written → agent_spawn's terms. */
export function choiceOfRef(ref: string, effort?: string): WorkerChoice {
  const slash = ref.indexOf("/");
  if (ref.slice(0, slash) === "claude-code") return { backend: "claude-code", model: ref.slice(slash + 1), effort: effort || DEFAULT_EFFORT };
  return { backend: "pi", model: ref, effort: effort || DEFAULT_EFFORT };
}

/** agent_spawn's terms → the ref a playbook writes. */
export function refOfChoice(c: Pick<WorkerChoice, "backend" | "model">): string {
  return c.backend === "claude-code" ? `claude-code/${c.model}` : c.model;
}

// ── inputs (your choices) ────────────────────────────────────────────────────────────────────────

export const INPUT_TYPES = ["text", "number", "toggle", "choice", "multi", "list", "models"] as const;
export type InputType = (typeof INPUT_TYPES)[number];
/** always: open on the card every run; once: a standing answer, asked the first time then folded;
    optional: under More Options. */
export const INPUT_ASKS = ["always", "once", "optional"] as const;
export type InputAsk = (typeof INPUT_ASKS)[number];

export interface InputOption {
  id: string;
  label: string;
  /** Its trade-off in a line, drawn like an alignment question's option. */
  help?: string;
}

interface InputBase {
  id: string;
  label: string;
  help?: string;
  ask: InputAsk;
  /** Start is blocked until it has a value. */
  required: boolean;
  /** "cycle": asked again at each cycle's stop point. */
  each?: "cycle";
}

export type PlaybookInput =
  | (InputBase & { type: "text"; default?: string; multiline: boolean })
  | (InputBase & { type: "number"; default?: number; min?: number; max?: number; integer: boolean })
  | (InputBase & { type: "toggle"; default?: boolean })
  | (InputBase & { type: "choice"; options: InputOption[]; default?: string })
  | (InputBase & { type: "multi"; options: InputOption[]; default?: string[] })
  | (InputBase & { type: "list"; default?: string[] })
  | (InputBase & { type: "models"; default?: PlaybookModel[] });

/** A value of an input on the card or in a frozen plan. */
export type InputValue = string | number | boolean | string[] | PlaybookModel[];

/** A fact the intake may look up and show on the card ("Pinned now 1.0.3"); never asked. */
export interface PlaybookFact {
  id: string;
  label: string;
  help?: string;
}

// ── roles (the cast) ─────────────────────────────────────────────────────────────────────────────

/** How many helpers of a role: a fixed number, or the value of a number input. */
export type RoleCount = { n: number } | { input: string };

export interface PlaybookRole {
  id: string;
  label: string;
  /** The role's prompt file, relative to the playbook folder (roles/<id>.md), with {{input}} slots.
      Required for every helper; for main, absent = the PLAYBOOK.md body. */
  prompt?: string;
  /** Your profile's model for this kind of work is the fallback once `models` runs out. */
  kind?: RoleKind;
  /** The preferred order. Empty: the role follows your profile (or the chat's own model). */
  models: PlaybookModel[];
  /** "Only these models": one of `models` or the role doesn't run (blocks Start). */
  only: boolean;
  /** One helper per… `count` (a number or a number input) or `per` (one per item of a multi, list
      or models input). Neither: one. Never both. */
  count?: RoleCount;
  per?: { input: string };
  /** You may turn the role off on the card. `startsOff`: it is off unless you turn it on. */
  optional: boolean;
  startsOff: boolean;
  /** "blind": the role must not see which arm is which (a blind grader); its brief says so. */
  sees: "all" | "blind";
  /** "cycle": started anew each cycle; "run" (default): kept for the whole run. */
  fresh: "run" | "cycle";
}

// ── flow: steps ──────────────────────────────────────────────────────────────────────────────────

export const STEP_REPORTS = ["chart", "table", "verdict"] as const;
export type StepReport = (typeof STEP_REPORTS)[number];

export interface PlaybookStep {
  id: string;
  label: string;
  /** Role ids that work in this step; "main" may be named without being declared. */
  roles: string[];
  /** How the step's helpers run: as one team (Sova adds a coordinator and a monitor) or as
      separate helpers. Written or derived: a team when two or more helper roles take part. */
  team: boolean;
  /** "always": the run waits for you here; "optional": a tick on the card; absent: runs through. */
  stop?: "always" | "optional";
  /** For an optional stop: off unless you turn it on. */
  startsOff: boolean;
  /** Extra conditions it stops on, a few words each ("the boundary baseline would have to grow"). */
  asks: string[];
  /** What it must show before it counts as done. */
  report?: StepReport;
  /** The step's detail page, relative to the folder (phases/<id>.md), read when the step begins. */
  phase?: string;
}

/**
 * How a repeating group goes round: a flow transition you set on the card (q5/q6: when it asks you,
 * when it repeats on its own, how many times). The playbook gives the defaults; the card edits them.
 */
export interface CycleSettings {
  /** How many cycles at most (1–50). */
  max: number;
  /** After how many cycles in a row it stops to ask you (1 = after every cycle; = max: only at the end). */
  askEvery: number;
  /** When it stops going round by itself: "rule" (once the playbook's stop rule is met, or at max);
      "max" (always runs max cycles, the rule only reported). */
  until: "rule" | "max";
}

export const CYCLE_MAX = 50;

export interface PlaybookCycle {
  id: string;
  label: string;
  /** The defaults of the user-set flow settings. */
  settings: CycleSettings;
  /** The stop rule in words, or a file in the folder (ends in .md) holding it. */
  rule?: string;
  /** What carries into the next cycle ("the winner becomes the next cycle's base"), in words. */
  carry?: string;
  /** Stop after each cycle (where the run reports and asks) follows `askEvery`; the group's own steps
      never repeat-nest: only plain steps inside. */
  steps: PlaybookStep[];
}

/** A step in the top-level list: a plain step or the one repeating group. */
export type PlaybookFlowItem = ({ kind: "step" } & PlaybookStep) | ({ kind: "cycle" } & PlaybookCycle);

// ── flow: machine (parsed and validated only; no runtime in phase 1) ─────────────────────────────

export interface MachineTransition {
  /** The state it moves to. */
  to: string;
  /** The condition in plain words, judged and reported by the main chat. */
  when?: string;
  /** How many times this move may be taken in one run (a numeric guard Sova keeps). */
  limit?: number;
}

export interface MachineState {
  id: string;
  label: string;
  roles: string[];
  team: boolean;
  stop?: "always" | "optional";
  startsOff: boolean;
  report?: StepReport;
  phase?: string;
  /** Named events → moves. A state with no moves is final. */
  on: Record<string, MachineTransition>;
  /** Ends the run quietly ("no new release"): no report, no Needs you. */
  quiet: boolean;
}

export interface PlaybookMachine {
  initial: string;
  states: MachineState[];
}

// ── the whole declaration ────────────────────────────────────────────────────────────────────────

export interface PlaybookSpec {
  version: 1;
  /** false: hidden from the Playbooks list and the / rows (Sova's own chats start it). */
  listed: boolean;
  run: PlaybookRun;
  inputs: PlaybookInput[];
  facts: PlaybookFact[];
  /** In declaration order. Always has `main` (declared, or the default main: no prompt, no models). */
  roles: PlaybookRole[];
  /** Exactly one of `steps` and `machine` is non-empty/present; neither is allowed only with no roles
      beyond main (a declaration that only sets listed or run). */
  steps: PlaybookFlowItem[];
  machine?: PlaybookMachine;
  /** Catalogue ids (shared/commands-ids.json) of the Sova commands the run uses. Those that change
      things are the ones the card lists (looking is free, so listing one that only looks is harmless). */
  commands: string[];
}

export type ParseResult<T> = T | { error: string };

// ── the parse ────────────────────────────────────────────────────────────────────────────────────

/** A fault at a path in the file; caught by parsePlaybookSpec and returned as `{error}`. */
class Fault extends Error {}
const fail = (path: string, fault: string): never => {
  throw new Fault(`${path}: ${fault}`);
};

const TOP_KEYS = ["version", "listed", "run", "inputs", "facts", "roles", "steps", "machine", "commands"];
const RUN_KEYS = ["where", "worktree", "mode", "minorModes", "permissions", "needs"];
const INPUT_BASE_KEYS = ["id", "label", "help", "type", "ask", "required", "each", "default"];
const INPUT_TYPE_KEYS: Record<InputType, string[]> = {
  text: ["multiline"],
  number: ["min", "max", "integer"],
  toggle: [],
  choice: ["options"],
  multi: ["options"],
  list: [],
  models: [],
};
const MAIN_KEYS = ["label", "prompt", "kind", "models", "only"];
const ROLE_KEYS = [...MAIN_KEYS, "count", "per", "optional", "startsOff", "sees", "fresh"];
const STEP_KEYS = ["id", "label", "roles", "team", "stop", "startsOff", "asks", "report", "phase"];
const GROUP_KEYS = ["id", "label", "repeat", "steps"];
const REPEAT_KEYS = ["max", "askEvery", "until", "rule", "carry"];
const STATE_KEYS = ["label", "roles", "team", "stop", "startsOff", "report", "phase", "on", "quiet"];
const MODEL_KEYS = ["model", "effort"];

/** An input, fact, role, step or state id: also its `{{slot}}` name in prompts. */
export const SPEC_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const EVENT_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MODEL_REF_RE = /^[^/\s]+\/\S+$/;
const MAX_MODELS = 8;
/** One chat runs at most this many helpers at once (team members, coordinators and monitors included). */
export const MAX_HELPERS = 24;
const TEXT_MAX = 2000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const list = (xs: readonly string[]) => xs.map((x) => `"${x}"`).join(", ");

function keysOnly(o: Record<string, unknown>, known: readonly string[], path: string): void {
  const bad = Object.keys(o).filter((k) => !known.includes(k));
  if (bad.length) fail(path, `unknown key ${list(bad)}. Known: ${known.join(", ")}.`);
}
function obj(v: unknown, path: string): Record<string, unknown> {
  if (!isObj(v)) fail(path, "must be an object.");
  return v as Record<string, unknown>;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "must be a list.");
  return v as unknown[];
}
function text(v: unknown, path: string, max = TEXT_MAX): string {
  if (typeof v !== "string" || !v.trim()) fail(path, "must be text.");
  const t = (v as string).trim();
  if (t.length > max) fail(path, `is at most ${max} characters.`);
  return t;
}
const optText = (v: unknown, path: string, max = TEXT_MAX): string | undefined => (v === undefined ? undefined : text(v, path, max));
function bool(v: unknown, path: string, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  if (typeof v !== "boolean") fail(path, "must be true or false.");
  return v as boolean;
}
function oneOf<T extends string>(v: unknown, known: readonly T[], path: string): T {
  if (!(known as readonly unknown[]).includes(v)) fail(path, `must be one of ${list(known)}.`);
  return v as T;
}
function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail(path, `must be a whole number from ${min} to ${max}.`);
  return v as number;
}
function id(v: unknown, path: string): string {
  if (typeof v !== "string" || !SPEC_ID_RE.test(v)) fail(path, "must be an id: a letter, then letters, digits, - or _ (at most 40).");
  return v as string;
}
/** A file in the playbook folder, relative, a markdown page; its existence is validatePlaybookFiles'. */
function page(v: unknown, path: string): string {
  const p = text(v, path, 200);
  if (p.startsWith("/") || p.includes("\\") || p.split("/").some((s) => s === ".." || s === "." || s === "") || !p.endsWith(".md"))
    fail(path, `must be a markdown file inside the playbook's folder, like "roles/grader.md".`);
  return p;
}

/** One model chain entry `{model, effort?}`. */
export function parseModelEntry(v: unknown, path: string): PlaybookModel {
  const o = obj(v, path);
  keysOnly(o, MODEL_KEYS, path);
  if (typeof o.model !== "string" || !MODEL_REF_RE.test(o.model.trim()) || o.model.length > 200) fail(`${path}.model`, `must be a model ref, "provider/id" ("claude-code/claude-opus-5-5", "zai/glm-5.3").`);
  const ref = (o.model as string).trim();
  const effort = o.effort === undefined ? undefined : oneOf(o.effort, THINKING_LEVELS, `${path}.effort`);
  return { ref, choice: choiceOfRef(ref, effort) };
}
function models(v: unknown, path: string): PlaybookModel[] {
  if (v === undefined) return [];
  const xs = arr(v, path);
  if (xs.length > MAX_MODELS) fail(path, `lists at most ${MAX_MODELS} models.`);
  const out = xs.map((x, i) => parseModelEntry(x, `${path}[${i}]`));
  out.forEach((m, i) => {
    if (out.findIndex((n) => n.ref === m.ref && n.choice.effort === m.choice.effort) !== i) fail(`${path}[${i}]`, `repeats ${m.ref}.`);
  });
  return out;
}

function parseRun(v: unknown): PlaybookRun {
  if (v === undefined) return { where: "this-chat", whereFixed: false, worktree: "none", needs: [] };
  const o = obj(v, "run");
  keysOnly(o, RUN_KEYS, "run");
  const out: PlaybookRun = {
    where: o.where === undefined ? "this-chat" : oneOf(o.where, ["this-chat", "new-chat"] as const, "run.where"),
    whereFixed: false,
    worktree: o.worktree === undefined ? "none" : oneOf(o.worktree, ["none", "new"] as const, "run.worktree"),
    needs: [],
  };
  if (o.mode !== undefined) {
    if (o.mode === "create") fail("run.mode", `a playbook never runs in Create mode; use "normal" or "delegate".`);
    out.mode = oneOf(o.mode, ["normal", "delegate"] as const, "run.mode");
  }
  if (o.minorModes !== undefined) {
    const ms = arr(o.minorModes, "run.minorModes");
    ms.forEach((m, i) => oneOf(m, AUTOMATION_MINOR_MODES, `run.minorModes[${i}]`));
    out.minorModes = AUTOMATION_MINOR_MODES.filter((m) => ms.includes(m));
  }
  if (o.permissions !== undefined) {
    const p = parsePermissions(o.permissions);
    if ("error" in p) {
      // The automation's sentence names `"permissions.x" fault`; say it at this file's path.
      const m = /^"permissions((?:\.\w+)*)" (.*)$/.exec(p.error);
      fail(`run.permissions${m?.[1] ?? ""}`, (m?.[2] ?? p.error).replace(/^has an unknown key/, "unknown key"));
    } else out.permissions = p;
    if (o.where === "this-chat") fail("run.where", `a playbook that asks for powers runs in a new chat (a chat's powers are fixed at its first message); use "new-chat" or leave it out.`);
    out.where = "new-chat";
    out.whereFixed = true;
  }
  if (o.needs !== undefined) {
    const ns = arr(o.needs, "run.needs");
    ns.forEach((n, i) => oneOf(n, PLAYBOOK_NEEDS, `run.needs[${i}]`));
    out.needs = PLAYBOOK_NEEDS.filter((n) => ns.includes(n));
  }
  return out;
}

function parseOptions(v: unknown, path: string): InputOption[] {
  const xs = arr(v, path);
  if (xs.length < 2 || xs.length > 20) fail(path, "has 2 to 20 options.");
  const out = xs.map((x, i) => {
    const p = `${path}[${i}]`;
    const o = obj(x, p);
    keysOnly(o, ["id", "label", "help"], p);
    const help = optText(o.help, `${p}.help`, 200);
    return { id: id(o.id, `${p}.id`), label: text(o.label, `${p}.label`, 80), ...(help ? { help } : {}) };
  });
  out.forEach((op, i) => {
    if (out.findIndex((x) => x.id === op.id) !== i) fail(`${path}[${i}].id`, `"${op.id}" is used twice.`);
  });
  return out;
}

function parseInput(v: unknown, i: number): PlaybookInput {
  const path = `inputs[${i}]`;
  const o = obj(v, path);
  const type = oneOf(o.type, INPUT_TYPES, `${path}.type`);
  keysOnly(o, [...INPUT_BASE_KEYS, ...INPUT_TYPE_KEYS[type]], path);
  const help = optText(o.help, `${path}.help`, 400);
  const base = {
    id: id(o.id, `${path}.id`),
    label: text(o.label, `${path}.label`, 80),
    ...(help ? { help } : {}),
    ask: o.ask === undefined ? ("always" as const) : oneOf(o.ask, INPUT_ASKS, `${path}.ask`),
    required: bool(o.required, `${path}.required`, false),
    ...(o.each === undefined ? {} : { each: oneOf(o.each, ["cycle"] as const, `${path}.each`) }),
  };
  const d = o.default;
  const dp = `${path}.default`;
  switch (type) {
    case "text": {
      if (d !== undefined && typeof d !== "string") fail(dp, "must be text.");
      return { ...base, type, multiline: bool(o.multiline, `${path}.multiline`, false), ...(d !== undefined ? { default: d as string } : {}) };
    }
    case "number": {
      const integer = bool(o.integer, `${path}.integer`, false);
      const num = (x: unknown, p: string) => {
        if (typeof x !== "number" || !Number.isFinite(x) || (integer && !Number.isInteger(x))) fail(p, integer ? "must be a whole number." : "must be a number.");
        return x as number;
      };
      const min = o.min === undefined ? undefined : num(o.min, `${path}.min`);
      const max = o.max === undefined ? undefined : num(o.max, `${path}.max`);
      if (min !== undefined && max !== undefined && min > max) fail(`${path}.max`, "must not be below min.");
      const dv = d === undefined ? undefined : num(d, dp);
      if (dv !== undefined && ((min !== undefined && dv < min) || (max !== undefined && dv > max))) fail(dp, `must be from ${min ?? "any"} to ${max ?? "any"}.`);
      return { ...base, type, integer, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(dv !== undefined ? { default: dv } : {}) };
    }
    case "toggle":
      return { ...base, type, ...(d !== undefined ? { default: bool(d, dp, false) } : {}) };
    case "choice": {
      const options = parseOptions(o.options, `${path}.options`);
      if (d !== undefined && !options.some((op) => op.id === d)) fail(dp, `must be one of the options' ids: ${list(options.map((op) => op.id))}.`);
      return { ...base, type, options, ...(d !== undefined ? { default: d as string } : {}) };
    }
    case "multi": {
      const options = parseOptions(o.options, `${path}.options`);
      if (d === undefined) return { ...base, type, options };
      const ds = arr(d, dp);
      ds.forEach((x, j) => {
        if (!options.some((op) => op.id === x)) fail(`${dp}[${j}]`, `must be one of the options' ids: ${list(options.map((op) => op.id))}.`);
      });
      return { ...base, type, options, default: options.map((op) => op.id).filter((x) => ds.includes(x)) };
    }
    case "list": {
      if (d === undefined) return { ...base, type };
      return { ...base, type, default: arr(d, dp).map((x, j) => text(x, `${dp}[${j}]`, 400)) };
    }
    case "models":
      return { ...base, type, ...(d !== undefined ? { default: models(d, dp) } : {}) };
  }
}

function parseFact(v: unknown, i: number): PlaybookFact {
  const path = `facts[${i}]`;
  const o = obj(v, path);
  keysOnly(o, ["id", "label", "help"], path);
  const help = optText(o.help, `${path}.help`, 400);
  return { id: id(o.id, `${path}.id`), label: text(o.label, `${path}.label`, 80), ...(help ? { help } : {}) };
}

function parseRole(roleId: string, v: unknown, inputs: PlaybookInput[]): PlaybookRole {
  const path = `roles.${roleId}`;
  const o = obj(v, path);
  const main = roleId === MAIN_ROLE;
  if (main) {
    const extra = Object.keys(o).filter((k) => ROLE_KEYS.includes(k) && !MAIN_KEYS.includes(k));
    if (extra.length) fail(path, `${list(extra)} is for helper roles only; the main chat is always one.`);
  }
  keysOnly(o, main ? MAIN_KEYS : ROLE_KEYS, path);
  const ms = models(o.models, `${path}.models`);
  const only = bool(o.only, `${path}.only`, false);
  if (only && !ms.length) fail(`${path}.only`, `"only these models" needs a "models" list.`);
  const role: PlaybookRole = {
    id: roleId,
    label: main ? (optText(o.label, `${path}.label`, 60) ?? "Main chat") : text(o.label, `${path}.label`, 60),
    ...(o.prompt !== undefined ? { prompt: page(o.prompt, `${path}.prompt`) } : {}),
    ...(o.kind !== undefined ? { kind: oneOf(o.kind, ROLE_KINDS, `${path}.kind`) } : {}),
    models: ms,
    only,
    optional: bool(o.optional, `${path}.optional`, false),
    startsOff: bool(o.startsOff, `${path}.startsOff`, false),
    sees: o.sees === undefined ? "all" : oneOf(o.sees, ["all", "blind"] as const, `${path}.sees`),
    fresh: o.fresh === undefined ? "run" : oneOf(o.fresh, ["run", "cycle"] as const, `${path}.fresh`),
  };
  if (!main && role.prompt === undefined) fail(`${path}.prompt`, `is required: a helper's prompt page, like "roles/${roleId}.md".`);
  if (role.startsOff && !role.optional) fail(`${path}.startsOff`, `needs "optional": true (only a role you may turn off can start off).`);
  if (o.count !== undefined && o.per !== undefined) fail(path, `has "count" and "per"; use one.`);
  if (o.count !== undefined) {
    if (typeof o.count === "number") role.count = { n: int(o.count, `${path}.count`, 1, MAX_HELPERS) };
    else {
      const c = obj(o.count, `${path}.count`);
      keysOnly(c, ["input"], `${path}.count`);
      const inp = inputs.find((x) => x.id === c.input);
      if (!inp || inp.type !== "number") fail(`${path}.count.input`, `must name a number input (${list(inputs.filter((x) => x.type === "number").map((x) => x.id)) || "none declared"}).`);
      role.count = { input: c.input as string };
    }
  }
  if (o.per !== undefined) {
    const c = obj(o.per, `${path}.per`);
    keysOnly(c, ["input"], `${path}.per`);
    const kinds: InputType[] = ["multi", "list", "models"];
    const inp = inputs.find((x) => x.id === c.input);
    if (!inp || !kinds.includes(inp.type)) fail(`${path}.per.input`, `must name a multi, list or models input (${list(inputs.filter((x) => kinds.includes(x.type)).map((x) => x.id)) || "none declared"}).`);
    role.per = { input: c.input as string };
  }
  return role;
}

function parseStepFields(o: Record<string, unknown>, path: string, roles: PlaybookRole[]): PlaybookStep {
  const sid = id(o.id, `${path}.id`);
  const rs = arr(o.roles, `${path}.roles`);
  if (!rs.length) fail(`${path}.roles`, "names at least one role.");
  const known = roles.map((r) => r.id);
  rs.forEach((r, j) => {
    if (typeof r !== "string" || !known.includes(r)) fail(`${path}.roles[${j}]`, `must be a declared role: ${list(known)}.`);
    if (rs.indexOf(r) !== j) fail(`${path}.roles[${j}]`, `"${r as string}" is named twice.`);
  });
  const helpers = (rs as string[]).filter((r) => r !== MAIN_ROLE).length;
  const team = bool(o.team, `${path}.team`, helpers >= 2);
  if (team && helpers === 0) fail(`${path}.team`, "a team needs at least one helper role.");
  const stop = o.stop === undefined ? undefined : oneOf(o.stop, ["always", "optional"] as const, `${path}.stop`);
  const startsOff = bool(o.startsOff, `${path}.startsOff`, false);
  if (startsOff && stop !== "optional") fail(`${path}.startsOff`, `needs "stop": "optional" (only an optional stop can start off).`);
  const asks = o.asks === undefined ? [] : arr(o.asks, `${path}.asks`).map((a, j) => text(a, `${path}.asks[${j}]`, 160));
  return {
    id: sid,
    label: text(o.label, `${path}.label`, 80),
    roles: rs as string[],
    team,
    ...(stop ? { stop } : {}),
    startsOff,
    asks,
    ...(o.report !== undefined ? { report: oneOf(o.report, STEP_REPORTS, `${path}.report`) } : {}),
    ...(o.phase !== undefined ? { phase: page(o.phase, `${path}.phase`) } : {}),
  };
}

function parseRepeat(v: unknown, path: string): { settings: CycleSettings; rule?: string; carry?: string } {
  const o = obj(v, path);
  keysOnly(o, REPEAT_KEYS, path);
  if (o.max === undefined) fail(`${path}.max`, "is required: the most cycles a run makes.");
  const max = int(o.max, `${path}.max`, 1, CYCLE_MAX);
  const askEvery = o.askEvery === undefined ? 1 : int(o.askEvery, `${path}.askEvery`, 1, max);
  const rule = optText(o.rule, `${path}.rule`, 600);
  const until = o.until === undefined ? (rule ? "rule" : "max") : oneOf(o.until, ["rule", "max"] as const, `${path}.until`);
  if (until === "rule" && !rule) fail(`${path}.until`, `"rule" needs the stop rule in "rule".`);
  const carry = optText(o.carry, `${path}.carry`, 600);
  return { settings: { max, askEvery, until }, ...(rule ? { rule } : {}), ...(carry ? { carry } : {}) };
}

function parseSteps(v: unknown, roles: PlaybookRole[]): PlaybookFlowItem[] {
  const xs = arr(v, "steps");
  if (!xs.length) fail("steps", "lists at least one step.");
  let group: string | null = null;
  const out: PlaybookFlowItem[] = xs.map((x, i) => {
    const path = `steps[${i}]`;
    const o = obj(x, path);
    if (o.repeat === undefined && o.steps === undefined) {
      keysOnly(o, STEP_KEYS, path);
      return { kind: "step" as const, ...parseStepFields(o, path, roles) };
    }
    keysOnly(o, GROUP_KEYS, path);
    if (group !== null) fail(path, `a playbook has at most one repeating group ("${group}" is one).`);
    if (o.repeat === undefined) fail(`${path}.repeat`, "is required for a group of steps: how it repeats.");
    const cycle = parseRepeat(o.repeat, `${path}.repeat`);
    const inner = arr(o.steps, `${path}.steps`);
    if (!inner.length) fail(`${path}.steps`, "lists at least one step.");
    const steps = inner.map((y, j) => {
      const p = `${path}.steps[${j}]`;
      const s = obj(y, p);
      if (s.repeat !== undefined || s.steps !== undefined) fail(p, "a repeating group holds plain steps only.");
      keysOnly(s, STEP_KEYS, p);
      return parseStepFields(s, p, roles);
    });
    group = id(o.id, `${path}.id`);
    return { kind: "cycle" as const, id: group, label: text(o.label, `${path}.label`, 80), ...cycle, steps };
  });
  const ids = stepsOf(out).map((s) => s.id);
  if (group) ids.push(group);
  ids.forEach((s, i) => {
    if (ids.indexOf(s) !== i) fail("steps", `the step id "${s}" is used twice.`);
  });
  return out;
}

function parseMachine(v: unknown, roles: PlaybookRole[]): PlaybookMachine {
  const o = obj(v, "machine");
  keysOnly(o, ["initial", "states"], "machine");
  const so = obj(o.states, "machine.states");
  const names = Object.keys(so);
  if (names.length < 2) fail("machine.states", "declares at least two states.");
  const known = roles.map((r) => r.id);
  const states: MachineState[] = names.map((sid) => {
    const path = `machine.states.${sid}`;
    id(sid, path);
    const s = obj(so[sid], path);
    keysOnly(s, STATE_KEYS, path);
    const rs = s.roles === undefined ? [MAIN_ROLE] : arr(s.roles, `${path}.roles`);
    rs.forEach((r, j) => {
      if (typeof r !== "string" || !known.includes(r)) fail(`${path}.roles[${j}]`, `must be a declared role: ${list(known)}.`);
    });
    const helpers = (rs as string[]).filter((r) => r !== MAIN_ROLE).length;
    const team = bool(s.team, `${path}.team`, helpers >= 2);
    if (team && helpers === 0) fail(`${path}.team`, "a team needs at least one helper role.");
    const stop = s.stop === undefined ? undefined : oneOf(s.stop, ["always", "optional"] as const, `${path}.stop`);
    const startsOff = bool(s.startsOff, `${path}.startsOff`, false);
    if (startsOff && stop !== "optional") fail(`${path}.startsOff`, `needs "stop": "optional".`);
    const on: Record<string, MachineTransition> = {};
    const onRaw = s.on === undefined ? {} : obj(s.on, `${path}.on`);
    for (const [ev, t] of Object.entries(onRaw)) {
      const tp = `${path}.on.${ev}`;
      if (!EVENT_RE.test(ev)) fail(tp, "an event's name is lowercase letters, digits and dashes.");
      if (typeof t === "string") on[ev] = { to: t };
      else {
        const to = obj(t, tp);
        keysOnly(to, ["to", "when", "limit"], tp);
        if (typeof to.to !== "string") fail(`${tp}.to`, "must name a state.");
        const when = optText(to.when, `${tp}.when`, 200);
        on[ev] = { to: to.to as string, ...(when ? { when } : {}), ...(to.limit !== undefined ? { limit: int(to.limit, `${tp}.limit`, 1, CYCLE_MAX) } : {}) };
      }
      if (!names.includes(on[ev]!.to)) fail(`${tp}`, `moves to "${on[ev]!.to}", which isn't a state: ${list(names)}.`);
    }
    const quiet = bool(s.quiet, `${path}.quiet`, false);
    if (quiet && Object.keys(on).length) fail(`${path}.quiet`, "only a final state (no moves) can end quietly.");
    return {
      id: sid,
      label: text(s.label, `${path}.label`, 80),
      roles: rs as string[],
      team,
      ...(stop ? { stop } : {}),
      startsOff,
      ...(s.report !== undefined ? { report: oneOf(s.report, STEP_REPORTS, `${path}.report`) } : {}),
      ...(s.phase !== undefined ? { phase: page(s.phase, `${path}.phase`) } : {}),
      on,
      quiet,
    };
  });
  if (typeof o.initial !== "string" || !names.includes(o.initial)) fail("machine.initial", `must name a state: ${list(names)}.`);
  const initial = o.initial as string;
  if (!states.some((s) => !Object.keys(s.on).length)) fail("machine.states", "declares at least one final state (one with no moves).");
  // Every state is reachable from the start, and every state can still reach an end.
  const next = (s: string) => Object.values(states.find((x) => x.id === s)!.on).map((t) => t.to);
  const reach = new Set([initial]);
  for (const q = [initial]; q.length; ) for (const n of next(q.shift()!)) if (!reach.has(n)) (reach.add(n), q.push(n));
  const lost = names.filter((n) => !reach.has(n));
  if (lost.length) fail("machine.states", `${list(lost)} can't be reached from "${initial}".`);
  const ends = new Set(states.filter((s) => !Object.keys(s.on).length).map((s) => s.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of states) if (!ends.has(s.id) && next(s.id).some((n) => ends.has(n))) (ends.add(s.id), (grew = true));
  }
  const stuck = names.filter((n) => !ends.has(n));
  if (stuck.length) fail("machine.states", `from ${list(stuck)} the run can never finish.`);
  return { initial, states };
}

function parseCommands(v: unknown): string[] {
  if (v === undefined) return [];
  const xs = arr(v, "commands");
  xs.forEach((c, i) => {
    const entry = typeof c === "string" ? findCommand(c) : undefined;
    if (!entry) fail(`commands[${i}]`, `must be a command id from Sova's catalogue (\`sova list\`).`);
    if (xs.indexOf(c) !== i) fail(`commands[${i}]`, `"${c as string}" is listed twice.`);
  });
  return xs as string[];
}

/**
 * A playbook.json's parsed JSON, strictly: every key known, every
 * type and reference right, or `{error: "<path>: <fault>"}` naming the first fault.
 */
export function parsePlaybookSpec(raw: unknown): ParseResult<PlaybookSpec> {
  try {
    const o = obj(raw, "playbook.json");
    keysOnly(o, TOP_KEYS, "playbook.json");
    if (o.version !== PLAYBOOK_FORMAT_VERSION) fail("version", `must be ${PLAYBOOK_FORMAT_VERSION}.`);
    const run = parseRun(o.run);
    const inputs = o.inputs === undefined ? [] : arr(o.inputs, "inputs").map(parseInput);
    const facts = o.facts === undefined ? [] : arr(o.facts, "facts").map(parseFact);
    const slots = [...inputs.map((x) => x.id), ...facts.map((x) => x.id)];
    slots.forEach((s, i) => {
      if (slots.indexOf(s) !== i) fail(i < inputs.length ? `inputs[${i}].id` : `facts[${i - inputs.length}].id`, `"${s}" is used twice (inputs and facts share their names).`);
    });
    const ro = o.roles === undefined ? {} : obj(o.roles, "roles");
    const roles = Object.entries(ro).map(([rid, v]) => (id(rid, `roles.${rid}`), parseRole(rid, v, inputs)));
    if (!roles.some((r) => r.id === MAIN_ROLE)) roles.unshift({ id: MAIN_ROLE, label: "Main chat", models: [], only: false, optional: false, startsOff: false, sees: "all", fresh: "run" });
    if (o.steps !== undefined && o.machine !== undefined) fail("playbook.json", `has both "steps" and "machine"; use one.`);
    const steps = o.steps === undefined ? [] : parseSteps(o.steps, roles);
    const machine = o.machine === undefined ? undefined : parseMachine(o.machine, roles);
    const helpers = roles.filter((r) => r.id !== MAIN_ROLE);
    if (helpers.length && !steps.length && !machine) fail("playbook.json", `declares helper roles but no "steps" (or "machine") that use them.`);
    const used = new Set([...stepsOf(steps).flatMap((s) => s.roles), ...(machine?.states.flatMap((s) => s.roles) ?? [])]);
    for (const r of helpers) if (!used.has(r.id)) fail(`roles.${r.id}`, `no step names it.`);
    const hasCycle = steps.some((s) => s.kind === "cycle");
    inputs.forEach((x, i) => {
      if (x.each === "cycle" && !hasCycle) fail(`inputs[${i}].each`, `"cycle" needs a repeating group in "steps".`);
    });
    roles.forEach((r) => {
      if (r.fresh === "cycle" && !hasCycle) fail(`roles.${r.id}.fresh`, `"cycle" needs a repeating group in "steps".`);
    });
    return {
      version: 1,
      listed: bool(o.listed, "listed", true),
      run,
      inputs,
      facts,
      roles,
      steps,
      ...(machine ? { machine } : {}),
      commands: parseCommands(o.commands),
    };
  } catch (err) {
    if (err instanceof Fault) return { error: err.message };
    throw err;
  }
}

/** Every plain step in order, a repeating group's own steps in its place. */
export function stepsOf(items: readonly PlaybookFlowItem[]): PlaybookStep[] {
  return items.flatMap((it) => (it.kind === "cycle" ? it.steps : [stripKind(it)]));
}
function stripKind(s: { kind: "step" } & PlaybookStep): PlaybookStep {
  const { kind: _kind, ...step } = s;
  return step;
}

/** The repeating group, if the playbook has one. */
export const cycleOf = (spec: Pick<PlaybookSpec, "steps">): PlaybookCycle | undefined => {
  const c = spec.steps.find((s) => s.kind === "cycle");
  return c && c.kind === "cycle" ? c : undefined;
};

/** Why cycle settings set on the card can't be used; null: they can. */
export function checkCycleSettings(s: CycleSettings): string | null {
  if (!Number.isInteger(s.max) || s.max < 1 || s.max > CYCLE_MAX) return `Cycles at most is a whole number from 1 to ${CYCLE_MAX}.`;
  if (!Number.isInteger(s.askEvery) || s.askEvery < 1 || s.askEvery > s.max) return `Ask me after every … cycles is a whole number from 1 to ${s.max}.`;
  if (s.until !== "rule" && s.until !== "max") return `Keep going until is "rule" or "max".`;
  return null;
}

/**
 * The folder checks a parse can't make:
 * every prompt, phase and rule page the description names exists. `files` lists the folder's files,
 * relative, "/"-separated (at least every page pagesOf names that exists). Returns the faults, first
 * first; [] when none.
 */
export function validatePlaybookFiles(spec: PlaybookSpec, files: readonly string[]): string[] {
  const have = new Set(files);
  return pagesOf(spec)
    .filter((p) => !have.has(p.file))
    .map((p) => `${p.path}: "${p.file}" isn't in the playbook's folder.`);
}

/** Every page in the folder the description points at, with where it says so; in file order. */
export function pagesOf(spec: PlaybookSpec): { path: string; file: string }[] {
  const out: { path: string; file: string }[] = [];
  for (const r of spec.roles) if (r.prompt) out.push({ path: `roles.${r.id}.prompt`, file: r.prompt });
  spec.steps.forEach((it, i) => {
    if (it.kind === "step") {
      if (it.phase) out.push({ path: `steps[${i}].phase`, file: it.phase });
      return;
    }
    if (it.rule && isPageRef(it.rule)) out.push({ path: `steps[${i}].repeat.rule`, file: it.rule });
    it.steps.forEach((s, j) => {
      if (s.phase) out.push({ path: `steps[${i}].steps[${j}].phase`, file: s.phase });
    });
  });
  for (const s of spec.machine?.states ?? []) if (s.phase) out.push({ path: `machine.states.${s.id}.phase`, file: s.phase });
  return out;
}

/** A cycle's rule written as a page in the folder ("phases/stop-rule.md") rather than in words. */
export const isPageRef = (rule: string): boolean => rule.endsWith(".md") && !/\s/.test(rule);

// ── slots ────────────────────────────────────────────────────────────────────────────────────────

/** Slots every role prompt may use besides its inputs and facts, filled at Start: `run`, the run's
    folder (where a helper writes); `note`, your note for the role on the card (empty when none). */
export const RUN_SLOTS = ["run", "note"] as const;
/** The slot a role with `count` or `per` may use: which one it is (the item of `per`'s input, as
    inputValueText words it, or "2 of 3" for `count`). */
export const EACH_SLOT = "each";
const SLOT_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** The `{{slot}}` names a page uses, each once, in order. */
export function slotsIn(text: string): string[] {
  return [...new Set([...text.matchAll(SLOT_RE)].map((m) => m[1]!))];
}

/**
 * Every `{{slot}}` in a helper's prompt names an input, a fact or a built-in slot (
 * a broken reference is a fault). `pages` maps each prompt page (relative) to its text; a page not in
 * it is skipped. Returns the faults, first first.
 */
export function validatePromptSlots(spec: PlaybookSpec, pages: Readonly<Record<string, string>>): string[] {
  const known = new Set<string>([...spec.inputs.map((x) => x.id), ...spec.facts.map((x) => x.id), ...RUN_SLOTS]);
  const out: string[] = [];
  for (const r of spec.roles) {
    // The main chat's page is its own text, not a brief Sova fills: it gets your choices in the run's message.
    if (r.id === MAIN_ROLE || !r.prompt || pages[r.prompt] === undefined) continue;
    const many = r.count !== undefined || r.per !== undefined;
    for (const slot of slotsIn(pages[r.prompt]!)) {
      if (known.has(slot) || (many && slot === EACH_SLOT)) continue;
      out.push(
        slot === EACH_SLOT
          ? `roles.${r.id}.prompt: "{{each}}" is only for a role with "count" or "per".`
          : `roles.${r.id}.prompt: "{{${slot}}}" isn't an input or fact (${[...known].map((k) => `"${k}"`).join(", ")}${many ? `, "each"` : ""}).`,
      );
    }
  }
  return out;
}

// ── values ───────────────────────────────────────────────────────────────────────────────────────

/** An input's value as the card and the plan hold it: why it can't be used; null: it can. */
export function checkInputValue(input: PlaybookInput, value: unknown): string | null {
  const bad = (what: string) => `${input.label}: ${what}`;
  switch (input.type) {
    case "text":
      return typeof value === "string" && value.length <= 20_000 ? null : bad("must be text.");
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return bad("must be a number.");
      if (input.integer && !Number.isInteger(value)) return bad("must be a whole number.");
      if ((input.min !== undefined && value < input.min) || (input.max !== undefined && value > input.max)) return bad(`must be from ${input.min ?? "any"} to ${input.max ?? "any"}.`);
      return null;
    }
    case "toggle":
      return typeof value === "boolean" ? null : bad("must be on or off.");
    case "choice":
      return typeof value === "string" && input.options.some((o) => o.id === value) ? null : bad(`must be one of ${input.options.map((o) => o.label).join(", ")}.`);
    case "multi":
      return Array.isArray(value) && value.every((v) => input.options.some((o) => o.id === v)) && new Set(value).size === value.length ? null : bad("must be some of its options.");
    case "list":
      return Array.isArray(value) && value.length <= 100 && value.every((v) => typeof v === "string" && v.trim() && v.length <= 400) ? null : bad("must be a list of text.");
    case "models":
      return Array.isArray(value) && value.length <= MAX_MODELS && value.every((m) => isModelValue(m)) ? null : bad("must be a list of models.");
  }
}
const isModelValue = (m: unknown): m is PlaybookModel =>
  isObj(m) && typeof m.ref === "string" && MODEL_REF_RE.test(m.ref) && isObj(m.choice) && typeof m.choice.model === "string" && typeof m.choice.effort === "string" && (m.choice.backend === "pi" || m.choice.backend === "claude-code");

/** Whether an input has a value Start can use (a required one blocks Start without it). */
export function hasValue(value: InputValue | undefined | null): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** An input's value as words for a prompt's `{{slot}}` (a list: one item per line). */
export function inputValueText(input: PlaybookInput, value: InputValue | undefined | null): string {
  if (value === undefined || value === null) return "";
  switch (input.type) {
    case "toggle":
      return value ? "yes" : "no";
    case "choice":
      return input.options.find((o) => o.id === value)?.label ?? String(value);
    case "multi":
      return (value as string[]).map((v) => input.options.find((o) => o.id === v)?.label ?? v).join(", ");
    case "list":
      return (value as string[]).map((v) => `- ${v}`).join("\n");
    case "models":
      return (value as PlaybookModel[]).map((m) => (m.choice.effort ? `${m.ref} (${m.choice.effort})` : m.ref)).join(", ");
    default:
      return String(value);
  }
}

/** The JSON form of a models value ({model, effort?}[]) → PlaybookModel[], strictly. */
export function parseModelsValue(v: unknown, path = "value"): ParseResult<PlaybookModel[]> {
  try {
    return models(v, path);
  } catch (err) {
    if (err instanceof Fault) return { error: err.message };
    throw err;
  }
}
