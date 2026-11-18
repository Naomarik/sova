// A started run's record frozen before teams had goals (a cast of roles, each team a step's helpers): read as the
// card the page draws now. Each old team is a team whose goal is what its step was called; helpers a step ran
// on their own are that step's team; the old roles that ran are its members, with their models and notes. The
// main chat isn't a member (it ran on the chat's model). Nothing new is claimed: an old role had no brief, so
// its brief is empty. Pure.
import type { PlaybookMemberView, PlaybookRunView, PlaybookStepView, PlaybookTeamView } from "../../shared/playbook-run";

interface OldRole extends Omit<PlaybookMemberView, "brief"> {
  main?: boolean;
  team?: string;
  prompt?: string;
}
interface OldTeam {
  id: string;
  label: string;
  roles?: string[];
}
interface OldStep extends Omit<PlaybookStepView, "teams"> {
  runs?: "main" | "team" | "helpers";
  team?: string;
  roles?: string[];
}

/** A frozen view in the old shape (it has `roles`, or a team without `members`). */
export function isLegacyView(v: unknown): boolean {
  const x = v as { roles?: unknown; teams?: { members?: unknown }[] } | null;
  return !!x && (Array.isArray(x.roles) || (Array.isArray(x.teams) && x.teams.some((t) => !Array.isArray(t?.members))));
}

const member = (r: OldRole): PlaybookMemberView => ({
  id: r.id,
  label: r.label,
  brief: "",
  ...(r.kind ? { kind: r.kind } : {}),
  count: r.count ?? 1,
  ...(r.per ? { per: r.per } : {}),
  optional: !!r.optional,
  on: r.on !== false,
  only: !!r.only,
  chain: r.chain ?? [],
  models: r.models ?? [],
  options: r.options ?? [],
  resolved: r.resolved ?? null,
  runnable: r.runnable !== false,
  note: r.note ?? "",
});

/** The old record as today's card: teams with members (never undefined), steps naming their teams, the counts. */
export function upgradeLegacyView(v: PlaybookRunView): PlaybookRunView {
  const old = v as unknown as Omit<PlaybookRunView, "teams" | "steps"> & { roles?: OldRole[]; teams?: OldTeam[]; steps?: OldStep[] };
  const roles = (old.roles ?? []).filter((r) => !r.main);
  const byId = (id: string) => roles.find((r) => r.id === id);
  const teams: PlaybookTeamView[] = (old.teams ?? []).map((t) => ({
    id: t.id,
    label: t.label,
    goal: t.label,
    steps: (old.steps ?? []).filter((s) => s.team === t.id).map((s) => s.id),
    note: "",
    members: (t.roles ?? []).map(byId).filter((r): r is OldRole => !!r).map(member),
  }));
  const steps: PlaybookStepView[] = (old.steps ?? []).map((s) => {
    let ids: string[] = [];
    if (s.runs === "team" && s.team) ids = [s.team];
    else if (s.runs === "helpers") {
      // The helpers a step ran on their own: one team, called what the step was.
      const helpers = (s.roles ?? []).map(byId).filter((r): r is OldRole => !!r && r.on !== false);
      if (helpers.length) {
        const id = teams.some((t) => t.id === s.id) ? `${s.id}-helpers` : s.id;
        teams.push({ id, label: s.title, goal: s.title, steps: [s.id], note: "", members: helpers.map(member) });
        ids = [id];
      }
    }
    return {
      id: s.id,
      title: s.title,
      ...(s.goal ? { goal: s.goal } : {}),
      stop: s.stop,
      stopOn: s.stopOn,
      teams: ids,
      ...(s.report ? { report: s.report } : {}),
      ...(s.cycle ? { cycle: true } : {}),
    };
  });
  // A helper the record names that ran in no team and no step of its own still shows, so the record keeps every helper.
  const placed = new Set(teams.flatMap((t) => t.members.map((m) => m.id)));
  const left = roles.filter((r) => r.on !== false && !placed.has(r.id));
  if (left.length) teams.push({ id: teams.some((t) => t.id === "other-helpers") ? "other-helpers-2" : "other-helpers", label: "Other helpers", goal: "Helpers this run named outside any team", steps: [], note: "", members: left.map(member) });
  const { roles: _roles, ...rest } = old;
  return { ...rest, teams, steps, who: { teams: teams.length, members: teams.reduce((n, t) => n + t.members.filter((m) => m.on).length, 0) }, legacy: true };
}
