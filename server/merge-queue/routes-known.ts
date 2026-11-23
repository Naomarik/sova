import type { Context, Hono } from "hono";
import type { MergeQueueView } from "../../shared/merge-queue";
import type { MergeFlakyTest, MergeHistoryPage, MergeQueueHealth } from "../../shared/merge-queue-health";
import { pageOnlyRefusal } from "../page-only";
import { HISTORY_PAGE_MAX } from "./health";

/**
 * The queue's known state and numbers (REST, not verbs, so the merge thread's tool never gains them): Clean Run and
 * Fix in New Chat on a flaky test are the user's own click on Sova's page; the reads are open as the queue view is.
 *
 *   POST /api/merge-queue/projects/:project/clean-run {entry?}       the next run (or the entry's) from an empty copy
 *   GET  /api/merge-queue/projects/:project/flaky                    every flaky test seen, most often first
 *   POST /api/merge-queue/projects/:project/flaky/fix {key}          Fix in New Chat on one of them
 *   GET  /api/merge-queue/projects/:project/history?branch=&before=&limit=   a page of the history, newest first
 *   GET  /api/merge-queue/projects/:project/health?days=             the health summary over the last days
 *
 * Refusals answer {error: {code, message}} with 400, 403 (not the user's page), 404 or 409.
 */

export interface KnownQueue {
  cleanRun(entryId?: string): Promise<MergeQueueView>;
  readonly flaky: { list(): MergeFlakyTest[]; get(key: string): MergeFlakyTest | undefined };
  historyPage(o: { branch?: string; before?: string; limit?: number }): MergeHistoryPage;
  health(days?: number): MergeQueueHealth;
}

export interface FlakyFixAnswer {
  session: string;
  path: string;
  branch?: string;
  worktree?: string;
}

export interface KnownRouteDeps {
  queueOf(projectId: string): Promise<KnownQueue | null>;
  /** Why this caller may not act here (only the operator's own page may), or null (server/page-only.ts). */
  notPage?: (c: Context) => string | null;
  /** Fix in New Chat on a flaky test: a fresh coding chat on a new branch from the target, told the test and its runs. */
  fixFlaky?: (projectId: string, key: string) => Promise<FlakyFixAnswer>;
}

const STATUS: Record<string, 400 | 403 | 404 | 409> = { "invalid-request": 400, "not-found": 404, busy: 409, forbidden: 403 };
const fail = (c: Context, err: unknown) => {
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "busy";
  return c.json({ error: { code, message: err instanceof Error ? err.message : String(err) } }, STATUS[code] ?? 409);
};
async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

export function registerMergeKnownRoutes(app: Hono<any>, deps: KnownRouteDeps): void {
  const refused = (c: Context) => {
    const why = deps.notPage?.(c) ?? null;
    return why ? c.json({ error: { code: "forbidden", message: why }, yourClick: true }, 403) : null;
  };
  const queue = async (c: Context): Promise<KnownQueue | Response> => {
    const id = c.req.param("project")!;
    const q = await deps.queueOf(id);
    return q ?? c.json({ error: { code: "not-found", message: `no project ${id}` } }, 404);
  };

  app.post("/api/merge-queue/projects/:project/clean-run", async (c) => {
    const no = refused(c);
    if (no) return no;
    const b = await jsonBody(c);
    if (b.entry !== undefined && (typeof b.entry !== "string" || !/^mq_[\w-]{1,64}$/.test(b.entry))) return c.json({ error: { code: "invalid-request", message: '"entry" is a queue entry (mq_…), or absent for the next run' } }, 400);
    const q = await queue(c);
    if (q instanceof Response) return q;
    try {
      return c.json({ view: await q.cleanRun(b.entry as string | undefined) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/merge-queue/projects/:project/flaky", async (c) => {
    const q = await queue(c);
    if (q instanceof Response) return q;
    return c.json({ tests: q.flaky.list() });
  });

  app.post("/api/merge-queue/projects/:project/flaky/fix", async (c) => {
    const no = refused(c);
    if (no) return no;
    if (!deps.fixFlaky) return c.json({ error: { code: "unsupported", message: "Fix in New Chat isn't wired in this server." } }, 501);
    const b = await jsonBody(c);
    if (typeof b.key !== "string" || !b.key || b.key.length > 2000) return c.json({ error: { code: "invalid-request", message: '"key" is a flaky test\'s key, as the list gives it' } }, 400);
    const q = await queue(c);
    if (q instanceof Response) return q;
    if (!q.flaky.get(b.key)) return c.json({ error: { code: "not-found", message: "no such flaky test: look again" } }, 404);
    try {
      return c.json(await deps.fixFlaky(c.req.param("project")!, b.key));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/merge-queue/projects/:project/history", async (c) => {
    const branch = c.req.query("branch");
    const before = c.req.query("before");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_PAGE_MAX)) return c.json({ error: { code: "invalid-request", message: `"limit" is a whole number from 1 to ${HISTORY_PAGE_MAX}` } }, 400);
    if (branch !== undefined && branch.length > 255) return c.json({ error: { code: "invalid-request", message: '"branch" is at most 255 characters' } }, 400);
    if (before !== undefined && !/^\d{4}-\d{2}-\d{2}T[^|]{1,40}\|[\w-]{0,80}$/.test(before)) return c.json({ error: { code: "invalid-request", message: '"before" is the previous page\'s "next"' } }, 400);
    const q = await queue(c);
    if (q instanceof Response) return q;
    return c.json(q.historyPage({ ...(branch ? { branch } : {}), ...(before ? { before } : {}), ...(limit !== undefined ? { limit } : {}) }));
  });

  app.get("/api/merge-queue/projects/:project/health", async (c) => {
    const raw = c.req.query("days");
    const days = raw === undefined ? 30 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 366) return c.json({ error: { code: "invalid-request", message: '"days" is a whole number from 1 to 366' } }, 400);
    const q = await queue(c);
    if (q instanceof Response) return q;
    return c.json(q.health(days));
  });
}

const WORDS = {
  overseer: "Only you start a clean run or a fix of a flaky test: the Overseer can't.",
  local: "A clean run or a fix of a flaky test is started only on this computer's page.",
  chat: "A chat can't start a clean run or a fix of a flaky test: press it yourself on the merge queue screen.",
  script: "A script can't start a clean run or a fix of a flaky test: press it yourself on the merge queue screen.",
  extension: "An extension can't start a clean run or a fix of a flaky test: press it yourself on the merge queue screen.",
};

/** The routes on the live server: projects by id (server/projects/spaces.ts). */
export function registerLiveMergeKnownRoutes(app: Hono<any>): void {
  registerMergeKnownRoutes(app, {
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
    notPage: (c) => pageOnlyRefusal(c, WORDS),
    fixFlaky: async (id, key) => (await import("./fix-live")).liveFixFlaky(id, key),
  });
}
