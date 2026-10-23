import type { Context, Hono } from "hono";
import { tmpdir } from "node:os";
import { askUsage, type HelperAnswer } from "./usage-helper/client";
import type { FoldInput } from "./usage-helper/project-fold";
import { listProjects } from "./projects/spaces";
import { attachedWorkspaces, defaultWorkspacesDir } from "./orgs";
import { overseerDir } from "./overseer-store";
import { agentRoot } from "./state-root";

/**
 * The usage ledger's routes (shared/usage/wire.ts, §app.insights/usage-ledger and
 * §app.insights/cost-history). Main listener only. Each one asks the usage helper and returns its
 * answer's bytes as they came: the server's loop never parses or computes a figure.
 */

const relay = (a: HelperAnswer): Response =>
  new Response(new Uint8Array(a.body), { status: a.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

const bad = (c: Context, error: string) => c.json({ error }, 400);

/** What the helper needs to fold the By project rows: every project here, archived
    ones too, the Overseer's and the organizations' folders, the agent dir and the temp folders. */
function foldInput(): FoldInput {
  let projects: FoldInput["projects"] = [];
  let workspaces: string[] = [];
  try {
    projects = listProjects().map((p) => ({ id: p.id, name: p.name, root: p.root, ...(p.archived ? { archived: true } : {}) }));
  } catch {
    // no engine open yet: no project is registered
  }
  try {
    workspaces = attachedWorkspaces().map((o) => o.dir);
  } catch {
    // no org index
  }
  return { projects, overseer: [overseerDir(), defaultWorkspacesDir(), ...workspaces], exclude: agentRoot(), temp: [...new Set([tmpdir(), "/tmp", "/var/tmp"])] };
}

export function registerUsageRoutes(app: Hono<any>): void {
  app.get("/api/usage/costs", async (c) =>
    relay(
      await askUsage("costs", {
        range: c.req.query("range") ?? "30d",
        provider: c.req.queries("provider") ?? [],
        model: c.req.queries("model") ?? [],
        tz: c.req.query("tz") ?? "UTC",
        fold: foldInput(),
      }),
    ),
  );
  // The Performance tab (shared/usage/perf.ts): measured reply timing, same range and filter as Costs.
  app.get("/api/usage/performance", async (c) =>
    relay(
      await askUsage("performance", {
        range: c.req.query("range") ?? "30d",
        provider: c.req.queries("provider") ?? [],
        model: c.req.queries("model") ?? [],
        tz: c.req.query("tz") ?? "UTC",
      }),
    ),
  );
  app.get("/api/usage/today", async (c) => relay(await askUsage("today", { tz: c.req.query("tz") ?? "UTC" })));
  app.get("/api/usage/session", async (c) => {
    const sid = c.req.query("sid");
    if (!sid) return bad(c, "sid is required");
    return relay(await askUsage("session", { sid }));
  });
  app.post("/api/usage/sessions", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return bad(c, "body must be JSON");
    }
    const sids = (body as { sids?: unknown })?.sids;
    if (!Array.isArray(sids)) return bad(c, "sids must be a list");
    return relay(await askUsage("sessions", { sids }));
  });
  app.get("/api/usage/prices", async () => relay(await askUsage("prices")));
  app.post("/api/usage/prices/refresh", async () => relay(await askUsage("refresh")));
}
