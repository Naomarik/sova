// The overview's Organizations card (§chat.transcript/landing-page): totals across every org, and
// the most recently active few as rows.
import type { OrgSummary } from "../../shared/orgs";
import { needsYouCount } from "./org-cards";

/** Rows the card shows before its "View all" link. */
export const OVERVIEW_ORG_ROWS = 5;

export interface OrgsTotals {
  orgs: number;
  people: number;
  projects: number;
  openBatons: number;
  /** Items waiting on the operator, summed over every org (§app.organizations/org-cards). */
  needsYou: number;
}

export interface OrgsGlance {
  totals: OrgsTotals;
  /** At most `cap`, most recently active first. */
  rows: OrgSummary[];
  /** Orgs left out of `rows`. */
  more: number;
}

const activityMs = (o: OrgSummary): number => {
  const ms = o.lastActivityAt ? Date.parse(o.lastActivityAt) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
};

/** Totals, then the rows: newest activity first, orgs with no known activity last, ties in the
    server's order. */
export function orgsGlance(orgs: readonly OrgSummary[], cap = OVERVIEW_ORG_ROWS): OrgsGlance {
  const totals: OrgsTotals = { orgs: orgs.length, people: 0, projects: 0, openBatons: 0, needsYou: 0 };
  for (const o of orgs) {
    totals.people += o.people;
    totals.projects += o.projects;
    totals.openBatons += o.openBatons;
    totals.needsYou += needsYouCount(o.needsYou);
  }
  const sorted = orgs
    .map((o, i) => ({ o, i, at: activityMs(o) }))
    .sort((a, b) => (a.at === b.at ? a.i - b.i : b.at - a.at))
    .map((x) => x.o);
  const rows = sorted.slice(0, Math.max(0, cap));
  return { totals, rows, more: orgs.length - rows.length };
}
