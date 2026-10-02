import type { Context, Hono } from "hono";
import { OrgError } from "./org-error";
import { projectCost } from "./project-costs";

/**
 * A project's cost at API prices (§app.project-costs/card). The operator's main listener only: the
 * share listener, the owner page's projection and the project overseer's tools never reach it
 * (§app.project-costs/privacy).
 */

const NO_STORE = { "Cache-Control": "no-store" };

const handle =
  (fn: (c: Context) => Promise<Response>) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  };

export function registerProjectCostRoutes(app: Hono<any>): void {
  app.get("/api/projects/:pid/costs", handle(async (c) => c.json(await projectCost(c.req.param("pid") ?? ""), 200, NO_STORE)));
}
