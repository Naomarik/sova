import type { SubagentProfile, TeamsSetting } from "../../shared/subagent-profiles";
import { profilesProblem } from "./subagent-profiles-draft";
import { claudeModelName } from "./format";

/**
 * Settings → Subagents' editor, the parts that are rules rather than markup: each collapsible
 * section's one-line summary, which sections hold something Save waits for, and how the
 * coordinator and monitor switches map onto the stored `teams` shape.
 */

export type EditorSection = "delegate" | "teams" | "spec" | "reviewer";

/**
 * A model's shortest readable form, the footprint's own rule (`shortModel` in
 * pi-config/extensions/subagents/subagent-profiles.ts, which the browser can't import), so a
 * summary and the list's footprint name a model alike: a Claude model by its catalog name
 * (`opus[1m]` → Opus 5.5), else the id without its provider (`zai/glm-5.3` → glm-5.3).
 */
export function footprintModel(model: string): string {
  const name = claudeModelName(model);
  if (name) return name;
  return model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
}
const model = (m: string): string | null => (m ? footprintModel(m) : null);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Delegate routing, closed: the routes' distinct primary models, then how many fallbacks. */
export function delegateSummary(p: SubagentProfile): string {
  const routes = Object.values(p.delegate);
  const names: string[] = [];
  for (const r of routes) {
    const m = model(r.primary.model);
    if (m && !names.includes(m)) names.push(m);
  }
  const fallbacks = routes.filter((r) => r.fallback !== null).length;
  return [names.length ? names.join(" · ") : "No models chosen", fallbacks ? plural(fallbacks, "fallback") : "no fallbacks"].join(" · ");
}

/** The coordinator is on: the profile stores standing roles and the coordinator among them. */
export const coordinatorOn = (p: SubagentProfile): boolean => !!p.teams && p.teams.coordinator.enabled;
/** The monitor is on. It reports to the coordinator, so it is never on without one. */
export const monitorOn = (p: SubagentProfile): boolean => coordinatorOn(p) && !!p.teams?.monitor.enabled;

/** Teams, closed: the standing roles, then the members default. */
export function teamsSummary(p: SubagentProfile): string {
  const roles = monitorOn(p) ? "Coordinator + monitor" : coordinatorOn(p) ? "Coordinator only" : "No standing roles";
  const members = p.members ? `members on ${model(p.members.model) ?? "a model not chosen yet"}` : "members on the lead's model";
  return `${roles} · ${members}`;
}

/** Spec writer, closed: the writer's model, or who writes the spec without one. */
export function specSummary(p: SubagentProfile): string {
  if (!p.specWriter) return "Off · the session writes it";
  const m = model(p.specWriter.primary.model) ?? "No model chosen";
  return p.specWriter.fallback ? `${m} · 1 fallback` : m;
}

/** Reviewer, closed: the reviewer's model, or that nothing reviews. */
export function reviewerSummary(p: SubagentProfile): string {
  if (!p.reviewer) return "Off · no review";
  const m = model(p.reviewer.primary.model) ?? "No model chosen";
  return p.reviewer.fallback ? `${m} · 1 fallback` : m;
}

/**
 * The coordinator's switch. Off stores no standing roles (`teams: null`, what the old master switch
 * stored). On restores `seed` — the profile's saved roles, else the legacy team defaults — with
 * the coordinator on; a stored shape whose coordinator was off just turns it on.
 */
export function withCoordinator(p: SubagentProfile, on: boolean, seed: TeamsSetting | null): SubagentProfile {
  const next: SubagentProfile = JSON.parse(JSON.stringify(p));
  if (!on) next.teams = null;
  else if (next.teams) next.teams.coordinator.enabled = true;
  else if (seed) {
    next.teams = JSON.parse(JSON.stringify(seed)) as TeamsSetting;
    next.teams.coordinator.enabled = true;
  }
  return next;
}

/** The monitor's switch. Without a coordinator there is nothing to turn on. */
export function withMonitor(p: SubagentProfile, on: boolean): SubagentProfile {
  const next: SubagentProfile = JSON.parse(JSON.stringify(p));
  if (next.teams && next.teams.coordinator.enabled) next.teams.monitor.enabled = on;
  return next;
}

/** A copy of `p` with only `section` kept as it is; every other section is made trivially valid. */
function only(p: SubagentProfile, section: EditorSection): SubagentProfile {
  const x: SubagentProfile = JSON.parse(JSON.stringify(p));
  const ok = { backend: "pi" as const, model: "a/b", effort: "low" };
  if (section !== "delegate") for (const k of Object.keys(x.delegate) as (keyof SubagentProfile["delegate"])[]) x.delegate[k] = { primary: ok, fallback: null };
  if (section !== "teams") {
    x.teams = null;
    x.members = null;
  }
  if (section !== "spec") x.specWriter = null;
  if (section !== "reviewer") delete x.reviewer;
  x.name = "x";
  return x;
}

/**
 * The editor's sections that hold something Save waits for, by the same rule the footer says it
 * (`profilesProblem`), so a section never opens itself for a reason Save doesn't have.
 */
export function sectionProblems(p: SubagentProfile): Set<EditorSection> {
  const out = new Set<EditorSection>();
  for (const s of ["delegate", "teams", "spec", "reviewer"] as const) if (profilesProblem({ version: 1, default: "off", profiles: [only(p, s)] })) out.add(s);
  return out;
}

/** A role's fields need fixing (its role name or worker rows), so they show even while it is off. */
export function roleProblem(p: SubagentProfile, role: "coordinator" | "monitor"): boolean {
  const t = p.teams;
  if (!t) return false;
  const r = t[role];
  const other = t[role === "coordinator" ? "monitor" : "coordinator"];
  const incomplete = (c: { model: string; effort?: string } | null) => !!c && (!c.model || !(c.effort ?? ""));
  const same = !!r.fallback && r.primary.backend === r.fallback.backend && r.primary.model === r.fallback.model && (r.primary.effort ?? "") === (r.fallback.effort ?? "");
  return !r.role.trim() || r.role.length > 64 || /[\r\n]/.test(r.role) || r.role.trim().toLowerCase() === other.role.trim().toLowerCase() || incomplete(r.primary) || incomplete(r.fallback) || same;
}
