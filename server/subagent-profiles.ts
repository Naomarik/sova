import { join } from "node:path";
import { agentRoot } from "./state-root";
import { LIBRARY_KEY, listKept, markRestored } from "./sync/kept";
import {
  loadSubagentProfiles, legacyProfile, parseSubagentProfiles, readProfilesDefault, resolveSubagents, profilesDefaultOf,
  footprint, profileProviders, profileSlots, writeSubagentProfiles, writeProfilesDefault, OFF_FOOTPRINT,
  profileWorkers, shortModel as workerModelName,
} from "../pi-config/extensions/subagents/subagent-profiles.ts";
import type { SubagentProfilesInfo, SubagentProfilesReplaced } from "../shared/subagent-profiles";
import { delegateOptions, verifySlots, type DelegateSources } from "./delegate";

export function subagentProfilesInfo(pick?: string, dir = agentRoot()): SubagentProfilesInfo {
  const state = loadSubagentProfiles(dir);
  const def = readProfilesDefault(dir);
  const r = resolveSubagents(dir, pick, state, def);
  const d = profilesDefaultOf(state, def);
  const warnings: string[] = [];
  if (def.state === "malformed") warnings.push(`the default file ${def.file} is malformed (${def.errors.join("; ")}); the default reads as Off until it is fixed`);
  else if (d.note) warnings.push(d.note);
  return {
    settings: state.state === "ok" ? state.value : { version: 1, profiles: [] },
    default: d.id,
    template: legacyProfile(dir),
    profiles: [{ id: "off", name: "Off", footprint: OFF_FOOTPRINT, providers: [] },
      ...(state.state === "ok" ? state.value.profiles.map(p => ({ id: p.id, name: p.name, footprint: footprint(p), providers: profileProviders(p) })) : [])],
    current: { id: r.id, name: r.name, source: r.source, ...(r.note ? { note: r.note } : {}) },
    file: state.file,
    ...(state.state !== "ok" ? { error: state.state === "malformed" ? state.errors.join("; ") : "Fix the malformed legacy team defaults before migrating profiles." } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...withReplaced(dir),
  };
}

/**
 * How many distinct primary models a library profile names: the count its footprint shows, never
 * cut at three (the profile cards' subagents count, §chat.profiles/picker). 0 for Off or an id the
 * library lacks.
 */
export function profileModelCount(info: Pick<SubagentProfilesInfo, "settings">, id: string): number {
  const p = info.settings.profiles.find((x) => x.id === id);
  return p ? new Set(profileWorkers(p, false).map((w) => workerModelName(w.model))).size : 0;
}

/** How long Settings → Subagents offers a kept library back (§chat.subagent-profiles/replaced). */
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

/** Validate on this host before writing a session pick or creating anything. */
export function requireSubagentProfile(id: unknown, dir = agentRoot()): string {
  const i = subagentProfilesInfo(undefined, dir);
  if (i.error) throw new Error(i.error);
  if (typeof id !== "string" || !i.profiles.some(p => p.id === id)) throw new Error(`Unknown subagent profile: ${String(id)}`);
  return id;
}

export async function saveSubagentProfiles(body: unknown, sources: DelegateSources, dir = agentRoot()): Promise<SubagentProfilesInfo | { error: string }> {
  const old = subagentProfilesInfo(undefined, dir);
  if (old.error) return { error: old.error };
  const parsed = parseSubagentProfiles(body);
  if (!parsed.ok) return { error: parsed.errors.join("; ") };
  const options = await delegateOptions(sources);
  // One slot per declared tuple — a disabled coordinator/monitor's tuples included, as the old
  // Teams editor did. `stored` is the tuple this very slot of this profile already holds: a slot
  // left as it was stored never blocks the save; anything else is checked as changed.
  const slots = parsed.value.profiles.flatMap((p) => {
    const previous = old.settings.profiles.find(o => o.id === p.id);
    const stored = new Map((previous ? profileSlots(previous) : []).map(s => [s.label, s.choice]));
    return profileSlots(p).map(s => ({ label: `${p.name}: ${s.label}`, choice: s.choice, stored: stored.get(s.label) }));
  });
  const checked = verifySlots(slots, options, "Subagents", "refuse affected work");
  if ("error" in checked) return checked;
  writeSubagentProfiles(dir, parsed.value);
  const info = subagentProfilesInfo(undefined, dir);
  return { ...info, warnings: [...(info.warnings ?? []), ...checked.warnings] };
}

/** Set this device's default (writes the default file only; the library and no other chat move). */
export function saveSubagentProfileDefault(id: unknown, dir = agentRoot()): void {
  writeProfilesDefault(dir, { version: 1, default: requireSubagentProfile(id, dir) });
}
