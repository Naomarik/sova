import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTRACT_FILE, parseDefinition } from "../shared/project-contract";
import { PO_CAP_LABEL, type ProjectOverseerCaps, type ProjectOverseerPatch, type ProjectOverseerSettings } from "../shared/project-overseer";
import type { FileChangeView, KeptChange, ProjectSettingsInfo, SettingsBy, SettingsCardView, SettingsGrant, SettingsHistoryRow, SettingsRow } from "../shared/project-settings";
import { DEFAULT_PROFILE_ID, parseProfile, powersText, powersToApprove, profileFileError, profileKey, type Profile } from "../shared/profiles";
import { isPowerId, POWER_INFO, POWERS, type PowerColumn } from "../shared/powers";
import { isProjectModeId, ModeFileError, parseModeFile, PROJECT_MODE_ENTRY, PROJECT_MODES_DIR } from "../shared/project-modes";
import { scheduleOf, scheduleText } from "../shared/schedules";
import { OFFERS_FILE, parseOffersFile, runButtonsOf } from "../shared/session-offers";
import { SETTINGS_REFERENCE, type SettingId } from "../shared/settings-reference";
import { checkoutRootOf, discoverProjectModes, readProjectMode } from "../pi-config/extensions/mode/project-discovery.ts";
import { OrgError } from "./org-error";
import { isPlaybookId, listProjectPlaybooks, parseFrontmatter, PROJECT_PLAYBOOK_DIRS, readProjectPlaybook } from "./playbooks";
import { approvalOf, approve as approveProfile, readTrust } from "./profile-trust";
import { findProfile, profileSources } from "./profile-sources";
import { isApproved as modeApproved, recordApproval as recordModeApproval } from "./project-mode-approvals";
import { mergePoPatch, projectOf, projectOverseerPaths, readPoSettings } from "./project-overseer-store";
import { advanceBranch, blobAt, busyWith, commitOnto, deleteRef, diffOf, dirtyPaths, git, readBlob, type Repo, repoOf, repoPath, SettingsGitError, setRef, writeBlob } from "./project-settings-git";
import { scheduleKeeper } from "./schedules";
import { approveRuns, runFingerprint, runsApproved } from "./session-offers-trust";
import { stateRoot } from "./state-root";

/**
 * A project's settings (§app.project-overseer/settings): every setting, Sova-kept and in the
 * project's files; the project overseer's Settings change cards (a propose writes its file changes
 * on a Sova-owned ref, never in the project folder); Apply, the operator's click, which applies and
 * records the approvals of exactly the card's grants; the uncommitted settings edits in the folder
 * as one card; the history and Undo.
 *
 * Files: `<state root>/project-settings/<pid>.json` (the cards, host-local) and
 * `<overseer dir>/settings-history.jsonl` (beside overseer.json).
 */

// ---- the overseer's own settings, as fields ----------------------------------------------------------

/** What applying a Sova-kept patch needs from the overseer (project-overseer.ts sets it: no import cycle). */
export interface SettingsDeps {
  /** PATCH …/overseer as the route does it, recording history as `by`; resolves with the rows it wrote. */
  patch(projectId: string, body: ProjectOverseerPatch, by: SettingsBy, meta?: { card?: string; revertOf?: string }): Promise<SettingsHistoryRow[]>;
  /** PUT …/overseer/memory; resolves with the rows it wrote, or throws its refusal. */
  memory(projectId: string, body: { on?: boolean; type?: string; size?: number }, by: SettingsBy, meta?: { card?: string; revertOf?: string }): Promise<SettingsHistoryRow[]>;
  /** The project's own PATCH (its name). */
  rename(projectId: string, name: string, by: SettingsBy, meta?: { card?: string; revertOf?: string }): Promise<SettingsHistoryRow[]>;
}
let deps: SettingsDeps | null = null;
export const setSettingsDeps = (d: SettingsDeps | null): void => void (deps = d);
const depsOrThrow = (): SettingsDeps => {
  if (!deps) throw new Error("project settings: the overseer's settings aren't wired (setSettingsDeps)");
  return deps;
};

type Fields = Record<string, unknown>;

/** The overseer's settings as one flat record of fields ("powers.overseer.gather", "caps.createPerDay", "watch"…). Pure. */
export function flatten(s: ProjectOverseerSettings): Fields {
  const out: Fields = {};
  for (const k of ["watch", "model", "thinking", "codingModel", "codingThinking", "gatheringModel", "gatheringThinking", "gatheringAbilities", "watchGapMin", "soonLookSec", "holdMin", "extraSystemPrompt"] as const) out[k] = s[k] ?? null;
  for (const k of Object.keys(s.caps) as (keyof ProjectOverseerCaps)[]) out[`caps.${k}`] = s.caps[k];
  for (const p of POWERS) {
    out[`powers.overseer.${p}`] = s.powers.overseer[p];
    if (POWER_INFO[p].assistant) out[`powers.assistant.${p}`] = s.powers.assistant[p];
  }
  out.assistantModels = s.powers.assistantModels ?? null;
  out.memory = s.memory ?? null;
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const LABEL: Record<string, string> = {
  watch: "Watch",
  model: "Its model",
  thinking: "Its thinking",
  codingModel: "Coding sessions' model",
  codingThinking: "Coding sessions' thinking",
  gatheringModel: "Gathering sessions' model",
  gatheringThinking: "Gathering sessions' thinking",
  gatheringAbilities: "Gathering sessions' abilities",
  watchGapMin: "Looks at most every (minutes)",
  soonLookSec: "The soon look (seconds)",
  holdMin: "The hold (minutes)",
  extraSystemPrompt: "Extra instructions",
  assistantModels: "The Project Assistant's models",
  memory: "Its memory",
  resume: "The brake",
  "project.name": "The project's name",
};

export function fieldLabel(field: string): string {
  if (field.startsWith("caps.")) return PO_CAP_LABEL[field.slice(5) as keyof ProjectOverseerCaps] ?? field;
  const m = /^powers\.(overseer|assistant)\.(.+)$/.exec(field);
  if (m && isPowerId(m[2])) return `${m[1] === "assistant" ? POWER_INFO[m[2]].assistantLabel ?? POWER_INFO[m[2]].label : POWER_INFO[m[2]].label} (${m[1] === "assistant" ? "the Project Assistant from a client" : "the overseer on its own"})`;
  if (field.startsWith("file:")) return field.slice(5);
  return LABEL[field] ?? field;
}

/** A field's value in words. Pure. */
export function valueText(field: string, v: unknown): string {
  if (field.startsWith("powers.") || field === "watch") return v === true ? "On" : "Off";
  if (field.startsWith("caps.")) return v === null ? "Unlimited" : String(v);
  if (field === "soonLookSec") return v === null ? "Off" : `${v} s`;
  if (field === "holdMin") return v === 0 ? "no hold" : `${v} min`;
  if (field === "watchGapMin") return `${v} min`;
  if (field === "extraSystemPrompt") return typeof v === "string" && v.trim() ? `${v.trim().length} characters` : "none";
  if (field === "gatheringAbilities") return v === null ? "Automatic" : JSON.stringify(v);
  if (field === "assistantModels") return v === null ? "the organization's" : JSON.stringify(v);
  if (field === "memory") return v === null ? "on (as it starts)" : `${(v as { on: boolean }).on ? "on" : "off"}`;
  if (field.endsWith("Model") || field === "model") return v === null ? "the default" : String(v);
  if (field.endsWith("Thinking") || field === "thinking") return v === null ? "the default" : String(v);
  if (field.startsWith("file:")) return v === null ? "absent" : String(v).slice(0, 10);
  if (field === "resume") return String(v);
  return v === null || v === undefined ? "not set" : String(v);
}

/** Why a change of `field` from `from` to `to` is a grant (what it allows), or undefined: it narrows or is neutral. Pure. */
export function grantOf(field: string, from: unknown, to: unknown): string | undefined {
  const m = /^powers\.(overseer|assistant)\.(.+)$/.exec(field);
  if (m) return from !== true && to === true ? `lets ${m[1] === "assistant" ? "a client's message to the Project Assistant" : "the overseer on its own"} ${lower(fieldLabel(field).replace(/ \(.*\)$/, ""))}` : undefined;
  if (field.startsWith("caps.")) {
    const raised = to === null ? from !== null : typeof from === "number" && typeof to === "number" && to > from;
    return raised ? `raises the limit ${fieldLabel(field)} to ${valueText(field, to)}` : undefined;
  }
  if (field === "watch") return from !== true && to === true ? "lets the overseer look at the project on its own" : undefined;
  if (field === "watchGapMin") return typeof from === "number" && typeof to === "number" && to < from ? `lets it look on its own as often as every ${to} min` : undefined;
  if (field === "soonLookSec") return to !== null && (from === null || (typeof from === "number" && typeof to === "number" && to < from)) ? `starts a look ${to} s after something to see soon` : undefined;
  if (field === "holdMin") return typeof from === "number" && typeof to === "number" && to < from ? (to === 0 ? "lifts the hold: its acts go ahead at once" : `shortens the hold to ${to} min`) : undefined;
  if (field === "extraSystemPrompt") return !same(from, to) ? "changes what the overseer is told (its extra instructions)" : undefined;
  if (field === "gatheringAbilities") return !same(from, to) ? "changes what its gathering sessions can do" : undefined;
  if (field === "resume") return "lifts the brake, so its switches act again";
  return undefined;
}
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Each field `after` changes, in words, with its grant. Pure. */
export function keptChanges(before: Fields, after: Fields): KeptChange[] {
  const out: KeptChange[] = [];
  for (const field of Object.keys(after)) {
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (same(from, to)) continue;
    const grant = grantOf(field, from, to);
    out.push({ field, label: fieldLabel(field), from, to, fromText: valueText(field, from), toText: valueText(field, to), ...(grant ? { grant } : {}) });
  }
  return out;
}

/** The PATCH body that sets exactly `changes` (each field to its `to`). */
export function patchOf(changes: Pick<KeptChange, "field" | "to">[]): ProjectOverseerPatch {
  const body: Record<string, any> = {};
  for (const { field, to } of changes) {
    const m = /^powers\.(overseer|assistant)\.(.+)$/.exec(field);
    if (m) ((body.powers ??= {})[m[1]!] ??= {})[m[2]!] = to;
    else if (field.startsWith("caps.")) (body.caps ??= {})[field.slice(5)] = to;
    else if (field === "resume") body.resume = true;
    else if (field === "assistantModels") body.assistantModels = to;
    else body[field] = to;
  }
  return body as ProjectOverseerPatch;
}

// ---- history ----------------------------------------------------------------------------------------

export const historyFile = (projectId: string): string => join(projectOverseerPaths(projectId).dir, "settings-history.jsonl");

export function readHistory(projectId: string): SettingsHistoryRow[] {
  let text = "";
  try {
    text = readFileSync(historyFile(projectId), "utf8");
  } catch {
    return [];
  }
  const out: SettingsHistoryRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SettingsHistoryRow;
      if (r && typeof r.id === "string" && typeof r.field === "string") out.push(r);
    } catch {
      // a torn line: skipped
    }
  }
  return out;
}

export function appendHistory(projectId: string, rows: Omit<SettingsHistoryRow, "id" | "at">[], at = new Date().toISOString()): SettingsHistoryRow[] {
  if (!rows.length) return [];
  const file = historyFile(projectId);
  mkdirSync(dirname(file), { recursive: true });
  const n = readHistory(projectId).length;
  const out = rows.map((r, i) => ({ id: `h${n + i + 1}`, at, ...r }));
  appendFileSync(file, out.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return out;
}

/** The rows a change of the overseer's settings from `before` to `after` writes. */
export function recordKept(projectId: string, before: ProjectOverseerSettings, after: ProjectOverseerSettings, by: SettingsBy, meta: { card?: string; revertOf?: string; resumed?: boolean } = {}): SettingsHistoryRow[] {
  const changes = keptChanges(flatten(before), flatten(after));
  const rows = changes.map((c) => ({ field: c.field, from: c.from, to: c.to, by, ...(meta.card ? { card: meta.card } : {}), ...(meta.revertOf ? { revertOf: meta.revertOf } : {}) }));
  if (meta.resumed) rows.push({ field: "resume", from: "braked", to: "resumed", by, ...(meta.card ? { card: meta.card } : {}) });
  return appendHistory(projectId, rows);
}

// ---- the cards' store ---------------------------------------------------------------------------------

interface StoredFile {
  setting: SettingId;
  id?: string;
  rel: string;
  before: string | null;
  after: string | null;
  summary: string;
}

interface StoredGrant extends SettingsGrant {
  /** What its approval is pinned to (a profile's powers, a schedule's lines, the run-button fingerprint). */
  pin?: unknown;
}

interface StoredCard {
  id: string;
  n: number;
  state: "waiting" | "applied" | "dismissed";
  createdAt: string;
  why: string;
  by: SettingsBy;
  /** The Sova-kept changes it holds (field → to), as they read when it was made. */
  kept: KeptChange[];
  memory?: { on?: boolean; type?: string; size?: number };
  name?: string;
  files: StoredFile[];
  parent: string | null;
  commit: string | null;
  ref: string | null;
  grants: StoredGrant[];
  fingerprint: string;
  appliedNow?: SettingsHistoryRow[];
  appliedAt?: string;
  appliedCommit?: string;
  dismissedAt?: string;
}

interface Store {
  version: 1;
  next: number;
  cards: StoredCard[];
}

export const MAX_WAITING = 10;
const KEEP_DONE = 20;

const storeFile = (projectId: string) => join(stateRoot(), "project-settings", `${projectId}.json`);

function readStore(projectId: string): Store {
  try {
    const raw = JSON.parse(readFileSync(storeFile(projectId), "utf8")) as Store;
    if (raw?.version === 1 && Array.isArray(raw.cards) && typeof raw.next === "number") return raw;
  } catch {
    // missing or unreadable: none
  }
  return { version: 1, next: 1, cards: [] };
}

function writeStore(projectId: string, s: Store): void {
  const waiting = s.cards.filter((c) => c.state === "waiting");
  const done = s.cards.filter((c) => c.state !== "waiting").slice(-KEEP_DONE);
  const file = storeFile(projectId);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...s, cards: [...done, ...waiting].sort((a, b) => a.n - b.n) }, null, 2)}\n`);
  renameSync(tmp, file);
}

const fingerprintOf = (c: { kept: KeptChange[]; memory?: unknown; name?: string; files: { rel: string; after: string | null }[]; grants: SettingsGrant[] }): string =>
  createHash("sha256")
    .update(JSON.stringify({ kept: c.kept.map((k) => [k.field, k.to]), memory: c.memory ?? null, name: c.name ?? null, files: c.files.map((f) => [f.rel, f.after]), grants: c.grants.map((g) => [g.key, g.what]) }))
    .digest("hex")
    .slice(0, 32);

// ---- edits --------------------------------------------------------------------------------------------

export class SettingsRefusal extends Error {}

const refuse = (m: string): never => {
  throw new SettingsRefusal(m);
};

const FILE_MAX = 64 * 1024;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The settings files' places, relative to the project root (local edits are looked for under these). */
export const SETTINGS_PLACES = [CONTRACT_FILE, OFFERS_FILE, ".sova/profiles", ...PROJECT_PLAYBOOK_DIRS.map((d) => d.split("\\").join("/")), PROJECT_MODES_DIR];

/** Whether `rel` is a settings file (a commit of Apply touches nothing else). */
export const isSettingsPath = (rel: string): boolean =>
  !rel.includes("..") && SETTINGS_PLACES.some((p) => rel === p || (rel.startsWith(`${p}/`) && p !== CONTRACT_FILE && p !== OFFERS_FILE));

/** The setting a settings file belongs to (local edits name it so). */
export function settingOfPath(rel: string): { setting: SettingId; id?: string } {
  if (rel === CONTRACT_FILE) return { setting: "services" };
  if (rel === OFFERS_FILE) return { setting: "offers" };
  let m = /^\.sova\/profiles\/([^/]+)\.json$/.exec(rel);
  if (m) return { setting: "profile", id: m[1]! };
  m = /^\.sova\/(?:marketing\/)?playbooks\/([^/]+)\//.exec(rel);
  if (m) return { setting: "playbook", id: m[1]! };
  m = new RegExp(`^${PROJECT_MODES_DIR.replace(/[.]/g, "\\.")}/([^/]+)/`).exec(rel);
  if (m) return { setting: "mode", id: m[1]! };
  return { setting: "services" };
}

/** One edit as sova_settings propose takes it. */
export type SettingsEdit =
  | { setting: "overseer"; patch: Record<string, unknown> }
  | { setting: "memory"; on?: boolean; type?: string; size?: number }
  | { setting: "project"; name?: string; root?: unknown; archived?: unknown }
  | { setting: "profile"; id: string; profile: Record<string, unknown> | null }
  | { setting: "playbook"; id: string; text: string | null }
  | { setting: "mode"; id: string; text: string | null }
  | { setting: "offers"; file: Record<string, unknown> | null }
  | { setting: "services"; file: Record<string, unknown> | null };

const PATCH_REFUSED: Record<string, string> = {
  autonomy: "Levels are gone: set the powers (patch.powers) instead.",
  confirmKinds: "confirmKinds is gone: the hold is what waits now.",
  powersNoteSeen: "The one-time note is the operator's to dismiss on the page.",
  codingMode: "Projects have no coding mode: coding sessions start in this computer's default mode.",
};
const PATCH_KNOWN = new Set(["model", "thinking", "codingModel", "codingThinking", "gatheringModel", "gatheringThinking", "gatheringAbilities", "watchGapMin", "soonLookSec", "watch", "holdMin", "extraSystemPrompt", "powers", "resume", "assistantModels", "caps"]);

/** A file edit: its path, setting and new text (null: removed). Throws the parser's refusal. */
async function fileEdit(root: string, e: Exclude<SettingsEdit, { setting: "overseer" | "memory" | "project" }>): Promise<{ rel: string; setting: SettingId; id?: string; text: string | null }> {
  const json = (v: Record<string, unknown>) => `${JSON.stringify(v, null, 2)}\n`;
  const sized = (t: string) => (Buffer.byteLength(t) > FILE_MAX ? refuse(`That file would be over ${FILE_MAX / 1024} KB.`) : t);
  switch (e.setting) {
    case "profile": {
      if (typeof e.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(e.id)) return refuse("A profile's id is lowercase letters, digits and dashes.");
      if (e.id === DEFAULT_PROFILE_ID) return refuse(`"${DEFAULT_PROFILE_ID}" is Default's id; Default can't be replaced.`);
      const rel = `.sova/profiles/${e.id}.json`;
      if (e.profile === null) return { rel, setting: "profile", id: e.id, text: null };
      if (!isObj(e.profile)) return refuse("profile must be the whole profile as a JSON object, or null to remove it.");
      const raw = { ...e.profile, id: e.profile.id ?? e.id };
      if (raw.id !== e.id) return refuse(`The profile's id is "${String(raw.id)}", but the edit names ${e.id}. They must match.`);
      const why = profileFileError(raw);
      if (why) return refuse(`Profile ${e.id}: ${why}`);
      return { rel, setting: "profile", id: e.id, text: sized(json(raw)) };
    }
    case "playbook": {
      if (typeof e.id !== "string" || !isPlaybookId(e.id)) return refuse("A playbook's id is lowercase letters, digits and dashes.");
      const found = await readProjectPlaybook(root, e.id);
      const rel = found ? relOf(root, join(found.info.dir, found.info.entry)) : `.sova/playbooks/${e.id}/PLAYBOOK.md`;
      if (e.text === null) return found ? { rel, setting: "playbook", id: e.id, text: null } : refuse(`The project has no playbook ${e.id}.`);
      if (typeof e.text !== "string" || !e.text.trim()) return refuse("text must be the whole PLAYBOOK.md, or null to remove it.");
      const { fields } = parseFrontmatter(e.text);
      const h = scheduleOf(fields);
      if (h?.error) return refuse(`Playbook ${e.id}'s schedule: ${h.error}.`);
      return { rel, setting: "playbook", id: e.id, text: sized(e.text.endsWith("\n") ? e.text : `${e.text}\n`) };
    }
    case "mode": {
      if (!isProjectModeId(e.id)) return refuse("A mode's id is lowercase letters, digits and hyphens, starting with a letter.");
      const rel = `${PROJECT_MODES_DIR}/${e.id}/${PROJECT_MODE_ENTRY}`;
      if (e.text === null) return { rel, setting: "mode", id: e.id, text: null };
      if (typeof e.text !== "string") return refuse("text must be the whole MODE.md, or null to remove it.");
      try {
        parseModeFile(e.text);
      } catch (err) {
        if (err instanceof ModeFileError) refuse(`Mode ${e.id}: ${err.message}`);
        throw err;
      }
      return { rel, setting: "mode", id: e.id, text: sized(e.text.endsWith("\n") ? e.text : `${e.text}\n`) };
    }
    case "offers": {
      if (e.file === null) return { rel: OFFERS_FILE, setting: "offers", text: null };
      if (!isObj(e.file)) return refuse("file must be the whole offers file as a JSON object, or null to remove it.");
      const text = sized(json(e.file));
      const parsed = parseOffersFile(text);
      if (parsed.state === "broken") return refuse(`The offers file: ${parsed.error}`);
      const bad = parsed.state === "ok" ? parsed.offers.find((o) => !o.ok) : undefined;
      if (bad && !bad.ok) return refuse(`The offer "${bad.name}": ${bad.error}`);
      return { rel: OFFERS_FILE, setting: "offers", text };
    }
    case "services": {
      if (e.file === null) return { rel: CONTRACT_FILE, setting: "services", text: null };
      if (!isObj(e.file)) return refuse("file must be the whole .sova/project.json as a JSON object, or null to remove it.");
      const text = sized(json(e.file));
      try {
        parseDefinition(text);
      } catch (err) {
        refuse(`The services file: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { rel: CONTRACT_FILE, setting: "services", text };
    }
  }
}

const relOf = (root: string, abs: string): string => abs.slice(root.length + (root.endsWith("/") ? 0 : 1)).split("\\").join("/");

// ---- grants of file changes ---------------------------------------------------------------------------

/** The grant a file change holds (what it allows, keyed like its approval), or null. */
export async function fileGrant(root: string, f: { setting: SettingId; id?: string; rel: string }, before: string | null, after: string | null): Promise<StoredGrant | null> {
  if (after === null) return null;
  if (f.setting === "services") return { key: `services:${root}`, setting: "services", what: "changes what runs on this computer (the project's services file)" };
  if (f.setting === "profile" && f.id) {
    let p: Profile | { error: string };
    try {
      p = parseProfile(JSON.parse(after));
    } catch {
      return null;
    }
    if ("error" in p) return null;
    const powers = powersToApprove(p);
    if (!powers) return null;
    const key = profileKey({ source: "project", id: f.id, project: root });
    if (approvalOf({ source: "project", key, ...powers }, readTrust()) === "approved") return null;
    return { key, setting: "profile", what: `the profile ${p.label} can ${powersText(powers)}`, pin: powers };
  }
  if (f.setting === "playbook" && f.id && /\/(PLAYBOOK|SKILL)\.md$/.test(f.rel)) {
    const h = scheduleOf(parseFrontmatter(after).fields);
    if (!h?.triggers) return null;
    const b = before === null ? null : scheduleOf(parseFrontmatter(before).fields);
    if (b && b.when === h.when && (b.tz ?? "") === (h.tz ?? "") && (b.profile ?? "") === (h.profile ?? "")) return null;
    return { key: `schedule:${root}#${f.id}`, setting: "schedule", what: `the playbook ${f.id} runs on its own: ${scheduleText(h.triggers)}${h.tz ? ` (${h.tz})` : ""} with the profile ${h.profile}`, pin: { when: h.when, tz: h.tz ?? null, profile: h.profile ?? null } };
  }
  if (f.setting === "mode" && f.id) {
    if (!f.rel.endsWith(`/${PROJECT_MODE_ENTRY}`)) return { key: `mode:${root}#${f.id}`, setting: "mode", what: `changes a program of the mode ${f.id}` };
    try {
      const m = parseModeFile(after);
      const parts = [m.tools.length ? `${m.tools.length} tool${m.tools.length === 1 ? "" : "s"}` : "", m.commands?.length ? `${m.commands.length} command${m.commands.length === 1 ? "" : "s"}` : "", m.hooks?.length ? `${m.hooks.length} hook${m.hooks.length === 1 ? "" : "s"} that run after turns` : ""].filter(Boolean);
      return parts.length ? { key: `mode:${root}#${f.id}`, setting: "mode", what: `the mode ${f.id} adds ${parts.join(", ")}` } : null;
    } catch {
      return null;
    }
  }
  if (f.setting === "offers") {
    const parsed = parseOffersFile(after);
    const fp = runFingerprint(parsed);
    if (!fp || runsApproved(root, parsed)) return null;
    const runs = runButtonsOf(parsed);
    return { key: `offers:${root}`, setting: "offers", what: `run buttons: ${runs.map((r) => `${r.label} (${r.offer}) runs ${r.run}`).join("; ")}`, pin: fp };
  }
  return null;
}

/** A file change in words. */
function fileSummary(f: { setting: SettingId; id?: string; rel: string }, after: string | null, before: string | null): string {
  const what = f.setting === "profile" ? `Profile ${f.id}` : f.setting === "playbook" ? `Playbook ${f.id}` : f.setting === "mode" ? `Mode ${f.id}` : SETTINGS_REFERENCE[f.setting].label;
  return `${what}: ${after === null ? "removed" : before === null ? "added" : "changed"} (${f.rel})`;
}

// ---- views --------------------------------------------------------------------------------------------

async function cardView(projectId: string, c: StoredCard, repo: Repo | null): Promise<SettingsCardView> {
  const project = projectOf(projectId);
  const files: FileChangeView[] = c.files.map((f) => ({ setting: f.setting, ...(f.id ? { id: f.id } : {}), path: f.rel, change: f.after === null ? "removed" : f.before === null ? "added" : "changed", summary: f.summary }));
  const diff = repo && c.commit ? await diffOf(repo, c.parent, c.commit).catch(() => "") : "";
  const extra: KeptChange[] = [
    ...(c.memory ? [{ field: "memory", label: fieldLabel("memory"), from: null, to: c.memory, fromText: "", toText: `${c.memory.on === false ? "off" : "on"}${c.memory.type ? `, ${c.memory.type}` : ""}${c.memory.size ? `, ${c.memory.size} bytes` : ""}` }] : []),
    ...(c.name ? [{ field: "project.name", label: fieldLabel("project.name"), from: project.name, to: c.name, fromText: project.name, toText: c.name }] : []),
  ];
  return {
    id: c.id,
    state: c.state,
    title: titleOf(c),
    why: c.why,
    by: c.by,
    createdAt: c.createdAt,
    kept: [...c.kept, ...extra],
    files,
    grants: c.grants.map(({ key, setting, what }) => ({ key, setting, what })),
    lands: c.files.length ? `${repo?.branch ?? "the branch"} in ${project.root}` : null,
    diff,
    fingerprint: c.fingerprint,
    ...(c.appliedNow?.length ? { appliedNow: c.appliedNow } : {}),
    ...(c.appliedAt ? { appliedAt: c.appliedAt } : {}),
    ...(c.appliedCommit ? { commit: c.appliedCommit } : {}),
    ...(c.dismissedAt ? { dismissedAt: c.dismissedAt } : {}),
  };
}

const titleOf = (c: Pick<StoredCard, "kept" | "files" | "memory" | "name">): string => {
  const parts = [...c.kept.map((k) => k.label), ...(c.memory ? ["Its memory"] : []), ...(c.name ? ["The project's name"] : []), ...c.files.map((f) => f.summary.split(":")[0]!)];
  const head = parts.slice(0, 3).join(", ");
  return parts.length > 3 ? `${head} and ${parts.length - 3} more` : head || "No change";
};

/** One card's view (the chat's card reads it live). */
export async function settingsCard(projectId: string, cardId: string): Promise<SettingsCardView | null> {
  if (cardId === "local") return localCard(projectId);
  const c = readStore(projectId).cards.find((x) => x.id === cardId);
  if (!c) return null;
  return cardView(projectId, c, await repoOf(projectOf(projectId).root).catch(() => null));
}

// ---- local edits (a10) ----------------------------------------------------------------------------------

async function hashText(repo: Repo, text: string): Promise<string> {
  const r = await git(["hash-object", "--stdin"], repo.top, { input: text });
  return r.stdout.trim();
}

interface LocalFile extends StoredFile {
  text: string | null;
}

async function localFiles(root: string, repo: Repo): Promise<LocalFile[]> {
  const rels = (await dirtyPaths(repo, SETTINGS_PLACES)).filter(isSettingsPath);
  const out: LocalFile[] = [];
  for (const rel of rels) {
    const abs = join(root, rel);
    const text = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    const before = await blobAt(repo, repo.head, rel);
    const after = text === null ? null : await hashText(repo, text);
    if (before === after) continue;
    const s = settingOfPath(rel);
    out.push({ ...s, rel, before, after, text, summary: fileSummary({ ...s, rel }, after, before) });
  }
  return out;
}

/** The uncommitted settings edits in the project folder as one card, or null when there are none (or no Git). */
export async function localCard(projectId: string): Promise<SettingsCardView | null> {
  const project = projectOf(projectId);
  const repo = await repoOf(project.root).catch(() => null);
  if (!repo) return null;
  const files = await localFiles(project.root, repo);
  if (!files.length) return null;
  const grants: StoredGrant[] = [];
  for (const f of files) {
    const beforeText = f.before ? await readBlob(repo, f.before).catch(() => null) : null;
    const g = await fileGrant(project.root, f, beforeText, f.text);
    if (g && !grants.some((x) => x.key === g.key)) grants.push(g);
  }
  const d = await git(["diff", "--no-color", "--no-ext-diff", "HEAD", "--", ...files.filter((f) => f.before).map((f) => repoPath(repo, f.rel))], repo.top);
  const untracked = files.filter((f) => !f.before && f.text !== null).map((f) => `--- /dev/null\n+++ b/${f.rel}\n${f.text!.split("\n").map((l) => `+${l}`).join("\n")}`);
  const diff = [d.stdout, ...untracked].join("\n").slice(0, 64 * 1024);
  const card = { kept: [], files, grants };
  return {
    id: "local",
    state: "waiting",
    title: "Uncommitted settings edits in the project folder",
    why: "These settings files were edited in the project folder and not committed.",
    by: { kind: "operator" },
    createdAt: new Date().toISOString(),
    kept: [],
    files: files.map((f) => ({ setting: f.setting, ...(f.id ? { id: f.id } : {}), path: f.rel, change: f.after === null ? "removed" : f.before === null ? "added" : "changed", summary: f.summary })),
    grants: grants.map(({ key, setting, what }) => ({ key, setting, what })),
    lands: `${repo.branch ?? "the branch"} in ${project.root}`,
    diff,
    fingerprint: fingerprintOf(card),
  };
}

// ---- propose --------------------------------------------------------------------------------------------

export interface ProposeResult {
  card: SettingsCardView | null;
  appliedNow: SettingsHistoryRow[];
}

/**
 * sova_settings propose (§app.project-overseer/settings): every edit checked by its parser first (a refusal
 * writes nothing); in the operator's turn (`attended`) each Sova-kept change that is no grant applies at once;
 * the rest becomes one card, its file changes a commit on `refs/sova/settings/<pid>/<n>`.
 */
export async function proposeSettings(projectId: string, input: { edits: unknown; why?: unknown }, ctx: { attended: boolean; by: SettingsBy }): Promise<ProposeResult> {
  const project = projectOf(projectId);
  if (project.archived) refuse("The project is archived: unarchive it on the project page first.");
  const why = typeof input.why === "string" ? input.why.trim().slice(0, 500) : "";
  if (!why) refuse("Say why (why): one or two sentences for the operator.");
  if (!Array.isArray(input.edits) || input.edits.length === 0) refuse("edits must list at least one change.");
  const edits = input.edits as unknown[];
  if (edits.length > 20) refuse("At most 20 edits at once.");

  // Sova-kept: one merged patch, checked as PATCH checks it.
  const current = readPoSettings(projectOverseerPaths(projectId));
  let body: Record<string, any> = {};
  let memory: { on?: boolean; type?: string; size?: number } | undefined;
  let name: string | undefined;
  const fileEdits: { rel: string; setting: SettingId; id?: string; text: string | null }[] = [];
  for (const raw of edits) {
    if (!isObj(raw) || typeof raw.setting !== "string") refuse('Each edit is an object naming its setting: {setting: "overseer" | "memory" | "project" | "profile" | "playbook" | "mode" | "offers" | "services", …}.');
    const e = raw as SettingsEdit;
    if (e.setting === "overseer") {
      if (!isObj(e.patch)) refuse("An overseer edit carries patch: the fields to change.");
      for (const k of Object.keys(e.patch)) {
        if (PATCH_REFUSED[k]) refuse(PATCH_REFUSED[k]!);
        if (!PATCH_KNOWN.has(k)) refuse(`Unknown overseer setting "${k}" (sova_settings reference overseer.<setting> lists them).`);
      }
      body = mergeBodies(body, e.patch);
    } else if (e.setting === "memory") {
      const m: { on?: boolean; type?: string; size?: number } = {};
      if (e.on !== undefined) typeof e.on === "boolean" ? (m.on = e.on) : refuse("memory on must be true or false.");
      if (e.type !== undefined) e.type === "uniichat" || e.type === "zoomable" ? (m.type = e.type) : refuse('memory type must be "uniichat" or "zoomable".');
      if (e.size !== undefined) Number.isInteger(e.size) && e.size > 0 ? (m.size = e.size) : refuse("memory size must be a whole number of bytes.");
      if (!Object.keys(m).length) refuse("A memory edit names on, type or size.");
      memory = { ...(memory ?? {}), ...m };
    } else if (e.setting === "project") {
      if (e.root !== undefined) refuse("Moving the project's folder is the operator's own, on the project page.");
      if (e.archived !== undefined) refuse("Archiving is the operator's own: Archive Project… on the project page, with its own confirm.");
      if (typeof e.name !== "string" || !e.name.trim() || e.name.trim().length > 80) refuse("A project edit names the new name (1–80 characters).");
      name = e.name!.trim();
    } else if (["profile", "playbook", "mode", "offers", "services"].includes(e.setting)) {
      const f = await fileEdit(project.root, e as never);
      if (fileEdits.some((x) => x.rel === f.rel)) refuse(`Two edits change ${f.rel}: make it one.`);
      fileEdits.push(f);
    } else refuse(`Unknown setting "${String((raw as { setting: unknown }).setting)}".`);
  }
  let next: ProjectOverseerSettings = current;
  try {
    next = mergePoPatch(current, body);
  } catch (err) {
    if (err instanceof OrgError) refuse(err.message);
    throw err;
  }
  const kept = keptChanges(flatten(current), flatten(next));
  if (body.resume === true) kept.push({ field: "resume", label: fieldLabel("resume"), from: "braked", to: "resumed", fromText: "on", toText: "lifted", grant: grantOf("resume", null, null)! });
  if (name === project.name) name = undefined;

  // Files: blobs, then one commit on a Sova-owned ref, cut from the folder's HEAD.
  const repo = fileEdits.length ? await repoOf(project.root) : null;
  if (fileEdits.length && !repo) refuse("The project folder isn't a Git repository, so its settings files change by hand.");
  const files: StoredFile[] = [];
  const grants: StoredGrant[] = [];
  for (const f of fileEdits) {
    const before = await blobAt(repo!, repo!.head, f.rel);
    const after = f.text === null ? null : await writeBlob(repo!, f.text);
    if (before === after) continue;
    if (f.text === null && before === null) refuse(`${f.rel} isn't on the branch: nothing to remove.`);
    files.push({ setting: f.setting, ...(f.id ? { id: f.id } : {}), rel: f.rel, before, after, summary: fileSummary(f, after, before) });
    const beforeText = before ? await readBlob(repo!, before) : null;
    const g = await fileGrant(project.root, f, beforeText, f.text);
    if (g && !grants.some((x) => x.key === g.key)) grants.push(g);
  }

  // What applies at once: in the operator's turn, a Sova-kept change that is no grant.
  const atOnce = ctx.attended ? kept.filter((k) => !k.grant) : [];
  const onCard = kept.filter((k) => !atOnce.includes(k));
  const memoryNow = ctx.attended && memory ? memory : undefined;
  const nameNow = ctx.attended && name ? name : undefined;
  const cardMemory = memoryNow ? undefined : memory;
  const cardName = nameNow ? undefined : name;
  for (const k of onCard) if (k.grant) grants.unshift({ key: `overseer:${project.root}#${k.field}`, setting: settingOfField(k.field), what: k.grant });

  const store = readStore(projectId);
  if ((onCard.length || files.length || cardMemory || cardName) && store.cards.filter((c) => c.state === "waiting").length >= MAX_WAITING)
    refuse(`${MAX_WAITING} settings cards already wait: withdraw one (sova_settings withdraw) or ask the operator to apply or dismiss them.`);

  const d = depsOrThrow();
  const appliedNow: SettingsHistoryRow[] = [];
  if (atOnce.length) appliedNow.push(...(await d.patch(projectId, patchOf(atOnce), ctx.by)));
  if (memoryNow) appliedNow.push(...(await d.memory(projectId, memoryNow, ctx.by)));
  if (nameNow) appliedNow.push(...(await d.rename(projectId, nameNow, ctx.by)));

  if (!onCard.length && !files.length && !cardMemory && !cardName) return { card: null, appliedNow };

  const n = store.next;
  const id = `sc_${n}`;
  let commit: string | null = null;
  let ref: string | null = null;
  if (files.length && repo) {
    commit = await commitOnto(repo, repo.head, files.map((f) => ({ rel: f.rel, blob: f.after })), `Settings: ${titleOf({ kept: [], files, ...(cardMemory ? { memory: cardMemory } : {}), ...(cardName ? { name: cardName } : {}) })}\n\n${why}\n\nProposed by the project overseer as ${id}.`);
    ref = `refs/sova/settings/${projectId}/${n}`;
    await setRef(repo, ref, commit);
  }
  const card: StoredCard = {
    id,
    n,
    state: "waiting",
    createdAt: new Date().toISOString(),
    why,
    by: ctx.by,
    kept: onCard,
    ...(cardMemory ? { memory: cardMemory } : {}),
    ...(cardName ? { name: cardName } : {}),
    files,
    parent: repo?.head ?? null,
    commit,
    ref,
    grants,
    fingerprint: "",
    ...(appliedNow.length ? { appliedNow } : {}),
  };
  card.fingerprint = fingerprintOf(card);
  store.cards.push(card);
  store.next = n + 1;
  writeStore(projectId, store);
  return { card: await cardView(projectId, card, repo), appliedNow };
}

const settingOfField = (field: string): SettingId =>
  field.startsWith("powers.") ? "overseer.powers" : field.startsWith("caps.") ? "overseer.limits" : field === "watch" ? "overseer.watch" : field === "holdMin" ? "overseer.hold" : field === "extraSystemPrompt" ? "overseer.extra" : field === "gatheringAbilities" ? "overseer.abilities" : field === "resume" ? "overseer.brake" : field === "watchGapMin" || field === "soonLookSec" ? "overseer.pace" : "overseer.models";

function mergeBodies(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === "powers" && isObj(v)) out.powers = { overseer: { ...(out.powers?.overseer ?? {}), ...((v.overseer as object) ?? {}) }, assistant: { ...(out.powers?.assistant ?? {}), ...((v.assistant as object) ?? {}) } };
    else if (k === "caps" && isObj(v)) out.caps = { ...(out.caps ?? {}), ...v };
    else out[k] = v;
  }
  return out;
}

// ---- withdraw ---------------------------------------------------------------------------------------------

/** Withdraw a waiting card (the overseer's withdraw, the operator's Dismiss). `local` is Discard: the operator's only. */
export async function withdrawCard(projectId: string, cardId: string, opts: { operator: boolean; fingerprint?: unknown }): Promise<void> {
  if (cardId === "local") {
    if (!opts.operator) refuse("Discarding the folder's uncommitted edits is the operator's own, on the waiting card.");
    return discardLocal(projectId, opts.fingerprint);
  }
  const store = readStore(projectId);
  const c = store.cards.find((x) => x.id === cardId);
  if (!c) throw new OrgError(`No settings card ${cardId} in this project.`, 404);
  if (c.state !== "waiting") throw new OrgError(`${cardId} is already ${c.state}.`, 409);
  c.state = "dismissed";
  c.dismissedAt = new Date().toISOString();
  writeStore(projectId, store);
  if (c.ref) {
    const repo = await repoOf(projectOf(projectId).root).catch(() => null);
    if (repo) await deleteRef(repo, c.ref);
  }
}

async function discardLocal(projectId: string, fingerprint: unknown): Promise<void> {
  const project = projectOf(projectId);
  const view = await localCard(projectId);
  if (!view) throw new OrgError("The project folder has no uncommitted settings edits.", 404);
  if (fingerprint !== view.fingerprint) throw new OrgError("The folder's uncommitted edits changed since you looked: look at them again.", 409);
  const repo = (await repoOf(project.root))!;
  for (const f of await localFiles(project.root, repo)) {
    const abs = join(project.root, f.rel);
    if (f.before) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, await readBlob(repo, f.before));
      await git(["update-index", "--add", "--cacheinfo", `100644,${f.before},${repoPath(repo, f.rel)}`], repo.top);
    } else {
      rmSync(abs, { force: true });
      await git(["update-index", "--force-remove", "--", repoPath(repo, f.rel)], repo.top);
    }
  }
}

// ---- apply ---------------------------------------------------------------------------------------------

/** Apply a card (the operator's click, §app.project-overseer/settings), or `local`: Land the folder's uncommitted edits. */
export async function applyCard(projectId: string, cardId: string, fingerprint: unknown): Promise<{ card: SettingsCardView; approved: string[]; commit?: string }> {
  const project = projectOf(projectId);
  const root = project.root;
  const by: SettingsBy = { kind: "operator", via: "card" };
  if (cardId === "local") {
    const view = await localCard(projectId);
    if (!view) throw new OrgError("The project folder has no uncommitted settings edits.", 404);
    if (fingerprint !== view.fingerprint) throw new OrgError("The folder's uncommitted edits changed since you looked: look at them again.", 409);
    const repo = (await repoOf(root))!;
    const files = await localFiles(root, repo);
    const grants: StoredGrant[] = [];
    for (const f of files) {
      const g = await fileGrant(root, f, f.before ? await readBlob(repo, f.before) : null, f.text);
      if (g && !grants.some((x) => x.key === g.key)) grants.push(g);
    }
    for (const f of files) if (f.text !== null) f.after = await writeBlob(repo, f.text);
    const commit = await landFiles(projectId, repo, files, `Settings: ${titleOf({ kept: [], files })}\n\nLanded from the project folder's uncommitted edits.`, { fromLocal: true });
    const approved = await recordApprovals(root, grants);
    appendHistory(projectId, files.map((f) => ({ field: `file:${f.rel}`, from: f.before, to: f.after, by, commit, card: "local" })));
    return { card: { ...view, state: "applied", appliedAt: new Date().toISOString(), commit }, approved, commit };
  }

  const store = readStore(projectId);
  const c = store.cards.find((x) => x.id === cardId);
  if (!c) throw new OrgError(`No settings card ${cardId} in this project.`, 404);
  if (c.state !== "waiting") throw new OrgError(`${cardId} is already ${c.state}.`, 409);
  if (fingerprint !== c.fingerprint) throw new OrgError(`${cardId} changed since you looked: look at it again.`, 409);
  if (project.archived) throw new OrgError("The project is archived: unarchive it first.", 409);

  // The kept part as it reads now: the grant set must be the card's.
  const current = readPoSettings(projectOverseerPaths(projectId));
  const body = patchOf(c.kept);
  let now: KeptChange[] = [];
  try {
    now = keptChanges(flatten(current), flatten(mergePoPatch(current, body)));
  } catch (err) {
    throw new OrgError(err instanceof Error ? err.message : String(err), 409);
  }
  if (c.kept.some((k) => k.field === "resume")) now.push({ ...c.kept.find((k) => k.field === "resume")! });
  const grantsNow = now.filter((k) => k.grant).map((k) => `${k.field}:${k.grant}`).sort().join("|");
  const grantsShown = c.kept.filter((k) => k.grant).map((k) => `${k.field}:${k.grant}`).sort().join("|");
  if (grantsNow !== grantsShown) throw new OrgError("The project's settings changed since the card was made, so it no longer grants what it showed. Dismiss it and ask the overseer for a new one.", 409);

  let commit: string | undefined;
  const repo = c.files.length ? await repoOf(root) : null;
  if (c.files.length) {
    if (!repo) throw new OrgError("The project folder isn't a Git repository any more.", 409);
    for (const f of c.files) {
      const head = await blobAt(repo, repo.head, f.rel);
      if (head !== f.before) throw new OrgError(`${f.rel} changed on ${repo.branch ?? "the branch"} since ${cardId} was made: dismiss it and ask for a new card.`, 409);
    }
    commit = await landFiles(projectId, repo, c.files, `Settings: ${titleOf({ kept: [], files: c.files })}\n\n${c.why}\n\nApplied from the project overseer's ${cardId}.`, { prepared: c.parent === repo.head ? c.commit : null });
  }
  const d = depsOrThrow();
  const meta = { card: cardId };
  const rows: SettingsHistoryRow[] = [];
  if (now.length) rows.push(...(await d.patch(projectId, patchOf(now), by, meta)));
  if (c.memory) rows.push(...(await d.memory(projectId, c.memory, by, meta)));
  if (c.name) rows.push(...(await d.rename(projectId, c.name, by, meta)));
  const approved = [...c.grants.filter((g) => g.key.startsWith("overseer:")).map((g) => g.key), ...(await recordApprovals(root, c.grants.filter((g) => !g.key.startsWith("overseer:"))))];
  if (c.files.length) appendHistory(projectId, c.files.map((f) => ({ field: `file:${f.rel}`, from: f.before, to: f.after, by, commit, card: cardId })));

  const after = readStore(projectId);
  const mine = after.cards.find((x) => x.id === cardId)!;
  mine.state = "applied";
  mine.appliedAt = new Date().toISOString();
  if (commit) mine.appliedCommit = commit;
  writeStore(projectId, after);
  return { card: await cardView(projectId, mine, repo), approved, ...(commit ? { commit } : {}) };
}

/**
 * Land settings files on the project folder's branch as one commit: only settings files, never in the
 * middle of a merge or on a detached HEAD, never over uncommitted edits (unless they are what lands, `fromLocal`);
 * then the folder's files and index, so profiles, playbooks, modes and offers read them at once.
 */
async function landFiles(projectId: string, repo: Repo, files: StoredFile[], message: string, opts: { fromLocal?: boolean; prepared?: string | null }): Promise<string> {
  const root = projectOf(projectId).root;
  const outside = files.find((f) => !isSettingsPath(f.rel));
  if (outside) throw new OrgError(`${outside.rel} isn't a settings file: Apply commits settings files only.`, 409);
  const busy = await busyWith(repo);
  if (busy) throw new OrgError(`The project folder is in the middle of a ${busy}: finish it first.`, 409);
  if (!repo.branch || !repo.head) throw new OrgError("The project folder isn't on a branch: check one out first.", 409);
  if (!opts.fromLocal) {
    const dirty = await dirtyPaths(repo, files.map((f) => f.rel));
    if (dirty.length) throw new OrgError(`${dirty[0]} has uncommitted edits in the project folder: land or discard them on the waiting card first.`, 409);
  }
  const changes = files.map((f) => ({ rel: f.rel, blob: f.after }));
  try {
    const commit = opts.prepared ?? (await commitOnto(repo, repo.head, changes, message));
    await advanceBranch(repo, repo.head, commit, changes);
    for (const f of files) {
      const abs = join(root, f.rel);
      if (f.after === null) rmSync(abs, { force: true });
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, await readBlob(repo, f.after));
      }
    }
    // The index's stat data for the files just written.
    await git(["update-index", "-q", "--refresh"], repo.top);
    return commit;
  } catch (err) {
    if (err instanceof SettingsGitError) throw new OrgError(`The commit didn't land: ${err.message}`, 409);
    throw err;
  }
}

/** Record the approvals of exactly `grants`, from the files as they now are (profiles first: a schedule's approval needs its profile's). */
async function recordApprovals(root: string, grants: StoredGrant[]): Promise<string[]> {
  const done: string[] = [];
  const order = (g: StoredGrant) => (g.setting === "profile" ? 0 : g.setting === "schedule" ? 2 : 1);
  for (const g of [...grants].sort((a, b) => order(a) - order(b))) {
    const id = g.key.includes("#") ? g.key.slice(g.key.lastIndexOf("#") + 1) : "";
    if (g.setting === "profile") {
      const p = await findProfile({ source: "project", id }, root);
      if (!p) throw new OrgError(`The profile ${id} isn't in the project's files any more.`, 409);
      approveProfile(p, (g.pin as Pick<Profile, "grant" | "overseerMayStart">) ?? p);
      done.push(p.key);
    } else if (g.setting === "schedule") {
      const keeper = scheduleKeeper();
      if (!keeper) continue;
      const pin = (await keeper.list()).find((s) => s.root === root && s.playbook === id)?.pin;
      const shown = g.pin as { when: string; tz: string | null; profile: string | null } | undefined;
      const read = await readProjectPlaybook(root, id);
      const h = read ? scheduleOf(read.fields) : null;
      if (!h || !shown || h.when !== shown.when || (h.tz ?? null) !== shown.tz || (h.profile ?? null) !== shown.profile) throw new OrgError(`The playbook ${id}'s schedule isn't what the card showed any more.`, 409);
      if (!pin) continue;
      const r = await keeper.approve(root, { playbook: id }, pin);
      if (!r.ok) throw new OrgError(r.error, 409);
      done.push(g.key);
    } else if (g.setting === "mode") {
      const top = checkoutRootOf(root) ?? root;
      const snap = readProjectMode(join(top, PROJECT_MODES_DIR), id);
      if ("toolsHash" in snap && snap.toolsHash) {
        recordModeApproval(top, id, snap.toolsHash, "user");
        done.push(g.key);
      }
    } else if (g.setting === "offers") {
      const parsed = parseOffersFile(readText(join(root, OFFERS_FILE)));
      approveRuns(root, parsed, g.pin);
      done.push(g.key);
    } else done.push(g.key);
  }
  return done;
}

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

// ---- undo ---------------------------------------------------------------------------------------------

/** Undo a history row: a Sova-kept field back (409 when it changed since), or a file change as a new card. */
export async function undoRow(projectId: string, rowId: unknown, opts: { fromOverseer: boolean }): Promise<{ undone?: SettingsHistoryRow[]; card?: SettingsCardView }> {
  const row = readHistory(projectId).find((r) => r.id === rowId);
  if (!row) throw new OrgError(`No settings history line ${String(rowId)}.`, 404);
  const by: SettingsBy = { kind: "operator", via: "undo" };
  const meta = { revertOf: row.id };
  if (row.field.startsWith("file:")) {
    const rel = row.field.slice(5);
    const project = projectOf(projectId);
    const repo = await repoOf(project.root);
    if (!repo) throw new OrgError("The project folder isn't a Git repository any more.", 409);
    const head = await blobAt(repo, repo.head, rel);
    if (head !== row.to) throw new OrgError(`${rel} changed since: undo the newer change first.`, 409);
    const s = settingOfPath(rel);
    const text = row.from === null ? null : await readBlob(repo, String(row.from));
    const files: StoredFile[] = [{ ...s, rel, before: head, after: row.from === null ? null : String(row.from), summary: fileSummary({ ...s, rel }, row.from === null ? null : String(row.from), head) }];
    const grants: StoredGrant[] = [];
    const g = await fileGrant(project.root, { ...s, rel }, head ? await readBlob(repo, head) : null, text);
    if (g) grants.push(g);
    const store = readStore(projectId);
    if (store.cards.filter((c) => c.state === "waiting").length >= MAX_WAITING) throw new OrgError(`${MAX_WAITING} settings cards already wait: apply or dismiss one first.`, 409);
    const n = store.next;
    const id = `sc_${n}`;
    const commit = await commitOnto(repo, repo.head, files.map((f) => ({ rel: f.rel, blob: f.after })), `Settings: undo ${rel}\n\nPuts ${rel} back as it was before ${row.id}.`);
    const ref = `refs/sova/settings/${projectId}/${n}`;
    await setRef(repo, ref, commit);
    const card: StoredCard = { id, n, state: "waiting", createdAt: new Date().toISOString(), why: `Undo ${row.id}: put ${rel} back as it was.`, by, kept: [], files, parent: repo.head, commit, ref, grants, fingerprint: "" };
    card.fingerprint = fingerprintOf(card);
    store.cards.push(card);
    store.next = n + 1;
    writeStore(projectId, store);
    return { card: await cardView(projectId, card, repo) };
  }
  if (row.field === "resume") throw new OrgError("Resume can't be undone: turn the powers you don't want Off instead.", 409);
  const d = depsOrThrow();
  if (row.field === "project.name") {
    const nowName = projectOf(projectId).name;
    if (nowName !== row.to) throw new OrgError("The project's name changed since: undo the newer change first.", 409);
    return { undone: await d.rename(projectId, String(row.from), by, meta) };
  }
  const nowVal = flatten(readPoSettings(projectOverseerPaths(projectId)))[row.field];
  if (!same(nowVal, row.to)) throw new OrgError(`${fieldLabel(row.field)} changed since: undo the newer change first.`, 409);
  if (opts.fromOverseer && grantOf(row.field, row.to, row.from)) throw new OrgError("Putting that back widens what the overseer may do: only the operator does that, on the project page.", 403);
  if (row.field === "memory") {
    const m = row.from as { on?: boolean; type?: string; size?: number } | null;
    return { undone: await d.memory(projectId, m ?? { on: true }, by, meta) };
  }
  return { undone: await d.patch(projectId, patchOf([{ field: row.field, to: row.from }]), by, meta) };
}

// ---- the listing ----------------------------------------------------------------------------------------

/** Every setting of the project with its state and where it is changed (the Settings tab's All Settings; sova_settings get). */
export async function settingsInfo(projectId: string): Promise<ProjectSettingsInfo> {
  const project = projectOf(projectId);
  const root = project.root;
  const s = readPoSettings(projectOverseerPaths(projectId));
  const tab = `#/projects/${projectId}/settings`;
  const rows: SettingsRow[] = [];
  const ANCHOR: Record<string, string> = { overseer: "project-settings-overseer", powers: "project-settings-powers", sessions: "project-settings-sessions", extra: "project-extra-label", limits: "project-limits-legend", offers: "project-offers" };
  const sova = (setting: SettingId, state: string, anchor: string, detail?: string) =>
    rows.push({ setting, label: SETTINGS_REFERENCE[setting].label, state, where: "sova", href: tab, ...(ANCHOR[anchor] ? { anchor: ANCHOR[anchor] } : {}), hrefLabel: SETTINGS_REFERENCE[setting].changedAt, ...(detail ? { detail } : {}) });
  const count = (col: PowerColumn) => POWERS.filter((p) => s.powers[col][p]).length;
  sova("overseer.watch", s.watch ? "On" : "Off", "overseer");
  sova("overseer.powers", `${count("overseer")} of ${POWERS.length} on for the overseer on its own`, "powers", `${count("assistant")} on for the Project Assistant`);
  sova("overseer.models", s.model ?? "the default model", "sessions", `coding: ${s.codingModel ?? "its own"} · gathering: ${s.gatheringModel ?? "its own"}`);
  sova("overseer.abilities", s.gatheringAbilities ? "Set" : "Automatic", "sessions");
  sova("overseer.extra", s.extraSystemPrompt.trim() ? `Set (${s.extraSystemPrompt.trim().length} characters)` : "Not set", "extra");
  sova("overseer.limits", "As set", "limits", `coding sessions: ${s.caps.createPerTurn ?? "no limit"} per message, ${s.caps.createPerDay ?? "no limit"} a day`);
  sova("overseer.pace", `Every ${s.watchGapMin} min`, "limits", s.soonLookSec === null ? "soon look off" : `soon look after ${s.soonLookSec} s`);
  sova("overseer.hold", s.holdMin === 0 ? "No hold" : `${s.holdMin} min`, "limits");
  sova("overseer.memory", s.memory ? (s.memory.on ? "On" : "Off") : "On", "overseer");
  sova("project.name", project.name, "head");

  const file = (setting: SettingId, state: string, href: string, hrefLabel: string, extra: Partial<SettingsRow> = {}) =>
    rows.push({ setting, label: SETTINGS_REFERENCE[setting].label, state, where: "file", href, hrefLabel, ...extra });
  // Services.
  const svc = readText(join(root, CONTRACT_FILE));
  if (svc === null) file("services", "Not set", `#/projects/${projectId}/branches`, "the Branches tab", { detail: CONTRACT_FILE });
  else
    try {
      const def = parseDefinition(svc);
      const names = def.services.map((x) => x.name);
      file("services", `${names.length} service${names.length === 1 ? "" : "s"}`, `#/projects/${projectId}/branches`, "the Branches tab", { detail: names.join(", ") || CONTRACT_FILE });
    } catch (err) {
      file("services", "Broken", `#/projects/${projectId}/branches`, "the Branches tab", { detail: err instanceof Error ? err.message : String(err) });
    }
  // Profiles.
  try {
    const src = await profileSources(root);
    for (const p of src.project.profiles)
      file("profile", p.approval === "needed" ? "Needs approval" : p.approval === "approved" ? "Approved" : "No approval needed", "#/settings/profiles", "Settings → Profiles", { name: p.id, detail: p.label });
    for (const pr of src.problems.filter((x) => x.source === "project")) file("profile", "Broken", "#/settings/profiles", "Settings → Profiles", { name: pr.file.split("/").pop()?.replace(/\.json$/, ""), detail: pr.error });
  } catch {
    // unreadable: none listed
  }
  // Playbooks and schedules.
  try {
    const schedules = (await scheduleKeeper()?.list().catch(() => [])) ?? [];
    for (const pb of await listProjectPlaybooks(root)) {
      file("playbook", "Set", tab, "the Playbooks dialog, in a chat of the project", { name: pb.id, detail: pb.title });
      if (pb.schedule) {
        const known = schedules.find((x) => x.root === root && x.playbook === pb.id);
        const st = known?.state ?? pb.schedule.state;
        const words: Record<string, string> = { "needs-approval": "Needs approval", active: "Approved", paused: "Paused", invalid: "Broken", "not-project": "Not run" };
        file("schedule", words[st] ?? st, tab, "the Playbooks dialog, in a chat of the project", { name: pb.id, detail: [pb.schedule.text ?? pb.schedule.when, known?.reason ?? pb.schedule.reason].filter(Boolean).join(" · ") });
      }
    }
  } catch {
    // unreadable: none listed
  }
  // Modes.
  try {
    const listing = discoverProjectModes(root);
    for (const m of listing.modes) {
      const needs = m.toolsHash !== "" && !(listing.root && modeApproved(listing.root, m.id, m.toolsHash));
      file("mode", m.toolsHash === "" ? "No approval needed" : needs ? "Needs approval" : "Approved", tab, "the mode menu, in a chat of the project", { name: m.id, detail: m.description });
    }
    for (const pr of listing.problems) file("mode", "Broken", tab, "the mode menu, in a chat of the project", { name: pr.id, detail: pr.error });
  } catch {
    // unreadable: none listed
  }
  // Offers.
  const offers = parseOffersFile(readText(join(root, OFFERS_FILE)));
  if (offers.state === "missing") file("offers", "Not set", tab, "the Offers list", { anchor: "project-offers", detail: OFFERS_FILE });
  else if (offers.state === "broken") file("offers", "Broken", tab, "the Offers list", { anchor: "project-offers", detail: offers.error });
  else {
    const runs = runButtonsOf(offers).length;
    file("offers", `${offers.offers.length} offer${offers.offers.length === 1 ? "" : "s"}`, tab, "the Offers list", {
      anchor: "project-offers",
      detail: runs ? (runsApproved(root, offers) ? "run buttons approved" : "run buttons need approval") : "send buttons only",
    });
  }

  const repo = await repoOf(root).catch(() => null);
  const store = readStore(projectId);
  const cards: SettingsCardView[] = [];
  for (const c of store.cards.filter((x) => x.state === "waiting")) cards.push(await cardView(projectId, c, repo));
  const recent: SettingsCardView[] = [];
  for (const c of store.cards.filter((x) => x.state !== "waiting").slice(-5)) recent.push(await cardView(projectId, c, repo));
  return { rows, cards, local: repo ? await localCard(projectId).catch(() => null) : null, git: !!repo, recent };
}
