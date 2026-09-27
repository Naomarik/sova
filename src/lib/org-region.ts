// The sidebar's Organizations region (§app.session-list/organizations): every organizational session
// (`SessionSummary.org`), and only here. Last before the Archive: its own Needs you list first, then
// org → project → rows, each project with a collapsed Finished tail.
//
// Pure on purpose, like `needs-you` and `group-open`: the grouping, order, counts, forced-open rules
// and aggregates run under tsx --test, and the sidebar keeps the (sessionStorage / memory) state.

import type { AttentionDigest, AttentionItem, SessionSummary } from "../../shared/protocol";
import { needsYouRows, type NeedsYouRow } from "./needs-you";
import { byRecentActivity } from "./recent";
import { isOrgSession } from "./regions";

/** Open by default; a collapse is remembered for the tab (the Needs-you pattern). */
export const ORGS_KEY = "sova:orgs-open";

/** One project inside an org: live rows, and the Finished tail. */
export interface OrgProject {
  /** `projectId`, or "" for workspace files that belong to no project. */
  id: string;
  name: string;
  active: SessionSummary[];
  finished: SessionSummary[];
}

export interface OrgSection {
  id: string;
  name: string;
  projects: OrgProject[];
}

/** What a project with no name on the wire is called: gone from projects.json, or no project at all. */
export const UNKNOWN_PROJECT = "Unknown project";
export const NO_PROJECT = "Other";

/** Finished: a baton that reached its goal or was closed, a cleared overseer conversation, or one the operator archived. */
export const orgFinished = (s: Pick<SessionSummary, "org" | "archived">): boolean => !!s.org?.finished || s.archived === true;

/** The project's hub: its current project overseer, pinned first. */
const isCurrentOverseer = (s: Pick<SessionSummary, "org" | "archived">): boolean => s.org?.kind === "overseer" && !orgFinished(s);

/** Inside a project: the current overseer first, then by activity (who replied), newest first. */
export const byOrgRow = (a: SessionSummary, b: SessionSummary): number =>
  Number(isCurrentOverseer(b)) - Number(isCurrentOverseer(a)) || byRecentActivity(a, b);

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Org sessions of `sessions` into org → project → {active, finished}. Orgs and projects by name
 * (ties on id), so the containers stay put between polls; "Other" (no project) goes last.
 */
export function orgSections(sessions: readonly SessionSummary[]): OrgSection[] {
  const orgs = new Map<string, { id: string; name: string; projects: Map<string, OrgProject> }>();
  for (const s of sessions) {
    const o = s.org;
    if (!o) continue;
    let org = orgs.get(o.orgId);
    if (!org) orgs.set(o.orgId, (org = { id: o.orgId, name: o.orgName || o.orgId, projects: new Map() }));
    // A later row may carry the name an earlier one lacked.
    if (o.orgName && org.name === o.orgId) org.name = o.orgName;
    const pid = o.projectId ?? "";
    let p = org.projects.get(pid);
    if (!p) org.projects.set(pid, (p = { id: pid, name: pid ? o.projectName || UNKNOWN_PROJECT : NO_PROJECT, active: [], finished: [] }));
    if (o.projectName && p.name === UNKNOWN_PROJECT) p.name = o.projectName;
    (orgFinished(s) ? p.finished : p.active).push(s);
  }
  return [...orgs.values()]
    .map((org) => ({
      id: org.id,
      name: org.name,
      projects: [...org.projects.values()]
        .map((p) => ({ ...p, active: p.active.sort(byOrgRow), finished: p.finished.sort(byRecentActivity) }))
        .sort((a, b) => Number(a.id === "") - Number(b.id === "") || byName(a, b)),
    }))
    .sort(byName);
}

/** Every row a section, project or the region holds, Finished included. */
export const projectCount = (p: OrgProject): number => p.active.length + p.finished.length;
export const orgCount = (o: OrgSection): number => o.projects.reduce((n, p) => n + projectCount(p), 0);
export const orgRows = (o: OrgSection): SessionSummary[] => o.projects.flatMap((p) => [...p.active, ...p.finished]);

/**
 * What a person is waiting on the operator for, straight from the baton field (the same kinds the
 * org card counts): so the region's Needs you never depends on the digest's 30-item cap or on the
 * Overseer's proactivity. Sentences match the digest's (server/attention.ts).
 */
export function batonWaitDetail(s: Pick<SessionSummary, "baton">): { text: string; since: number } | null {
  const b = s.baton;
  if (!b) return null;
  if (b.needsYou) return { text: `${b.needsYou.from} → you: ${b.needsYou.question}`, since: b.needsYou.since || 0 };
  if (b.sendLink) return { text: `Send ${b.sendLink.to} their link: ${b.sendLink.question}`, since: b.sendLink.since };
  const p = b.proposals?.[0];
  if (p) return { text: `Approve ${p.name}${p.role ? ` (${p.role})` : ""}${p.by ? ` proposed by ${p.by}` : ""}?`, since: p.since };
  return null;
}

/**
 * The region's own Needs you: every org session waiting on the operator. The digest's act items
 * (a dialog, an errored turn, a question) joined to the org hits, plus any baton wait the digest
 * didn't carry. Newest first, like the global list.
 */
export function orgNeedsYouRows(digest: Pick<AttentionDigest, "items"> | undefined, sessions: readonly SessionSummary[]): NeedsYouRow[] {
  const org = sessions.filter(isOrgSession);
  const rows = needsYouRows(digest, org);
  const listed = new Set(rows.map((r) => r.session.path));
  for (const s of org) {
    if (listed.has(s.path) || orgFinished(s)) continue;
    const w = batonWaitDetail(s);
    if (w) rows.push({ session: s, detail: w.text, details: [w.text], since: w.since });
  }
  return rows.sort((a, b) => b.since - a.since || a.session.path.localeCompare(b.session.path));
}

/**
 * The region's Needs you items that belong to no session: a project whose main stakeholder left
 * (§app.organizations/stakeholder). Each opens its project page and says the digest's own sentence.
 * A search keeps only those whose project or org name matches. Newest first.
 */
export function orgProjectItems(digest: Pick<AttentionDigest, "items"> | undefined, query = ""): AttentionItem[] {
  const q = query.trim().toLowerCase();
  return (digest?.items ?? [])
    .filter((it) => it.kind === "project-stakeholder" && (!q || `${it.title} ${it.where}`.toLowerCase().includes(q)))
    .sort((a, b) => b.since - a.since || a.id.localeCompare(b.id));
}

/** A row's place, said under the region's Needs you rows: "{org} · {project}". */
export const orgPlaceLabel = (s: Pick<SessionSummary, "org">): string => {
  const o = s.org;
  if (!o) return "";
  const project = o.projectId ? o.projectName || UNKNOWN_PROJECT : null;
  return project ? `${o.orgName || o.orgId} · ${project}` : o.orgName || o.orgId;
};

/** The extra text search matches on an org row: its org, its project and the baton holder. */
export const orgSearchText = (s: Pick<SessionSummary, "org" | "baton">): string =>
  s.org ? [s.org.orgName, s.org.projectName ?? "", s.baton?.holder ?? "", s.baton?.offer?.holder ?? ""].join(" ") : "";

/** The stored choice: only "0" (the user collapsed it) closes the region. */
export const storedOrgsOpen = (raw: string | null): boolean => raw !== "0";

/**
 * Whether the region is open: forced open (the stored choice left alone) while searching and while
 * the open session is inside it. Otherwise the tab's choice.
 */
export const orgsRegionOpen = (input: { stored: boolean; searching: boolean; holdsSelected: boolean }): boolean =>
  input.searching || input.holdsSelected || input.stored;

/** An org section: open by default (memory only), forced open by a search or the open session inside. */
export const orgSectionOpen = (input: { chosen: boolean | undefined; searching: boolean; holdsSelected: boolean }): boolean =>
  input.searching || input.holdsSelected || (input.chosen ?? true);

/** A Finished tail: collapsed by default (memory only), forced open by a search or the open session inside. */
export const finishedOpen = (input: { chosen: boolean | undefined; searching: boolean; holdsSelected: boolean }): boolean =>
  input.searching || input.holdsSelected || (input.chosen ?? false);

/** The org head's title: its count, and who is waiting. */
export const orgTitle = (name: string, n: number, waiting: number): string =>
  `${n} ${n === 1 ? "session" : "sessions"} in ${name}.${waiting > 0 ? ` ${waiting} waiting on you.` : ""}`;
