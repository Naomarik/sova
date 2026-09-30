// The sidebar's Organizations region (§app.session-list/organizations): every organizational session
// (`SessionSummary.org`), and only here. Last before the Archive: its own Needs you list first, then
// org → project, each project's rows in groups — Conversations and Conflicts to settle (Not started /
// In progress / Done) and Builds (active / Done). A project's current overseer is not a row but the
// eye on its heading; its cleared conversations are in no region (its History).
//
// Pure on purpose, like `needs-you` and `group-open`: the grouping, order, counts, forced-open rules
// and aggregates run under tsx --test, and the sidebar keeps the (sessionStorage / memory) state.
// Which group and state a row is in is decided in `rowGroup` and `orgRowState` alone.

import type { AttentionDigest, AttentionItem, SessionSummary } from "../../shared/protocol";
import { needsYouRows, type NeedsYouRow } from "./needs-you";
import { byRecentActivity } from "./recent";
import { isOrgSession } from "./regions";
import { rowLeadMark } from "./signals";

/** Open by default; a collapse is remembered for the tab (the Needs-you pattern). */
export const ORGS_KEY = "sova:orgs-open";

/** A row's state: people conversations use all three; a build is in progress (running or waiting) or done. */
export type OrgRowState = "not-started" | "in-progress" | "done";

/** A group split by state, each list newest activity first. */
export interface StateSplit {
  notStarted: SessionSummary[];
  inProgress: SessionSummary[];
  done: SessionSummary[];
}

/** One project inside an org: its overseer (the heading's eye), then its groups. */
export interface OrgProject {
  /** `projectId`, or "" for workspace files that belong to no project. */
  id: string;
  name: string;
  /** The current project overseer, drawn as the eye on the heading, never as a row. */
  overseer: SessionSummary | null;
  /** Gathering sessions and offers sent to people (not settle sessions). */
  conversations: StateSplit;
  /** Settle sessions: a conflict's baton session, whoever started it. */
  conflicts: StateSplit;
  /** Coding sessions the project started: running or waiting, then Done (merged per git, or archived). */
  builds: { active: SessionSummary[]; done: SessionSummary[] };
  /** Rows in no group: a workspace file no project claims, a second "current" overseer. */
  other: SessionSummary[];
}

export interface OrgSection {
  id: string;
  name: string;
  projects: OrgProject[];
}

/** What a project with no name on the wire is called: gone from its org's project list, or no project at all. */
export const UNKNOWN_PROJECT = "Unknown project";
export const NO_PROJECT = "Other";

/** Done: a baton done or closed, a build merged per git (all `org.finished`), or one the operator archived. */
export const orgDone = (s: Pick<SessionSummary, "org" | "archived">): boolean => !!s.org?.finished || s.archived === true;

/** A project overseer's conversation that isn't the current one: its History opens it, no region lists it. */
export const isClearedOverseer = (s: Pick<SessionSummary, "org">): boolean => s.org?.kind === "overseer" && !!s.org.finished;

/** The project's current overseer (archived or not): the eye on its heading. */
const isCurrentOverseer = (s: Pick<SessionSummary, "org">): boolean => s.org?.kind === "overseer" && !s.org.finished;

/** What the region holds: every org session but a cleared overseer conversation. */
export const inOrgRegion = (s: Pick<SessionSummary, "org">): boolean => !!s.org && !isClearedOverseer(s);

/** A session of an archived project (§app.organizations/archive): in no org → project list, no
    heading, no eye, not counted; only the region's own Needs you still shows it while it waits. */
export const inArchivedProject = (s: Pick<SessionSummary, "org">): boolean => !!s.org?.projectArchived;

/** Which of a project's groups a row goes in. */
export function rowGroup(s: Pick<SessionSummary, "org" | "baton">): "conversations" | "conflicts" | "builds" | "other" {
  const k = s.org?.kind;
  if (k === "gathering" || k === "offer") return s.baton?.settle ? "conflicts" : "conversations";
  if (k === "coding") return "builds";
  return "other";
}

/** Not started until someone it was sent to has written (an opened link doesn't count); then In progress; Done. A build is never Not started. */
export function orgRowState(s: Pick<SessionSummary, "org" | "archived" | "baton">): OrgRowState {
  if (orgDone(s)) return "done";
  if (s.org?.kind === "coding") return "in-progress";
  return s.baton?.written ? "in-progress" : "not-started";
}

/** A Not started row's hint: why nobody has written yet. None while the operator holds it (Needs you says it). */
function notStartedHint(s: Pick<SessionSummary, "baton">): string | null {
  const b = s.baton;
  if (!b || b.state === "needs-you") return null;
  if (b.opened) return "Opened, no reply yet";
  return b.linkAt ? "Not opened yet" : "Link not sent yet";
}

/** A project row's line 2 in place of its gist: a settle session names its conflict; a Not started row says why. */
export function rowLine(s: Pick<SessionSummary, "org" | "archived" | "baton">): string | null {
  const hint = orgRowState(s) === "not-started" ? notStartedHint(s) : null;
  const area = s.baton?.settle?.area;
  if (area) return hint ? `In conflict: ${area} · ${hint}` : `In conflict: ${area}`;
  return hint;
}

const emptySplit = (): StateSplit => ({ notStarted: [], inProgress: [], done: [] });
const SPLIT_KEY: Record<OrgRowState, keyof StateSplit> = { "not-started": "notStarted", "in-progress": "inProgress", done: "done" };
const sortSplit = (x: StateSplit): StateSplit => ({ notStarted: x.notStarted.sort(byRecentActivity), inProgress: x.inProgress.sort(byRecentActivity), done: x.done.sort(byRecentActivity) });

/** A split's rows, in state order. */
export const splitRows = (x: StateSplit): SessionSummary[] => [...x.notStarted, ...x.inProgress, ...x.done];
export const splitCount = (x: StateSplit): number => x.notStarted.length + x.inProgress.length + x.done.length;

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Org sessions of `sessions` into org → project → groups. Orgs and projects by name (ties on id), so
 * the containers stay put between polls; "Other" (no project) goes last.
 */
export function orgSections(sessions: readonly SessionSummary[]): OrgSection[] {
  const orgs = new Map<string, { id: string; name: string; projects: Map<string, OrgProject> }>();
  for (const s of sessions) {
    const o = s.org;
    if (!o || !inOrgRegion(s) || inArchivedProject(s)) continue;
    let org = orgs.get(o.orgId);
    if (!org) orgs.set(o.orgId, (org = { id: o.orgId, name: o.orgName || o.orgId, projects: new Map() }));
    // A later row may carry the name an earlier one lacked.
    if (o.orgName && org.name === o.orgId) org.name = o.orgName;
    const pid = o.projectId ?? "";
    let p = org.projects.get(pid);
    if (!p)
      org.projects.set(
        pid,
        (p = { id: pid, name: pid ? o.projectName || UNKNOWN_PROJECT : NO_PROJECT, overseer: null, conversations: emptySplit(), conflicts: emptySplit(), builds: { active: [], done: [] }, other: [] }),
      );
    if (o.projectName && p.name === UNKNOWN_PROJECT) p.name = o.projectName;
    if (isCurrentOverseer(s)) {
      // Only one is current; should the list ever carry two, the newest is the eye and the other stays a row.
      const [eye, row] = !p.overseer ? [s, null] : byRecentActivity(s, p.overseer) < 0 ? [s, p.overseer] : [p.overseer, s];
      p.overseer = eye;
      if (row) p.other.push(row);
      continue;
    }
    const g = rowGroup(s);
    if (g === "builds") (orgDone(s) ? p.builds.done : p.builds.active).push(s);
    else if (g === "other") p.other.push(s);
    else p[g][SPLIT_KEY[orgRowState(s)]].push(s);
  }
  return [...orgs.values()]
    .map((org) => ({
      id: org.id,
      name: org.name,
      projects: [...org.projects.values()]
        .map((p) => ({
          ...p,
          conversations: sortSplit(p.conversations),
          conflicts: sortSplit(p.conflicts),
          builds: { active: p.builds.active.sort(byRecentActivity), done: p.builds.done.sort(byRecentActivity) },
          other: p.other.sort(byRecentActivity),
        }))
        .sort((a, b) => Number(a.id === "") - Number(b.id === "") || byName(a, b)),
    }))
    .sort(byName);
}

/** Every row a project draws, in group order. The eye is not a row. */
export const projectRows = (p: OrgProject): SessionSummary[] => [...splitRows(p.conversations), ...splitRows(p.conflicts), ...p.builds.active, ...p.builds.done, ...p.other];
/** Every row a section, project or the region holds, Done included. */
export const projectCount = (p: OrgProject): number => projectRows(p).length;
export const orgCount = (o: OrgSection): number => o.projects.reduce((n, p) => n + projectCount(p), 0);
export const regionCount = (orgs: readonly OrgSection[]): number => orgs.reduce((n, o) => n + orgCount(o), 0);
/** Every session a section holds, its overseers included: what forces it open, and its working dot. */
export const orgRows = (o: OrgSection): SessionSummary[] => o.projects.flatMap((p) => [...(p.overseer ? [p.overseer] : []), ...projectRows(p)]);

/**
 * The eye's one mark, from the list alone: working (Busy), else a failed last turn, else a new reply.
 * While its conversation is open it is `current`, and the last two go (you're looking at it), as a row's do.
 */
export function overseerEye(
  s: Pick<SessionSummary, "path" | "turnError" | "unread">,
  input: { selected: string | null; busy: boolean },
): { mark: "working" | "error" | "unread" | null; current: boolean } {
  const current = s.path === input.selected;
  const lead = rowLeadMark(s, input.selected);
  return { mark: input.busy ? "working" : lead, current };
}

const EYE_CLAUSE = { working: " · working", error: " · last turn failed", unread: " · new reply" } as const;

/** The eye's name and title: "Open the {project} overseer", and its mark in words. */
export const eyeLabel = (project: string, mark: ReturnType<typeof overseerEye>["mark"]): string =>
  `Open the ${project} overseer${mark ? EYE_CLAUSE[mark] : ""}`;

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
    if (listed.has(s.path) || orgDone(s)) continue;
    const w = batonWaitDetail(s);
    if (w) rows.push({ session: s, detail: w.text, details: [w.text], since: w.since });
  }
  return rows.sort((a, b) => b.since - a.since || a.session.path.localeCompare(b.session.path));
}

/** The digest kinds that are a project's, not a session's: each opens its project page (a message not sent, the person's). */
const PROJECT_KINDS: ReadonlySet<AttentionItem["kind"]> = new Set(["held-act", "conflict-to-operator", "project-stakeholder", "outreach-not-sent"]);

/**
 * The region's Needs you items that belong to no session: an act waiting in a hold before it
 * reaches a person or the code (§app.project-overseer/holds), a conflict for the operator to settle
 * that no session asks about (§app.requirements/routing), a project whose main stakeholder left
 * (§app.organizations/stakeholder), an overseer's WhatsApp message that was not sent (§app.outreach/send).
 * Each opens its project page (the last, the person's page) and says the digest's own sentence.
 * A search keeps only those whose project or org name matches. Held acts first, the one going
 * ahead soonest on top (they can't wait); then the rest newest first.
 */
export function orgProjectItems(digest: Pick<AttentionDigest, "items"> | undefined, query = ""): AttentionItem[] {
  const q = query.trim().toLowerCase();
  const goesAt = (it: AttentionItem) => (it.kind === "held-act" ? (it.held?.goesAt ?? Number.MAX_SAFE_INTEGER) : null);
  return (digest?.items ?? [])
    .filter((it) => PROJECT_KINDS.has(it.kind) && (!q || `${it.title} ${it.where}`.toLowerCase().includes(q)))
    .sort((a, b) => {
      const ga = goesAt(a);
      const gb = goesAt(b);
      if (ga !== null || gb !== null) return ga === null ? 1 : gb === null ? -1 : ga - gb || a.id.localeCompare(b.id);
      return b.since - a.since || a.id.localeCompare(b.id);
    });
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
  s.org ? [s.org.orgName, s.org.projectName ?? "", s.baton?.holder ?? "", s.baton?.offer?.holder ?? "", s.baton?.settle?.area ?? ""].join(" ") : "";

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

/** A group's Done tail: collapsed by default (memory only), forced open by a search or the open session inside. */
export const doneOpen = (input: { chosen: boolean | undefined; searching: boolean; holdsSelected: boolean }): boolean =>
  input.searching || input.holdsSelected || (input.chosen ?? false);

/** The org head's title: its count, and who is waiting. */
export const orgTitle = (name: string, n: number, waiting: number): string =>
  `${n} ${n === 1 ? "session" : "sessions"} in ${name}.${waiting > 0 ? ` ${waiting} waiting on you.` : ""}`;
