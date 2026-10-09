import type { Context, Hono } from "hono";
import { BusyError } from "../chat-manager";
import { OrgError } from "../org-error";
import { OVERSEER_CARD_HEADER, OVERSEER_SENDER_HEADER, overseerCard, overseerSender } from "../overseer-sender";
import { mergeRun, readRuntime, RuntimeRefusal, startOnboard, startRuntimeTick } from "./runtime";
import { operatorEnvelopeOf, type OperatorBy } from "./spaces";

/**
 * The software registry's routes (§app/project-runtime): `GET /api/projects/:pid/runtime` (the registry, read
 * fresh), `POST …/runtime/merge {hash}` (Merge Branch on the proposed run) and `POST …/verbs/onboard {why?, model?}`
 * (the Project verbs playbook).
 */

const NO_STORE = { "Cache-Control": "no-store" };

const handle =
  (fn: (c: Context) => Promise<Response>) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof RuntimeRefusal) return c.json({ error: err.message }, err.status);
      if (err instanceof OrgError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
      if (err instanceof BusyError) return c.json({ error: err.message }, 409);
      throw err;
    }
  };

async function body(c: Context): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

function operatorBy(c: Context): OperatorBy {
  const overseerId = overseerSender(c.req.header(OVERSEER_SENDER_HEADER));
  if (!overseerId) return { kind: "operator" };
  const card = overseerCard(c.req.header(OVERSEER_CARD_HEADER));
  return { kind: "operator", via: "overseer", overseerId, ...(card ? { card } : {}) };
}

const opt = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function registerRuntimeRoutes(app: Hono<any>): void {
  startRuntimeTick();

  app.get("/api/projects/:pid/runtime", handle(async (c) => c.json(await readRuntime(c.req.param("pid") ?? ""), 200, NO_STORE)));

  // Merge Branch on a proposed run (§app.project-runtime/merge): a refused merge says why (409).
  app.post(
    "/api/projects/:pid/runtime/merge",
    handle(async (c) => {
      const b = await body(c);
      const hash = opt(b.hash);
      if (!hash) return c.json({ error: "Give the hash you were shown (hash)." }, 400);
      const out = await mergeRun(c.req.param("pid") ?? "", hash);
      if (out.refused) return c.json({ error: `The merge was refused: ${out.refused}`, runtime: out.view }, 409, NO_STORE);
      return c.json(out.view, 200, NO_STORE);
    }),
  );

  app.post(
    "/api/projects/:pid/verbs/onboard",
    handle(async (c) => {
      const pid = c.req.param("pid") ?? "";
      const b = await body(c);
      const input = { ...(opt(b.why) ? { why: opt(b.why) } : {}), ...(opt(b.model) ? { model: opt(b.model) } : {}), ...(opt(b.thinking) ? { thinking: opt(b.thinking) } : {}), ...(opt(b.playbook) ? { playbook: opt(b.playbook) } : {}) };
      const made = await startOnboard(pid, input, operatorEnvelopeOf(pid, operatorBy(c)));
      return c.json({ sessionId: made.sessionId, path: made.path, ...(made.worktree ? { worktree: made.worktree } : {}), ...(made.notPrompted ? { notPrompted: made.notPrompted } : {}) }, 201);
    }),
  );
}
