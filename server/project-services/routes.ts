import { notPageNorProven } from "../mesh/click-proof";
import { CALLER_HEADER, callerKeys } from "../caller-keys";
import { isCardRun } from "../extension-sender";
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

const jsonOf = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

export function registerProjectServiceRoutes(app: Hono<any>): void {
  app.post("/api/project-services/:verb", async (c) => {
    const raw = await c.req.text().catch(() => "");
    const verb = c.req.param("verb");
    const body = jsonOf(raw);
    // A process a chat runs carries its chat's key (`x-sova-caller`, scripts/sova-token.mjs): the route still runs as the
    // operator, but never the operator's acts on a release (t17).
    const key = c.req.header(CALLER_HEADER)?.trim();
    const fromChat = !!key;
    const named = key ? callerKeys.callerOf(key) : "no-key";
    const chat = named.startsWith("chat:") ? named.slice("chat:".length) : undefined;
    const fromCard = isCardRun((n) => c.req.header(n));
    // Your page, here or on another of your computers with its proof (server/mesh/click-proof.ts).
    const notPage = verb === "apply" && (await notPageNorProven(c, raw));
    const r = await projectEngine().run(verb, body, { kind: "operator", ...(fromChat ? { fromChat: true as const } : {}), ...(chat ? { chat } : {}), ...(fromCard ? { fromCard: true as const } : {}), ...(notPage ? { notPage: true } : {}) });
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
