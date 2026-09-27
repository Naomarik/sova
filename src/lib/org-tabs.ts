// The tabs of an organization's page (§app.organizations/org-page): each tab's count, and how many
// things inside it wait on the operator (its Needs-you dot).
import type { OrgDetail, OrgProject } from "../../shared/orgs";
import type { OrgTab } from "./orgs-route";

export interface OrgTabInfo {
  id: OrgTab;
  label: string;
  /** Shown after the label; null = no count (Workspace has nothing to count). */
  count: number | null;
  /** Things in this tab that wait on the operator; > 0 shows the dot. */
  waiting: number;
  /** The dot's words for a screen reader and the tooltip, "" when none. */
  waitingText: string;
}

type TabSource = Pick<OrgDetail, "batons" | "roster" | "projectList" | "problems" | "git" | "projectConflicts">;

/** A project whose main stakeholder left the org and has none now: the operator picks a new one. */
export const stakeholderToPick = (p: Pick<OrgProject, "stakeholder" | "stakeholderCleared">): boolean => !!p.stakeholderCleared && !p.stakeholder;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function orgTabsOf(o: TabSource): OrgTabInfo[] {
  const replies = o.batons.filter((b) => b.waiting === "reply").length;
  const links = o.batons.filter((b) => b.waiting === "link").length;
  const proposed = o.roster.filter((p) => p.status === "proposed").length;
  const conflicts = Object.values(o.projectConflicts ?? {}).reduce((a, n) => a + n, 0);
  const stakeholders = o.projectList.filter(stakeholderToPick).length;
  const repo = o.problems.length + (o.git.lastError ? 1 : 0);
  const words = (parts: string[]) => parts.filter(Boolean).join(" · ");
  return [
    {
      id: "sessions",
      label: "Sessions",
      count: o.batons.length,
      waiting: replies + links,
      waitingText: words([replies ? `${replies} to answer` : "", links ? `${plural(links, "link")} to send` : ""]),
    },
    { id: "people", label: "People", count: o.roster.length, waiting: proposed, waitingText: proposed ? `${plural(proposed, "person", "people")} to approve` : "" },
    {
      id: "projects",
      label: "Projects",
      count: o.projectList.length,
      waiting: conflicts + stakeholders,
      waitingText: words([conflicts ? `${plural(conflicts, "conflict")} to settle` : "", stakeholders ? `${plural(stakeholders, "stakeholder")} to pick` : ""]),
    },
    {
      id: "workspace",
      label: "Workspace",
      count: null,
      waiting: repo,
      waitingText: words([o.problems.length ? `${plural(o.problems.length, "file problem")}` : "", o.git.lastError ? "the last commit or push failed" : ""]),
    },
  ];
}
