import type { Hono } from "hono";
import { httpStatusOf } from "../../shared/project-contract";
import { conformer } from "./conform";
import { SelectedDriver } from "./adapters";
import { attentionChanged } from "../attention-memo";
import { Deployer } from "./deploy";
import { ProjectEngine } from "./engine";

/**
 * The verbs' routes (§app.project-services/callers): `POST /api/project-services/<verb>` runs one
 * verb as the operator and answers its result with the status of its exit class. The CLI
 * (scripts/sova-project.mjs) is a client of these; the tools call the same engine in-process.
 */

let engine: ProjectEngine | null = null;
let deployer: Deployer | null = null;

/** The server's one engine (its supervisor adapter chosen at first use, server/project-services/adapters.ts). */
export function projectEngine(): ProjectEngine {
  if (!engine) {
    engine = new ProjectEngine({ driver: new SelectedDriver() });
    engine.conformer = conformer(engine);
    const d = (deployer = new Deployer(engine));
    // A deploy that ended may be the digest's to list (§app.project-services/deploy-status).
    d.onEnded = () => attentionChanged();
    engine.deployer = async (verb, body, caller, opts) => {
      const r = await d.run(verb, body, caller, opts);
      if (r.changed) attentionChanged();
      return r;
    };
  }
  return engine;
}

/** The server's one deployer (§app.project-services/deploy), beside its engine. */
export function projectDeployer(): Deployer {
  projectEngine();
  return deployer!;
}

export function registerProjectServiceRoutes(app: Hono<any>): void {
  app.post("/api/project-services/:verb", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const r = await projectEngine().run(c.req.param("verb"), body, { kind: "operator" });
    return c.json(r, httpStatusOf(r) as 200);
  });
}

/** At server start: bring instances back to their desired state (§app.project-services/reconcile). */
export async function reconcileProjectServices(): Promise<void> {
  try {
    const sel = await (projectEngine().driver as SelectedDriver).selection();
    console.log(`[project-services] supervisor: ${sel.id} (${sel.why})`);
    const did = await projectEngine().reconcile();
    for (const d of did) console.log(`[project-services] ${d}`);
    for (const d of projectDeployer().reconcile()) console.log(`[project-services] ${d}`);
  } catch (err) {
    console.error("[project-services] reconcile failed:", err instanceof Error ? err.message : err);
  }
}
