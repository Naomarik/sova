/**
 * An automation file (§chat.schedules/automation-file): `<project root>/.sova/automations/<id>.json`,
 * one automation each: its triggers, the playbook it runs, its session kind, and its session's own
 * settings and permissions, inline (it names no profile). Pure and shared: the strict parse, the
 * profile snapshot its session gets, and what an approval of it covers (the v2 pin source). Imports
 * only shared modules.
 */
import { canonicalWhen, parseWhen, validZone, type Trigger } from "./schedules";
import { DEFAULT_LIMITS, GRANTABLE, LIMIT_KEYS, PROFILE_MINOR_MODES, REMOVABLE, THINKING_LEVELS, normalizeCaps, type Grantable, type ProfileLimits, type ProfileMinorMode, type Removable, type ThinkingLevel } from "./profiles";
import { MEMORY_SIZES, MEMORY_TYPES } from "./memory";
import type { MemoryType } from "./protocol";

export const AUTOMATIONS_DIR = ".sova/automations";
export const AUTOMATION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The session kinds a file may name. Only long-running for now: one session woken by every fire. */
export const SESSION_KINDS = ["long-running"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

const KEYS = ["id", "label", "when", "tz", "task", "playbook", "session", "settings", "permissions"];
const SETTINGS_KEYS = ["model", "thinking", "mode", "minorModes", "memory"];
const PERMISSION_KEYS = ["remove", "grant", "oneAtATime", "limits", "overseerMayStart"];
/** A session's minor modes as an automation may set them: a profile's, plus memory. */
export const AUTOMATION_MINOR_MODES = [...PROFILE_MINOR_MODES, "memory"] as const;
export type AutomationMinorMode = ProfileMinorMode | "memory";

export interface AutomationSettings {
  model?: string;
  thinking?: ThinkingLevel;
  mode?: "normal" | "delegate";
  /** Exactly these minor modes; [] = none; absent = leave the session's as they are. */
  minorModes?: AutomationMinorMode[];
  memory?: { type: MemoryType; size: number };
}

export interface AutomationPermissions {
  remove: Removable[];
  grant: Grantable[];
  oneAtATime: boolean;
  limits: ProfileLimits;
  overseerMayStart: boolean;
}

export interface Automation {
  id: string;
  label: string;
  when: string;
  triggers: Trigger[];
  tz?: string;
  task?: string;
  playbook: string;
  session: SessionKind;
  settings: AutomationSettings;
  permissions: AutomationPermissions;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const unknownKeys = (o: Record<string, unknown>, known: readonly string[], where: string): string | null => {
  const bad = Object.keys(o).filter((k) => !known.includes(k));
  return bad.length ? `${where}has an unknown key ${bad.map((k) => `"${k}"`).join(", ")}. Known: ${known.join(", ")}.` : null;
};

/**
 * An automation file's JSON, strictly (§chat.schedules/automation-file): every key known, every type
 * right, or the exact error. `fileId` is the file's name without `.json`.
 */
export function parseAutomation(raw: unknown, fileId: string): Automation | { error: string } {
  if (!isObj(raw)) return { error: "An automation file must be a JSON object." };
  const top = unknownKeys(raw, KEYS, "The file ");
  if (top) return { error: top };
  if (!AUTOMATION_ID_RE.test(fileId)) return { error: `"${fileId}.json": an automation's file name is its id (lowercase letters, digits and dashes).` };
  if (raw.id !== fileId) return { error: `"id" must be "${fileId}", the file's name.` };
  for (const k of ["label", "when", "playbook", "session"] as const) if (typeof raw[k] !== "string" || !(raw[k] as string).trim()) return { error: `"${k}" is required, as text.` };
  for (const k of ["tz", "task"] as const) if (raw[k] !== undefined && (typeof raw[k] !== "string" || !(raw[k] as string).trim())) return { error: `"${k}" must be text.` };
  const label = (raw.label as string).trim();
  if (label.length > 60) return { error: `"label" is at most 60 characters.` };
  const playbook = (raw.playbook as string).trim();
  if (!AUTOMATION_ID_RE.test(playbook)) return { error: `"playbook" must be a playbook's id (its folder name: lowercase letters, digits and dashes).` };
  const session = (raw.session as string).trim();
  if (!(SESSION_KINDS as readonly string[]).includes(session)) return { error: `"session" must be ${SESSION_KINDS.map((s) => `"${s}"`).join(" or ")}.` };
  const w = parseWhen(raw.when as string);
  if (!w.ok) return { error: w.error };
  const tz = typeof raw.tz === "string" ? raw.tz.trim() : undefined;
  if (tz && !validZone(tz)) return { error: `"${tz}" is not a time zone Sova knows; use an IANA name like Europe/Berlin` };
  const settings = parseSettings(raw.settings);
  if ("error" in settings) return settings;
  const permissions = parsePermissions(raw.permissions);
  if ("error" in permissions) return permissions;
  return {
    id: fileId,
    label,
    when: raw.when as string,
    triggers: w.triggers,
    ...(tz ? { tz } : {}),
    ...(typeof raw.task === "string" ? { task: raw.task.trim() } : {}),
    playbook,
    session: session as SessionKind,
    settings,
    permissions,
  };
}

function parseSettings(v: unknown): AutomationSettings | { error: string } {
  if (v === undefined) return {};
  if (!isObj(v)) return { error: `"settings" must be an object.` };
  const bad = unknownKeys(v, SETTINGS_KEYS, `"settings" `);
  if (bad) return { error: bad };
  const out: AutomationSettings = {};
  if (v.model !== undefined) {
    if (typeof v.model !== "string" || !/^[^/\s]+\/\S+$/.test(v.model.trim())) return { error: `"settings.model" must be a model ref, "provider/id".` };
    out.model = v.model.trim();
  }
  if (v.thinking !== undefined) {
    if (!(THINKING_LEVELS as readonly unknown[]).includes(v.thinking)) return { error: `"settings.thinking" must be one of ${THINKING_LEVELS.join(", ")}.` };
    out.thinking = v.thinking as ThinkingLevel;
  }
  if (v.mode !== undefined) {
    if (v.mode !== "normal" && v.mode !== "delegate") return { error: `"settings.mode" must be "normal" or "delegate".` };
    out.mode = v.mode;
  }
  if (v.minorModes !== undefined) {
    if (!Array.isArray(v.minorModes) || v.minorModes.some((m) => !(AUTOMATION_MINOR_MODES as readonly unknown[]).includes(m)))
      return { error: `"settings.minorModes" must be a list of ${AUTOMATION_MINOR_MODES.join(", ")}.` };
    out.minorModes = AUTOMATION_MINOR_MODES.filter((m) => (v.minorModes as unknown[]).includes(m));
  }
  if (v.memory !== undefined) {
    const m = v.memory;
    if (!isObj(m) || unknownKeys(m, ["type", "size"], "") || !(MEMORY_TYPES as readonly unknown[]).includes(m.type) || (m.size !== undefined && !MEMORY_SIZES.includes(m.size as number)))
      return { error: `"settings.memory" must be {type: ${MEMORY_TYPES.join(" or ")}, size?: ${MEMORY_SIZES.join(", ")}}.` };
    out.memory = { type: m.type as MemoryType, size: typeof m.size === "number" ? m.size : 128 };
  }
  return out;
}

function parsePermissions(v: unknown): AutomationPermissions | { error: string } {
  if (v === undefined) return { remove: [], grant: [], oneAtATime: false, limits: { ...DEFAULT_LIMITS }, overseerMayStart: false };
  if (!isObj(v)) return { error: `"permissions" must be an object.` };
  const bad = unknownKeys(v, PERMISSION_KEYS, `"permissions" `);
  if (bad) return { error: bad };
  for (const [k, known] of [["remove", REMOVABLE], ["grant", GRANTABLE]] as const) {
    const list = v[k];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((x) => !(known as readonly unknown[]).includes(x))) return { error: `"permissions.${k}" must be a list of ${known.join(", ")}.` };
  }
  for (const k of ["oneAtATime", "overseerMayStart"] as const) if (v[k] !== undefined && typeof v[k] !== "boolean") return { error: `"permissions.${k}" must be true or false.` };
  const limits: ProfileLimits = { ...DEFAULT_LIMITS };
  if (v.limits !== undefined) {
    if (!isObj(v.limits)) return { error: `"permissions.limits" must be an object.` };
    for (const [k, n] of Object.entries(v.limits)) {
      if (!(LIMIT_KEYS as readonly string[]).includes(k)) return { error: `"permissions.limits" has an unknown key "${k}". Known: ${LIMIT_KEYS.join(", ")}.` };
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10_000) return { error: `"permissions.limits.${k}" must be a whole number from 1 to 10000.` };
      limits[k as keyof ProfileLimits] = n;
    }
  }
  const caps = normalizeCaps((v.remove as string[] | undefined) ?? [], (v.grant as string[] | undefined) ?? []);
  return { ...caps, oneAtATime: v.oneAtATime === true, limits, overseerMayStart: v.overseerMayStart === true };
}

/**
 * What an approval of an automation covers (§chat.schedules/approval), as one canonical string: its
 * triggers and zone, the playbook's id, its session kind and every permission. Settings, label, task
 * and the playbook's text are not in it. A legacy header schedule translates to the same string
 * (§chat.schedules/store), so its approval carries when they say the same.
 */
export function pin2Source(a: { triggers: readonly Trigger[]; tz?: string; playbook: string; session: SessionKind | "per-fire"; permissions: AutomationPermissions }): string {
  const p = a.permissions;
  return JSON.stringify({
    v: 2,
    when: canonicalWhen(a.triggers),
    tz: a.tz ?? null,
    playbook: a.playbook,
    session: a.session,
    remove: [...p.remove].sort(),
    grant: [...p.grant].sort(),
    oneAtATime: p.oneAtATime,
    limits: LIMIT_KEYS.map((k) => p.limits[k]),
    overseerMayStart: p.overseerMayStart,
  });
}

/** A profile's powers in an automation's terms: what a header schedule's profile gives its runs. */
export function permissionsOfProfile(p: { remove: readonly Removable[]; grant: readonly Grantable[]; singleton: boolean; limits: ProfileLimits; overseerMayStart: boolean }): AutomationPermissions {
  return { ...normalizeCaps(p.remove, p.grant), oneAtATime: p.singleton, limits: { ...p.limits }, overseerMayStart: p.overseerMayStart };
}
