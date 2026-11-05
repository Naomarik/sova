import type { Context, Hono } from "hono";
import { BusyError } from "../chat-handle";
import { OrgError } from "../org-error";
import { OVERSEER_CARD_HEADER, OVERSEER_SENDER_HEADER, overseerCard, overseerSender } from "../overseer-sender";
import { mergeRun, readRuntime, RuntimeRefusal, startOnboard, startRuntimeTick } from "./runtime";
import { operatorEnvelopeOf, type OperatorBy } from "./spaces";
import { FOLDED_PLAYBOOKS, SETUP_MODE, SETUP_PLAYBOOK_ID } from "./onboard";
import { openSetup, readSetup, SETUP_FROM, type SetupDeps, type SetupFrom } from "./setup-chat";
import type { Envelope } from "../org-envelope";

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

/** The live server's ways to start and archive the Setup chat (server/projects/setup-chat.ts). */
function liveSetupDeps(app: Hono<any>): SetupDeps {
  return {
    startRun: (pid, input, envelope?: Envelope) => startOnboard(pid, input, envelope),
    // A plain chat in the folder, made without a first message, set to the Setup chat's mode and model, then sent it.
    startChat: async (cwd, text, title, model) => {
      const res = await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
      const json = (await res.json().catch(() => null)) as { id?: string; path?: string; error?: string } | null;
      if (res.status !== 201 || !json?.id || !json.path) throw new RuntimeRefusal(`The Setup chat didn't start: ${json?.error ?? `HTTP ${res.status}`}`, 409);
      (await import("../session-titles")).writeAutoTitle(json.id, title);
      const chat = await (await import("../chat-handle")).acquireChatHandle(json.path);
      await chat.switchMode({ mode: SETUP_MODE.mode, minorModes: [...SETUP_MODE.minorModes] });
      if (model) {
        await chat.setModel(model.model);
        if (model.thinking) await chat.setThinking(model.thinking);
      }
      await chat.deliverToAgent(text);
      return { id: json.id, path: json.path };
    },
    archive: async (path) => {
      const r = await (await import("../sessions-index")).archiveSession(path, true);
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? "refused" };
    },
    working: async (path) => !!(await (await import("./playbook-review")).runLive(path))?.working,
    runtime: (pid) => readRuntime(pid),
  };
}

export function registerRuntimeRoutes(app: Hono<any>): void {
  startRuntimeTick();

  // The Setup chat (§app.project-setup/chat, /start): its state, and Set Up with a Chat / Change Setup / Start Fresh.
  app.get("/api/projects/:pid/setup", handle(async (c) => c.json(await readSetup(c.req.param("pid") ?? ""), 200, NO_STORE)));
  app.post(
    "/api/projects/:pid/setup",
    handle(async (c) => {
      const pid = c.req.param("pid") ?? "";
      const b = await body(c);
      if (b.from !== undefined && !(SETUP_FROM as readonly unknown[]).includes(b.from)) return c.json({ error: `from is one of ${SETUP_FROM.join(", ")}.` }, 400);
      const input = { ...(b.fresh === true ? { fresh: true } : {}), ...(b.from ? { from: b.from as SetupFrom } : {}), ...(opt(b.why) ? { why: opt(b.why) } : {}), ...(opt(b.model) ? { model: opt(b.model) } : {}), ...(opt(b.thinking) ? { thinking: opt(b.thinking) } : {}) };
      const made = await openSetup(pid, input, liveSetupDeps(app), operatorEnvelopeOf(pid, operatorBy(c)));
      return c.json(made, made.reopened ? 200 : 201, NO_STORE);
    }),
  );

  app.get("/api/projects/:pid/runtime", handle(async (c) => c.json(await readRuntime(c.req.param("pid") ?? ""), 200, NO_STORE)));

  // Merge Branch on a proposed run (§app.project-runtime/merge): a refused merge says why (409).
  app.post(
    "/api/projects/:pid/runtime/merge",
    handle(async (c) => {
      const b = await body(c);
      const hash = opt(b.hash);
      if (!hash) return c.json({ error: "Give the hash you were shown (hash)." }, 400);
      const out = await mergeRun(c.req.param("pid") ?? "", hash, opt(b.commit));
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
      // The setup playbooks folded into the Setup chat (and its own) open the Setup chat: never a second one.
      const pbId = opt(b.playbook);
      if (pbId && (pbId === SETUP_PLAYBOOK_ID || FOLDED_PLAYBOOKS.includes(pbId))) {
        const opened = await openSetup(pid, { ...(input.why ? { why: input.why } : {}), ...(input.model ? { model: input.model } : {}), ...(input.thinking ? { thinking: input.thinking } : {}) }, liveSetupDeps(app), operatorEnvelopeOf(pid, operatorBy(c)));
        return c.json({ sessionId: opened.sessionId, path: opened.path, ...(opened.worktree ? { worktree: opened.worktree } : {}), reopened: opened.reopened }, opened.reopened ? 200 : 201);
      }
      const made = await startOnboard(pid, input, operatorEnvelopeOf(pid, operatorBy(c)));
      return c.json({ sessionId: made.sessionId, path: made.path, ...(made.worktree ? { worktree: made.worktree } : {}), ...(made.notPrompted ? { notPrompted: made.notPrompted } : {}) }, 201);
    }),
  );
}
