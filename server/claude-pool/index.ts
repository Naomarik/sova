import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultClaudeDir } from "../../pi-config/extensions/claude-code/accounts.ts";
import type { MeshApi } from "../mesh";
import { stateRoot } from "../state-root";
import { loginKindsPin } from "../sync/logins-merge";
import { PoolAgent, type CommitReply, type LendReply, type PoolPeer, type ReturnReply } from "./agent";
import { parseDoc, type PoolDoc } from "./doc";

/**
 * The pool of Claude logins on the mesh (§app.claude-logins/pool). While the mesh is OFF nothing
 * here runs: no agent, no timer, no file (§mesh.peers/off), and every login on this host is used
 * as in phase 1. The agent is built on the mesh's start hook and dropped on its stop hook.
 *
 * Peer routes (peer listener only; a browser-proxied call is refused, like every /api/peer/*):
 *   GET  /api/peer/claude-pool/doc          the pool document (no secret)
 *   POST /api/peer/claude-pool/doc          a peer's document: merged in, the merge answered
 *   POST /api/peer/claude-pool/lend         at the keeper: offer a free login (its credentials)
 *   POST /api/peer/claude-pool/commit       at the keeper: the asker staged it; hand it over
 *   POST /api/peer/claude-pool/return       at the keeper: a login coming back (its credentials)
 * Credentials cross only these, inside the tailnet's WireGuard hop, never the browser (f5).
 *
 * Browser routes (while on): PUT /api/claude/pool/keeper {device}, PUT /api/claude/pool/order
 * {order}, PATCH /api/claude/pool/:id {pin}, POST /api/claude/pool/:id/return. They change the document, which every device follows.
 */

const PEER_CALL_TIMEOUT_MS = 20_000;
const CREDENTIALS_LIMIT = 256 * 1024;

let current: PoolAgent | null = null;
/** The running agent (mesh on), or null. */
export const poolAgent = (): PoolAgent | null => current;

const peerCaller = (mesh: MeshApi, c: Context): string | null =>
  c.req.header("x-forwarded-host") ? null : (mesh.requestPeer(c)?.id ?? null);
const onPeerListener = (c: Context): boolean => !!(c.env as { meshPeer?: unknown } | undefined)?.meshPeer;

function httpPeer(mesh: MeshApi, id: string): PoolPeer {
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await mesh.peerFetch(id, path, {
      ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(PEER_CALL_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`${path}: HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  };
  const doc = async (p: Promise<unknown>): Promise<PoolDoc> => {
    const d = parseDoc(await p);
    if (!d) throw new Error("malformed pool document");
    return d;
  };
  return {
    id,
    doc: () => doc(call("/api/peer/claude-pool/doc")),
    pushDoc: (d) => doc(call("/api/peer/claude-pool/doc", d)),
    lend: (req) => call<LendReply>("/api/peer/claude-pool/lend", req),
    commit: async (req) => {
      const r = await call<CommitReply>("/api/peer/claude-pool/commit", req);
      if ("ok" in r) return { ok: true, doc: await doc(Promise.resolve(r.doc)) };
      return r;
    },
    giveBack: async (req) => {
      const r = await call<ReturnReply>("/api/peer/claude-pool/return", req);
      if ("ok" in r) return { ok: true, doc: await doc(Promise.resolve(r.doc)) };
      return r;
    },
  };
}

export interface PoolPaths {
  agentDir: () => string;
  stateDir: () => string;
  claudeDir: () => string;
}
const defaultPaths: PoolPaths = { agentDir: getAgentDir, stateDir: stateRoot, claudeDir: () => defaultClaudeDir() };

export function mountClaudePool(app: Hono, mesh: MeshApi, paths: PoolPaths = defaultPaths): void {
  const canHold = () => (loginKindsPin() ?? (mesh.settings().loginKinds === "api-keys" ? "api-keys" : "all")) !== "api-keys";
  // Each peer's last known up-state: onPeerUp, and every pool call's outcome (the 60 s exchange included).
  const upNow = new Map<string, boolean>();
  const peerInfo = () => mesh.peers().map((p) => ({ id: p.id, label: p.label, up: upNow.get(p.id) === true }));

  mesh.onMeshStart(() => {
    if (current) return;
    const agent = new PoolAgent({
      agentDir: paths.agentDir(),
      stateDir: paths.stateDir(),
      self: () => mesh.self().id,
      selfLabel: () => mesh.self().label,
      peers: () => mesh.peers().map((p) => trackingPeer(httpPeer(mesh, p.id), upNow)),
      peerInfo,
      defaultClaudeDir: paths.claudeDir(),
      canHold,
      ...testTimings(),
    });
    current = agent;
    void agent.start().catch((err) => console.error("[claude-pool] start failed:", err));
  });
  mesh.onMeshStop(() => {
    current?.stop();
    current = null;
    upNow.clear();
  });
  mesh.onPeerUp((id) => {
    upNow.set(id, true);
    const agent = current;
    const peer = mesh.peers().find((p) => p.id === id);
    if (!agent || !peer) return;
    // Pull what changed while it was away, then retry any step that waited for it.
    void agent.syncWith(trackingPeer(httpPeer(mesh, id), upNow)).then(() => agent.tick());
  });

  const notFound = (c: Context) => c.json({ error: "Not found" }, 404);
  const body = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };
  app.get("/api/peer/claude-pool/doc", (c) => {
    if (!peerCaller(mesh, c) || !current) return notFound(c);
    return c.json(current.doc());
  });
  app.post("/api/peer/claude-pool/doc", bodyLimit({ maxSize: CREDENTIALS_LIMIT, onError: (c) => c.json({ error: "Too large" }, 413) }), async (c) => {
    const from = peerCaller(mesh, c);
    if (!from || !current) return notFound(c);
    upNow.set(from, true);
    const merged = current.receiveDoc(await body(c));
    return merged ? c.json(merged) : c.json({ error: "Malformed pool document" }, 400);
  });
  app.post("/api/peer/claude-pool/lend", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) }), async (c) => {
    const from = peerCaller(mesh, c);
    if (!from || !current) return notFound(c);
    return c.json(await current.lend(from, (await body(c)) as never));
  });
  app.post("/api/peer/claude-pool/commit", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) }), async (c) => {
    const from = peerCaller(mesh, c);
    if (!from || !current) return notFound(c);
    return c.json(await current.commit(from, (await body(c)) as never));
  });
  app.post("/api/peer/claude-pool/return", bodyLimit({ maxSize: CREDENTIALS_LIMIT, onError: (c) => c.json({ error: "Too large" }, 413) }), async (c) => {
    const from = peerCaller(mesh, c);
    if (!from || !current) return notFound(c);
    return c.json(await current.receiveReturn(from, (await body(c)) as never));
  });

  const browser = (c: Context): PoolAgent | Response => {
    if (onPeerListener(c) && !c.req.header("x-forwarded-host")) return notFound(c);
    return current ?? c.json({ error: "The mesh is off: there is no pool" }, 409);
  };
  app.put("/api/claude/pool/keeper", async (c) => {
    const agent = browser(c);
    if (agent instanceof Response) return agent;
    const device = ((await body(c)) as { device?: unknown } | undefined)?.device;
    const known = [mesh.self().id, ...mesh.peers().map((p) => p.id)];
    if (typeof device !== "string" || !known.includes(device)) return c.json({ error: "Expected { device } naming this host or a peer" }, 400);
    agent.setKeeper(device);
    return c.json(agent.view(), 200, { "Cache-Control": "no-store" });
  });
  app.put("/api/claude/pool/order", async (c) => {
    const agent = browser(c);
    if (agent instanceof Response) return agent;
    const order = ((await body(c)) as { order?: unknown } | undefined)?.order;
    if (!Array.isArray(order) || order.some((id) => typeof id !== "string") || !agent.setOrder(order as string[])) {
      return c.json({ error: "The order must list every login of the pool, each once" }, 400);
    }
    return c.json(agent.view(), 200, { "Cache-Control": "no-store" });
  });
  app.patch("/api/claude/pool/:id", async (c) => {
    const agent = browser(c);
    if (agent instanceof Response) return agent;
    const pin = ((await body(c)) as { pin?: unknown } | undefined)?.pin;
    const known = [mesh.self().id, ...mesh.peers().map((p) => p.id)];
    if (pin !== null && (typeof pin !== "string" || !known.includes(pin))) return c.json({ error: "Expected { pin } naming a device, or null" }, 400);
    if (!agent.setPin(c.req.param("id"), pin as string | null)) return c.json({ error: "No such login in the pool" }, 404);
    void agent.tick();
    return c.json(agent.view(), 200, { "Cache-Control": "no-store" });
  });
  app.post("/api/claude/pool/:id/return", (c) => {
    const agent = browser(c);
    if (agent instanceof Response) return agent;
    if (!agent.askReturn(c.req.param("id"))) return c.json({ error: "That login is not held by any device" }, 409);
    void agent.tick();
    return c.json(agent.view(), 200, { "Cache-Control": "no-store" });
  });
}

/**
 * Test knobs for the multi-host e2e (scripts/claude-pool-e2e): SOVA_CLAUDE_POOL_IDLE_MS,
 * SOVA_CLAUDE_POOL_CUT_MS (both drain bounds) and SOVA_CLAUDE_POOL_TICK_MS. Unset: the real ones.
 */
function testTimings(env: NodeJS.ProcessEnv = process.env): { idleMs?: number; quickCutMs?: number; slowCutMs?: number; tickMs?: number } {
  const n = (v: string | undefined) => (v && Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  const idle = n(env.SOVA_CLAUDE_POOL_IDLE_MS);
  const cut = n(env.SOVA_CLAUDE_POOL_CUT_MS);
  const tick = n(env.SOVA_CLAUDE_POOL_TICK_MS);
  return { ...(idle ? { idleMs: idle } : {}), ...(cut ? { quickCutMs: cut, slowCutMs: cut } : {}), ...(tick ? { tickMs: tick } : {}) };
}

/** Record each call's outcome as the peer's up-state (for "Stuck on …"). */
function trackingPeer(peer: PoolPeer, up: Map<string, boolean>): PoolPeer {
  const wrap = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    try {
      const r = await fn(...a);
      up.set(peer.id, true);
      return r;
    } catch (err) {
      up.set(peer.id, false);
      throw err;
    }
  };
  return {
    id: peer.id,
    doc: wrap(peer.doc),
    pushDoc: wrap(peer.pushDoc),
    lend: wrap(peer.lend),
    commit: wrap(peer.commit),
    giveBack: wrap(peer.giveBack),
  };
}
