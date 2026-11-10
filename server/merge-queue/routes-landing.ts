import type { Context, Hono } from "hono";
import { type LandHow, type MergeEntry, type MergeQueueView } from "../../shared/merge-queue";
import { pageOnlyRefusal } from "../page-only";
import { isLandHow } from "./strategy";
import type { DiscardDeps } from "../worktree-remove-discard";

/**
 * The routes of how a branch lands (al_3), beside the merge verbs (routes.ts): REST, not verbs, so the merge thread's
 * tool never gains them. Each is the operator's own act on a screen (the Merge Queue tab, the settings row, a card).
 *
 *   POST   /api/merge-queue/projects/:project/update-local-main     the queue's own fast-forward of the local target
 *   POST   /api/merge-queue/entries/:id/publish {title, body, draft} publish a reviewed request (q10)
 *   PUT    /api/merge-queue/projects/:project/land-how {how, where}  save How it lands (project file or this computer)
 *   DELETE /api/merge-queue/projects/:project/land-how/override      clear this computer's choice
 *   POST   /api/merge-queue/projects/:project/discard-branch {branch, commit, dryRun?: true, digest?}
 *                                                                     Discard Branch…: what goes (dry run), then folder, branch, chat
 *
 * Refusals answer {error: {code, message}} with 400 (invalid-request), 404 (not-found), 409 (busy) or 501 (unsupported).
 */

/** What these routes ask of a project's queue (queue.ts ProjectQueue implements it). */
export interface LandingQueue {
  updateLocalMain(): Promise<{ kind: "updated" | "current"; head: string }>;
  publish(entryId: string, text: { title: string; body: string; draft: boolean }): Promise<MergeEntry>;
  setLandHow(how: LandHow, where: "project" | "computer"): Promise<{ state: "saved"; commit?: string } | { state: "waiting"; release?: string } | { state: "requested"; url: string } | { state: "pushed"; branch: string }>;
  clearLandHowOverride(): Promise<void>;
  view(): Promise<MergeQueueView>;
}

export interface LandingRouteDeps {
  /** The queue of a registered project, by its id; null: no such project. */
  queueOf(projectId: string): Promise<LandingQueue | null>;
  /** The queue holding an entry, among the loaded ones; null: none. */
  queueOfEntry(entryId: string): Promise<LandingQueue | null>;
  /** Why this caller may not act here (only the operator's own page may), or null (server/page-only.ts). */
  notPage?: (c: Context) => string | null;
  /** Discard Branch… (server/worktree-remove-discard.ts): a project's main checkout by id, the act's world, and its
   *  own page-only words (its dry run is the page's alone too: it lists a chat's files). */
  discard?: { rootOf(projectId: string): Promise<string | null>; deps(): Promise<DiscardDeps>; notPage(c: Context): string | null };
}

const STATUS: Record<string, 400 | 403 | 404 | 409 | 501> = { "invalid-request": 400, "not-found": 404, busy: 409, unsupported: 501, forbidden: 403, "needs-confirm": 400 };

function fail(err: unknown): { body: { error: { code: string; message: string } }; status: 400 | 403 | 404 | 409 | 501 } {
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "busy";
  const message = err instanceof Error ? err.message : String(err);
  return { body: { error: { code, message } }, status: STATUS[code] ?? 409 };
}

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

export function registerMergeLandingRoutes(app: Hono<any>, deps: LandingRouteDeps): void {
  const noProject = (id: string) => ({ error: { code: "not-found", message: `no project ${id}` } });
  const refused = (c: Context) => {
    const why = deps.notPage?.(c) ?? null;
    return why ? c.json({ error: { code: "forbidden", message: why } }, 403) : null;
  };

  app.post("/api/merge-queue/projects/:project/update-local-main", async (c) => {
    const no = refused(c);
    if (no) return no;
    const id = c.req.param("project");
    const q = await deps.queueOf(id);
    if (!q) return c.json(noProject(id), 404);
    try {
      const r = await q.updateLocalMain();
      return c.json({ ...r, view: await q.view() });
    } catch (err) {
      const f = fail(err);
      return c.json(f.body, f.status);
    }
  });

  app.post("/api/merge-queue/entries/:id/publish", async (c) => {
    const no = refused(c);
    if (no) return no;
    const id = c.req.param("id");
    const b = await jsonBody(c);
    for (const k of ["title", "body"] as const) if (b[k] !== undefined && typeof b[k] !== "string") return c.json({ error: { code: "invalid-request", message: `"${k}" must be text` } }, 400);
    if (typeof b.title !== "string" || !b.title.trim() || b.title.length > 255) return c.json({ error: { code: "invalid-request", message: "the request needs a title, as text (at most 255 characters)" } }, 400);
    if (typeof b.body !== "string" || !b.body.trim() || b.body.length > 60_000) return c.json({ error: { code: "invalid-request", message: "the request needs a description, as text (at most 60,000 characters)" } }, 400);
    if (b.draft !== undefined && typeof b.draft !== "boolean") return c.json({ error: { code: "invalid-request", message: '"draft" must be true or false' } }, 400);
    const title = b.title.trim();
    const body = b.body;
    const q = await deps.queueOfEntry(id);
    if (!q) return c.json({ error: { code: "not-found", message: `no queue entry ${id}` } }, 404);
    try {
      return c.json({ entry: await q.publish(id, { title, body, draft: b.draft === true }) });
    } catch (err) {
      const f = fail(err);
      return c.json(f.body, f.status);
    }
  });

  app.put("/api/merge-queue/projects/:project/land-how", async (c) => {
    const no = refused(c);
    if (no) return no;
    const id = c.req.param("project");
    const b = await jsonBody(c);
    // A value of the wrong type is refused for itself, before what's missing.
    for (const k of ["how", "where"] as const) if (b[k] !== undefined && typeof b[k] !== "string") return c.json({ error: { code: "invalid-request", message: `"${k}" must be text` } }, 400);
    if (!isLandHow(b.how)) return c.json({ error: { code: "invalid-request", message: '"how" is one of "local", "github-pr", "gitlab-mr", "push-branch"' } }, 400);
    if (b.where !== "project" && b.where !== "computer") return c.json({ error: { code: "invalid-request", message: '"where" is "project" (the project\'s file) or "computer" (this computer only)' } }, 400);
    const q = await deps.queueOf(id);
    if (!q) return c.json(noProject(id), 404);
    try {
      return c.json(await q.setLandHow(b.how, b.where));
    } catch (err) {
      const f = fail(err);
      return c.json(f.body, f.status);
    }
  });

  app.post("/api/merge-queue/projects/:project/discard-branch", async (c) => {
    const dis = deps.discard;
    if (!dis) return c.json({ error: { code: "unsupported", message: "Discard Branch isn't wired in this server." } }, 501);
    const why = dis.notPage(c);
    if (why) return c.json({ error: { code: "forbidden", message: why }, yourClick: true }, 403);
    const b = await jsonBody(c);
    const bad = (message: string) => c.json({ error: { code: "invalid-request", message } }, 400);
    // A value of the wrong type is refused for itself, before what's missing.
    for (const k of ["branch", "commit", "digest"] as const) if (b[k] !== undefined && typeof b[k] !== "string") return bad(`"${k}" must be text`);
    if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") return bad('"dryRun" must be true or absent');
    if (typeof b.branch !== "string" || !b.branch || b.branch.length > 255 || b.branch.startsWith("-") || /[\s\0~^:?*[\\]|\.\.|@\{/.test(b.branch)) return bad('"branch" is a branch name');
    if (typeof b.commit !== "string" || !/^[0-9a-f]{40,64}$/.test(b.commit)) return bad('"commit" is the full commit the row showed');
    if (b.dryRun !== undefined && b.dryRun !== true) return bad('"dryRun" is true or absent');
    if (b.dryRun === true && b.digest !== undefined) return bad("Send dryRun: true or a digest, not both");
    if (b.dryRun !== true && (typeof b.digest !== "string" || !/^(|[0-9a-f]{8,64})$/.test(b.digest))) return bad('"digest" is the dry run\'s digest');
    const id = c.req.param("project");
    const root = await dis.rootOf(id);
    if (!root) return c.json(noProject(id), 404);
    const { previewDiscard, discardBranch, DiscardRefused } = await import("../worktree-remove-discard");
    const req = { root, branch: b.branch, commit: b.commit };
    try {
      const d = await dis.deps();
      if (b.dryRun === true) return c.json(await previewDiscard(req, d));
      return c.json(await discardBranch(req, b.digest as string, d));
    } catch (err) {
      if (err instanceof DiscardRefused) return c.json({ error: { code: err.code, message: err.message } }, 409);
      const f = fail(err);
      return c.json(f.body, f.status);
    }
  });

  app.delete("/api/merge-queue/projects/:project/land-how/override", async (c) => {
    const no = refused(c);
    if (no) return no;
    const id = c.req.param("project");
    const q = await deps.queueOf(id);
    if (!q) return c.json(noProject(id), 404);
    try {
      await q.clearLandHowOverride();
      return c.json({ ok: true });
    } catch (err) {
      const f = fail(err);
      return c.json(f.body, f.status);
    }
  });
}

const WRITE_WORDS = {
  overseer: "Only you choose how branches land and publish their requests: the Overseer can't.",
  local: "How branches land is changed only on this computer.",
  chat: "A chat can't publish a request or change how branches land: do it yourself on the Merge Queue tab.",
  script: "A script can't publish a request or change how branches land: do it yourself on the Merge Queue tab.",
  extension: "An extension can't publish a request or change how branches land: do it yourself on the Merge Queue tab.",
};

const DISCARD_WORDS = "Only the user discards a branch. Ask them to press Discard Branch… in the Land menu. Nothing was deleted.";
const DISCARD_PAGE = {
  overseer: DISCARD_WORDS,
  local: "A branch is discarded only on the page of the computer it is on. Nothing was deleted.",
  chat: DISCARD_WORDS,
  script: DISCARD_WORDS,
  extension: DISCARD_WORDS,
};
/** Why this caller may not discard a branch: only a click on the operator's own page on this machine may. */
export const discardNotPage = (c: Context): string | null => pageOnlyRefusal(c, DISCARD_PAGE);

/** The routes on the live server: projects by id (server/projects/spaces.ts), entries among the loaded queues. */
export function registerLiveMergeLandingRoutes(app: Hono<any>): void {
  registerMergeLandingRoutes(app, {
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
    async queueOfEntry(entryId) {
      const { mergeQueues } = await import("./wire");
      return (await mergeQueues()?.findEntry(entryId)) ?? null;
    },
    notPage: (c) => pageOnlyRefusal(c, WRITE_WORDS),
    discard: {
      async rootOf(id) {
        const { listProjects } = await import("../projects/spaces");
        try {
          return listProjects().find((p) => p.id === id)?.root ?? null;
        } catch {
          return null;
        }
      },
      deps: async () => (await import("../worktree-remove-discard")).realDiscardDeps(),
      notPage: discardNotPage,
    },
  });
}
