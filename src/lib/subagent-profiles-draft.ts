import type { SubagentProfile, SubagentProfilesInfo } from "../../shared/subagent-profiles";
import { putSubagentProfileDefault, putSubagentProfiles } from "./api";
import { createDraftStore, SaveFailed } from "./settings-draft";
import { check, type FieldCheck, firstIssue } from "../../shared/form-rules";
import { profileFields } from "../../shared/subagent-profile-checks";
import { TEAM_NUMBERS, TEAM_RULES, type TeamNumberField } from "../../shared/subagent-limits";

export const cloneProfiles = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * The library draft: the synced file's profiles plus this device's `default`, staged in the draft
 * like any other field. The wire file carries no `default` — it
 * lives in `subagent-profiles-default.json`, never synced — so a Save writes the two apart.
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
  return bad && `Subagents: ${bad.message}`;
};

/** The draft as the file takes it: each team number box's typed text as its number. */
function typedOut(d: LibraryDraft): LibraryDraft {
  const out = cloneProfiles(d);
  for (const p of out.profiles)
    for (const f of Object.keys(TEAM_RULES) as TeamNumberField[]) {
      const path = TEAM_NUMBERS[f].path;
      const parent = path.slice(0, -1).reduce<any>((o, k) => o?.[k], p.teams);
      const r = parent ? check(TEAM_RULES[f], parent[path.at(-1)!]) : null;
      if (r?.ok) parent[path.at(-1)!] = r.value;
    }
  return out;
}

/**
 * Settings → Subagents' draft of the whole library. The file's
 * validation is whole-file, so one Save writes it all; a moved `default` goes to its own file in
 * the same save, and its failure is said as partial — the library already changed.
 */
export const profilesDraft = createDraftStore<LibraryDraft, LibraryDraft, SubagentProfilesInfo>({
  tab: "subagents",
  label: "Subagents",
  toDraft: cloneProfiles,
  same: (a, b) => JSON.stringify(typedOut(a)) === JSON.stringify(b),
  fields: profilesFields,
  write: async (typed, base) => {
    const d = typedOut(typed);
    // The synced library first, then this device's default only when it moved. Two files, no
    // transaction: a default failure after the library wrote is partial, and says so.
    const profilesMoved = JSON.stringify(d.profiles) !== JSON.stringify(base.profiles);
    let r: SubagentProfilesInfo | null = null;
    if (profilesMoved) r = await putSubagentProfiles({ version: 1, profiles: d.profiles });
    if (d.default !== base.default) {
      try {
        r = await putSubagentProfileDefault(d.default);
      } catch (err) {
        if (profilesMoved) throw new SaveFailed(`The profiles were saved, then the default failed: ${(err instanceof Error ? err.message : String(err)).replace(/\.$/, "")}`, true);
        throw err;
      }
    }
    if (!r) throw new Error("Nothing to save"); // unreachable: same() gates the write
    return { saved: { version: 1, default: r.default, profiles: r.settings.profiles }, warnings: r.warnings ?? [], result: r };
  },
});
