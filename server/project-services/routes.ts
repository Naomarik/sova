import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Hono } from "hono";
import { CONTRACT_FILE, DefinitionError, httpStatusOf, parseDefinition } from "../../shared/project-contract";
import { projectOf } from "../project-root";
import { conformer } from "./conform";
import { driverFromEnv } from "./drivers";
import { ProjectEngine } from "./engine";
import { approve, defHashOf } from "./trust";

/**
 * The verbs' routes (§app.project-services/callers): `POST /api/project-services/<verb>` runs one
 * verb as the operator and answers its result with the status of its exit class;
 * `POST /api/project-services/approve` approves a definition's hash. The CLI
 * (scripts/sova-project.mjs) is a client of these; the tools call the same engine in-process.
 */

let engine: ProjectEngine | null = null;

/** The server's one engine (its driver chosen from SOVA_PROJECT_DRIVER at first use). */
export function projectEngine(): ProjectEngine {
  if (!engine) {
    engine = new ProjectEngine({ driver: driverFromEnv() });
    engine.conformer = conformer(engine);
  }
  return engine;
}

export function registerProjectServiceRoutes(app: Hono<any>): void {
  app.post("/api/project-services/approve", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { project?: unknown; defHash?: unknown; checkout?: unknown } | null;
    const project = typeof body?.project === "string" ? body.project : "";
    const seen = typeof body?.defHash === "string" ? body.defHash : "";
    if (!project || !isAbsolute(project) || !seen) return c.json({ error: "give project (an absolute path) and defHash (the hash you were shown)" }, 400);
    const p = await projectOf(project);
    if (p.state !== "ok") return c.json({ error: p.state === "none" ? `no project at ${project}` : p.message }, 404);
    // The definition is read where it will run: the checkout named, else the main checkout.
    const where = typeof body?.checkout === "string" && isAbsolute(body.checkout) ? body.checkout : p.root;
    if ((await projectOf(where)).state !== "ok" || ((await projectOf(where)) as { root: string }).root !== p.root) return c.json({ error: `${where} is not a checkout of ${p.root}` }, 400);
    const file = join(where, CONTRACT_FILE);
    if (!existsSync(file)) return c.json({ error: `no ${CONTRACT_FILE} in ${where}` }, 404);
    let current: string;
    try {
      current = defHashOf(parseDefinition(readFileSync(file, "utf8")));
    } catch (err) {
      return c.json({ error: err instanceof DefinitionError ? err.message : String(err) }, 400);
    }
    try {
      approve(p.root, seen, current);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
    return c.json({ ok: true, project: p.root, defHash: current });
  });

  app.post("/api/project-services/:verb", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const r = await projectEngine().run(c.req.param("verb"), body, { kind: "operator" });
    return c.json(r, httpStatusOf(r) as 200);
  });
}

/** At server start: bring instances back to their desired state (§app.project-services/reconcile). */
export async function reconcileProjectServices(): Promise<void> {
  try {
    const did = await projectEngine().reconcile();
    for (const d of did) console.log(`[project-services] ${d}`);
  } catch (err) {
    console.error("[project-services] reconcile failed:", err instanceof Error ? err.message : err);
  }
}
