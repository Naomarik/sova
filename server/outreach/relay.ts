import type { Context, Hono } from "hono";
import type { MeshApi } from "../mesh";
import { SenderUnreachable, type Frame } from "./ipc-client";
import { readOutreach } from "./settings";
import { newestSeq, receiptsSince, relayLocal } from "./whatsapp";

/**
 * The relay (§app.outreach/sender-route): a host whose default sender is on this host (its own, or a
 * number added here) sends through that one for the peers its
 * `acceptFrom` lists, over the peer listener (the caller is its verified StableID, never a body
 * field). `status`, `check`, `send` and `events`; and `reconnect` for a peer this host grants full
 * control (the listener's `admin` capability, server/mesh/access.ts), never while the account is
 * blocked (§app.outreach/sender-controls). Linking, unlinking and pausing are the sender host's own.
 * A caller's idempotency key is namespaced by its StableID, and it gets only the receipts of its own sends.
 */

export const accepts = (acceptFrom: "all" | string[], nodeId: string): boolean => acceptFrom === "all" || acceptFrom.includes(nodeId);

/** The status frame a peer may see: never the auth directory. */
const RELAYED_STATUS = ["state", "why", "retryAt", "paused", "me", "limits", "usage", "version"];

export function mountOutreachRelay(app: Hono, mesh: Pick<MeshApi, "requestPeer" | "peers">): void {
  const gate = (c: Context): { nodeId: string } | Response => {
    const peer = mesh.requestPeer(c);
    if (!peer) return c.json({ error: "Not found" }, 404);
    const f = readOutreach();
    if (!relayLocal()) return c.json({ ok: false, code: "no-sender", retryable: false, why: "This host has no sender of its own." }, 404);
    if (!accepts(f.acceptFrom, peer.nodeId) || !mesh.peers().some((p) => p.nodeId === peer.nodeId))
      return c.json({ ok: false, code: "not-accepted", retryable: false, why: "This host doesn't accept sends from yours." }, 403);
    return { nodeId: peer.nodeId };
  };
  const body = async (c: Context): Promise<Frame> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Frame) : {};
    } catch {
      return {};
    }
  };
  const call = async (c: Context, op: string, req: Frame): Promise<Response> => {
    const client = relayLocal()?.client;
    if (!client) return c.json({ ok: false, code: "no-sender", retryable: false, why: "This host has no sender of its own." }, 404);
    try {
      return c.json(await client.request(op, req));
    } catch (err) {
      return c.json({ ok: false, code: "unreachable", retryable: true, why: err instanceof SenderUnreachable ? err.message : "The sender didn't answer." }, 502);
    }
  };

  app.post("/api/peer/outreach/status", async (c) => {
    const g = gate(c);
    if (g instanceof Response) return g;
    const r = await call(c, "status", {});
    if (r.status !== 200) return r;
    const f = (await r.json()) as Frame;
    return c.json(Object.fromEntries(Object.entries(f).filter(([k]) => RELAYED_STATUS.includes(k) || k === "ok")));
  });
  app.post("/api/peer/outreach/check", async (c) => {
    const g = gate(c);
    if (g instanceof Response) return g;
    const b = await body(c);
    return call(c, "check", { digits: b.digits });
  });
  app.post("/api/peer/outreach/send", async (c) => {
    const g = gate(c);
    if (g instanceof Response) return g;
    const b = await body(c);
    if (typeof b.idem !== "string" || !b.idem) return c.json({ ok: false, code: "invalid", retryable: false, why: "idem is required." }, 400);
    return call(c, "send", { idem: `${g.nodeId}:${b.idem}`, digits: b.digits, text: b.text });
  });
  app.post("/api/peer/outreach/events", async (c) => {
    const g = gate(c);
    if (g instanceof Response) return g;
    const b = await body(c);
    const since = typeof b.since === "number" && b.since >= 0 ? b.since : 0;
    // Only this caller's receipts, without its namespace; the idem stays the caller's own key.
    const l = relayLocal();
    if (!l) return c.json({ seq: 0, events: [] });
    const events = receiptsSince(l, `${g.nodeId}:`, since).map((e) => ({ ...e, idem: String(e.idem).slice(g.nodeId.length + 1) }));
    return c.json({ seq: newestSeq(l), events });
  });
  // One immediate attempt, outside the budget. The listener let this through only with the admin grant.
  // Blocked is the sender host's own call: a reconnect there risks a ban, so its own page warns first.
  app.post("/api/peer/outreach/reconnect", async (c) => {
    const g = gate(c);
    if (g instanceof Response) return g;
    const r = await call(c, "status", {});
    if (r.status !== 200) return r;
    const st = (await r.json()) as Frame;
    if (st.state === "blocked") return c.json({ ok: false, code: "refused", retryable: false, why: "WhatsApp blocked this account: only the sender's own host reconnects it, after its ban-risk warning." }, 403);
    return call(c, "reconnect", {});
  });
  // Everything else under the prefix: the sender host's operator only.
  app.post("/api/peer/outreach/:op", (c) => {
    if (!mesh.requestPeer(c)) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: false, code: "refused", retryable: false, why: "Only the sender's own host links, unlinks or pauses it." }, 403);
  });
}
