import type { Context, Hono } from "hono";
import { pageOnlyRefusal } from "../page-only";
import { mergeThread } from "./thread";
import { cleanRunLogs, runLogsInfo, type RunLogsQueue } from "./run-logs";

/**
 * The merge thread's Run Logs chip (run-logs.ts): REST, not a merge verb, so no chat's tool gains it.
 *
 *   GET  /api/merge-queue/run-logs?project=<id> | ?session=<the merge thread's chat id>  RunLogsInfo
 *   POST /api/merge-queue/run-logs/clean {project, confirm: true}                         RunLogsCleaned
 *
 * Clean is the operator's own page's (page-only): a chat, the Overseer, a script or an extension is refused.
 * Refusals answer {error: {code, message}}: 400 invalid-request or forbidden, 404 not-found, 409 needs-confirm.
 */

export interface RunLogsRouteDeps {
  /** The loaded queues (each served project's). */
  queues(): Promise<(RunLogsQueue & { readonly root: string })[]>;
  /** The chat is `root`'s merge thread. */
  isThreadChat(root: string, session: string): boolean;
  /** Why this request isn't the operator's own page (server/page-only.ts), or null. */
  notPage?: (c: Context) => string | null;
}

const STATUS: Record<string, 400 | 404 | 409> = { "invalid-request": 400, forbidden: 400, "not-found": 404, "needs-confirm": 409 };
class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const CLEAN_WORDS = {
  overseer: "Only you clean the merge queue's run logs: the Overseer can't.",
  local: "The merge queue's run logs are cleaned only on this computer.",
  chat: "A chat can't clean the merge queue's run logs: use Clean Logs in the merge thread's chat yourself.",
  script: "A script can't clean the merge queue's run logs: use Clean Logs in the merge thread's chat yourself.",
  extension: "An extension can't clean the merge queue's run logs: use Clean Logs in the merge thread's chat yourself.",
};

export function registerRunLogsRoutes(app: Hono<any>, deps: RunLogsRouteDeps): void {
  const byProject = async (id: string) => {
    const q = (await deps.queues()).find((x) => x.id === id);
    if (!q) throw new Refusal("not-found", `no merge queue for project ${id}`);
    return q;
  };
  const answer = async (c: Context, fn: () => Promise<unknown>) => {
    try {
      return c.json(await fn(), 200, { "Cache-Control": "no-store" });
    } catch (e) {
      const code = e instanceof Refusal ? e.code : "invalid-request";
      return c.json({ error: { code, message: e instanceof Error ? e.message : String(e) } }, STATUS[code] ?? 400);
    }
  };

  app.get("/api/merge-queue/run-logs", (c) =>
    answer(c, async () => {
      const project = c.req.query("project");
      const session = c.req.query("session");
      if (project) return runLogsInfo(await byProject(project));
      if (!session) throw new Refusal("invalid-request", "name the project (?project=) or the merge thread's chat (?session=)");
      const q = (await deps.queues()).find((x) => deps.isThreadChat(x.root, session));
      if (!q) throw new Refusal("not-found", "that chat isn't a project's merge thread");
      return runLogsInfo(q);
    }),
  );

  app.post("/api/merge-queue/run-logs/clean", (c) =>
    answer(c, async () => {
      const why = deps.notPage?.(c) ?? null;
      if (why) throw new Refusal("forbidden", why);
      const b = (await c.req.json().catch(() => null)) as { project?: unknown; confirm?: unknown } | null;
      if (!b || typeof b.project !== "string" || !b.project) throw new Refusal("invalid-request", "the body is {project, confirm: true}");
      const q = await byProject(b.project);
      if (b.confirm !== true) throw new Refusal("needs-confirm", "Clean Logs deletes the logs of old finished runs: confirm it (confirm: true)");
      return cleanRunLogs(q);
    }),
  );
}

/** The live wiring: the server's loaded queues and its merge thread keeper. */
export function registerLiveRunLogsRoutes(app: Hono<any>): void {
  registerRunLogsRoutes(app, {
    queues: async () => {
      const qs = (await import("./wire")).mergeQueues();
      return qs ? qs.loaded() : [];
    },
    isThreadChat: (root, session) => mergeThread().isThreadChat(root, session),
    notPage: (c) => pageOnlyRefusal(c, CLEAN_WORDS),
  });
}
