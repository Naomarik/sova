import type { Hono } from "hono";
import type { MergeEventsPage } from "../../shared/merge-queue";
import type { EventQuery } from "./events";

/**
 * The event memory's read (§app.merge-queue/activity): REST, open as the queue view is (it changes nothing).
 *
 *   GET /api/merge-queue/projects/:project/events?entry=&run=&branch=&by=&kind=&before=&limit=
 *       → MergeEventsPage: newest first; `before` the last seq of the previous page (Show Older)
 *
 * Refusals answer {error: {code, message}} with 400 or 404.
 */

export interface EventsQueue {
  events(q: EventQuery): MergeEventsPage;
}

export interface EventsRouteDeps {
  queueOf(projectId: string): Promise<EventsQueue | null>;
}

const BY = ["user", "queue", "thread", "chat", "reviewer", "release"];
const ID_RE = /^[\w.:-]{1,80}$/;

/** The query's words, checked; a string: what is wrong with it. */
export function eventQueryOf(get: (k: string) => string | undefined): EventQuery | string {
  const q: EventQuery = {};
  for (const k of ["entry", "run", "kind"] as const) {
    const v = get(k);
    if (v === undefined) continue;
    if (!ID_RE.test(v)) return `"${k}" is an id (letters, digits, - _ . :)`;
    (q as Record<string, string>)[k] = v;
  }
  const branch = get("branch");
  if (branch !== undefined) {
    if (!branch || branch.length > 255) return '"branch" is a branch name, at most 255 characters';
    q.branch = branch;
  }
  const by = get("by");
  if (by !== undefined) {
    if (!BY.includes(by)) return `"by" is one of ${BY.join(", ")}`;
    q.by = by as EventQuery["by"];
  }
  for (const k of ["before", "limit"] as const) {
    const raw = get(k);
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || (k === "limit" && n > 500)) return `"${k}" is a whole number${k === "limit" ? " from 1 to 500" : " from 1"}`;
    q[k] = n;
  }
  return q;
}

export function registerMergeEventsRoutes(app: Hono<any>, deps: EventsRouteDeps): void {
  app.get("/api/merge-queue/projects/:project/events", async (c) => {
    const q = eventQueryOf((k) => c.req.query(k));
    if (typeof q === "string") return c.json({ error: { code: "invalid-request", message: q } }, 400);
    const id = c.req.param("project")!;
    const queue = await deps.queueOf(id);
    if (!queue) return c.json({ error: { code: "not-found", message: `no project ${id}` } }, 404);
    return c.json(queue.events(q));
  });
}

/** The route on the live server: projects by id (server/projects/spaces.ts). */
export function registerLiveMergeEventsRoutes(app: Hono<any>): void {
  registerMergeEventsRoutes(app, {
    async queueOf(id) {
      const [{ mergeQueues }, { listProjects }] = await Promise.all([import("./wire"), import("../projects/spaces")]);
      const qs = mergeQueues();
      if (!qs) return null;
      let root: string | null = null;
      try {
        root = listProjects().find((p) => p.id === id)?.root ?? null;
      } catch {}
      return root ? qs.get(root) : null;
    },
  });
}
