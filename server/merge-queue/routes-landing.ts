import type { Context, Hono } from "hono";
import { type LandHow, type MergeEntry, type MergeQueueView, type MergeRun, type MergeTrial, type MergeTrialWaiting } from "../../shared/merge-queue";
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
 *   POST   /api/merge-queue/projects/:project/dry-run {branch, commit}  Run Dry Run: started, or waiting its turn
 *   POST   /api/merge-queue/projects/:project/dry-run/stop {run} | {waiting}  Stop Dry Run
 *   POST   /api/merge-queue/projects/:project/fix {branch, commit, run, newChat?, check?}  Fix / Fix in New Chat
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
  trial(req: { branch: string; commit: string; by: { kind: "operator" } }): Promise<{ trial?: MergeTrial; run?: MergeRun; waiting?: MergeTrialWaiting }>;
  stopTrial(req: { run?: string; waiting?: string; by: { kind: "operator" } }): Promise<{ trial?: MergeTrial; waiting?: MergeTrialWaiting }>;
}

/** Fix / Fix in New Chat's answer. */
export interface FixAnswer {
  session: string;
  path: string;
  branch?: string;
  worktree?: string;
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
  /** Fix (and Fix in New Chat): the failure of `run` sent to the branch's chat, or a fresh chat started with it. */
  fix?: (projectId: string, req: { branch: string; commit: string; run: string; newChat: boolean; check?: string }) => Promise<FixAnswer>;
}

/** A text field of the wrong type, refused for itself before what's missing: its words, or null. */
const textWrong = (b: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const k of keys) if (b[k] !== undefined && typeof b[k] !== "string") return `"${k}" must be text`;
  return null;
};

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
    for (const k of DISCARD_TEXT_FIELDS) if (b[k] !== undefined && typeof b[k] !== "string") return bad(`"${k}" must be text`);
    if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") return bad('"dryRun" must be true or absent');
    if (typeof b.branch !== "string" || !b.branch || b.branch.length > 255 || b.branch.startsWith("-") || /[\s\0~^:?*[\\]|\.\.|@\{/.test(b.branch)) return bad('"branch" is a branch name');
    if (typeof b.commit !== "string" || !/^[0-9a-f]{40,64}$/.test(b.commit)) return bad('"commit" is the full commit the row showed');
    if (b.dryRun !== undefined && b.dryRun !== true) return bad('"dryRun" is true or absent');
    if (b.dryRun === true && b.digest !== undefined) return bad("Send dryRun: true or a digest, not both");
    if (b.dryRun !== true && (typeof b.digest !== "string" || !/^(|[0-9a-f]{8,64}(-[0-9a-f]{8,64})?)$/.test(b.digest))) return bad('"digest" is the dry run\'s digest');
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

  const branchOk = (b: unknown): b is string => typeof b === "string" && !!b && b.length <= 255 && !b.startsWith("-") && !/[\s\0~^:?*[\\]|\.\.|@\{/.test(b);
  const commitOk = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40,64}$/.test(v);

  // Run Dry Run / Run Dry Run Again: the operator's own click; while the copy is busy it waits its turn.
  app.post("/api/merge-queue/projects/:project/dry-run", async (c) => {
    const no = refused(c);
    if (no) return no;
    const b = await jsonBody(c);
    const wrong = textWrong(b, DRY_RUN_TEXT_FIELDS);
    if (wrong) return c.json({ error: { code: "invalid-request", message: wrong } }, 400);
    if (!branchOk(b.branch)) return c.json({ error: { code: "invalid-request", message: '"branch" is a branch name' } }, 400);
    if (!commitOk(b.commit)) return c.json({ error: { code: "invalid-request", message: '"commit" is the full commit the row showed' } }, 400);
    const id = c.req.param("project");
    const q = await deps.queueOf(id);
    if (!q) return c.json(noProject(id), 404);
    try {
      return c.json(await q.trial({ branch: b.branch, commit: b.commit, by: { kind: "operator" } }));
    } catch (err) {
      const f = fail(err);
      return c.json(f.body, f.status);
    }
  });

  // Stop Dry Run: the running one (its run) or a waiting one (its id).
  app.post("/api/merge-queue/projects/:project/dry-run/stop", async (c) => {
    const no = refused(c);
    if (no) return no;
    const b = await jsonBody(c);
    const wrong = textWrong(b, STOP_TEXT_FIELDS);
    if (wrong) return c.json({ error: { code: "invalid-request", message: wrong } }, 400);
    const run = typeof b.run === "string" && /^mr_[\w-]{1,64}$/.test(b.run) ? b.run : undefined;
    const waiting = typeof b.waiting === "string" && /^tw_[\w-]{1,64}$/.test(b.waiting) ? b.waiting : undefined;
    if (!run === !waiting) return c.json({ error: { code: "invalid-request", message: 'send the running dry run\'s "run" (mr_…) or a waiting one\'s "waiting" (tw_…)' } }, 400);
    const id = c.req.param("project");
    const q = await deps.queueOf(id);
    if (!q) return c.json(noProject(id), 404);
    try {
      return c.json(await q.stopTrial({ ...(run ? { run } : {}), ...(waiting ? { waiting } : {}), by: { kind: "operator" } }));
    } catch (err) {
      const f = fail(err);
      return c.json(f.body, f.status);
    }
  });

  // Fix / Fix in New Chat on a failure holding a branch up: the operator's own click; nothing lands or is approved.
  app.post("/api/merge-queue/projects/:project/fix", async (c) => {
    const no = refused(c);
    if (no) return no;
    if (!deps.fix) return c.json({ error: { code: "unsupported", message: "Fix isn't wired in this server." } }, 501);
    const b = await jsonBody(c);
    const wrong = textWrong(b, FIX_TEXT_FIELDS);
    if (wrong) return c.json({ error: { code: "invalid-request", message: wrong } }, 400);
    if (b.newChat !== undefined && typeof b.newChat !== "boolean") return c.json({ error: { code: "invalid-request", message: '"newChat" must be true or false' } }, 400);
    // A check broken on the target (Fix in New Chat only) is named by its check and run, never a branch.
    const brokenCheck = b.newChat === true && typeof b.check === "string" && b.branch === undefined && b.commit === undefined;
    if (!brokenCheck && !branchOk(b.branch)) return c.json({ error: { code: "invalid-request", message: '"branch" is a branch name' } }, 400);
    if (!brokenCheck && !commitOk(b.commit)) return c.json({ error: { code: "invalid-request", message: '"commit" is the full commit the failure is at' } }, 400);
    if (typeof b.run !== "string" || !/^mr_[\w-]{1,64}$/.test(b.run)) return c.json({ error: { code: "invalid-request", message: '"run" is the failed run (mr_…)' } }, 400);
    if (b.newChat !== undefined && typeof b.newChat !== "boolean") return c.json({ error: { code: "invalid-request", message: '"newChat" must be true or false' } }, 400);
    if (b.check !== undefined && (typeof b.check !== "string" || !b.check || b.check.length > 120)) return c.json({ error: { code: "invalid-request", message: '"check" is a check id' } }, 400);
    try {
      return c.json(await deps.fix(c.req.param("project"), { branch: brokenCheck ? "" : (b.branch as string), commit: brokenCheck ? "" : (b.commit as string), run: b.run, newChat: b.newChat === true, ...(typeof b.check === "string" ? { check: b.check } : {}) }));
    } catch (err) {
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

/** Run Dry Run's, Stop Dry Run's and Fix's text fields: each refused for its own wrong type. */
const ROW_FIELDS = ["branch", "commit"] as const;
const FIX_TEXT_FIELDS = ["run", "check", ...ROW_FIELDS] as const;
const DRY_RUN_TEXT_FIELDS = ROW_FIELDS;
const STOP_TEXT_FIELDS = ["run", "waiting"] as const;

/** Discard Branch…'s text fields: each refused for its own wrong type. */
const DISCARD_TEXT_FIELDS = ["branch", "commit", "digest"] as const;

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
    fix: async (id, req) => (await import("./fix-live")).liveFix(id, req),
  });
}
