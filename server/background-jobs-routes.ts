import { existsSync } from "node:fs";
import type { Hono } from "hono";
import { chatJobs, stopJob, sweepJobs, type JobView } from "./background-jobs";
import { wakeOwnerOf, workerChatsOf } from "./chat-host";
import { resolveSessionPath } from "./paths";
import { getSessionSummary } from "./sessions-index";

/** A chat's workers, by session id, with each one's worker id. */
function workersOf(sessionId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const sid of workerChatsOf(sessionId)) out.set(sid, wakeOwnerOf(sid)?.workerId ?? sid);
  return out;
}

/**
 * The Background jobs section's routes (§app.background-jobs/pane): a chat's running jobs and its
 * workers', and Stop. Neither starts the chat, nor wakes it.
 */
export function registerJobRoutes(app: Hono): void {
  app.get("/api/sessions/jobs", async (c) => {
    const path = resolveSessionPath(c.req.query("path") ?? null);
    if (!path) return c.json({ error: "Invalid or missing path (must be a .jsonl under the pi sessions dir)" }, 400);
    const s = existsSync(path) ? await getSessionSummary(path) : null;
    if (!s) return c.json({ error: "Session file not found" }, 404);
    const jobs: JobView[] = chatJobs(s.id, workersOf(s.id));
    return c.json({ jobs });
  });

  app.post("/api/sessions/jobs/stop", async (c) => {
    let body: { path?: unknown; id?: unknown; sessionId?: unknown };
    try {
      const parsed: unknown = await c.req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as typeof body;
    } catch {
      return c.json({ error: "Expected JSON body { path, id }" }, 400);
    }
    if (typeof body.id !== "string" || !/^j\d+$/.test(body.id)) return c.json({ error: "id must be a job id such as j1" }, 400);
    if (body.sessionId !== undefined && typeof body.sessionId !== "string") return c.json({ error: "sessionId must be a string" }, 400);
    const path = resolveSessionPath(typeof body.path === "string" ? body.path : null);
    if (!path) return c.json({ error: "Invalid or missing path (must be a .jsonl under the pi sessions dir)" }, 400);
    const s = existsSync(path) ? await getSessionSummary(path) : null;
    if (!s) return c.json({ error: "Session file not found" }, 404);
    const owner = (body.sessionId as string | undefined) ?? s.id;
    if (owner !== s.id && !workersOf(s.id).has(owner)) return c.json({ error: "That job belongs to no worker of this chat" }, 404);
    const j = await stopJob(owner, body.id, "stop");
    if (!j) return c.json({ error: `No job ${body.id}` }, 404);
    void sweepJobs();
    return c.json({ ok: true, id: j.id, ended: !!j.ended });
  });
}
