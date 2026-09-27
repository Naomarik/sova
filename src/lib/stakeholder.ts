// A project's main stakeholder on its page (§app.organizations/projects): who it is, who may be
// picked, the one person the page suggests, and why a cleared one is gone. Pure, so the rules run
// under tsx --test.

import type { OrgProject, Person } from "../../shared/orgs";

export interface StakeholderView {
  /** The stakeholder in force: set, and still an active person on the roster. */
  current: Person | null;
  /** Who the select offers: the active people, by name. */
  options: Person[];
  /** No stakeholder, and exactly one active person: the page suggests them (the operator confirms). */
  suggestion: Person | null;
  /** The stakeholder left the org, so the project has none (until the operator picks again). */
  cleared: { name: string; at: string } | null;
  /** The newest change, for the line under the select: the operator's, or a leaving (with who left). */
  latest: { why: "operator"; at: string } | { why: "left"; at: string; name: string } | null;
}

export function stakeholderView(project: Pick<OrgProject, "stakeholder" | "stakeholderCleared" | "stakeholderHistory">, roster: readonly Person[]): StakeholderView {
  const options = roster.filter((p) => p.status === "active").sort((a, b) => a.name.localeCompare(b.name));
  const current = (project.stakeholder && options.find((p) => p.id === project.stakeholder)) || null;
  const cleared = !current && project.stakeholderCleared ? { name: project.stakeholderCleared.name, at: project.stakeholderCleared.at } : null;
  const last = project.stakeholderHistory?.at(-1);
  const latest: StakeholderView["latest"] = !last
    ? null
    : last.why === "left"
      ? { why: "left", at: last.at, name: roster.find((p) => p.id === last.from)?.name ?? project.stakeholderCleared?.name ?? last.from ?? "" }
      : { why: "operator", at: last.at };
  return { current, options, cleared, latest, suggestion: !current && options.length === 1 ? options[0]! : null };
}
