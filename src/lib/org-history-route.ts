// The History tab's address: `#/orgs/<id>/history` is the timeline,
// `#/orgs/<id>/history/events/<event id>` selects one event, and the filters ride in the hash's
// query beside `host=`, so Back restores the previous filter and a link opens the same view. A
// value this version can't read is dropped, never guessed. Pure: no DOM, no Solid.
import { HISTORY_KINDS, INITIATIONS, type HistoryKind, type HistoryQuery, type Initiation } from "../../shared/org-history";

const ID_RE = /^[A-Za-z0-9_-]+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** An actor key (shared/org-history `HistoryQuery.actors`): a bare kind, or a kind and its id. */
const ACTOR_RE = /^(operator|global-overseer|model|sova|statechart|system|person:[A-Za-z0-9_-]+|project-overseer:[A-Za-z0-9_-]+)$/;

/** The Kind filter's groups: one word per family of kinds, so the bar stays short. */
export const KIND_GROUPS = {
  requests: ["request.made", "look.started"],
  gaps: ["gap.filed", "gap.planned", "gap.closed"],
  gatherings: ["gathering.started", "gathering.handed-off", "gathering.offered", "gathering.closed"],
  decisions: ["decision.recorded", "decision.superseded", "conflict.opened", "conflict.settled"],
  holds: ["hold.created", "hold.released", "hold.cancelled", "act.refused", "stop.made"],
  delivery: ["promotion.made", "build.started", "build.prompted", "build.finished", "merge.requested", "merge.observed", "test.observed", "validation.observed", "preview.started", "preview.made"],
  people: ["outreach.sent", "owner-update.posted", "owner-update.removed", "project.placed", "project.archived", "project.unarchived", "person.added", "person.status-changed", "setting.changed"],
  history: ["annotation.added", "correction.recorded", "rationale.purged", "history.gap", "history.imported"],
} as const satisfies Record<string, readonly HistoryKind[]>;
export type KindGroup = keyof typeof KIND_GROUPS;
export const KIND_GROUP_IDS = Object.keys(KIND_GROUPS) as KindGroup[];


export interface HistoryFilters {
  /** Project ids, any of them (archived ones too); empty = all projects. */
  projects: string[];
  kind?: KindGroup;
  initiation?: Initiation;
  actor?: string;
  /** Local days, inclusive (`YYYY-MM-DD`). */
  from?: string;
  to?: string;
  /** Literal words (no model). */
  q?: string;
}

export interface HistoryView {
  filters: HistoryFilters;
  /** The selected event. */
  event?: string;
  /** Causal View instead of the timeline. */
  chain?: boolean;
  /** How many times the Causal View was expanded past its first bound (1–50), so Back and a link read it as far. */
  more?: number;
}

export const emptyFilters = (): HistoryFilters => ({ projects: [] });

const isDay = (s: string): boolean => DAY_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00`));

/** The history view a path tail and query name, or null when the tail isn't one (`""` or `/events/<id>`). */
export function historyViewOf(tail: string, params: URLSearchParams): HistoryView | null {
  let event: string | undefined;
  if (tail !== "" && tail !== "/") {
    const m = /^\/events\/([^/]+)\/?$/.exec(tail);
    if (!m || !ID_RE.test(m[1]!)) return null;
    event = m[1]!;
  }
  const filters = emptyFilters();
  const projects = params.get("project");
  if (projects) filters.projects = [...new Set(projects.split(",").filter((p) => ID_RE.test(p)))];
  const kind = params.get("kind");
  if (kind && (KIND_GROUP_IDS as string[]).includes(kind)) filters.kind = kind as KindGroup;
  const init = params.get("initiation");
  if (init && (INITIATIONS as readonly string[]).includes(init)) filters.initiation = init as Initiation;
  const actor = params.get("actor");
  if (actor && ACTOR_RE.test(actor)) filters.actor = actor;
  const from = params.get("from");
  if (from && isDay(from)) filters.from = from;
  const to = params.get("to");
  if (to && isDay(to)) filters.to = to;
  const q = params.get("q")?.trim();
  if (q) filters.q = q.slice(0, 200);
  const chain = params.get("view") === "chain";
  const more = /^[1-9]\d?$/.test(params.get("more") ?? "") ? Number(params.get("more")) : 0;
  return { filters, ...(event ? { event } : {}), ...(chain ? { chain: true } : {}), ...(chain && more && more <= 50 ? { more } : {}) };
}

/** The query part (no `?`), in one fixed order, so one view has one address. Empty filters: "". */
export function historyQueryOf(v: HistoryView): string {
  const f = v.filters;
  const parts: string[] = [];
  const put = (k: string, val: string | undefined) => val && parts.push(`${k}=${encodeURIComponent(val)}`);
  // Ids are plain characters: the comma stays readable.
  if (f.projects.length) parts.push(`project=${f.projects.join(",")}`);
  put("kind", f.kind);
  put("initiation", f.initiation);
  put("actor", f.actor);
  put("from", f.from);
  put("to", f.to);
  put("q", f.q);
  if (v.chain) parts.push("view=chain");
  if (v.chain && v.more) parts.push(`more=${v.more}`);
  return parts.join("&");
}

/** The path tail after `/history`. */
export const historyTailOf = (v: Pick<HistoryView, "event">): string => (v.event ? `/events/${v.event}` : "");

/** One scalar per view, for equality-gated memos: the same string is the same view. */
export const historyKey = (v: HistoryView): string => `${historyTailOf(v)}?${historyQueryOf(v)}`;
/** The filters alone (what a list read depends on): selecting an event or the view keeps it. */
export const filtersKey = (f: HistoryFilters): string => historyQueryOf({ filters: f });

export const filtersSet = (f: HistoryFilters): number =>
  (f.projects.length ? 1 : 0) + (f.kind ? 1 : 0) + (f.initiation ? 1 : 0) + (f.actor ? 1 : 0) + (f.from || f.to ? 1 : 0) + (f.q ? 1 : 0);

/** Local midnight of a `YYYY-MM-DD`, in ms; `end` = the last ms of that day. */
export function dayMs(day: string, end = false): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return end ? new Date(y, m - 1, d + 1).getTime() - 1 : new Date(y, m - 1, d).getTime();
}

/** The server query the filters ask for (the page and cursor are the caller's). */
export function queryOf(f: HistoryFilters): HistoryQuery {
  const q: HistoryQuery = {};
  if (f.projects.length) q.projects = [...f.projects];
  if (f.kind) q.kinds = [...KIND_GROUPS[f.kind]];
  if (f.initiation) q.initiation = [f.initiation];
  if (f.actor) q.actors = [f.actor];
  if (f.from) q.from = dayMs(f.from);
  if (f.to) q.to = dayMs(f.to, true);
  if (f.q) q.text = f.q;
  return q;
}

/** A kind this version knows. */
export const isHistoryKind = (k: string): k is HistoryKind => (HISTORY_KINDS as readonly string[]).includes(k);
