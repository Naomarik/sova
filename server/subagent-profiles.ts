import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  loadSubagentProfiles, legacyProfile, parseSubagentProfiles, readProfilesDefault, resolveSubagents, profilesDefaultOf,
  footprint, profileProviders, profileSlots, writeSubagentProfiles, writeProfilesDefault, OFF_FOOTPRINT,
} from "../pi-config/extensions/subagents/subagent-profiles.ts";
import type { SubagentProfilesInfo } from "../shared/subagent-profiles";
import { delegateOptions, verifySlots, type DelegateSources } from "./delegate";

export function subagentProfilesInfo(pick?: string, dir = getAgentDir()): SubagentProfilesInfo {
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
  };
}

/** Validate on this host before writing a session pick or creating anything. */
export function requireSubagentProfile(id: unknown, dir = getAgentDir()): string {
  const i = subagentProfilesInfo(undefined, dir);
  if (i.error) throw new Error(i.error);
  if (typeof id !== "string" || !i.profiles.some(p => p.id === id)) throw new Error(`Unknown subagent profile: ${String(id)}`);
  return id;
}

export async function saveSubagentProfiles(body: unknown, sources: DelegateSources, dir = getAgentDir()): Promise<SubagentProfilesInfo | { error: string }> {
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
export function saveSubagentProfileDefault(id: unknown, dir = getAgentDir()): void {
  writeProfilesDefault(dir, { version: 1, default: requireSubagentProfile(id, dir) });
}
