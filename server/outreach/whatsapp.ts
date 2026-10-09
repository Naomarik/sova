import type { SenderState, SenderStatus } from "../../shared/outreach";
import { meshPeers, peerFetch } from "../mesh";
import { noteSenderState, noteSenderStatus } from "./health";
import { SenderClient, SenderUncertain, SenderUnreachable, type Frame, type SenderClientOptions, type SenderEvent } from "./ipc-client";
import { noteLinkEvent } from "./link";
import { localSocket, noteAuthDir, readOutreach } from "./settings";
import type { Channel, ChannelSend, Receipt } from "./types";

/**
 * The WhatsApp channel (§app.outreach/channels, /sender-route): a client of the sender, either on
 * this host (its Unix socket, services/whatsapp/IPC.md) or on a peer through that peer's Sova
 * (`/api/peer/outreach/*`, server/outreach/relay.ts). The sender owns the number; this module
 * reconnects, pauses, links or unlinks it only for the operator's own buttons on the sender's host
 * (§app.outreach/sender-controls, /sender-link). Every status it reads and every `state` event is
 * noted in ./health.ts; the link events go to ./link.ts and nowhere else.
 */

const STATES: ReadonlySet<string> = new Set(["unpaired", "linking", "connecting", "open", "logged-out", "replaced", "blocked", "down"]);
const RING = 500;

let local: { path: string; client: SenderClient } | null = null;
let clientOptions: SenderClientOptions = {};
const listeners: ((r: Receipt) => void)[] = [];
/** Receipt events the local sender sent, for the relay to hand each caller its own (newest last). */
const ring: SenderEvent[] = [];

function onSenderEvent(e: SenderEvent): void {
  // A QR is as good as the credentials: ./link.ts alone sees it, and only for a link this page started.
  if (e.ev === "qr" || e.ev === "paired" || e.ev === "state") noteLinkEvent(e);
  if (e.ev === "state") {
    // A replayed event dates the state from when it happened, never later than now.
    const now = Date.now();
    const at = typeof e.at === "string" ? Date.parse(e.at) : NaN;
    const f = statusOf(e);
    if (typeof e.state === "string" && STATES.has(e.state)) noteSenderState(f, Number.isFinite(at) ? Math.min(at, now) : now);
    return;
  }
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
    local = { path, client: new SenderClient(path, onSenderEvent, clientOptions) };
  }
  return local.client;
}

/** Tests: how the next local client connects (an in-memory sender, no retry gap); {} restores the socket. */
export function setSenderClientOptionsForTest(o: SenderClientOptions): void {
  clientOptions = o;
  resetLocalClient();
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
  if (typeof f.retryAt === "string" && Number.isFinite(Date.parse(f.retryAt))) out.retryAt = f.retryAt;
  if (typeof f.paused === "boolean") out.paused = f.paused;
  if (typeof f.me === "string") out.me = f.me;
  const counts = <K extends string>(v: unknown, keys: readonly K[]): Record<K, number> | undefined =>
    v && typeof v === "object" && keys.every((k) => typeof (v as Record<string, unknown>)[k] === "number")
      ? (Object.fromEntries(keys.map((k) => [k, (v as Record<string, number>)[k]])) as Record<K, number>)
      : undefined;
  const limits = counts(f.limits, ["gapS", "perHour", "perDay"] as const);
  if (limits) out.limits = limits;
  const usage = counts(f.usage, ["hour", "day"] as const);
  if (usage) out.usage = usage;
  const reconnects = counts(f.reconnects, ["hour", "day", "perHour", "perDay"] as const);
  if (reconnects) out.reconnects = reconnects;
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
  } catch (err) {
    // A timeout means the request left: its outcome is unknown.
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) throw new SenderUncertain("The sender's host didn't answer in time.");
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

// ---- the operator's controls (§app.outreach/sender-controls) ---------------------------------------

/** A control's answer: the sender's, or why it couldn't be asked. */
export type ControlAnswer = { ok: true; frame: Frame } | { ok: false; why: string; code?: string };

const answerOf = (f: Frame): ControlAnswer =>
  f.ok === false ? { ok: false, why: typeof f.why === "string" ? f.why : "The sender refused.", ...(typeof f.code === "string" ? { code: f.code } : {}) } : { ok: true, frame: f };

/** `reconnect {}`, `pause {on}` or `unlink {confirm: true}` on this host's own sender. Never the relay's: the routes call it for the operator only. */
export async function localControl(op: "reconnect" | "pause" | "unlink", body: Frame = {}): Promise<ControlAnswer> {
  const c = localClient();
  if (!c) return { ok: false, why: "This host has no sender of its own." };
  try {
    const req = op === "pause" ? { on: body.on === true } : op === "unlink" ? { confirm: true } : {};
    // An unlink logs the device out first, which the sender waits up to 10 s for.
    return answerOf(await c.request(op, req, op === "unlink" ? 20_000 : 10_000));
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err), code: "unreachable" };
  }
}

/**
 * The status of the sender at `path` on this host, whatever the setting (§app.outreach/sender-list):
 * the setting's own client when it is that socket, else a connection made for this one question.
 */
export async function probeLocal(path: string): Promise<SenderStatus> {
  const c = localClient();
  const own = c?.socketPath === path;
  const client = own ? c! : new SenderClient(path, () => {}, { ...clientOptions, retryMs: 0 });
  try {
    const f = await client.request("status", {}, 5_000);
    return f.ok === false ? { state: "down", why: String(f.why ?? "The sender refused.") } : statusOf(f);
  } catch (err) {
    return { state: "unreachable", why: err instanceof Error ? err.message : String(err) };
  } finally {
    if (!own) client.close();
  }
}

/** The status of a peer's sender through its relay, or why it has none this host may use (§app.outreach/sender-list). */
export async function peerSenderStatus(nodeId: string, ms = 5_000): Promise<{ status: SenderStatus } | { why: string }> {
  const peerId = peerIdOf(nodeId);
  if (!peerId) return { why: "It is not one of this host's peers." };
  let res: Response;
  try {
    res = await peerFetch(peerId, "/api/peer/outreach/status", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(ms) });
  } catch {
    return { why: "It can't be reached." };
  }
  if (res.status === 403) return (await res.body?.cancel(), { why: "It doesn't accept sends from this host." });
  if (res.status === 404) return (await res.body?.cancel(), { why: "It has no sender of its own." });
  try {
    const f = (await res.json()) as Frame;
    if (res.status !== 200) return { why: typeof f.why === "string" ? f.why : `It answered ${res.status}.` };
    return { status: statusOf(f) };
  } catch {
    return { why: `It answered ${res.status}.` };
  }
}

/** Reconnect on the peer whose sender this host uses (`via`): that peer's admin grant decides. */
export async function viaReconnect(nodeId: string): Promise<ControlAnswer> {
  const peerId = peerIdOf(nodeId);
  if (!peerId) return { ok: false, why: "The sender's host is not one of this host's peers." };
  let res: Response;
  try {
    res = await peerFetch(peerId, "/api/peer/outreach/reconnect", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(20_000) });
  } catch {
    return { ok: false, why: "The sender's host can't be reached.", code: "unreachable" };
  }
  if (res.status === 403 && res.headers.get("x-sova-mesh") === "denied") {
    await res.body?.cancel();
    return { ok: false, code: "denied", why: "The sender's host doesn't give this host full control, so only its own Settings can reconnect it." };
  }
  let f: Frame;
  try {
    f = (await res.json()) as Frame;
  } catch {
    return { ok: false, why: `The sender's host answered ${res.status}.` };
  }
  return answerOf(f);
}

export const whatsapp: Channel = {
  id: "whatsapp",
  async status() {
    const route = readOutreach().sender;
    if (route === "off") return noteSenderStatus({ state: "off" });
    let s: SenderStatus;
    try {
      if ("via" in route) s = statusOf(await viaCall(route.via.nodeId, "status"));
      else {
        const c = localClient()!;
        const f = await c.request("status", {}, 10_000);
        const authDir = c.hello?.authDir;
        if (typeof authDir === "string") noteAuthDir(authDir);
        s = f.ok === false ? { state: "down", why: String(f.why ?? "The sender refused.") } : statusOf(f);
      }
    } catch (err) {
      s = { state: "unreachable", why: err instanceof Error ? err.message : String(err) };
    }
    return noteSenderStatus(s);
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
      const why = err instanceof Error ? err.message : String(err);
      // Sent but unanswered: it may have gone (a Retry is still safe: the same idem never sends twice).
      if (err instanceof SenderUncertain) return failed("unknown", `${why} It may have been sent.`);
      return failed("unreachable", why, true);
    }
  },
  onReceipt(cb) {
    listeners.push(cb);
  },
};
