// The words on an organization's card on #/orgs (§app.organizations/org-cards).
import type { OrgNeedsYou } from "../../shared/orgs";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Items waiting on the operator in one org (0 when the server didn't say). */
export const needsYouCount = (n: OrgNeedsYou | undefined): number => (n ? n.replies + n.links + n.proposals + (n.conflicts ?? 0) + (n.stakeholders ?? 0) : 0);

/** What waits, by kind, for the card's Needs-you line: "1 reply · 2 links to send · 1 person to approve ·
    1 conflict to settle".
    "" when nothing does. */
export function needsYouLabel(n: OrgNeedsYou | undefined): string {
  if (!n) return "";
  return [
    n.replies ? `${plural(n.replies, "reply", "replies")}` : "",
    n.links ? `${plural(n.links, "link")} to send` : "",
    n.proposals ? `${plural(n.proposals, "person", "people")} to approve` : "",
    n.conflicts ? `${plural(n.conflicts, "conflict")} to settle` : "",
    n.stakeholders ? `${plural(n.stakeholders, "stakeholder")} to pick` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The card's counts line: "3 people · 1 project · 2 open hand-offs". */
export const orgCountsLine = (o: { people: number; projects: number; openBatons: number }): string =>
  `${plural(o.people, "person", "people")} · ${plural(o.projects, "project")} · ${plural(o.openBatons, "open hand-off")}`;
