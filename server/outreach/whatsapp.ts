import type { SenderState, SenderStatus } from "../../shared/outreach";
import { meshPeers, peerFetch } from "../mesh";
import { SenderClient, SenderUnreachable, type Frame, type SenderEvent } from "./ipc-client";
import { localSocket, noteAuthDir, readOutreach } from "./settings";
import type { Channel, ChannelSend, Receipt } from "./types";

/**
 * The WhatsApp channel (§app.outreach/channels, /sender-route): a client of the sender, either on
 * this host (its Unix socket, services/whatsapp/IPC.md) or on a peer through that peer's Sova
 * (`/api/peer/outreach/*`, server/outreach/relay.ts). The sender owns the number; this module never
 * links, unlinks or reconnects it.
 */

const STATES: ReadonlySet<string> = new Set(["unpaired", "linking", "connecting", "open", "logged-out", "replaced", "blocked", "down"]);
const RING = 500;

let local: { path: string; client: SenderClient } | null = null;
const listeners: ((r: Receipt) => void)[] = [];
/** Receipt events the local sender sent, for the relay to hand each caller its own (newest last). */
const ring: SenderEvent[] = [];

function onSenderEvent(e: SenderEvent): void {
  if (e.ev !== "receipt") return;
  ring.push(e);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  const idem = typeof e.idem === "string" ? e.idem : "";
  if (idem.startsWith("local:")) dispatch(e);
}

function dispatch(e: Frame): void {
  const status = e.status;
  if (typeof e.ref !== "string" || (status !== "delivered" && status !== "read" && status !== "failed")) return;
  const r: Receipt = { ref: e.ref, status, ...(typeof e.code === "string" ? { code: e.code } : {}) };
  for (const cb of listeners) cb(r);
}

/** The local sender's client for the setting now; null when the sender is not local. */
export function localClient(): SenderClient | null {
  const path = localSocket(readOutreach().sender);
  if (!path) {
    local?.client.close();
    local = null;
    return null;
  }
  if (local?.path !== path) {
    local?.client.close();
    local = { path, client: new SenderClient(path, onSenderEvent) };
  }
  return local.client;
}

/** Drop the local connection (a save of the setting): the next use makes it afresh. */
export function resetLocalClient(): void {
  local?.client.close();
  local = null;
}

/** Receipt events of sends whose idem starts with `prefix`, after `since` (the relay). */
export const receiptsSince = (prefix: string, since: number): SenderEvent[] =>
  ring.filter((e) => e.seq > since && typeof e.idem === "string" && e.idem.startsWith(prefix));
export const newestSeq = (): number => ring.at(-1)?.seq ?? 0;

/** A sender frame as a status. */
export function statusOf(f: Frame): SenderStatus {
  const state = typeof f.state === "string" && STATES.has(f.state) ? (f.state as SenderState) : "down";
  const out: SenderStatus = { state };
  if (typeof f.why === "string") out.why = f.why;
  if (typeof f.paused === "boolean") out.paused = f.paused;
  if (typeof f.me === "string") out.me = f.me;
  if (f.limits && typeof f.limits === "object") out.limits = f.limits as SenderStatus["limits"];
  if (f.usage && typeof f.usage === "object") out.usage = f.usage as SenderStatus["usage"];
  if (typeof f.version === "string") out.version = f.version;
  return out;
}

const failed = (code: string, why: string, retryable = false): ChannelSend => ({ ok: false, code, retryable, why });

/** A sender's answer to `send` as a channel result. */
export function sendResultOf(f: Frame): ChannelSend {
  if (f.ok === true && typeof f.ref === "string") return { ok: true, ref: f.ref, at: typeof f.at === "string" ? f.at : new Date().toISOString() };
  const code = typeof f.code === "string" ? f.code : "failed";
  return failed(code, typeof f.why === "string" ? f.why : "The sender refused the message.", f.retryable === true);
}

// ---- via a peer ----------------------------------------------------------------------------------

const viaSeq = new Map<string, number>();

function peerIdOf(nodeId: string): string | null {
  return meshPeers().find((p) => p.nodeId === nodeId)?.id ?? null;
}

async function viaCall(nodeId: string, op: string, body: Frame = {}): Promise<Frame> {
  const peerId = peerIdOf(nodeId);
  if (!peerId) throw new SenderUnreachable("The sender's host is not one of this host's peers.");
  let res: Response;
  try {
    res = await peerFetch(peerId, `/api/peer/outreach/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) });
  } catch {
    throw new SenderUnreachable("The sender's host can't be reached.");
  }
  let f: Frame;
  try {
    f = (await res.json()) as Frame;
  } catch {
    throw new SenderUnreachable(`The sender's host answered ${res.status}.`);
  }
  if (res.status === 403) throw new SenderUnreachable("The sender's host doesn't accept sends from this host (its Accept sends from).");
  if (res.status === 404) throw new SenderUnreachable("The sender's host has no sender of its own.");
  return f;
}

/** Pull the peer's receipts of this host's sends (after a send, a few times; receipts come within seconds). */
function pollVia(nodeId: string, delays = [5_000, 30_000, 120_000, 600_000]): void {
  for (const d of delays) {
    const t = setTimeout(() => {
      void viaCall(nodeId, "events", { since: viaSeq.get(nodeId) ?? 0 })
        .then((f) => {
          if (typeof f.seq === "number") viaSeq.set(nodeId, Math.max(viaSeq.get(nodeId) ?? 0, f.seq));
          if (Array.isArray(f.events)) for (const e of f.events) if (e && typeof e === "object") dispatch(e as Frame);
        })
        .catch(() => {});
    }, d);
    t.unref?.();
  }
}

// ---- the channel ---------------------------------------------------------------------------------

export const whatsapp: Channel = {
  id: "whatsapp",
  async status() {
    const route = readOutreach().sender;
    if (route === "off") return { state: "off" };
    try {
      if ("via" in route) return statusOf(await viaCall(route.via.nodeId, "status"));
      const c = localClient()!;
      const f = await c.request("status", {}, 10_000);
      const authDir = c.hello?.authDir;
      if (typeof authDir === "string") noteAuthDir(authDir);
      return f.ok === false ? { state: "down", why: String(f.why ?? "The sender refused.") } : statusOf(f);
    } catch (err) {
      return { state: "unreachable", why: err instanceof Error ? err.message : String(err) };
    }
  },
  async send({ idem, address, text }) {
    const route = readOutreach().sender;
    if (route === "off") return failed("off", "Outreach is off: set it up in Settings → Outreach.");
    try {
      if ("via" in route) {
        const r = sendResultOf(await viaCall(route.via.nodeId, "send", { idem, digits: address, text }));
        if (r.ok) pollVia(route.via.nodeId);
        return r;
      }
      return sendResultOf(await localClient()!.request("send", { idem: `local:${idem}`, digits: address, text }));
    } catch (err) {
      // Unreachable before the request went out, or no answer: the idem makes a Retry safe either way.
      return failed("unreachable", err instanceof Error ? err.message : String(err), true);
    }
  },
  onReceipt(cb) {
    listeners.push(cb);
  },
};
