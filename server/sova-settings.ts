import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { OutreachPatch } from "../shared/outreach";
import { CREATE_NO_DEFAULT } from "../shared/profiles";
import { MESH_ADAPTERS } from "./sova-mesh-settings";
import type { KeptChange, MeshAccessRow, SettingsBy, SettingsCardView, SettingsGrant, SovaCardsInfo } from "../shared/project-settings";
import { isSovaSettingId, SOVA_SETTINGS, type SovaSettingId } from "../shared/sova-settings-reference";
import { alignSettingsFile, alignSettingsInfo, saveAlignSettingsBody } from "./align-settings";
import { assistantPickOf, writeAssistantDefault } from "./baton-settings";
import type { DelegateSources } from "./delegate";
import { saveDecisions } from "./decide-routes";
import { decisionsFile, parseDecisionSettings, readDecisionSettings } from "./decide-settings";
import { memoryFile, memorySettingsInfo, parseMemorySettings, putMemorySettings } from "./memory/settings";
import { parseModelPolicy, readModelPolicy, writeModelPolicy } from "./model-policy";
import { favoritesFile, parseModelRef, setFavorite } from "./model-favorites";
import { modeFile, parseModePatch, readMode, writeMode, type ModePatch } from "./mode-state";
import { outreachFile, parseOutreach, readOutreach, readOutreachState } from "./outreach/settings";
import { saveProviderLimits } from "./provider-limits";
import { parsePushSettings, pushSettingsFile, readPushSettings, writePushSettings } from "./push-store";
import { parseSessionTitleSettings, readSessionTitleSettings, sessionTitleSettingsFile, writeSessionTitleSettings } from "./session-titles-settings";
import { credentialProblem, credentialRefusal } from "./card-refusals";
import { agentRoot, stateRoot } from "./state-root";
import { saveSubagentProfileDefault, saveSubagentProfiles, subagentProfilesInfo } from "./subagent-profiles";
import { settingsSpreadNow } from "./sync/spreads";
import { parseTargets, targetsFile, loadTargets, writeTargets } from "./targets";
import { parseSummarizerSettings, readSummarizerSettings, topicOutlineFile, writeSummarizerSettings } from "./topic-outline-settings";
import { writeFileAtomic } from "./sync/logins-stores";
import { loadDefaults, saveDefaults } from "./web-defaults";
import { readWebSettings, writeWebSettings } from "./web-settings";
import { parseNice } from "../pi-config/extensions/subagents/priority.ts";
import { parseProviderLimits, readProviderLimits } from "../pi-config/extensions/provider-limits/gate.ts";
import { parseAlignSettings } from "../pi-config/extensions/mode/align-settings.ts";
import { policyFilePath, validatePolicyFile } from "../pi-config/extensions/sandbox/policy.ts";
import { parseSubagentProfiles } from "../pi-config/extensions/subagents/subagent-profiles.ts";

/**
 * Sova-wide settings cards (§chat.create-mode/settings-cards): every setting Sova keeps for itself or for this
 * computer, those with no screen included, prepared by a Create chat and applied only by the person's click. Each
 * setting is checked by the reader it already has and written the way its own screen writes it. A card holds whole
 * values, so Apply writes exactly what the card showed; a file that changed since refuses it. A file that is a link
 * out of the agent dir is Sova's own code on this install and is never written (§chat.create-mode/boundary).
 */

export class SovaSettingsRefusal extends Error {}
const refuse = (m: string): never => {
  throw new SovaSettingsRefusal(m);
};

export interface SovaSettingsDeps {
  /** What the worker pickers check a model against. */
  sources: DelegateSources;
  /** A save of the session titles reschedules their sweep. */
  titlesChanged?: () => void;
}
let deps: SovaSettingsDeps | null = null;
export const setSovaSettingsDeps = (d: SovaSettingsDeps | null): void => void (deps = d);
const sources = (): DelegateSources => {
  if (!deps) throw new Error("Sova-wide settings aren't wired yet.");
  return deps.sources;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const errorOf = (r: unknown): string | null => (isObj(r) && typeof r.error === "string" ? r.error : null);
const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** One setting's reader and writer. */
interface Adapter {
  /** The files it writes: each is resolved before any write. */
  files(): string[];
  /** What it holds now; `value`: of what the card names, for a setting a card changes one part of. */
  read(value?: unknown): unknown;
  /** Why this value can't be saved, or null. Writes nothing. */
  check(value: unknown): string | null | Promise<string | null>;
  /** Save it; a refusal's words, or null. */
  write(value: unknown, input?: string): Promise<string | null>;
  /** A value the person types into the card's own field at Apply: it never reaches a chat. */
  input?: { field: string; label: string };
  /** The value the card holds, when more is pinned than the chat named. */
  prepare?(value: unknown): Promise<unknown>;
  /** What the person should read before Apply, as it stands now. */
  notes?(value: unknown): Promise<string[]>;
  /** Whether this change is a grant, where only some are; absent: the entry's grant always stands. */
  widens?(before: unknown, value: unknown): boolean;
  /** Every computer's access after this change: the whole of what it means, not the one change. */
  access?(value: unknown): Promise<MeshAccessRow[]>;
}

const agentFile = (name: string) => () => join(agentRoot(), name);
const settingsFile = () => join(stateRoot(), "settings.json");

/** A file of its own with no screen: its whole text, checked by `check`, written atomically. */
const wholeFile = (file: () => string, check: (v: unknown) => string | null): Adapter => ({
  files: () => [file()],
  read: () => readJson(file()),
  check,
  async write(value) {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileAtomic(file(), `${JSON.stringify(value, null, 2)}\n`);
    return null;
  },
});

/** Change these keys of a JSON file, keeping every other (a file another writer shares). */
function mergeKeys(file: string, keys: Record<string, unknown>): void {
  const was = readJson(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify({ ...(isObj(was) ? was : {}), ...keys }, null, 2)}\n`);
}

const OUTREACH_KEYS = ["sender", "acceptFrom", "paused", "numbers", "labels", "authDir"];

/** The starred models as refs, in the file's order; none when it can't be read. */
function favoriteRefs(): string[] {
  const all = readJson(favoritesFile());
  const models = isObj(all) && Array.isArray(all.models) ? all.models : [];
  return models.filter(isObj).map((m) => `${String(m.provider)}/${String(m.id)}`);
}

const PI_DEFAULT_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"];

export const SOVA_ADAPTERS: Record<SovaSettingId, Adapter> = {
  ...MESH_ADAPTERS,
  "models.policy": {
    files: () => [join(agentRoot(), "model-policy.json")],
    read: readModelPolicy,
    check: (v) => errorOf(parseModelPolicy(v)),
    write: async (v) => errorOf(writeModelPolicy(v)),
  },
  "models.limits": {
    files: () => [join(agentRoot(), "provider-limits.json")],
    read() {
      const s = readProviderLimits(agentRoot());
      return s.state === "ok" ? { limits: s.value.limits } : { limits: {} };
    },
    check(v) {
      const parsed = parseProviderLimits({ version: 1, limits: isObj(v) ? v.limits : undefined });
      return parsed.ok ? null : parsed.errors.join("; ");
    },
    async write(v) {
      const r = saveProviderLimits(v);
      return r.status === 200 ? null : errorOf(r.body);
    },
  },
  "models.default": {
    files: () => [join(stateRoot(), "defaults.json")],
    read: () => loadDefaults(),
    check(v) {
      if (!isObj(v)) return "Expected {model?, thinking?}.";
      for (const k of Object.keys(v)) if (k !== "model" && k !== "thinking") return `Unknown key "${k}": model or thinking.`;
      if (v.model !== undefined && (typeof v.model !== "string" || !v.model.includes("/"))) return 'model is "provider/model".';
      if (v.thinking !== undefined && typeof v.thinking !== "string") return "thinking is a level's name.";
      return null;
    },
    async write(v) {
      saveDefaults(v as { model?: string; thinking?: string });
      return null;
    },
  },
  "models.providers": wholeFile(agentFile("models.json"), (v) => (isObj(v) && isObj(v.providers) ? null : "Expected {providers: {<name>: {…}}}.")),
  "models.image-fallback": wholeFile(agentFile("vision-delegate.json"), (v) => {
    if (!isObj(v)) return "Expected {fallbacks, exhaustedAbovePct, contextChars}.";
    if (v.fallbacks !== undefined && (!Array.isArray(v.fallbacks) || !v.fallbacks.length || v.fallbacks.some((r) => typeof r !== "string" || !r.includes("/")))) return 'fallbacks lists "provider/modelId" refs.';
    if (v.exhaustedAbovePct !== undefined && !(typeof v.exhaustedAbovePct === "number" && v.exhaustedAbovePct > 0 && v.exhaustedAbovePct <= 100)) return "exhaustedAbovePct is above 0, at most 100.";
    if (v.contextChars !== undefined && !(Number.isInteger(v.contextChars) && (v.contextChars as number) >= 0)) return "contextChars is a whole number.";
    return null;
  }),
  "models.pi-defaults": {
    files: () => [join(agentRoot(), "settings.json")],
    read() {
      const all = readJson(join(agentRoot(), "settings.json"));
      return Object.fromEntries(PI_DEFAULT_KEYS.filter((k) => isObj(all) && k in all).map((k) => [k, (all as Record<string, unknown>)[k]]));
    },
    check(v) {
      if (!isObj(v)) return "Expected {defaultProvider?, defaultModel?, defaultThinkingLevel?}.";
      for (const [k, x] of Object.entries(v)) {
        if (!PI_DEFAULT_KEYS.includes(k)) return `"${k}" can't go on a card: only ${PI_DEFAULT_KEYS.join(", ")} can.`;
        if (typeof x !== "string" || !x) return `${k} is a name.`;
      }
      return null;
    },
    async write(v) {
      mergeKeys(join(agentRoot(), "settings.json"), v as Record<string, unknown>);
      return null;
    },
  },
  "remote.targets": {
    files: () => [targetsFile()],
    read: () => loadTargets().targets,
    check(v) {
      if (!Array.isArray(v)) return "Expected the whole list of targets.";
      const r = parseTargets(JSON.stringify({ version: 1, targets: v }));
      return r.error ?? (r.invalid[0] ? `target ${r.invalid[0].name}: ${r.invalid[0].errors.join("; ")}` : null);
    },
    async write(v) {
      writeTargets(v as never);
      return null;
    },
  },
  "sandbox.policy": wholeFile(
    () => policyFilePath(agentRoot()),
    (v) => {
      const r = validatePolicyFile(v);
      return r.ok ? null : r.error;
    },
  ),
  "workers.priority": {
    files: () => [settingsFile()],
    read() {
      const all = readJson(settingsFile());
      return isObj(all) ? (all.workerNice ?? null) : null;
    },
    check: (v) => (typeof v === "number" && parseNice(v) === v ? null : "Expected a whole number, 0 to 19."),
    async write(v) {
      mergeKeys(settingsFile(), { workerNice: v });
      return null;
    },
  },
  "workers.profiles": {
    files: () => [join(agentRoot(), "subagent-profiles.json")],
    read: () => subagentProfilesInfo().settings,
    check(v) {
      const r = parseSubagentProfiles(v);
      return r.ok ? null : (r.errors ?? []).join("; ") || "The library doesn't parse.";
    },
    write: async (v) => errorOf(await saveSubagentProfiles(v, sources())),
  },
  "workers.default-profile": {
    files: () => [join(agentRoot(), "subagent-profiles-default.json")],
    read: () => subagentProfilesInfo().default ?? null,
    check: (v) => (typeof v === "string" && v ? null : "Expected a profile's id."),
    async write(v) {
      saveSubagentProfileDefault(v);
      return null;
    },
  },
  "alignment.style": {
    files: () => [alignSettingsFile()],
    read: () => alignSettingsInfo().settings,
    check: (v) => errorOf(parseAlignSettings(v)),
    write: async (v) => errorOf(saveAlignSettingsBody(v)),
  },
  "alignment.review": {
    files: () => [settingsFile()],
    read: () => readWebSettings().alignment.review,
    check: (v) => (typeof v === "boolean" ? null : "Expected true or false."),
    write: async (v) => errorOf(writeWebSettings({ alignment: { review: v } })),
  },
  memory: {
    files: () => [memoryFile()],
    read: () => memorySettingsInfo().settings,
    check: (v) => errorOf(parseMemorySettings(v)),
    write: async (v) => errorOf(await putMemorySettings(v, sources())),
  },
  "summaries.model": {
    files: () => [topicOutlineFile()],
    read() {
      const { primary, fallback } = readSummarizerSettings().settings;
      return { primary, fallback };
    },
    check: (v) => errorOf(parseSummarizerSettings(v)),
    write: async (v) => errorOf(writeSummarizerSettings(v)),
  },
  "summaries.limits": {
    files: () => [topicOutlineFile()],
    read() {
      const all = readJson(topicOutlineFile());
      const list = isObj(all) && Array.isArray(all.summarizers) ? all.summarizers : [];
      return list.map((e) => (isObj(e) ? Object.fromEntries(Object.entries(e).filter(([k]) => k === "timeoutMs" || k === "maxBudgetUsd")) : {}));
    },
    check(v) {
      const all = readJson(topicOutlineFile());
      const list = isObj(all) && Array.isArray(all.summarizers) ? all.summarizers : null;
      if (!list) return "The summary chain is still the default: set Summary line's model first, so there is a chain to limit.";
      if (!Array.isArray(v) || v.length !== list.length) return `Expected ${list.length} entries, one per summarizer.`;
      for (const e of v) {
        if (!isObj(e)) return "Each entry is {timeoutMs?, maxBudgetUsd?}.";
        for (const [k, x] of Object.entries(e)) {
          if (k !== "timeoutMs" && k !== "maxBudgetUsd") return `"${k}" isn't a limit: timeoutMs or maxBudgetUsd.`;
          if (typeof x !== "number" || x <= 0) return `${k} is a number above 0.`;
        }
      }
      return null;
    },
    async write(v) {
      const all = readJson(topicOutlineFile()) as { summarizers: Record<string, unknown>[] };
      const limits = v as Record<string, unknown>[];
      const summarizers = all.summarizers.map((e, i) => {
        const { timeoutMs: _t, maxBudgetUsd: _b, ...rest } = e;
        return { ...rest, ...limits[i] };
      });
      mergeKeys(topicOutlineFile(), { summarizers });
      return null;
    },
  },
  "summaries.titles": {
    files: () => [sessionTitleSettingsFile()],
    read: () => readSessionTitleSettings(),
    check: (v) => errorOf(parseSessionTitleSettings(v)),
    async write(v) {
      const parsed = parseSessionTitleSettings(v);
      if ("error" in parsed) return parsed.error;
      writeSessionTitleSettings(parsed);
      deps?.titlesChanged?.();
      return null;
    },
  },
  decisions: {
    files: () => [decisionsFile()],
    read: () => readDecisionSettings(),
    check: (v) => errorOf(parseDecisionSettings(v)),
    async write(v) {
      const r = await saveDecisions(v, sources());
      return r.status === 200 ? null : errorOf(r.body);
    },
  },
  "overseer.global": {
    files: () => [join(stateRoot(), "overseer.json")],
    read: () => readJson(join(stateRoot(), "overseer.json")),
    check: async (v) => (await import("./overseer")).overseerSettingsProblem(v),
    async write(v) {
      const { saveOverseerSettings } = await import("./overseer");
      return errorOf(await saveOverseerSettings(v));
    },
  },
  notifications: {
    files: () => [pushSettingsFile()],
    read: () => readPushSettings(),
    check: (v) => errorOf(parsePushSettings(v, true)),
    write: async (v) => errorOf(writePushSettings(v)),
  },
  outreach: {
    files: () => [outreachFile()],
    read() {
      const file = readOutreach() as unknown as Record<string, unknown>;
      return Object.fromEntries(OUTREACH_KEYS.filter((k) => file[k] !== undefined).map((k) => [k, file[k]]));
    },
    check(v) {
      if (!isObj(v)) return `Expected {${OUTREACH_KEYS.join(", ")}}.`;
      for (const k of Object.keys(v)) if (!OUTREACH_KEYS.includes(k)) return `"${k}" can't go on a card: ${OUTREACH_KEYS.join(", ")} can.`;
      const { file, problem } = readOutreachState();
      if (problem) return `outreach.json can't be read (${problem}).`;
      try {
        parseOutreach({ ...file, ...v });
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    async write(v) {
      const { applyOutreachPatch } = await import("./outreach/routes");
      return errorOf(await applyOutreachPatch(v as OutreachPatch));
    },
  },
  "modes.default": {
    files: () => [modeFile()],
    read() {
      const m = readMode();
      return { mode: m.mode, strict: m.strict, minorModes: m.minorModes };
    },
    check(v) {
      if (!isObj(v)) return "Expected {mode, strict, minorModes}.";
      if (v.mode === "create") return CREATE_NO_DEFAULT;
      for (const k of ["mode", "strict", "minorModes"]) if (!(k in v)) return `Name all three: mode, strict and minorModes (${k} is missing).`;
      for (const k of Object.keys(v)) if (!["mode", "strict", "minorModes"].includes(k)) return `"${k}" can't go on a card: mode, strict and minorModes can.`;
      if (v.mode !== "normal" && v.mode !== "delegate") return 'mode is "normal" or "delegate".';
      if (typeof v.strict !== "boolean") return "strict is true or false.";
      return errorOf(parseModePatch({ minorModes: v.minorModes }));
    },
    async write(v) {
      writeMode(v as ModePatch);
      return null;
    },
  },
  "models.favorites": {
    files: () => [favoritesFile()],
    read: favoriteRefs,
    check(v) {
      if (!Array.isArray(v) || v.some((r) => typeof r !== "string" || !parseModelRef(r))) return 'Expected the whole list: ["provider/id", …].';
      return null;
    },
    async write(v) {
      const was = favoriteRefs();
      const now = v as string[];
      for (const ref of [...now.filter((r) => !was.includes(r)).map((ref) => ({ ref, favorite: true })), ...was.filter((r) => !now.includes(r)).map((ref) => ({ ref, favorite: false }))]) {
        const r = setFavorite(ref);
        if (r.status !== 200) return errorOf(r.body);
      }
      return null;
    },
  },
  "assistant.default": {
    files: () => [join(stateRoot(), "baton-settings.json")],
    read() {
      const all = readJson(join(stateRoot(), "baton-settings.json"));
      return assistantPickOf(isObj(all) ? all.assistant : null);
    },
    check(v) {
      if (v === null) return null;
      return isObj(v) && typeof v.model === "string" && v.model.includes("/") ? null : 'Expected {model: "provider/model", thinking?} or null.';
    },
    write: async (v) => errorOf(writeAssistantDefault({ assistant: v })),
  },
};

// ---- links ---------------------------------------------------------------------------------------------

const INSTEAD: Partial<Record<SovaSettingId, string>> = {
  "models.providers": "Add the provider with an add-on in your own folder instead: a file in `extensions/` of your agent folder that calls `pi.registerProvider`.",
  "models.image-fallback": "On this install it isn't yours to change through Sova: Sova can't change its own code.",
};

/** The file of `id` that is a link out of Sova's own data folders, in words, or null. Links are resolved before any write. */
export function linkProblem(id: SovaSettingId): string | null {
  const roots = [resolve(agentRoot()), resolve(stateRoot())].map((r) => (existsSync(r) ? realpathSync(r) : r));
  for (const file of SOVA_ADAPTERS[id].files()) {
    let linked = false;
    try {
      linked = lstatSync(file).isSymbolicLink();
    } catch {
      continue; // Not there yet: nothing to resolve.
    }
    if (!linked) continue;
    let target: string;
    try {
      target = realpathSync(file);
    } catch {
      target = file;
    }
    if (roots.some((r) => !relative(r, target).startsWith(".."))) continue;
    return `${SOVA_SETTINGS[id].label} is a link into Sova's own folder on this install, so a card doesn't change it. ${INSTEAD[id] ?? "Sova can't change its own code."}`;
  }
  return null;
}

// ---- cards ---------------------------------------------------------------------------------------------

interface StoredEdit {
  id: SovaSettingId;
  before: unknown;
  value: unknown;
  /** What the card showed of every computer's access. */
  access?: MeshAccessRow[];
  /** Read again as the card is read; never part of its fingerprint. */
  notes?: string[];
}

interface StoredSovaCard {
  id: string;
  n: number;
  state: "waiting" | "applied" | "dismissed";
  createdAt: string;
  why: string;
  by: SettingsBy;
  edits: StoredEdit[];
  fingerprint: string;
  appliedAt?: string;
  dismissedAt?: string;
}

interface Store {
  version: 1;
  next: number;
  cards: StoredSovaCard[];
}

export const MAX_SOVA_WAITING = 10;
const KEEP_DONE = 20;
const storeFile = () => join(stateRoot(), "sova-settings-cards.json");
export const sovaHistoryFile = () => join(stateRoot(), "sova-settings-history.jsonl");

function readStore(): Store {
  const raw = readJson(storeFile()) as Store | null;
  return raw?.version === 1 && Array.isArray(raw.cards) && typeof raw.next === "number" ? raw : { version: 1, next: 1, cards: [] };
}

function writeStore(s: Store): void {
  const waiting = s.cards.filter((c) => c.state === "waiting");
  const done = s.cards.filter((c) => c.state !== "waiting").slice(-KEEP_DONE);
  const file = storeFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...s, cards: [...done, ...waiting].sort((a, b) => a.n - b.n) }, null, 2)}\n`);
  renameSync(tmp, file);
}

/** A pin's shape anywhere in a value: 32 hex digits, however grouped. */
const input32 = (v: unknown): boolean => /(?:[0-9a-f][\s:-]?){32}/i.test(JSON.stringify(v ?? null));

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const fingerprintOf = (edits: StoredEdit[]): string =>
  createHash("sha256")
    .update(JSON.stringify(edits.map((e) => [e.id, e.before, e.value, e.access ?? null])))
    .digest("hex")
    .slice(0, 32);

/** Each value that differs, by its path: what a card says row by row. */
function leaves(path: string, v: unknown, out: Map<string, unknown>): void {
  if (isObj(v) && Object.keys(v).length) for (const [k, x] of Object.entries(v)) leaves(path ? `${path}.${k}` : k, x, out);
  // A list of records goes by each one's id, so one changed field reads as that field, not as the whole list.
  else if (Array.isArray(v) && v.length && v.every(isObj)) v.forEach((x, i) => leaves(`${path}[${String(x.id ?? x.name ?? i)}]`, x, out));
  else out.set(path, v);
}
const words = (v: unknown): string => {
  if (v === undefined || v === null) return "not set";
  if (v === true) return "on";
  if (v === false) return "off";
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};
const MAX_ROWS = 12;

const POLICY_LISTS = ["disabledProviders", "disabledModels", "subagentDisabledProviders", "subagentDisabledModels"] as const;

/** What a change allows, or null: the setting's own grant, and for the model policy only when a model comes back on. */
function grantOf(e: StoredEdit): string | null {
  const what = SOVA_SETTINGS[e.id].grant;
  if (!what) return null;
  if (SOVA_ADAPTERS[e.id].widens?.(e.before, e.value) === false) return null;
  if (e.id === "models.policy") {
    const from = e.before as Record<string, string[]>;
    const to = e.value as Record<string, string[]>;
    if (!POLICY_LISTS.some((k) => (from[k] ?? []).some((x) => !(to[k] ?? []).includes(x)))) return null;
  }
  return what.replace(/\.$/, ""); // The card adds its own full stop.
}

function rowsOf(e: StoredEdit): KeptChange[] {
  const label = SOVA_SETTINGS[e.id].label;
  const grant = grantOf(e) ?? undefined;
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  leaves("", e.before, a);
  leaves("", e.value, b);
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter((k) => !same(a.get(k), b.get(k)));
  const rows: KeptChange[] = changed.slice(0, MAX_ROWS).map((k) => ({ field: `${e.id}${k ? `.${k}` : ""}`, label: k ? `${label}: ${k}` : label, from: a.get(k) ?? null, to: b.get(k) ?? null, fromText: words(a.get(k)), toText: words(b.get(k)), ...(grant ? { grant } : {}) }));
  if (changed.length > MAX_ROWS) rows.push({ field: `${e.id}.more`, label, from: null, to: null, fromText: "", toText: `${changed.length - MAX_ROWS} more changes (Show File Changes)`, ...(grant ? { grant } : {}) });
  return rows;
}

const diffOf = (edits: StoredEdit[]): string =>
  edits.map((e) => [`--- ${SOVA_SETTINGS[e.id].file}`, `+++ ${SOVA_SETTINGS[e.id].file}`, ...JSON.stringify(e.before ?? null, null, 2).split("\n").map((l) => `- ${l}`), ...JSON.stringify(e.value ?? null, null, 2).split("\n").map((l) => `+ ${l}`)].join("\n")).join("\n").slice(0, 64 * 1024);

/** §design.copy-deck/create-mode: a Sova-wide card's place. It says "by sync" only when a peer would receive it. */
function placeOf(edits: StoredEdit[]): string {
  return edits.some((e) => SOVA_SETTINGS[e.id].sync) && settingsSpreadNow() ? "Sova-wide, and your other computers by sync" : "Sova-wide";
}

function cardView(c: StoredSovaCard): SettingsCardView {
  const grants: SettingsGrant[] = c.edits.flatMap((e) => {
    const what = grantOf(e);
    return what ? [{ key: `sova:${e.id}`, setting: e.id, what }] : [];
  });
  const labels = c.edits.map((e) => SOVA_SETTINGS[e.id].label);
  return {
    id: c.id,
    kind: "sova",
    place: placeOf(c.edits),
    state: c.state,
    title: labels.length > 3 ? `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more` : labels.join(", "),
    why: c.why,
    by: c.by,
    createdAt: c.createdAt,
    kept: c.edits.flatMap(rowsOf),
    files: [],
    grants,
    lands: null,
    diff: diffOf(c.edits),
    fingerprint: c.fingerprint,
    ...(c.edits.map((e) => SOVA_ADAPTERS[e.id].input).find(Boolean) ? { input: c.edits.map((e) => SOVA_ADAPTERS[e.id].input).find(Boolean)! } : {}),
    ...(c.edits.some((e) => e.notes?.length) ? { notes: c.edits.flatMap((e) => e.notes ?? []) } : {}),
    ...(c.edits.some((e) => e.access) ? { access: c.edits.flatMap((e) => e.access ?? []) } : {}),
    ...(c.appliedAt ? { appliedAt: c.appliedAt } : {}),
    ...(c.dismissedAt ? { dismissedAt: c.dismissedAt } : {}),
  };
}

export function sovaCardsInfo(): SovaCardsInfo {
  const s = readStore();
  return { cards: s.cards.filter((c) => c.state === "waiting").map(cardView), recent: s.cards.filter((c) => c.state !== "waiting").slice(-KEEP_DONE).map(cardView) };
}

/** What a waiting card's notes say now: the page reads this before it draws, so they age no more than a poll. */
export async function refreshSovaNotes(): Promise<void> {
  const fresh = new Map<string, string[]>();
  for (const c of readStore().cards.filter((x) => x.state === "waiting"))
    for (const e of c.edits) {
      const now = await SOVA_ADAPTERS[e.id].notes?.(e.value).catch(() => null);
      if (now && !same(now, e.notes)) fresh.set(`${c.id}/${e.id}`, now);
    }
  if (!fresh.size) return;
  const store = readStore();
  for (const c of store.cards) for (const e of c.edits) if (fresh.has(`${c.id}/${e.id}`)) e.notes = fresh.get(`${c.id}/${e.id}`)!;
  writeStore(store);
}

/** Prepare a card (a Create chat's propose): every edit checked first, a refusal writes nothing. It never applies. */
export async function proposeSova(input: { edits: unknown[]; why: unknown }, by: SettingsBy): Promise<SettingsCardView | null> {
  const why = typeof input.why === "string" ? input.why.trim().slice(0, 500) : "";
  if (!why) refuse("Say why (why): one or two sentences for the person.");
  if (input.edits.length > 20) refuse("At most 20 edits at once.");
  const edits: StoredEdit[] = [];
  for (const raw of input.edits) {
    if (!isObj(raw)) return refuse('Each edit is {setting: "sova", id, value}.');
    if (!isSovaSettingId(raw.id)) return refuse(`No Sova-wide setting "${String(raw.id)}" (sova_settings get lists them).`);
    const id = raw.id;
    if (!("value" in raw)) return refuse(`${id} names its value: ${SOVA_SETTINGS[id].value}.`);
    if (credentialProblem(raw.value)) refuse(credentialRefusal(SOVA_SETTINGS[id].screen ?? `the file ${SOVA_SETTINGS[id].file}`, id === "decisions" ? "Its key stays on Settings → Decisions." : undefined));
    if (input32(raw.value)) refuse("A fingerprint never goes through a chat: the person types it into the card's own field.");
    if (SOVA_ADAPTERS[id].input && input.edits.length > 1) refuse(`${SOVA_SETTINGS[id].label} goes on a card of its own.`);
    const link = linkProblem(id);
    if (link) refuse(link);
    const problem = await SOVA_ADAPTERS[id].check(raw.value);
    if (problem) refuse(`${SOVA_SETTINGS[id].label}: ${problem}`);
    if (edits.some((e) => e.id === id)) refuse(`Two edits change ${id}: make it one.`);
    const value = (await SOVA_ADAPTERS[id].prepare?.(raw.value)) ?? raw.value;
    const before = SOVA_ADAPTERS[id].read(value);
    if (!same(before, value)) {
      const access = await SOVA_ADAPTERS[id].access?.(value);
      const notes = await SOVA_ADAPTERS[id].notes?.(value);
      edits.push({ id, before, value, ...(access ? { access } : {}), ...(notes ? { notes } : {}) });
    }
  }
  if (!edits.length) return null;
  const store = readStore();
  if (store.cards.filter((c) => c.state === "waiting").length >= MAX_SOVA_WAITING) refuse(`${MAX_SOVA_WAITING} Sova-wide cards already wait: withdraw one, or ask the person to apply or dismiss them.`);
  const n = store.next;
  const card: StoredSovaCard = { id: `sw_${n}`, n, state: "waiting", createdAt: new Date().toISOString(), why, by, edits, fingerprint: fingerprintOf(edits) };
  store.cards.push(card);
  store.next = n + 1;
  writeStore(store);
  return cardView(card);
}

/** Apply is the person's click on Sova's own page: the route is page-only, as a project's card is. */
export async function applySovaCard(cardId: string, fingerprint: unknown, input?: unknown): Promise<{ card: SettingsCardView; approved: string[] }> {
  const store = readStore();
  const c = store.cards.find((x) => x.id === cardId);
  if (!c) throw Object.assign(new SovaSettingsRefusal(`No settings card ${cardId}.`), { status: 404 });
  if (c.state !== "waiting") throw Object.assign(new SovaSettingsRefusal(`${cardId} is already ${c.state}.`), { status: 409 });
  if (fingerprint !== c.fingerprint) throw Object.assign(new SovaSettingsRefusal(`${cardId} changed since you looked: look at it again.`), { status: 409 });
  for (const e of c.edits) {
    const link = linkProblem(e.id);
    if (link) throw Object.assign(new SovaSettingsRefusal(link), { status: 409 });
    if (!same(SOVA_ADAPTERS[e.id].read(e.value), e.before)) throw Object.assign(new SovaSettingsRefusal(`${SOVA_SETTINGS[e.id].label} changed since ${cardId} was made: dismiss it and ask for a new card.`), { status: 409 });
  }
  const by: SettingsBy = { ...c.by, via: "card" };
  const needs = c.edits.find((e) => SOVA_ADAPTERS[e.id].input);
  if (needs && (typeof input !== "string" || !input.trim())) throw Object.assign(new SovaSettingsRefusal(`${SOVA_ADAPTERS[needs.id].input!.label}: fill it in on the card.`), { status: 409 });
  for (const e of c.edits) {
    const refused = await SOVA_ADAPTERS[e.id].write(e.value, SOVA_ADAPTERS[e.id].input ? (input as string) : undefined);
    if (refused) throw Object.assign(new SovaSettingsRefusal(`${SOVA_SETTINGS[e.id].label}: ${refused}`), { status: 409 });
    mkdirSync(dirname(sovaHistoryFile()), { recursive: true });
    appendFileSync(sovaHistoryFile(), `${JSON.stringify({ at: new Date().toISOString(), field: e.id, from: e.before ?? null, to: e.value, by, card: c.id })}\n`);
  }
  const after = readStore();
  const mine = after.cards.find((x) => x.id === cardId)!;
  mine.state = "applied";
  mine.appliedAt = new Date().toISOString();
  writeStore(after);
  return { card: cardView(mine), approved: c.edits.filter((e) => grantOf(e)).map((e) => `sova:${e.id}`) };
}

/** Dismiss (the person's), or a Create chat's withdraw of its own card. */
export function withdrawSovaCard(cardId: string, opts: { chat?: string } = {}): void {
  const store = readStore();
  const c = store.cards.find((x) => x.id === cardId);
  if (!c) throw Object.assign(new SovaSettingsRefusal(`No settings card ${cardId}.`), { status: 404 });
  if (c.state !== "waiting") throw Object.assign(new SovaSettingsRefusal(`${cardId} is already ${c.state}.`), { status: 409 });
  if (opts.chat !== undefined && c.by.chat !== opts.chat) refuse(`${cardId} isn't this chat's: only the person dismisses it.`);
  c.state = "dismissed";
  c.dismissedAt = new Date().toISOString();
  writeStore(store);
}
