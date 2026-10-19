/**
 * The powers (§app.project-overseer/autonomy-levels): what may happen without the operator, per project,
 * as On/Off switches in two columns. `overseer`: what the project overseer does on its own (its looks,
 * Run Now, what the statecharts start by themselves). `assistant`: what the client's Project Assistant may
 * set off from an owner's message. The operator is never restricted: a turn the operator started runs
 * every tool whatever the switches say. Stored in overseer.json under `powers` (StoredPowers), beside a
 * never-looser `autonomy` for older Sova hosts. Harness-neutral, DOM-free, imports nothing at runtime
 * but the level list: imported by the server and the operator app.
 */

import type { ThinkingLevel } from "./profiles";
import type { Autonomy } from "./project-overseer";

const LEVELS: readonly Autonomy[] = ["L0", "L1", "L2", "L3"];
const rank = (l: Autonomy): number => LEVELS.indexOf(l);
const isLevel = (v: unknown): v is Autonomy => typeof v === "string" && (LEVELS as readonly string[]).includes(v);

export const POWER_COLUMNS = ["overseer", "assistant"] as const;
export type PowerColumn = (typeof POWER_COLUMNS)[number];

export const POWER_GROUPS = ["people", "spec", "code", "copies", "release"] as const;
export type PowerGroup = (typeof POWER_GROUPS)[number];

export const POWERS = [
  "gather", "whatsapp", "ownerUpdates", "roster", // people
  "promote", "bookkeeping", // spec
  "codingStart", "codingPrompt", "onboard", "markMerged", // code
  "copiesRun", "copiesReset", // copies
  "share", "deploy", // release
] as const;
export type PowerId = (typeof POWERS)[number];
export const isPowerId = (v: unknown): v is PowerId => typeof v === "string" && (POWERS as readonly string[]).includes(v);

export interface PowerInfo {
  group: PowerGroup;
  /** The level that allowed it unattended before (the carry-over and the derived level). null: no level ever did (deploy). */
  oldLevel: Autonomy | null;
  /** Whether the Project Assistant column can ever set this act off (false: always Off there). */
  assistant: boolean;
  /** The switch row's label; refusals name the power with it. */
  label: string;
  /** Only an organization's project has it (people, a roster): a standalone project's view omits it. */
  placedOnly?: true;
}

export const POWER_INFO: Record<PowerId, PowerInfo> = {
  gather: { group: "people", oldLevel: "L1", assistant: true, label: "Start, offer and close gatherings", placedOnly: true },
  whatsapp: { group: "people", oldLevel: "L1", assistant: false, label: "Message people on WhatsApp", placedOnly: true },
  ownerUpdates: { group: "people", oldLevel: "L1", assistant: false, label: "Post owner updates", placedOnly: true },
  roster: { group: "people", oldLevel: "L2", assistant: false, label: "Approve or decline proposed people", placedOnly: true },
  promote: { group: "spec", oldLevel: "L2", assistant: false, label: "Promote decisions into the spec" },
  bookkeeping: { group: "spec", oldLevel: "L1", assistant: false, label: "Fix the pipeline's bookkeeping" },
  codingStart: { group: "code", oldLevel: "L3", assistant: true, label: "Start coding sessions" },
  codingPrompt: { group: "code", oldLevel: "L3", assistant: true, label: "Send coding sessions prompts" },
  onboard: { group: "code", oldLevel: "L3", assistant: false, label: "Set up the project's verbs" },
  markMerged: { group: "code", oldLevel: "L2", assistant: false, label: "Mark a build merged" },
  copiesRun: { group: "copies", oldLevel: "L3", assistant: true, label: "Create, start and update running copies" },
  copiesReset: { group: "copies", oldLevel: "L3", assistant: false, label: "Reset or tear down running copies" },
  share: { group: "release", oldLevel: "L1", assistant: false, label: "Share a version to try" },
  deploy: { group: "release", oldLevel: null, assistant: true, label: "Deploy (the project's own recipe)" },
};

export const POWER_GROUP_LABEL: Record<PowerGroup, string> = { people: "People", spec: "Spec", code: "Code", copies: "Running copies", release: "Release" };

/** What always runs without the operator, in both columns, never braked (the page lists it above the switches). */
export const ALWAYS_PHRASES: readonly string[] = [
  "reading the project and its sessions",
  "keeping notes and ideas",
  "asking you with a card",
  "planning a gathering for later",
  "sorting decisions into drafts",
  "writing requirements into a spec draft",
  "cancelling a held act",
  "stopping a running copy",
  "taking a share link back",
  "asking you to deploy",
];

export const powersOfGroup = (g: PowerGroup): PowerId[] => POWERS.filter((p) => POWER_INFO[p].group === g);

/** true = On, false = Off. */
export type PowerMap = Record<PowerId, boolean>;

export const WORK_KINDS = ["reply", "coding", "gathering"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
export interface ModelPick {
  model: string;
  thinking?: ThinkingLevel | null;
}
/** null or absent = inherit. */
export type WorkModels = Partial<Record<WorkKind, ModelPick | null>>;

/** A column's profile: its powers and the models per kind of work. v1 stores both columns inline per project. */
export interface PowerProfile {
  powers: PowerMap;
  models?: WorkModels;
}

export type PowersNote = { kind: "carried-over" | "rederived"; from: Autonomy; at: string; seen: boolean };

/** overseer.json `powers`. */
export interface StoredPowers {
  version: 1;
  /** The `autonomy` written beside it at the same save. If the file's `autonomy` differs, a Sova that
      doesn't know switches changed the level: the overseer column is re-derived from it (the carry-over).
      Its other signals: confirmKindsKnown/confirmKinds in the file, a `stamp` that no longer matches (powersStamp). */
  derivedAutonomy: Autonomy;
  overseer: PowerMap;
  assistant: PowerMap;
  /** Per-project override of the assistant's models for the coding and gathering sessions it starts. */
  assistantModels?: WorkModels;
  /** Resume pressed on the empty-roster brake (ISO): lifted until the roster has someone again, then cleared. */
  emptyRosterResumedAt?: string | null;
  /** The one-time note: levels became switches, or an older Sova's level re-derived them. */
  note?: PowersNote | null;
}

export type BrakeKind = "paused" | "empty-roster";
export interface Brake {
  kind: BrakeKind;
  reason: string;
}

export const PAUSED_BRAKE_REASON = "Paused: this organization was attached on this host. Press Resume to let it act on its own again.";
export const EMPTY_ROSTER_BRAKE_REASON = "The roster has no active people yet.";

// ---- pure helpers ---------------------------------------------------------------------------------

const mapOf = (f: (p: PowerId) => boolean): PowerMap => Object.fromEntries(POWERS.map((p) => [p, f(p)])) as PowerMap;

/** The carry-over (al_3 q4): each power whose old level is at or below `autonomy` is On, every other Off. */
export function carryOver(autonomy: Autonomy): PowerMap {
  return mapOf((p) => {
    const old = POWER_INFO[p].oldLevel;
    return old !== null && rank(old) <= rank(autonomy);
  });
}

/** The Project Assistant column of a new or carried-over project: all Off. */
export const assistantDefaults = (): PowerMap => mapOf(() => false);

/** The never-looser level for older readers: the highest L where every power with an old level ≤ L is On (L0 always). */
export function derivedAutonomy(overseer: PowerMap): Autonomy {
  let out: Autonomy = "L0";
  for (const l of LEVELS.slice(1)) {
    if (POWERS.every((p) => POWER_INFO[p].oldLevel === null || rank(POWER_INFO[p].oldLevel!) > rank(l) || overseer[p] === true)) out = l;
    else break;
  }
  return out;
}

/** A group's switch in one column: every act On, every act Off, or Mixed. The assistant column counts only acts it can set off. */
export function groupState(m: PowerMap, g: PowerGroup, col: PowerColumn): "on" | "off" | "mixed" {
  const ps = powersOfGroup(g).filter((p) => col === "overseer" || POWER_INFO[p].assistant);
  if (ps.length === 0) return "off";
  const on = ps.filter((p) => m[p]).length;
  return on === 0 ? "off" : on === ps.length ? "on" : "mixed";
}

/** What acts on the switches: under a brake every power is Off. */
export const effectivePowers = (m: PowerMap, brake: Brake | null): PowerMap => (brake ? mapOf(() => false) : { ...m });

/** The brake in force: the attach pause first, then an empty roster unless Resume lifted it. */
export function brakeOf(i: { paused: boolean; ceiling: { reason?: string } | null; emptyRosterResumed: boolean }): Brake | null {
  if (i.paused) return { kind: "paused", reason: PAUSED_BRAKE_REASON };
  if (i.ceiling && !i.emptyRosterResumed) return { kind: "empty-roster", reason: i.ceiling.reason || EMPTY_ROSTER_BRAKE_REASON };
  return null;
}

/** Why a column's patch can't be saved, or null. Pure. */
export function powersPatchProblem(v: unknown): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "powers must be an object with overseer and/or assistant switches.";
  for (const [col, m] of Object.entries(v as Record<string, unknown>)) {
    if (!(POWER_COLUMNS as readonly string[]).includes(col)) return `powers has no column "${col}": use ${POWER_COLUMNS.join(" or ")}.`;
    if (typeof m !== "object" || m === null || Array.isArray(m)) return `powers.${col} must map powers to true (On) or false (Off).`;
    for (const [k, b] of Object.entries(m as Record<string, unknown>)) {
      if (!isPowerId(k)) return `There is no power "${k}". Powers: ${POWERS.join(", ")}.`;
      if (typeof b !== "boolean") return `powers.${col}.${k} must be true (On) or false (Off).`;
      if (col === "assistant" && b && !POWER_INFO[k].assistant) return `${POWER_INFO[k].label} can't be turned on for the Project Assistant.`;
    }
  }
  return null;
}

const modelsOf = (v: unknown): WorkModels | undefined => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: WorkModels = {};
  for (const k of WORK_KINDS) {
    const x = (v as Record<string, unknown>)[k];
    if (x === null) out[k] = null;
    else if (typeof x === "object" && x !== null && typeof (x as ModelPick).model === "string" && (x as ModelPick).model.trim()) {
      const t = (x as ModelPick).thinking;
      out[k] = { model: (x as ModelPick).model, ...(typeof t === "string" ? { thinking: t } : {}) };
    }
  }
  return out;
};

/**
 * overseer.json's `powers`, read tolerantly (ARCH §1's read rules). `raw` is the whole parsed file.
 * 1. No readable `powers`: the overseer column carries over from `autonomy` (default L1), the assistant is
 *    all Off, a one-time "carried-over" note. 2. `autonomy` differs from `powers.derivedAutonomy`: an older
 *    Sova changed the level: the overseer column re-derives from it, the assistant is kept, a "rederived"
 *    note. 3. Else per key: a boolean wins, anything else is its default (carry-over, or Off), and an
 *    assistant key the column can't set is Off. `now` stamps a new note.
 */
/** JSON with object keys sorted (arrays in order), so a writer that reorders keys stamps the same. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  if (typeof v === "object" && v !== null)
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/**
 * The stamp only this Sova writes into `powers.stamp`: a hash (FNV-1a, 64-bit as two halves; not a secret,
 * a change detector) of the whole settings file as saved, `powers.stamp` itself left out. A file whose stamp no
 * longer matches was rewritten by a Sova that doesn't know switches (it changed a level, a model, a cap): the
 * overseer column is re-derived from its level.
 */
export function powersStamp(file: Record<string, unknown>): string {
  const p = file.powers;
  const { stamp: _s, ...rest } = (typeof p === "object" && p !== null && !Array.isArray(p) ? p : {}) as Record<string, unknown>;
  const text = canonicalJson({ ...file, ...(p !== undefined ? { powers: rest } : {}) });
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `s1-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** `file` with its `powers.stamp` set (the save's last step: nothing may change the file after it). */
export function stampedSettingsFile(file: Record<string, unknown>): Record<string, unknown> {
  const plain = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
  if (typeof plain.powers !== "object" || plain.powers === null) return plain;
  return { ...plain, powers: { ...(plain.powers as Record<string, unknown>), stamp: powersStamp(plain) } };
}

export function readStoredPowers(raw: unknown, now: () => string = () => new Date().toISOString()): StoredPowers {
  const file = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const autonomy: Autonomy = isLevel(file.autonomy) ? file.autonomy : "L1";
  const p = file.powers as Record<string, unknown> | undefined;
  const readable = typeof p === "object" && p !== null && !Array.isArray(p) && p.version === 1 && typeof p.overseer === "object" && p.overseer !== null;
  const asst = (m: unknown): PowerMap => {
    const o = (typeof m === "object" && m !== null ? m : {}) as Record<string, unknown>;
    return mapOf((k) => POWER_INFO[k].assistant && o[k] === true);
  };
  if (!readable) {
    // The note only for a file that had a level (an existing project): a new project carried nothing over.
    const note: PowersNote | null = isLevel(file.autonomy) ? { kind: "carried-over", from: autonomy, at: now(), seen: false } : null;
    return { version: 1, derivedAutonomy: derivedAutonomy(carryOver(autonomy)), overseer: carryOver(autonomy), assistant: assistantDefaults(), note };
  }
  const extras = {
    ...(modelsOf(p.assistantModels) ? { assistantModels: modelsOf(p.assistantModels) } : {}),
    ...(typeof p.emptyRosterResumedAt === "string" ? { emptyRosterResumedAt: p.emptyRosterResumedAt } : {}),
  };
  const assistant = asst(p.assistant);
  const derived = isLevel(p.derivedAutonomy) ? p.derivedAutonomy : null;
  // A save by a Sova that doesn't know switches, told by what only this Sova controls, never by the level's value
  // alone (an older Sova rewriting the same level would otherwise leave a power On it meant to rule out): it
  // always writes confirmKindsKnown/confirmKinds, which this Sova never does; or the stamp no longer matches
  // the file; or the level differs from the one saved beside the switches. Then the overseer column is the
  // level's carry-over (never looser: the level written was the switches' never-looser one).
  const olderWriter = "confirmKindsKnown" in file || "confirmKinds" in file;
  const stampMoved = typeof p.stamp === "string" && p.stamp !== powersStamp(file);
  const levelMoved = derived !== null && isLevel(file.autonomy) && file.autonomy !== derived;
  if (olderWriter || stampMoved || levelMoved) {
    const overseer = carryOver(autonomy);
    return { version: 1, derivedAutonomy: derivedAutonomy(overseer), overseer, assistant, ...extras, note: { kind: "rederived", from: autonomy, at: now(), seen: false } };
  }
  const o = p.overseer as Record<string, unknown>;
  const fallback = carryOver(derived ?? autonomy);
  const overseer = mapOf((k) => (typeof o[k] === "boolean" ? (o[k] as boolean) : fallback[k]));
  const n = p.note as Record<string, unknown> | null | undefined;
  const note: PowersNote | null =
    n && typeof n === "object" && (n.kind === "carried-over" || n.kind === "rederived") && isLevel(n.from)
      ? { kind: n.kind, from: n.from, at: typeof n.at === "string" ? n.at : now(), seen: n.seen === true }
      : null;
  return { version: 1, derivedAutonomy: derivedAutonomy(overseer), overseer, assistant, ...extras, note };
}

/** Apply a powers patch (already checked with powersPatchProblem). Pure: returns a new value. */
export function applyPowersPatch(s: StoredPowers, patch: { overseer?: Partial<PowerMap>; assistant?: Partial<PowerMap> }): StoredPowers {
  const overseer = { ...s.overseer };
  const assistant = { ...s.assistant };
  for (const [k, v] of Object.entries(patch.overseer ?? {})) if (isPowerId(k) && typeof v === "boolean") overseer[k] = v;
  for (const [k, v] of Object.entries(patch.assistant ?? {})) if (isPowerId(k) && typeof v === "boolean") assistant[k] = v && POWER_INFO[k].assistant;
  return { ...s, overseer, assistant, derivedAutonomy: derivedAutonomy(overseer) };
}

// ---- the wire (GET/PATCH …/overseer, §3 of the design) --------------------------------------------

export interface PowersView {
  info: Record<PowerId, PowerInfo>;
  /** Display order of the groups and their labels. */
  groups: { id: PowerGroup; label: string; powers: PowerId[] }[];
  /** ALWAYS_PHRASES. */
  always: readonly string[];
  overseer: PowerMap;
  assistant: PowerMap;
  /** After the brake. */
  effective: { overseer: PowerMap; assistant: PowerMap };
  /** The brake in force (its reason shown; Resume lifts it), or null. */
  brake: Brake | null;
  note: PowersNote | null;
  /** For older clients only. */
  derivedAutonomy: Autonomy;
  /** A standalone project: no acts that need an organization, no Project Assistant column. */
  standalone?: true;
  models: {
    overseer: WorkModels;
    assistant: WorkModels;
    assistantSource: { reply: "org"; coding: "org" | "project"; gathering: "org" | "project" };
  };
}

/** The powers part of PATCH …/overseer. */
export interface PowersPatch {
  powers?: { overseer?: Partial<PowerMap>; assistant?: Partial<PowerMap> };
  /** Lifts the brake: ends the attach pause; on an empty roster, holds until the roster has someone again. */
  resume?: true;
  /** Hides the one-time note. */
  powersNoteSeen?: true;
  assistantModels?: WorkModels | null;
}

export const powerGroupsView = (): PowersView["groups"] => POWER_GROUPS.map((g) => ({ id: g, label: POWER_GROUP_LABEL[g], powers: powersOfGroup(g) }));

// ---- refusals (the statecharts' power check words them the same; a test pins them) ----------------

export const powerOffSentence = (p: PowerId, col: PowerColumn): string =>
  col === "assistant"
    ? `${POWER_INFO[p].label} is off for the Project Assistant. Do not retry it. Tell the owner it went to the team: it reaches the operator as a request.`
    : `${POWER_INFO[p].label} is off for the overseer on its own. Do not retry it. File what you would do as an idea (sova_idea) or raise a sova_card card that says what and why; the operator's click starts a turn in which you may act.`;

/** The GET view of a project's powers. Pure. A standalone project (`placed` false) omits the acts only an
    organization has and the Project Assistant column (its maps then hold Off for every assistant key). */
export function powersView(s: StoredPowers, brake: Brake | null, placed: boolean, models: PowersView["models"]): PowersView {
  const keep = (p: PowerId) => placed || !POWER_INFO[p].placedOnly;
  const info = Object.fromEntries(POWERS.filter(keep).map((p) => [p, POWER_INFO[p]])) as Record<PowerId, PowerInfo>;
  const pick = (m: PowerMap): PowerMap => Object.fromEntries(POWERS.filter(keep).map((p) => [p, m[p]])) as PowerMap;
  const assistant = placed ? s.assistant : assistantDefaults();
  return {
    info,
    groups: powerGroupsView()
      .map((g) => ({ ...g, powers: g.powers.filter(keep) }))
      .filter((g) => g.powers.length > 0),
    always: ALWAYS_PHRASES,
    overseer: pick(s.overseer),
    assistant: pick(assistant),
    effective: { overseer: pick(effectivePowers(s.overseer, brake)), assistant: pick(effectivePowers(assistant, brake)) },
    brake,
    note: s.note ?? null,
    derivedAutonomy: s.derivedAutonomy,
    models,
    ...(placed ? {} : { standalone: true as const }),
  };
}

/** The power an act needed, in words, for the history's authorization (§app.org-history/actors): a switch row's
    label with its column, or what "always" and "operator" mean. undefined for an unknown value. */
export function powerWord(power: string | undefined, column?: PowerColumn): string | undefined {
  const col = column === "assistant" ? "the Project Assistant's switch" : "the overseer's switch";
  if (power === "always") return "No switch needed";
  if (power === "operator") return "The operator's alone";
  if (isPowerId(power)) return `${POWER_INFO[power].label} (${col})`;
  return column ? (column === "assistant" ? "The Project Assistant's switches" : "The overseer's switches") : undefined;
}
