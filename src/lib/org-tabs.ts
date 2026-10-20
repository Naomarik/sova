// The tabs of an organization's page (§app.organizations/org-page): each tab's count, and how many
// things inside it wait on the operator (its Needs-you dot).
import type { OrgDetail, OrgProject } from "../../shared/orgs";
import type { OrgTab } from "./orgs-route";

export interface OrgTabInfo {
  id: OrgTab;
  label: string;
  /** Shown after the label; null = no count (History and Settings have nothing to count). */
  count: number | null;
  /** Things in this tab that wait on the operator; > 0 shows the dot. */
  waiting: number;
  /** The dot's words for a screen reader and the tooltip, "" when none. */
  waitingText: string;
}

type TabSource = Pick<OrgDetail, "batons" | "roster" | "projectList" | "problems" | "git" | "projectConflicts"> & Partial<Pick<OrgDetail, "needsYou" | "owner" | "ownerRequests">>;

/** The Requests tab shows while the org has an owner or any owner request (an older server's org,
    with no request counts, by its owner alone; §app.project-assistant/requests-tab). */
export const hasRequestsTab = (o: Partial<Pick<OrgDetail, "owner" | "ownerRequests">>): boolean => !!o.owner || (o.ownerRequests?.total ?? 0) > 0;

/** A project whose main stakeholder left the org and has none now: the operator picks a new one. */
export const stakeholderToPick = (p: Pick<OrgProject, "stakeholder" | "stakeholderCleared">): boolean => !!p.stakeholderCleared && !p.stakeholder;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function orgTabsOf(o: TabSource): OrgTabInfo[] {
  const replies = o.batons.filter((b) => b.waiting === "reply").length;
  const links = o.batons.filter((b) => b.waiting === "link").length;
  const proposed = o.roster.filter((p) => p.status === "proposed").length;
  const conflicts = Object.values(o.projectConflicts ?? {}).reduce((a, n) => a + n, 0);
  const stakeholders = o.projectList.filter(stakeholderToPick).length;
  // Acts waiting in a hold before they reach a person or the code (§app.project-overseer/holds).
  const held = o.needsYou?.held ?? 0;
  const repo = o.problems.length + (o.git.lastError ? 1 : 0);
  // Owner requests still with the team: the same ones Needs you raises (none while the org has no owner).
  const toAnswer = o.needsYou?.requests ?? 0;
  const words = (parts: string[]) => parts.filter(Boolean).join(" · ");
  const tabs: OrgTabInfo[] = [
    {
      id: "projects",
      label: "Projects",
      // Archived projects are not counted (§app.organizations/archive).
      count: o.projectList.filter((p) => !p.archived).length,
      waiting: conflicts + stakeholders + held,
      waitingText: words([
        conflicts ? `${plural(conflicts, "conflict")} to settle` : "",
        stakeholders ? `${plural(stakeholders, "stakeholder")} to pick` : "",
        held ? plural(held, "held act") : "",
      ]),
    },
    {
      id: "sessions",
      label: "Sessions",
      count: o.batons.length,
      waiting: replies + links,
      waitingText: words([replies ? `${replies} to answer` : "", links ? `${plural(links, "link")} to send` : ""]),
    },
    { id: "requests", label: "Requests", count: o.ownerRequests?.open ?? 0, waiting: toAnswer, waitingText: toAnswer ? `${toAnswer} to answer` : "" },
    { id: "people", label: "People", count: o.roster.length, waiting: proposed, waitingText: proposed ? `${plural(proposed, "person", "people")} to approve` : "" },
    // An open-ended record, not a list size: no count, and nothing in it waits.
    { id: "history", label: "History", count: null, waiting: 0, waitingText: "" },
    // The org's own settings (About, Company hours, the workspace repo): nothing to count; the
    // repo's file problems and a failed commit or push are its dot.
    {
      id: "settings",
      label: "Settings",
      count: null,
      waiting: repo,
      waitingText: words([o.problems.length ? `${plural(o.problems.length, "file problem")}` : "", o.git.lastError ? "the last commit or push failed" : ""]),
    },
  ];
  return hasRequestsTab(o) ? tabs : tabs.filter((t) => t.id !== "requests");
}
