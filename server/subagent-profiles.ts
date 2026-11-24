import { join } from "node:path";
import { agentRoot } from "./state-root";
import { LIBRARY_KEY, listKept, markRestored } from "./sync/kept";
import {
  loadSubagentProfiles, parseSubagentProfiles, readProfilesDefault, readSubagentProfiles, resolveSubagents, profilesDefaultOf,
  footprint, profileProviders, profileSlots, writeSubagentProfiles, writeProfilesDefault, builtinFallback, helperProfileOf, pickableHelpers,
  profileWorkers, shortModel as workerModelName, OFF_PROFILE_ID,
} from "../pi-config/extensions/subagents/subagent-profiles.ts";
import { readConnectedAccounts } from "../pi-config/extensions/subagents/builtin-profiles.ts";
import type { SubagentProfile, SubagentProfilesFile, SubagentProfilesInfo, SubagentProfilesReplaced } from "../shared/subagent-profiles";
import { firstIssue } from "../shared/form-rules";
import { profileFields } from "../shared/subagent-profile-checks";
import { delegateOptions, verifySlots, type DelegateSources } from "./delegate";
import { profileHash } from "./sync/profile-merge";

/**
 * The helper profiles as Settings, the pickers and the pick checks read them: the library's (named as
 * screens show them) and the built-in ones listed here, this device's default (a missing or "off" default is the
 * built-in one the connected accounts give; "off" only with none connected: no helper profile), and what `pick`
 * resolves to now.
 */
export function subagentProfilesInfo(pick?: string, dir = agentRoot()): SubagentProfilesInfo {
  const state = loadSubagentProfiles(dir);
  const def = readProfilesDefault(dir);
  const fallback = builtinFallback(dir);
  const r = resolveSubagents(dir, pick, state, def, fallback);
  const d = profilesDefaultOf(state, def, fallback);
  // No default and nothing connected: "off", no helper profile (what the field always said for none).
  const defaultId = d.id ?? fallback ?? OFF_PROFILE_ID;
  const library = state.state === "ok" ? state.value.profiles : [];
  const warnings: string[] = [];
  if (d.note) warnings.push(d.note);
  const listed = state.state === "malformed" ? [] : pickableHelpers(library, readConnectedAccounts(dir));
  const helpers = listed.map((c) => helperProfileOf(c.id, library)!).filter(Boolean);
  // New Profile's helpers start from the default's (the built-in Claude's when there is none).
  const { id: _id, name: _name, ...from } = helperProfileOf(defaultId, library) ?? helperProfileOf(fallback ?? "claude", library)!;
  return {
    settings: state.state === "ok" ? state.value : { version: 1, profiles: [] },
    default: defaultId,
    template: { id: "new", name: "New profile", ...JSON.parse(JSON.stringify(from)) },
    profiles: helpers.map((p) => ({ id: p.id, name: p.name, footprint: footprint(p), providers: profileProviders(p) })),
    current: { id: r.id, name: r.name, source: r.source, ...(r.note ? { note: r.note } : {}) },
    file: state.file,
    ...(state.state === "malformed" ? { error: state.errors.join("; ") } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...withReplaced(dir),
  };
}

/**
 * How many distinct primary models a library profile names: the count its footprint shows, never
 * cut at three (the profile cards' subagents count, §chat.profiles/picker), a built-in one's too. 0
 * for an id that names none here.
 */
export function profileModelCount(info: Pick<SubagentProfilesInfo, "settings">, id: string): number {
  const p = helperProfileOf(id, info.settings.profiles);
  return p ? new Set(profileWorkers(p, false).map((w) => workerModelName(w.model))).size : 0;
}

/** How long Settings → Profiles offers a kept library back (§chat.subagent-profiles/replaced). */
export const REPLACED_NOTICE_MS = 24 * 60 * 60_000;
const stateDirOf = (dir: string) => join(dir, "sova");

/** The newest change another device's copy made here, while it is under a day old and not restored. */
export function replacedNotice(dir = agentRoot(), now = Date.now()): SubagentProfilesReplaced | undefined {
  const newest = listKept(stateDirOf(dir), LIBRARY_KEY)[0];
  if (!newest || newest.restoredAt !== undefined || now - newest.at > REPLACED_NOTICE_MS) return undefined;
  return { file: newest.file, at: newest.at, by: newest.byName ?? newest.by, ...(newest.changes ? { changes: newest.changes } : {}) };
}
const withReplaced = (dir: string): { replaced?: SubagentProfilesReplaced } => {
  const r = replacedNotice(dir);
  return r ? { replaced: r } : {};
};

/**
 * Restore Previous Library: write the kept copy back as a new local edit, through the library's own
 * strict writer (the mesh then syncs it like any edit), and mark it restored.
 */
export function restoreReplacedProfiles(file: unknown, dir = agentRoot(), now = Date.now()): SubagentProfilesInfo | { error: string } {
  if (typeof file !== "string") return { error: "Name the kept library to restore" };
  const kept = listKept(stateDirOf(dir), LIBRARY_KEY).find((k) => k.file === file);
  if (!kept) return { error: "That kept library is no longer on this device" };
  let value: unknown;
  try {
    value = JSON.parse(kept.content);
  } catch {
    return { error: "The kept library isn't valid JSON" };
  }
  try {
    writeSubagentProfiles(dir, value);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  markRestored(stateDirOf(dir), LIBRARY_KEY, kept.file, now);
  return subagentProfilesInfo(undefined, dir);
}

/** Validate on this host before writing a session pick or creating anything: a library profile or a built-in one (which a profile of yours may take the place of). */
export function requireSubagentProfile(id: unknown, dir = agentRoot()): string {
  const state = loadSubagentProfiles(dir);
  if (state.state === "malformed") throw new Error(state.errors.join("; "));
  const library = state.state === "ok" ? state.value.profiles : [];
  if (typeof id === "string" && id.trim().toLowerCase() === "off") {
    const names = pickableHelpers(library, readConnectedAccounts(dir)).map((p) => p.name);
    const list = names.length <= 1 ? (names[0] ?? "none") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    throw new Error(`No profile is named "off"; the profiles here are ${list}.`);
  }
  if (typeof id !== "string" || !helperProfileOf(id, library)) throw new Error(`Unknown subagent profile: ${String(id)}`);
  return id;
}

export async function saveSubagentProfiles(body: unknown, sources: DelegateSources, dir = agentRoot()): Promise<SubagentProfilesInfo | { error: string }> {
  const checked = await checkSubagentProfiles(body, sources, dir);
  if ("error" in checked) return checked;
  try {
    writeCheckedProfiles(checked, dir);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const info = subagentProfilesInfo(undefined, dir);
  return { ...info, warnings: [...(info.warnings ?? []), ...checked.warnings] };
}

/** A library that passed the save's checks, and the library it was checked against (read before the model check's await). */
export interface CheckedProfiles {
  value: SubagentProfilesFile;
  warnings: string[];
  base: SubagentProfile[];
}

/**
 * Everything saveSubagentProfiles checks, without writing: the editor's box rules, the strict parse,
 * and every changed worker slot against this host's models. Settings → Profiles' save checks its
 * library half this way before it writes either half.
 */
export async function checkSubagentProfiles(body: unknown, sources: DelegateSources, dir = agentRoot(), copiedFrom: Readonly<Record<string, string>> = {}): Promise<CheckedProfiles | { error: string }> {
  const old = subagentProfilesInfo(undefined, dir);
  if (old.error) return { error: old.error };
  // The editor's boxes' rules first, so a bad box is refused in the words the editor shows it in.
  const sent = body && typeof body === "object" ? (body as { profiles?: unknown }).profiles : undefined;
  const bad = Array.isArray(sent) ? firstIssue(sent.flatMap((p) => (p && typeof p === "object" ? profileFields(p as SubagentProfile).filter((f) => f.value !== undefined) : []))) : null;
  if (bad) return { error: bad.message };
  const parsed = parseSubagentProfiles(body);
  if (!parsed.ok) return { error: parsed.errors.join("; ") };
  const options = await delegateOptions(sources);
  // One slot per declared tuple — a disabled coordinator/monitor's tuples included, as the old
  // Teams editor did. `stored` is the tuple this very slot of this profile already holds: a slot
  // left as it was stored never blocks the save; anything else is checked as changed.
  const slots = parsed.value.profiles.flatMap((p) => {
    // A copy (Duplicate, Save Current As Profile) is checked as the profile it was copied from.
    const previous = old.settings.profiles.find(o => o.id === (copiedFrom[p.id] ?? p.id));
    const stored = new Map((previous ? profileSlots(previous) : []).map(s => [s.label, s.choice]));
    return profileSlots(p).map(s => ({ label: `${p.name}: ${s.label}`, choice: s.choice, stored: stored.get(s.label) }));
  });
  const checked = verifySlots(slots, options, "Subagents", "refuse affected work");
  if ("error" in checked) return checked;
  return { value: parsed.value, warnings: checked.warnings, base: old.settings.profiles };
}

/**
 * What a save changed, put on the library as it stands now, profile by profile. `base` is the library
 * the save started from, `saved` what it asks for, `now` the file at the moment of writing. A profile
 * the save changed or added is the save's; one it left as it was stays as it is now (or gone, if it
 * went meanwhile); one it dropped from `base` is deleted; one that arrived since is kept.
 */
export function rebaseProfiles(base: readonly SubagentProfile[], saved: readonly SubagentProfile[], now: readonly SubagentProfile[]): SubagentProfile[] {
  const started = new Map(base.map((p) => [p.id, profileHash(p)]));
  const current = new Map(now.map((p) => [p.id, p]));
  const asked = new Set(saved.map((p) => p.id));
  const out = saved.flatMap((p) => {
    if (started.get(p.id) !== profileHash(p)) return [p];
    const c = current.get(p.id);
    return c ? [c] : [];
  });
  return [...out, ...now.filter((p) => !asked.has(p.id) && !started.has(p.id))];
}

/**
 * Write what checkSubagentProfiles passed. The model check awaits, and the mesh can change the file
 * during it: a list read before that would drop what arrived, and the sync would then record the
 * drop as a deletion everywhere. So the file is read again here, with no await before the write.
 */
export function writeCheckedProfiles(checked: CheckedProfiles, dir = agentRoot()): SubagentProfilesFile {
  const now = readSubagentProfiles(dir);
  if (now.state === "malformed") throw new Error(`${now.file} can't be read (${now.errors.join("; ")}), so nothing was saved. Fix or remove it first.`);
  return writeSubagentProfiles(dir, { version: 1, profiles: rebaseProfiles(checked.base, checked.value.profiles, now.state === "ok" ? now.value.profiles : []) });
}

/** Set this device's default (writes the default file only; the library and no other chat move). */
export function saveSubagentProfileDefault(id: unknown, dir = agentRoot()): void {
  writeProfilesDefault(dir, { version: 1, default: requireSubagentProfile(id, dir) });
}
