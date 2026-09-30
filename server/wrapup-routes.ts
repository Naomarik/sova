import type { Hono } from "hono";
import type { BatonInfo } from "../shared/baton";
import { batonById, retryWrapup as retryAct } from "./baton";
import { OrgError } from "./orgs";
import { batonInfo } from "./org-routes";

/**
 * Retry Wrap-Up (§app.organizations/wrap-up): the operator runs a failed wrap-up again. The baton
 * statechart's `baton/wrapup-retry` checks it (only a `failed` one, no wrap-up and no reply running, in
 * today's words) and starts the wrap-up's run. It never retries on its own (a model that degenerated
 * once may do it again); this is the operator's call. Answers with the row as the run started.
 */
export async function retryWrapup(sessionId: string): Promise<BatonInfo> {
  if (!batonById(sessionId)) throw new OrgError("Unknown baton session", 404);
  await retryAct(sessionId);
  return batonInfo(batonById(sessionId)!.row);
}

export function registerWrapupRoutes(app: Hono<any>): void {
  app.post("/api/baton/:sid/wrapup/retry", async (c) => {
    try {
      return c.json(await retryWrapup(c.req.param("sid") ?? ""));
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });
}
