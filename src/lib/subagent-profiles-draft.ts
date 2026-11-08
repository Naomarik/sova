import type { SubagentProfile, SubagentProfilesInfo } from "../../shared/subagent-profiles";
import { type FieldCheck, firstIssue } from "../../shared/form-rules";
import { profileFields } from "../../shared/subagent-profile-checks";

export const cloneProfiles = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * The library as its rules read it: the synced file's profiles plus this device's `default`. The
 * Profiles form (profiles-draft.ts) checks each library half through these same rules, so the
 * editor's sentences are the ones the Subagents tab said.
 */
export interface LibraryDraft {
  version: 1;
  /** A profile's id, or "off". */
  default: string;
  profiles: SubagentProfile[];
}

/** What the server has, as the draft store keeps it: the file plus this device's default. */
export const savedOf = (info: SubagentProfilesInfo): LibraryDraft => ({ version: 1, default: info.default, profiles: cloneProfiles(info.settings.profiles) });

type Tuple = { backend: string; model: string; effort?: string };
const incomplete = (c: Tuple | null | undefined): boolean => !!c && (!c.model || !(c.effort ?? ""));
const samePair = (primary: Tuple, fallback: Tuple | null | undefined): boolean =>
  !!fallback && primary.backend === fallback.backend && primary.model === fallback.model && (primary.effort ?? "") === (fallback.effort ?? "");

/** Why profile `id`'s name can't be saved, beyond its rule's length (the box's own sentence), or null. */
export function profileNameIssue(d: LibraryDraft, id: string): string | null {
  const p = d.profiles.find((x) => x.id === id);
  if (!p?.name) return null;
  if (p.name.trim() !== p.name || /[\x00-\x1f]/.test(p.name)) return "Profile name must be one line, with no spaces at either end.";
  if (p.name.toLowerCase() === "off") return 'Profile name can\'t be "Off", the built-in profile\'s.';
  if (d.profiles.some((x) => x.id !== id && x.name.toLowerCase() === p.name.toLowerCase())) return "Another profile has this name.";
  return null;
}

/** Each profile's boxes and rows in page order: the first that fails is what Save waits for. */
export function profilesFields(d: LibraryDraft): (FieldCheck | { message: string | null })[] {
  return d.profiles.flatMap((p) => {
    const rows: [string, Tuple, Tuple | null][] = [
      ...Object.values(p.delegate).map((r): [string, Tuple, Tuple | null] => ["Delegate", r.primary, r.fallback]),
      ...(p.teams ? ([["Coordinator", p.teams.coordinator.primary, p.teams.coordinator.fallback], ["Monitor", p.teams.monitor.primary, p.teams.monitor.fallback]] as [string, Tuple, Tuple | null][]) : []),
      ...(p.specWriter ? ([["Spec writer", p.specWriter.primary, p.specWriter.fallback]] as [string, Tuple, Tuple | null][]) : []),
      ...(p.reviewer ? ([["Reviewer", p.reviewer.primary, p.reviewer.fallback]] as [string, Tuple, Tuple | null][]) : []),
    ];
    const row = rows.find(([, a, b]) => incomplete(a) || incomplete(b) || samePair(a, b));
    const roles = p.teams ? [p.teams.coordinator.role.trim().toLowerCase(), p.teams.monitor.role.trim().toLowerCase()] : [];
    const [name, ...boxes] = profileFields(p);
    return [
      name!,
      { message: profileNameIssue(d, p.id) },
      { message: row ? (samePair(row[1], row[2]) ? `${p.name}'s ${row[0]} fallback is its primary; choose another worker, or none.` : `${p.name}'s ${row[0]} rows each need a model and an effort.`) : null },
      { message: incomplete(p.members) ? `${p.name}'s members default needs a model and an effort.` : null },
      ...boxes,
      { message: roles[0] && roles[0] === roles[1] ? `${p.name}'s coordinator and monitor need different role names.` : null },
    ];
  });
}

/** The first way the draft can't be saved, as the footer says it. */
export const profilesProblem = (d: LibraryDraft): string | null => {
  const bad = firstIssue(profilesFields(d));
  return bad && `Profiles: ${bad.message}`;
};
