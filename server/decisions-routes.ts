import type { Context, Hono } from "hono";
import type { ConflictResolveInput } from "../shared/decisions";
import { DecisionError } from "./decide";
import { OrgError } from "./orgs";
import { draftProject, listDecisions, promoteDecisions, reconcileProject, resolveConflict, routeConflictNow, setFrozen, setOwnerArea, settleSpecText, specStatusOf } from "./reconcile";
import { SpecToolError } from "./spec-draft-writer";

/**
 * The operator's routes for a project's decisions, conflicts and spec (§app/requirements; the
 * list is in shared/decisions.ts). Main listener only, never the share listener. Every write runs
 * in the project's one-job-at-a-time queue (server/reconcile.ts).
 */

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return typeof b === "object" && b !== null && !Array.isArray(b) ? b : {};
  } catch {
    throw new OrgError("Expected a JSON object body");
  }
}

const p = (c: Context, name: string): string => c.req.param(name) ?? "";

const handle =
  (fn: (c: Context) => Promise<Response> | Response) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message }, err.status);
      if (err instanceof SpecToolError) return c.json({ error: err.message, codes: err.codes }, 409);
      if (err instanceof DecisionError) return c.json({ error: err.message, code: err.failure }, 503);
      throw err;
    }
  };

const BASE = "/api/orgs/:id/projects/:pid";

export function registerDecisionRoutes(app: Hono<any>): void {
  app.get(
    `${BASE}/decisions`,
    handle((c) => c.json(listDecisions(p(c, "id"), p(c, "pid")))),
  );
  app.get(
    `${BASE}/conflicts`,
    handle((c) => c.json(listDecisions(p(c, "id"), p(c, "pid")).conflicts)),
  );
  app.post(
    `${BASE}/reconcile`,
    handle(async (c) => c.json(await reconcileProject(p(c, "id"), p(c, "pid")))),
  );
  app.post(
    `${BASE}/draft`,
    handle(async (c) => c.json(await draftProject(p(c, "id"), p(c, "pid")))),
  );
  app.post(
    `${BASE}/promote`,
    handle(async (c) => {
      const b = await body(c);
      const ids = b.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every((x) => typeof x === "string")) throw new OrgError("Expected { ids: string[] } (1–200 decision ids)");
      if (b.bulk !== undefined && typeof b.bulk !== "boolean") throw new OrgError("bulk must be a boolean");
      return c.json(await promoteDecisions(p(c, "id"), p(c, "pid"), ids as string[], { by: b.bulk ? "bulk" : "operator-explicit" }));
    }),
  );
  app.patch(
    `${BASE}/decisions/:did`,
    handle(async (c) => {
      const ownerArea = (await body(c)).ownerArea;
      if (typeof ownerArea !== "string") throw new OrgError('Expected { ownerArea: string } (a roster decision area or "none")');
      return c.json(await setOwnerArea(p(c, "id"), p(c, "pid"), p(c, "did"), ownerArea));
    }),
  );
  app.post(
    `${BASE}/decisions/:did/text`,
    handle(async (c) => c.json(await settleSpecText(p(c, "id"), p(c, "pid"), p(c, "did"), (await body(c)).action))),
  );
  app.post(
    `${BASE}/conflicts/:cid/route`,
    handle(async (c) => {
      const to = (await body(c)).to;
      if (to !== undefined && typeof to !== "string") throw new OrgError("to must be a person id or \"operator\"");
      return c.json(await routeConflictNow(p(c, "id"), p(c, "pid"), p(c, "cid"), to || undefined));
    }),
  );
  app.post(
    `${BASE}/conflicts/:cid/resolve`,
    handle(async (c) => {
      const b = await body(c);
      const input: ConflictResolveInput | null =
        typeof b.statement === "string" ? { statement: b.statement } : b.keep === "a" || b.keep === "b" || b.keep === "both" ? { keep: b.keep } : null;
      if (!input) throw new OrgError('Expected { keep: "a" | "b" | "both" } or { statement }');
      return c.json(await resolveConflict(p(c, "id"), p(c, "pid"), p(c, "cid"), input));
    }),
  );
  app.get(
    `${BASE}/spec`,
    handle((c) => c.json(specStatusOf(p(c, "id"), p(c, "pid")))),
  );
  app.patch(
    `${BASE}/spec`,
    handle(async (c) => {
      const frozen = (await body(c)).frozen;
      if (typeof frozen !== "boolean") throw new OrgError("Expected { frozen: boolean }");
      return c.json(await setFrozen(p(c, "id"), p(c, "pid"), frozen));
    }),
  );
}
