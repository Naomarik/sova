import type { Context, Hono } from "hono";
import type { EffectiveModel, MergeQueueSettings, MergeSettingsChange, MergeSettingsSaveResult, ModelChoice } from "../../shared/merge-queue-settings";
import { parseChange, SettingsEditError } from "./settings-edit";
import { effectiveModel, liveModelCheck, type ModelCheck, parseChoice, writeModels } from "./models";
import { pageOnlyRefusal } from "../page-only";

/**
 * The merge queue's settings (the Settings dialog's Merge Queue tab), beside the merge verbs (routes.ts): REST, not
 * verbs, so the merge thread's tool never gains them.
 *
 *   GET    /api/merge-queue/projects/:project/settings                   every setting the queue uses (view.settings)
 *   PUT    /api/merge-queue/projects/:project/models {review?, thread?}  the review and thread models, on this computer
 *   POST   /api/merge-queue/projects/:project/settings {changes, confirm} one commit on the target (or waits for the run)
 *   DELETE /api/merge-queue/projects/:project/settings/pending           cancel a waiting save
 *
 * `:project` is the registered project's id. Writes are the operator's own page's (page-only). Refusals answer
 * {error: {code, message}}: 400 invalid-request, 404 not-found, 409 busy, dirty or needs-confirm.
 */

export interface SettingsQueue {
  settings(): Promise<MergeQueueSettings>;
  saveSettings(changes: MergeSettingsChange): Promise<MergeSettingsSaveResult>;
  cancelPendingSave(): Promise<boolean>;
  settingsChanged(): void;
  readonly store: { readonly dir: string };
}

export interface SettingsRouteDeps {
  queueOf(projectId: string): Promise<SettingsQueue | null>;
  modelCheck: ModelCheck;
  /** Why this request isn't the operator's own page (server/page-only.ts), or null. */
  notPage?: (c: Context) => string | null;
}

const STATUS: Record<string, 400 | 404 | 409> = { "invalid-request": 400, "not-found": 404, busy: 409, dirty: 409, "needs-confirm": 409, forbidden: 400, unsupported: 400 };
const err = (code: string, message: string) => ({ error: { code, message } });

function failure(e: unknown): { body: ReturnType<typeof err>; status: 400 | 404 | 409 } {
  if (e instanceof SettingsEditError) return { body: err("invalid-request", e.message), status: 400 };
  const message = e instanceof Error ? e.message : String(e);
  let code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "busy";
  // The settings file's uncommitted edit (or the checkout's) is its own code, so the screen can grey the controls.
  if (code === "invalid-request" && /^Commit or discard the edit|has uncommitted changes/.test(message)) code = "dirty";
  return { body: err(code, message), status: STATUS[code] ?? 409 };
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

export function registerMergeSettingsRoutes(app: Hono<any>, deps: SettingsRouteDeps): void {
  const queue = async (c: Context) => {
    const id = c.req.param("project") ?? "";
    const q = await deps.queueOf(id);
    if (!q) throw Object.assign(new Error(`no project ${id}`), { code: "not-found" });
    return q;
  };
  const guard = (c: Context) => {
    const why = deps.notPage?.(c) ?? null;
    if (why) throw Object.assign(new Error(why), { code: "forbidden" });
  };
  const run = async (c: Context, fn: () => Promise<unknown>) => {
    try {
      return c.json(await fn(), 200, { "Cache-Control": "no-store" });
    } catch (e) {
      const f = failure(e);
      return c.json(f.body, f.status);
    }
  };

  app.get("/api/merge-queue/projects/:project/settings", (c) => run(c, async () => (await queue(c)).settings()));

  app.put("/api/merge-queue/projects/:project/models", (c) =>
    run(c, async () => {
      guard(c);
      const b = await jsonBody(c);
      if (!b) throw Object.assign(new Error('the body is {review?: {model, thinking?} | null, thread?: …}'), { code: "invalid-request" });
      const patch: { review?: ModelChoice | null; thread?: ModelChoice | null } = {};
      for (const role of ["review", "thread"] as const) {
        if (!(role in b)) continue;
        try {
          patch[role] = parseChoice(b[role], role);
        } catch (e) {
          throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { code: "invalid-request" });
        }
      }
      if (!Object.keys(patch).length) throw Object.assign(new Error("name review or thread"), { code: "invalid-request" });
      const q = await queue(c);
      // A pick turned off in Settings → Models is refused here; one not signed in is kept (it falls back until it is).
      for (const role of ["review", "thread"] as const) {
        const p = patch[role];
        if (!p) continue;
        const why = await deps.modelCheck.denial(p.model);
        if (why && /turned off/.test(why)) throw Object.assign(new Error(why), { code: "invalid-request" });
      }
      const next = writeModels(q.store.dir, patch);
      q.settingsChanged();
      const out: { review: EffectiveModel; thread: EffectiveModel } = {
        review: await effectiveModel(next.review, deps.modelCheck),
        thread: await effectiveModel(next.thread, deps.modelCheck),
      };
      return out;
    }),
  );

  app.post("/api/merge-queue/projects/:project/settings", (c) =>
    run(c, async () => {
      guard(c);
      const b = await jsonBody(c);
      if (!b) throw Object.assign(new Error("the body is {changes, confirm: true}"), { code: "invalid-request" });
      const changes = parseChange(b.changes);
      if (b.confirm !== undefined && typeof b.confirm !== "boolean") throw Object.assign(new Error("confirm is true or false"), { code: "invalid-request" });
      const q = await queue(c);
      if (b.confirm !== true) throw Object.assign(new Error("a settings save lands one commit on the target: confirm it (confirm: true)"), { code: "needs-confirm" });
      return q.saveSettings(changes);
    }),
  );

  app.delete("/api/merge-queue/projects/:project/settings/pending", (c) =>
    run(c, async () => {
      guard(c);
      return { cancelled: await (await queue(c)).cancelPendingSave() };
    }),
  );
}

/** The live wiring: the server's queues by project id, Settings → Models, the page-only rule. */
export function registerLiveMergeSettingsRoutes(app: Hono<any>): void {
  registerMergeSettingsRoutes(app, {
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
    modelCheck: liveModelCheck(),
    notPage: (c) => pageOnlyRefusal(c, WRITE_WORDS),
  });
}

const WRITE_WORDS = {
  overseer: "Only you change the merge queue's settings: the Overseer can't.",
  local: "The merge queue's settings are changed only on this computer.",
  chat: "A chat can't change the merge queue's settings: change them yourself in Settings → Merge Queue.",
  script: "A script can't change the merge queue's settings: change them yourself in Settings → Merge Queue.",
  extension: "An extension can't change the merge queue's settings: change them yourself in Settings → Merge Queue.",
};
