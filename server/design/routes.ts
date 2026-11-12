// The page's routes for a chat's designs. Every one names the parent chat by `?path=`. Nothing here
// starts a turn in the main chat or writes to its context.
import { existsSync } from "node:fs";
import type { Context, Hono } from "hono";
import { DESIGN_ASK_ABOVE, designerSkills, isDesignLabel, type DesignRun, type DesignSetup } from "../../shared/design";
import { DESIGN_RUN } from "../harness/state-kinds";
import { chatHandle, acquireChatHandle } from "../chat-handle";
import { notPage } from "../page-only";
import { resolveSessionPath } from "../paths";
import { idOf } from "../sessions-index";
import { BriefRefused, startBrief, startCoordinator } from "./coordinator";
import { mountCoordinatorRoutes } from "./coordinator-routes";
import { mountDesignLiveRoutes } from "./live-route";
import { mountDesignAssetRoutes } from "./asset-routes";
import { showAssets } from "./assets";
import { mountDescribeRoutes } from "./describe-routes";
import { assertLaunchAllowed, deleteDesign, deliverDesign, DesignLimitError, designCount, retryDesign, type DesignParent } from "./batch";
import { designView, livePage } from "./live";
import { cleanSetup, estimateUsd } from "./setup";
import { skillReadTokens } from "./skills";
import { changeDesigns, designOf, readDesigns, readPage, runOf } from "./store";

const BAD_PATH = "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)";
const ONLY_YOUR_CLICK = "Only your own click on the Lookbook's brief in Sova's page starts the designs.";

function parentOf(c: Context): DesignParent | null {
  const path = resolveSessionPath(c.req.query("path"));
  if (!path || !existsSync(path)) return null;
  return { sessionId: idOf(path), path };
}

const body = async (c: Context): Promise<Record<string, unknown>> => {
  try {
    const v = await c.req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function mountDesignRoutes(app: Hono): void {
  // First: `/api/design/coordinator/...` would otherwise read as a design's own routes.
  mountCoordinatorRoutes(app);
  mountDesignLiveRoutes(app, parentOf);
  mountDesignAssetRoutes(app, parentOf);
  mountDescribeRoutes(app, parentOf);
  app.get("/api/design", (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    return c.json(designView(p.sessionId), 200, { "Cache-Control": "no-store" });
  });

  app.patch("/api/design/runs/:run/setup", async (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const sent = await body(c);
    if (typeof sent.brief !== "string" || !Array.isArray(sent.models) || !Array.isArray(sent.directions)) return c.json({ error: "Expected a whole Setup { brief, models, directions }." }, 400);
    const runId = c.req.param("run");
    const run = runOf(p.sessionId, runId);
    if (!run) return c.json({ error: "No such design run." }, 404);
    const briefOpen = run.phase === "brief";
    if (run.phase !== "setup" && !briefOpen) return c.json({ error: "This run has started, so its Setup is closed." }, 409);
    const next = cleanSetup(run.setup, sent, briefOpen);
    if (typeof next === "string") return c.json({ error: next }, 400);
    changeDesigns(p.sessionId, (s) => {
      const r = s.runs.find((x) => x.id === runId);
      if (r) {
        r.setup = next;
        r.updatedAt = new Date().toISOString();
        if (briefOpen && r.brief) {
          // On the card, so what Start starts from has moved; and so has what it should cost.
          r.brief.rev++;
          const estimate = estimateUsd(next, Date.now(), skillReadTokens(designerSkills(r)));
          if (estimate === null) delete r.brief.estimateUsd;
          else r.brief.estimateUsd = estimate;
        }
      }
    });
    return c.json(designView(p.sessionId));
  });

  app.post("/api/design/runs/:run/start", async (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const run = runOf(p.sessionId, c.req.param("run"));
    const runId = c.req.param("run");
    if (!run) return c.json({ error: "No such design run." }, 404);
    if (run.phase !== "setup") return c.json({ error: "This run has already started." }, 409);
    const n = designCount(run.setup);
    if (!n) return c.json({ error: "Pick at least one model and one style first." }, 400);
    // The hard stop only: the spending question waits for Start on the brief, when the plan is known.
    try {
      assertLaunchAllowed(n, true);
    } catch (err) {
      if (err instanceof DesignLimitError) return c.json({ error: err.message }, 400);
      throw err;
    }
    const started = runOf(p.sessionId, runId)!;
    try {
      await startCoordinator(p, started, cwdOf(p));
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
    return c.json(designView(p.sessionId));
  });

  app.post("/api/design/runs/:run/brief/start", async (c) => {
    if (notPage(c)) return c.json({ error: ONLY_YOUR_CLICK }, 403);
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const b = await body(c);
    if (typeof b.rev !== "number" || (b.confirmSpend !== undefined && typeof b.confirmSpend !== "boolean")) return c.json({ error: "Expected { rev, confirmSpend? }." }, 400);
    const runId = c.req.param("run");
    try {
      await startBrief(p, runId, { rev: b.rev, confirmSpend: b.confirmSpend === true });
      // The run's mark on the chat's own file; best effort, the store is what the card reads.
      void recordRun(p, runId).catch((err) => console.warn(`[design] the run's record was not written: ${message(err)}`));
      return c.json(designView(p.sessionId));
    } catch (err) {
      if (err instanceof DesignLimitError) {
        const run = runOf(p.sessionId, runId);
        return c.json({ error: err.message, ...(err.needsConfirm && run ? { needsConfirm: true, designs: err.designs, askAbove: DESIGN_ASK_ABOVE, ...priced(run.setup, designerSkills(run)) } : {}) }, err.needsConfirm ? 409 : 400);
      }
      if (err instanceof BriefRefused) return c.json({ error: err.message, ...err.detail }, 409);
      return c.json({ error: message(err) }, 500);
    }
  });

  const send = (name: "message" | "refine") =>
    app.post(`/api/design/:label/${name}`, async (c) => {
      const p = parentOf(c);
      if (!p) return c.json({ error: BAD_PATH }, 400);
      const b = await body(c);
      if (typeof b.text !== "string" || typeof b.key !== "string" || !b.key || (b.quick !== undefined && !(Array.isArray(b.quick) && b.quick.every((q) => typeof q === "string")))) return c.json({ error: "Expected { text, key, quick? }: text and key are strings, quick a list of strings." }, 400);
      const text = b.text.trim();
      const key = b.key;
      const quick = (b.quick as string[] | undefined) ?? [];
      if (!text && !quick.length) return c.json({ error: "Say what to change." }, 400);
      const label = c.req.param("label");
      if (!isDesignLabel(label) || !designOf(p.sessionId, label)) return c.json({ error: `No design ${label} in this chat.` }, 404);
      try {
        const words = name === "refine" ? refineMessage(text, quick) : text;
        return c.json(await deliverDesign(p, label, { text: words, key, by: "user", version: name === "refine" ? "refine" : "chat" }));
      } catch (err) {
        return c.json({ error: message(err) }, 502);
      }
    });
  send("message");
  send("refine");

  app.post("/api/design/:label/retry", (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const label = c.req.param("label");
    if (!isDesignLabel(label) || !designOf(p.sessionId, label)) return c.json({ error: `No design ${label} in this chat.` }, 404);
    try {
      retryDesign(p, label);
      return c.json(designView(p.sessionId));
    } catch (err) {
      return c.json({ error: message(err) }, 409);
    }
  });

  app.delete("/api/design/:label", (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const label = c.req.param("label");
    if (!isDesignLabel(label) || !designOf(p.sessionId, label)) return c.json({ error: `No design ${label} in this chat.` }, 404);
    deleteDesign(p, label);
    return c.json(designView(p.sessionId));
  });

  app.get("/api/design/:label/page", (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const label = c.req.param("label");
    const v = c.req.query("v");
    const n = v === undefined ? undefined : Number(v);
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) return c.json({ error: "?v= must be a version number" }, 400);
    const stored = readPage(p.sessionId, label, n);
    if (stored === null) return c.json({ error: "No such page." }, 404);
    const images = c.req.query("images");
    if (images !== undefined && images !== "small" && images !== "full") return c.json({ error: "?images= must be small or full." }, 400);
    // Only drawing asks for pictures; every other reader, a model's included, gets the page as it was written, names and all.
    const page = images ? showAssets(p.sessionId, stored, images) : stored;
    // As text, never as a page of Sova's origin: the web app seals it in its own frames.
    return c.text(page, 200, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  });

  app.get("/api/design/:label/live", (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const live = livePage(p.sessionId, c.req.param("label"));
    return live ? c.json(live, 200, { "Cache-Control": "no-store" }) : c.json({ error: "Nothing is being written." }, 404);
  });
}

const priced = (setup: DesignSetup, skills?: DesignRun["skills"]) => {
  const estimateUsd_ = estimateUsd(setup, Date.now(), skillReadTokens(skills));
  return estimateUsd_ === null ? {} : { estimateUsd: estimateUsd_ };
};

const cwdOf = (p: DesignParent): string => readDesigns(p.sessionId).cwd ?? chatHandle(p.path)?.mirror.cwd ?? "";

async function recordRun(p: DesignParent, runId: string): Promise<void> {
  const run = runOf(p.sessionId, runId);
  if (!run) return;
  await (await acquireChatHandle(p.path)).appendState(DESIGN_RUN, {
    v: 1,
    runId,
    at: run.updatedAt,
    // What was chosen, never the whole model list.
    setup: { brief: run.setup.brief, models: run.setup.models.filter((m) => m.design).map((m) => m.ref), coordinator: run.setup.models.find((m) => m.coordinator)?.ref ?? null, directions: run.setup.directions.filter((d) => d.on).map((d) => d.name), layouts: (run.setup.layouts ?? []).filter((d) => d.on).map((d) => d.name), combine: run.setup.combine ?? "pair", ...(run.setup.pairSeed ? { pairSeed: run.setup.pairSeed } : {}) },
  });
}

/** What Refine hands a design's session: the person's words, and how far to go. */
export function refineMessage(text: string, quick: string[]): string {
  const asks = [...quick, ...(text ? [text] : [])];
  return `Refine your page.\n\n${asks.join("\n")}\n\nOpen it with design_look at desktop and at phone width, look at what is really on screen, and fix what you find. At most two rounds of looking and fixing, then design_hand_in.`;
}
