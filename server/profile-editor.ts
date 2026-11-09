import {
  DEFAULT_LIMITS, DEFAULT_PROFILE_ID, isCapabilityNeutral, OFF_ID, PROFILE_FIELDS, PROFILE_MINOR_MODES, THINKING_LEVELS,
  type JoinedProfile, type Profile, type ProfileSaveRequest, type ProfileStarts,
} from "../shared/profiles";
import { PROFILE_LABEL_RULE, PROFILE_NAME_TAKEN, profileNameProblem } from "../shared/profile-limits";
import { problemOf } from "../shared/form-rules";
import type { SubagentProfile, SubagentProfilesFile } from "../shared/subagent-profiles";
import { idFor, legacyProfile, loadSubagentProfiles, writeSubagentProfiles } from "../pi-config/extensions/subagents/subagent-profiles.ts";
import { resolveDefaultProfile } from "./default-profile";
import type { DelegateSources } from "./delegate";
import { joinedProfiles, pickJoined } from "./joined-profiles";
import { changeProfiles } from "./profiles-store";
import { agentRoot } from "./state-root";
import { checkSubagentProfiles, writeCheckedProfiles } from "./subagent-profiles";

/**
 * Settings → Profiles' writes (§chat.profiles/joined, §app.settings-dialog/profile-editor): save,
 * add, rename, duplicate and delete one profile of yours, each half through its own writer — the
 * session half through yours' (profiles-store changeProfiles), the helper half through the
 * library's (pi-config's writeSubagentProfiles, after the same checks PUT /api/settings/subagents
 * makes) — and each only when it changed. The library half is written first, then the session half;
 * a session half that then fails says the library half was saved (`partial`).
 */

export type EditorAnswer =
  | { ok: true; savedKey?: string; warnings?: string[] }
  | { ok: false; status: 400 | 404 | 409; error: string; field?: "name"; partial?: true };

export interface EditorDeps {
  sources: DelegateSources;
  cwd?: string | null;
  dir?: string;
}

type Helpers = Omit<SubagentProfile, "id" | "name">;
type Raw = Record<string, unknown>;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const helpersOf = (p: SubagentProfile): Helpers => {
  const { id: _id, name: _name, ...rest } = p;
  return clone(rest);
};
const fail = (status: 400 | 404 | 409, error: string, extra: { field?: "name"; partial?: true } = {}): EditorAnswer => ({ ok: false, status, error, ...extra });
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The session half as a file entry: only the profile's own fields (never the listing's key, source or file). */
function rawOf(p: Profile): Raw {
  const out: Raw = {};
  for (const k of PROFILE_FIELDS) if ((p as unknown as Raw)[k] !== undefined) out[k] = clone((p as unknown as Raw)[k]);
  return out;
}

/** The starts part's defaults: a profile that sets nothing there (§chat.profiles/joined's library-only rule). */
const setsStarts = (s: ProfileStarts | undefined): boolean =>
  !!s && (!isCapabilityNeutral(s) || s.mode !== undefined || s.minorModes !== undefined || s.overseerMayStart || !!s.description?.trim());

/** Write each starts field into `raw`, only where it differs from what the file means now. */
function applyStarts(raw: Raw, now: Profile | undefined, s: ProfileStarts): void {
  const put = (k: string, v: unknown, current: unknown) => {
    if (same(v, current)) return;
    if (v === undefined) delete raw[k];
    else raw[k] = clone(v);
  };
  put("icon", s.icon ?? now?.icon ?? "wrench", now?.icon);
  put("description", s.description?.trim() || undefined, now?.description || undefined);
  put("remove", s.remove, now?.remove ?? []);
  put("grant", s.grant, now?.grant ?? []);
  put("singleton", s.singleton, now?.singleton ?? false);
  put("limits", s.limits, now?.limits);
  put("mode", s.mode, now?.mode);
  put("minorModes", s.minorModes ? PROFILE_MINOR_MODES.filter((m) => s.minorModes!.includes(m)) : undefined, now?.minorModes);
  put("firstMessage", s.firstMessage?.trim() || undefined, now?.firstMessage);
  put("overseerMayStart", s.overseerMayStart, now?.overseerMayStart ?? false);
}

function applyModel(raw: Raw, now: Profile | undefined, model: string | null | undefined, thinking: string | null | undefined): void {
  if (model !== undefined && (model ?? undefined) !== now?.model) {
    if (model) raw.model = model;
    else delete raw.model;
  }
  if (thinking !== undefined && (thinking ?? undefined) !== now?.thinking) {
    if (thinking) raw.thinking = thinking;
    else delete raw.thinking;
  }
}

/** Both halves' plan, checked; then written library first. */
interface Plan {
  library?: SubagentProfilesFile;
  /** Library profiles that are copies: new id → the id copied, so their slots check as stored. */
  copiedFrom?: Record<string, string>;
  session?: (profiles: Raw[]) => Raw[];
  savedKey: string;
}

async function run(plan: Plan, deps: EditorDeps): Promise<EditorAnswer> {
  const dir = deps.dir ?? agentRoot();
  let warnings: string[] = [];
  // Dry run of the session half first: a file that can't be read, or a change it refuses, writes neither half.
  if (plan.session) {
    try {
      changeProfiles(plan.session, undefined, true);
    } catch (err) {
      return fail(409, message(err));
    }
  }
  if (plan.library) {
    const now = loadSubagentProfiles(dir);
    if (!(now.state === "ok" && same(now.value, plan.library))) {
      const checked = await checkSubagentProfiles(plan.library, deps.sources, dir, plan.copiedFrom);
      if ("error" in checked) return fail(400, checked.error);
      warnings = checked.warnings;
      try {
        writeCheckedProfiles(checked, dir);
      } catch (err) {
        return fail(409, message(err));
      }
    }
  }
  if (plan.session) {
    try {
      changeProfiles(plan.session);
    } catch (err) {
      return fail(409, plan.library ? `Its models were saved, but the rest wasn't: ${message(err)}` : message(err), plan.library ? { partial: true } : {});
    }
  }
  return { ok: true, savedKey: plan.savedKey, ...(warnings.length ? { warnings } : {}) };
}

/** The library as it stands, or the reason a write needing it can't go ahead. */
function libraryNow(dir: string): { ok: true; value: SubagentProfilesFile } | { ok: false; error: string } {
  const s = loadSubagentProfiles(dir);
  if (s.state === "ok") return { ok: true, value: clone(s.value) };
  if (s.state === "absent") return { ok: true, value: { version: 1, profiles: [] } };
  return { ok: false, error: `The helper library can't be read (${s.errors.join("; ")}), so nothing was saved. Fix or remove ${s.file} first.` };
}

/** Names a new or renamed profile can't take: your other profiles', and the library's other halves'. */
function takenNames(rows: readonly JoinedProfile[], lib: SubagentProfilesFile, row?: JoinedProfile): string[] {
  const names = rows.filter((r) => r.group === "yours" && r !== row).map((r) => r.name);
  for (const l of lib.profiles) if (l.id !== row?.libraryId) names.push(l.name);
  return names;
}

/** Ids no new half may take: yours, the library's, and Default's. */
const takenIds = (rows: readonly JoinedProfile[], lib: SubagentProfilesFile) =>
  new Set([DEFAULT_PROFILE_ID, OFF_ID, ...rows.filter((r) => r.session?.source === "user").map((r) => r.id), ...lib.profiles.map((l) => l.id)]);

function modelProblem(req: Pick<ProfileSaveRequest, "model" | "thinking">): string | null {
  if (req.model != null && (typeof req.model !== "string" || !/^[^/\s]+\/\S+$/.test(req.model) || req.model.length > 200)) return 'The chat\'s model must be "provider/model".';
  if (req.thinking != null && !(THINKING_LEVELS as readonly unknown[]).includes(req.thinking)) return `The chat's effort must be one of ${THINKING_LEVELS.join(", ")}.`;
  return null;
}

/** POST /api/profiles/mine: save one of yours, both halves; a new one when `key` is absent. */
export async function saveMine(req: ProfileSaveRequest, deps: EditorDeps): Promise<EditorAnswer> {
  const dir = deps.dir ?? agentRoot();
  if (!req || typeof req.name !== "string") return fail(400, "Expected {name, key?, starts?, model?, thinking?, helpers?}");
  const rows = await joinedProfiles(deps.cwd, {}, dir);
  const row = (req.key ? pickJoined(rows, req.key) : null) ?? undefined;
  if (req.key && (!row || row.key !== req.key)) return fail(404, "That profile isn't here anymore.");
  if (row && row.group !== "yours") return fail(409, `${row.name} isn't one of yours, so it is changed in its file, not here.`);
  const bad = modelProblem(req);
  if (bad) return fail(400, bad);
  const lib = libraryNow(dir);
  if (!lib.ok) return fail(409, lib.error);
  const name = req.name.trim();
  const renamed = !row || name !== row.name;
  if (renamed) {
    const why = profileNameProblem(req.name, takenNames(rows, lib.value, row));
    if (why) return fail(400, why, { field: "name" });
  }
  const ids = takenIds(rows, lib.value);
  const library = lib.value;
  let libChanged = false;
  let libId = row?.libraryId;
  const libIndex = () => library.profiles.findIndex((l) => l.id === libId);
  if (!row) {
    // A new profile: both halves, linked, under one id.
    libId = idFor(name, ids);
    library.profiles.push({ id: libId, name, ...clone(req.helpers ?? helpersOf(legacyProfile(dir))), members: null } as SubagentProfile);
    libChanged = true;
  } else if (libId && libIndex() >= 0) {
    const i = libIndex();
    const cur = library.profiles[i]!;
    // The retired Members value is no part of an edit: it stays what the library holds.
    const edited = req.helpers && { ...clone(req.helpers), members: cur.members };
    if (edited && !same(helpersOf(cur), edited)) (library.profiles[i] = { id: cur.id, name: cur.name, ...edited } as SubagentProfile), (libChanged = true);
    // One name for both halves; a half another profile shares keeps its own.
    if (renamed && !row.alsoUsedBy?.length && library.profiles[i]!.name !== name) (library.profiles[i] = { ...library.profiles[i]!, name }), (libChanged = true);
  } else if (req.helpers) {
    // Its helpers weren't here (a link whose half hasn't arrived) or it had none: the half is made now, linked.
    if (!libId || ids.has(libId)) libId = idFor(name, ids);
    library.profiles.push({ id: libId, name, ...clone(req.helpers), members: null } as SubagentProfile);
    libChanged = true;
  }
  // The session half.
  let session: Plan["session"];
  let savedKey: string;
  const now = row?.session;
  if (now) {
    const id = now.id;
    session = (list) =>
      list.map((raw) => {
        if (raw.id !== id) return raw;
        const next = { ...raw };
        if (renamed) next.label = name;
        if (req.starts) applyStarts(next, now, req.starts);
        applyModel(next, now, req.model, req.thinking);
        if (libId && libId !== now.subagents) next.subagents = libId;
        return next;
      });
    savedKey = `user:${id}`;
  } else if (!row || setsStarts(req.starts) || req.model || req.thinking) {
    // New, or a library-only profile now setting something only a session half holds.
    const sessionIds = new Set(rows.filter((r) => r.session?.source === "user").map((r) => r.id));
    const id = libId && !sessionIds.has(libId) && libId !== DEFAULT_PROFILE_ID ? libId : idFor(name, ids);
    session = (list) => {
      const fresh: Raw = { id, label: name, icon: req.starts?.icon ?? "wrench" };
      if (req.starts) applyStarts(fresh, undefined, req.starts);
      applyModel(fresh, undefined, req.model, req.thinking);
      if (libId) fresh.subagents = libId;
      return [...list, fresh];
    };
    savedKey = `user:${id}`;
  } else savedKey = `library:${libId}`;
  return run({ ...(libChanged ? { library } : {}), ...(session ? { session } : {}), savedKey }, deps);
}

/** "{name} copy", then "{name} copy 2"…, within the name's limit and unused. */
export function copyName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  for (let n = 1; ; n++) {
    const tail = n === 1 ? " copy" : ` copy ${n}`;
    const cand = `${name.slice(0, PROFILE_LABEL_RULE.max - tail.length).trimEnd()}${tail}`;
    if (!used.has(cand.toLowerCase())) return cand;
  }
}

/** POST /api/profiles/mine/duplicate: a copy of one of yours, each half it has copied under a new id, linked. */
export async function duplicateMine(key: unknown, deps: EditorDeps): Promise<EditorAnswer> {
  const dir = deps.dir ?? agentRoot();
  if (typeof key !== "string") return fail(400, "Expected {key}");
  const rows = await joinedProfiles(deps.cwd, {}, dir);
  const row = pickJoined(rows, key);
  if (!row || row.key !== key) return fail(404, "That profile isn't here anymore.");
  if (row.group !== "yours") return fail(409, `${row.name} isn't one of yours.`);
  const lib = libraryNow(dir);
  if (!lib.ok) return fail(409, lib.error);
  const name = copyName(row.name, takenNames(rows, lib.value));
  const ids = takenIds(rows, lib.value);
  const id = idFor(name, ids);
  const library = lib.value;
  if (row.library) library.profiles.push({ ...clone(row.library), id, name, members: null });
  const src = row.session;
  const session: Plan["session"] = src
    ? (list) => [...list, { ...rawOf(src), id, label: name, ...(row.library ? { subagents: id } : {}) }]
    : undefined;
  return run({ ...(row.library ? { library, copiedFrom: { [id]: row.library.id } } : {}), ...(session ? { session } : {}), savedKey: src ? `user:${id}` : `library:${id}` }, deps);
}

/** POST /api/profiles/mine/delete: delete one of yours; its library half stays while another profile links it. Never the default. */
export async function deleteMine(key: unknown, deps: EditorDeps): Promise<EditorAnswer> {
  const dir = deps.dir ?? agentRoot();
  if (typeof key !== "string") return fail(400, "Expected {key}");
  const rows = await joinedProfiles(deps.cwd, {}, dir);
  const row = pickJoined(rows, key);
  if (!row || row.key !== key) return fail(404, "That profile isn't here anymore.");
  if (row.group !== "yours") return fail(409, `${row.name} isn't one of yours, so it is deleted from its file, not here.`);
  const def = await resolveDefaultProfile(deps.cwd, rows, dir);
  if (def.row.key === row.key) return fail(409, "Make another profile the default first.");
  const sharedWith = rows.filter((r) => r !== row && r.libraryId && r.libraryId === row.libraryId);
  let library: SubagentProfilesFile | undefined;
  if (row.library && !sharedWith.length) {
    const lib = libraryNow(dir);
    if (!lib.ok) return fail(409, lib.error);
    library = { ...lib.value, profiles: lib.value.profiles.filter((l) => l.id !== row.library!.id) };
  }
  const id = row.session?.id;
  // The session half goes first, so a failure never leaves a profile pointing at deleted helpers.
  if (id) {
    try {
      changeProfiles((list) => list.filter((p) => p.id !== id));
    } catch (err) {
      return fail(409, message(err));
    }
  }
  if (library) {
    try {
      writeSubagentProfiles(dir, library);
    } catch (err) {
      return fail(409, id ? `It was deleted, but its models weren't: ${message(err)}` : message(err), id ? { partial: true } : {});
    }
  }
  return { ok: true };
}

/** What a chat uses now, as Save Current As Profile and Update {name} read it. */
export interface ChatNow {
  model?: string;
  thinking?: string;
  /** Its major mode (in Create, its last normal or Delegate choice) and minor modes. */
  mode?: "normal" | "delegate";
  minorModes?: string[];
  /** The library profile its helpers resolve to now; "off" or undefined: none. */
  helpers?: string;
}

/**
 * Save Current As Profile (§chat.profiles/picker): a new capability-neutral profile of yours with
 * both halves, linked: the chat's model and effort, and a copy of its helpers (Off: none).
 */
export async function saveCurrentAsProfile(label: unknown, now: ChatNow, deps: EditorDeps): Promise<EditorAnswer> {
  const dir = deps.dir ?? agentRoot();
  const rule = problemOf(PROFILE_LABEL_RULE, label);
  if (rule) return fail(400, rule, { field: "name" });
  const name = String(label).trim();
  const rows = await joinedProfiles(deps.cwd, {}, dir);
  const lib = libraryNow(dir);
  const library = lib.ok ? lib.value : undefined;
  const why = profileNameProblem(name, library ? takenNames(rows, library) : rows.filter((r) => r.group === "yours").map((r) => r.name));
  if (why === PROFILE_NAME_TAKEN) return fail(409, `You already have a profile named "${name}". Pick another name.`, { field: "name" });
  if (why) return fail(400, why, { field: "name" });
  const source = now.helpers && now.helpers !== OFF_ID ? library?.profiles.find((l) => l.id === now.helpers) : undefined;
  if (now.helpers && now.helpers !== OFF_ID && !source) return fail(409, lib.ok ? `Its helpers ("${now.helpers}") aren't in this device's library.` : lib.error);
  const ids = library ? takenIds(rows, library) : new Set([DEFAULT_PROFILE_ID, ...rows.map((r) => r.id)]);
  const id = idFor(name, ids);
  if (source && library) library.profiles.push({ ...clone(source), id, name, members: null });
  const fresh: Raw = { id, label: name, icon: "wrench" };
  if (now.model) fresh.model = now.model;
  if (now.thinking && (THINKING_LEVELS as readonly string[]).includes(now.thinking)) fresh.thinking = now.thinking;
  fresh.subagents = source ? id : OFF_ID;
  return run({ ...(source ? { library, copiedFrom: { [id]: source.id } } : {}), session: (list) => [...list, fresh], savedKey: `user:${id}` }, deps);
}

/**
 * Update {name} (§chat.subagent-profiles/menu): this chat's model and effort, and its mode and
 * add-on modes, into its profile's session half (made, linked, for a library-only profile). Never a
 * helper; never Off, a project's or a shipped profile.
 */
export async function updateFromChat(key: string | undefined, now: ChatNow, deps: EditorDeps): Promise<EditorAnswer> {
  const dir = deps.dir ?? agentRoot();
  const rows = await joinedProfiles(deps.cwd, {}, dir);
  const row = key ? pickJoined(rows, key) : null;
  if (!row || row.kind === "off") return fail(409, "This chat is on Off, which saves nothing.");
  if (row.group !== "yours") return fail(409, `${row.name} is a file in ${row.kind === "project" ? "the project" : "Sova"}, so it can't be updated here.`);
  const current = row.session;
  const starts: ProfileStarts | undefined = current
    ? { icon: current.icon, description: current.description, remove: current.remove, grant: current.grant, singleton: current.singleton, limits: current.limits, firstMessage: current.firstMessage, overseerMayStart: current.overseerMayStart, ...(now.mode ? { mode: now.mode } : {}), ...(now.minorModes ? { minorModes: PROFILE_MINOR_MODES.filter((m) => now.minorModes!.includes(m)) } : {}) }
    : undefined;
  const req: ProfileSaveRequest = {
    key: row.key,
    name: row.name,
    ...(starts ? { starts } : {}),
    ...(now.model ? { model: now.model } : {}),
    ...(now.thinking && (THINKING_LEVELS as readonly string[]).includes(now.thinking) ? { thinking: now.thinking as Profile["thinking"] } : {}),
  };
  if (!current) {
    // A library-only profile: its session half is made with the chat's modes.
    req.starts = {
      remove: [], grant: [], singleton: false, limits: { ...DEFAULT_LIMITS }, overseerMayStart: false,
      ...(now.mode ? { mode: now.mode } : {}),
      ...(now.minorModes ? { minorModes: PROFILE_MINOR_MODES.filter((m) => now.minorModes!.includes(m)) } : {}),
    };
  }
  return saveMine(req, deps);
}
