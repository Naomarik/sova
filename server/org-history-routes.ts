import type { Context, Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HEntry } from "../shared/harness";
import { HISTORY_KINDS, HISTORY_OUTCOMES, INITIATIONS, type HistoryKind, type HistoryOutcome, type HistoryQuery, type HistoryReader, type Initiation } from "../shared/org-history";
import { batonFileOf } from "./baton";
import { joinedText, parsePi } from "./harness/pi/reader";
import { hostOf } from "./org-engine";
import type { HistoryLabels, HistorySources } from "./org-history/query";
import { orgDir, OrgError, readOrg, readProjects, readRoster } from "./orgs";
import { OVERSEER_SENDER_HEADER } from "./overseer-sender";

/**
 * The operator's reads of an organization's history and Purge
 * Reason…. On the main listener only, like every org route; the share
 * listener never registers them. Every read is the history's own (server/org-history/), answered from its
 * index without a model call; these routes add only the names a page shows and open a cited message
 * through the neutral reader when asked.
 *
 * The list's parameters are exactly these names (shared/org-history.ts): an unknown one is refused, never
 * ignored, so a misspelt filter can't quietly stop filtering.
 */

const READER: HistoryReader = { role: "operator" };

const LIST_PARAMS = ["project", "kind", "outcome", "actor", "initiation", "from", "to", "q", "asOf", "groupOf", "cursor", "limit"] as const;
const EVENT_PARAMS = ["asOf"] as const;
const CHAIN_PARAMS = ["hops", "limit", "cursor", "asOf", "project"] as const;
const PACKET_PARAMS = ["event", ...LIST_PARAMS] as const;

const p = (c: Context, name: string): string => c.req.param(name) ?? "";

/** The request's query, refused when it names a parameter this route doesn't take. */
function params(c: Context, allowed: readonly string[]): Record<string, string> {
  const all = c.req.queries();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (!allowed.includes(k)) throw new OrgError(`Unknown parameter: ${k}. This route takes ${allowed.join(", ")}.`);
    if (v.length > 1) throw new OrgError(`${k} is given more than once: give one, comma-separated.`);
    out[k] = v[0] ?? "";
  }
  return out;
}

const list = (v: string | undefined): string[] | undefined => {
  const xs = (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return xs.length ? xs : undefined;
};

function oneOf<T extends string>(name: string, v: string | undefined, allowed: readonly T[]): T[] | undefined {
  const xs = list(v);
  if (!xs) return undefined;
  const bad = xs.find((x) => !allowed.includes(x as T));
  if (bad) throw new OrgError(`${name} must be one or more of ${allowed.join(", ")}; "${bad}" is not.`);
  return xs as T[];
}

function ms(name: string, v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new OrgError(`${name} must be a time in milliseconds.`);
  return n;
}

function count(name: string, v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new OrgError(`${name} must be a whole number of at least 1.`);
  return n;
}

/** The list's filters as the history reads them (bounds are the history's own). */
export function historyQueryOf(q: Record<string, string>): HistoryQuery {
  const kinds = oneOf<HistoryKind>("kind", q.kind, HISTORY_KINDS);
  const outcomes = oneOf<HistoryOutcome>("outcome", q.outcome, HISTORY_OUTCOMES);
  const initiation = oneOf<Initiation>("initiation", q.initiation, INITIATIONS);
  const projects = list(q.project);
  const actors = list(q.actor);
  const from = ms("from", q.from);
  const to = ms("to", q.to);
  const asOf = ms("asOf", q.asOf);
  const limit = count("limit", q.limit);
  const text = q.q?.trim();
  return {
    ...(projects ? { projects } : {}),
    ...(kinds ? { kinds } : {}),
    ...(outcomes ? { outcomes } : {}),
    ...(actors ? { actors } : {}),
    ...(initiation ? { initiation } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(text ? { text } : {}),
    ...(asOf !== undefined ? { asOf } : {}),
    ...(q.groupOf ? { groupOf: q.groupOf } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

/** The org's history, its org checked first (an unknown org is 404, as on every org route). */
function historyFor(orgId: string) {
  readOrg(orgId);
  return hostOf(orgId).history;
}

/** The names the operator's page shows: the org's projects (archived ones say so) and its people. */
export function orgLabels(orgId: string): HistoryLabels {
  const projects = new Map(readProjects(orgId).map((x) => [x.id, x]));
  let people: Map<string, string> | null = null;
  return {
    project: (id) => {
      const x = projects.get(id);
      return x ? { name: x.name, ...(x.archived ? { archived: true } : {}) } : null;
    },
    person: (id) => {
      people ??= new Map(readRoster(orgId).map((x) => [x.id, x.name]));
      return people.get(id) ?? null;
    },
  };
}

/**
 * A cited message, opened on request: a gathering's transcript in the org's
 * workspace, read through the neutral reader, its one entry's text only (and the span when one is cited).
 * A session that isn't a gathering here (an overseer's or a coding session's) is not on this host's
 * workspace: "other-host" unless it is found.
 */
export function orgSources(orgId: string): HistorySources {
  const dir = orgDir(orgId);
  return {
    transcript(session, entry, span) {
      const rel = batonFileOf(dir, session);
      if (!rel) return { state: "other-host" };
      let entries: HEntry[];
      try {
        entries = parsePi(readFileSync(join(dir, rel), "utf8")).entries;
      } catch {
        return { state: "corrupt" };
      }
      const h = entries.find((x) => x.id === entry);
      if (!h) return { state: "missing" };
      const text = joinedText(h, { images: false });
      return { state: "available", text: span ? text.slice(span[0], span[1]) : text };
    },
  };
}

const notFound = (): never => {
  throw new OrgError("No such event in this organization.", 404);
};

/** Run a handler, turning OrgError into its status (as the org routes do). */
const handle =
  (fn: (c: Context) => Promise<Response> | Response) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "history") return c.json({ error: (err as Error).message, code: "history" }, 503);
      throw err;
    }
  };

export function registerOrgHistoryRoutes(app: Hono<any>): void {
  app.get(
    "/api/orgs/:id/history",
    handle((c) => {
      const orgId = p(c, "id");
      const q = historyQueryOf(params(c, LIST_PARAMS));
      return c.json(historyFor(orgId).search(READER, q, orgLabels(orgId)));
    }),
  );
  app.get(
    "/api/orgs/:id/history/packet",
    handle((c) => {
      const orgId = p(c, "id");
      const q = params(c, PACKET_PARAMS);
      const h = historyFor(orgId);
      const asOf = ms("asOf", q.asOf);
      const what = q.event ? { event: q.event, ...(asOf !== undefined ? { asOf } : {}) } : { query: historyQueryOf(Object.fromEntries(Object.entries(q).filter(([k]) => k !== "event"))) };
      if (q.event && Object.keys(q).some((k) => k !== "event" && k !== "asOf")) throw new OrgError("A packet is of one event or of a list's filters, not both.");
      return c.json(h.packet(READER, what, orgLabels(orgId), orgSources(orgId)) ?? notFound());
    }),
  );
  app.get(
    "/api/orgs/:id/history/events/:eid",
    handle((c) => {
      const orgId = p(c, "id");
      const q = params(c, EVENT_PARAMS);
      const asOf = ms("asOf", q.asOf);
      return c.json(historyFor(orgId).event(READER, p(c, "eid"), asOf !== undefined ? { asOf } : {}, orgLabels(orgId), orgSources(orgId)) ?? notFound());
    }),
  );
  app.get(
    "/api/orgs/:id/history/events/:eid/chain",
    handle((c) => {
      const orgId = p(c, "id");
      const q = params(c, CHAIN_PARAMS);
      const hops = count("hops", q.hops);
      const limit = count("limit", q.limit);
      const asOf = ms("asOf", q.asOf);
      const projects = list(q.project);
      return c.json(
        historyFor(orgId).trace(
          READER,
          p(c, "eid"),
          { ...(hops ? { hops } : {}), ...(limit ? { limit } : {}), ...(q.cursor ? { cursor: q.cursor } : {}), ...(asOf !== undefined ? { asOf } : {}), ...(projects ? { projects } : {}) },
          orgLabels(orgId),
        ) ?? notFound(),
      );
    }),
  );
  app.get(
    "/api/orgs/:id/history/events/:eid/evidence/:n",
    handle((c) => {
      const orgId = p(c, "id");
      params(c, []);
      const n = count("n", p(c, "n"));
      return c.json(historyFor(orgId).evidence(READER, p(c, "eid"), n ?? 0, orgSources(orgId)) ?? notFound());
    }),
  );
  // Purge Reason…: the operator's own, confirmed; never through the global Overseer.
  app.post(
    "/api/orgs/:id/history/events/:eid/purge",
    handle(async (c) => {
      const orgId = p(c, "id");
      params(c, []);
      // A call carrying the Overseer's sender header at all is not the operator's own click.
      if (c.req.header(OVERSEER_SENDER_HEADER) !== undefined) throw new OrgError("Only the operator purges a reason, on the History tab.", 403);
      let body: unknown = null;
      try {
        body = await c.req.json();
      } catch {
        // no body: not confirmed
      }
      if (!(typeof body === "object" && body !== null && (body as { confirm?: unknown }).confirm === true)) throw new OrgError("Confirm the purge: { confirm: true }.");
      const h = historyFor(orgId);
      const eid = p(c, "eid");
      if (!h.event(READER, eid)) notFound();
      let event: string;
      try {
        event = await hostOf(orgId).purgeRationale(eid, { kind: "operator" });
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === "history") throw err;
        throw new OrgError(err instanceof Error ? err.message : String(err), 409);
      }
      return c.json({ event });
    }),
  );
}
