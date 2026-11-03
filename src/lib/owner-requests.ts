// The org's Requests tab (§app.project-assistant/requests-tab) and the request card in a chat
// (§app.project-assistant/request-chat): words, the status filter and the grouping. DOM- and
// Solid-free, so it is unit-tested on its own.
import { OWNER_REQUEST_KIND_WORD, OWNER_REQUEST_STATUS_WORD, type OwnerRequest, type OwnerRequestStatus } from "../../shared/project-assistant";

export const KIND_WORD = OWNER_REQUEST_KIND_WORD;
export const STATUS_WORD = OWNER_REQUEST_STATUS_WORD;
/** The status chip's tone: with the team waits on the operator; declined is plain. */
export const STATUS_TONE: Record<OwnerRequestStatus, "warn" | "info" | "success" | undefined> = { "with-team": "warn", started: "info", done: "success", declined: undefined, closed: undefined };

/** A row's status chip word: the owner's close names them ("Closed by Omar", §app.project-assistant/requests-tab). */
export const statusWord = (r: Pick<OwnerRequest, "status">, owner: string): string => (r.status === "closed" ? `Closed by ${owner ? firstName(owner) : "the owner"}` : STATUS_WORD[r.status]);

/** The line under a request the owner closed: when, and whether through their assistant. */
export const closedLine = (r: Pick<OwnerRequest, "closed">, owner: string, ago: string): string | null =>
  r.closed ? (r.closed.by.kind === "assistant" ? `Closed ${ago} · through the Project Assistant` : `Closed ${ago} · by ${owner ? firstName(owner) : "the owner"}`) : null;

/** Got It shows on a request the owner closed while it was being worked on, until pressed (its Needs you item). */
export const needsGotIt = (r: Pick<OwnerRequest, "status" | "closed">): boolean => r.status === "closed" && r.closed?.prior === "started" && !r.closed.noted;

export type RequestFilter = "open" | "done" | "declined" | "closed" | "all";
export const REQUEST_FILTERS: readonly { id: RequestFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "done", label: "Done" },
  { id: "declined", label: "Declined" },
  { id: "closed", label: "Closed by Owner" },
  { id: "all", label: "All" },
];

export const isOpenRequest = (r: Pick<OwnerRequest, "status">): boolean => r.status === "with-team" || r.status === "started";

/** Whether a request is under a filter. */
export function underFilter(r: Pick<OwnerRequest, "status">, f: RequestFilter): boolean {
  if (f === "all") return true;
  if (f === "open") return isOpenRequest(r);
  return r.status === f;
}

/** The filter that shows a request: the one asked for when it is under it, else its own status's. */
export const filterShowing = (r: Pick<OwnerRequest, "status">, asked: RequestFilter): RequestFilter =>
  underFilter(r, asked) ? asked : isOpenRequest(r) ? "open" : (r.status as RequestFilter);

export function filterCounts(rs: readonly Pick<OwnerRequest, "status">[]): Record<RequestFilter, number> {
  const out: Record<RequestFilter, number> = { open: 0, done: 0, declined: 0, closed: 0, all: rs.length };
  for (const r of rs) {
    if (isOpenRequest(r)) out.open++;
    else if (r.status === "done") out.done++;
    else if (r.status === "declined") out.declined++;
    else if (r.status === "closed") out.closed++;
  }
  return out;
}

export interface RequestGroup {
  projectId: string;
  name: string;
  rows: OwnerRequest[];
}

/** The rows under a filter, grouped under their project's name, newest first in each group; the
    group with the newest request comes first. */
export function groupRequests(rs: readonly OwnerRequest[], f: RequestFilter, projects: readonly { projectId: string; name: string }[]): RequestGroup[] {
  const at = (r: OwnerRequest) => Date.parse(r.createdAt) || 0;
  const rows = rs.filter((r) => underFilter(r, f)).sort((a, b) => at(b) - at(a));
  const groups = new Map<string, RequestGroup>();
  for (const r of rows) {
    let g = groups.get(r.projectId);
    if (!g) groups.set(r.projectId, (g = { projectId: r.projectId, name: projects.find((p) => p.projectId === r.projectId)?.name ?? "A project", rows: [] }));
    g.rows.push(r);
  }
  return [...groups.values()];
}

/** The owner's first name ("Omar" of "Omar Haddad"). */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the panel says when nothing is under the filter: a live fact, then the absence. */
export function emptyLine(rs: readonly Pick<OwnerRequest, "status">[], f: RequestFilter, owner: string): string {
  const c = filterCounts(rs);
  const who = owner ? firstName(owner) : "the owner";
  switch (f) {
    case "open":
      return `${c.done} done. Nothing open from ${who} right now.`;
    case "done":
      return `${plural(c.open, "open request")}. None marked done yet.`;
    case "declined":
      return `${plural(c.open, "open request")}. None declined.`;
    case "closed":
      return `${plural(c.open, "open request")}. ${who} hasn't closed any.`;
    case "all":
      return `Nothing from ${who} yet. What they ask for through their Project Assistant lands here.`;
  }
}

/** The Owner card's link line: "3 open requests from Omar". */
export const openRequestsLine = (open: number, owner: string): string => `${plural(open, "open request")} from ${firstName(owner)}`;
