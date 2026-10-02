import type { SubagentProfile, SubagentProfilesInfo } from "../../shared/subagent-profiles";
import { putSubagentProfileDefault, putSubagentProfiles } from "./api";
import { createDraftStore, SaveFailed } from "./settings-draft";
import { numberIssue, type TeamNumberField } from "./team-form";

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

/** The number fields' labels, as the editor says them. */
const NUMBER_LABELS: Record<TeamNumberField, string> = {
  contextPct: "Wrap-up context %",
  everyMinutes: "Check every (minutes)",
  pausePct: "Pause usage %",
  resumeMarginMinutes: "Resume margin (minutes)",
  retireTimeoutMinutes: "Retire timeout (minutes)",
};

/** The first threshold in a profile's teams that can't be saved, said like its field, or null. */
function teamsNumberError(p: SubagentProfile): string | null {
  if (!p.teams) return null;
  const t = p.teams;
  const values: Record<TeamNumberField, number> = {
    contextPct: t.monitor.contextPct,
    everyMinutes: t.monitor.everyMinutes,
    pausePct: t.monitor.usage.pausePct,
    resumeMarginMinutes: t.monitor.usage.resumeMarginMinutes,
    retireTimeoutMinutes: t.handover.retireTimeoutMinutes,
  };
  for (const f of Object.keys(values) as TeamNumberField[]) {
    const issue = numberIssue(f, values[f]);
    if (issue) return `${NUMBER_LABELS[f]}: ${issue}`;
  }
  return null;
}

/** The first way the draft can't be saved, as one footer sentence that names the form. */
export function profilesProblem(d: LibraryDraft): string | null {
  const names = new Set<string>();
  for (const p of d.profiles) {
    if (!p.name.trim() || p.name.trim() !== p.name || p.name.length > 48 || /[\r\n\x00-\x1f]/.test(p.name) || p.name.toLowerCase() === "off" || names.has(p.name.toLowerCase()))
      return `Subagents needs unique, single-line names of at most 48 characters (never "Off").`;
    names.add(p.name.toLowerCase());
    const rows: [string, Tuple, Tuple | null][] = [
      ...Object.values(p.delegate).map((r) => ["Delegate", r.primary, r.fallback] as [string, Tuple, Tuple | null]),
      ...(p.teams
        ? ([
            ["Coordinator", p.teams.coordinator.primary, p.teams.coordinator.fallback],
            ["Monitor", p.teams.monitor.primary, p.teams.monitor.fallback],
          ] as [string, Tuple, Tuple | null][])
        : []),
      ...(p.specWriter ? ([["Spec writer", p.specWriter.primary, p.specWriter.fallback]] as [string, Tuple, Tuple | null][]) : []),
    ];
    for (const [label, primary, fallback] of rows) {
      if (incomplete(primary) || incomplete(fallback)) return `Subagents: ${p.name}'s ${label} rows each need a model and an effort.`;
      if (samePair(primary, fallback)) return `Subagents: ${p.name}'s ${label} fallback is its primary; choose another worker, or none.`;
    }
    if (incomplete(p.members)) return `Subagents: ${p.name}'s members default needs a model and an effort.`;
    if (p.teams) {
      const roles = [p.teams.coordinator.role, p.teams.monitor.role];
      for (const role of roles) if (!role.trim() || role.length > 64 || /[\r\n]/.test(role)) return `Subagents: ${p.name}'s coordinator and monitor each need a role name on one line of at most 64 characters.`;
      if (p.teams.coordinator.role.trim().toLowerCase() === p.teams.monitor.role.trim().toLowerCase())
        return `Subagents: ${p.name}'s coordinator and monitor need different role names.`;
      const n = teamsNumberError(p);
      if (n) return `Subagents: ${p.name}: ${n}`;
    }
  }
  return null;
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
  same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  problem: profilesProblem,
  write: async (d, base) => {
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
