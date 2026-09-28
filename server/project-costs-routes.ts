import type { Context, Hono } from "hono";
import { OrgError } from "./orgs";
import { orgCosts, projectCost } from "./project-costs";

/**
 * A project's cost at API prices and the org's roll-up (§app.project-costs/card, /org-rollup).
 * The operator's main listener only: the share listener, the owner page's projection and the
 * project overseer's tools never reach these (§app.project-costs/privacy).
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
  app.get("/api/orgs/:id/projects/:pid/costs", handle(async (c) => c.json(await projectCost(c.req.param("id") ?? "", c.req.param("pid") ?? ""), 200, NO_STORE)));
  app.get("/api/orgs/:id/costs", handle(async (c) => c.json(await orgCosts(c.req.param("id") ?? ""), 200, NO_STORE)));
}
