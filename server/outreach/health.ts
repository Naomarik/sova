import type { AttentionItem } from "../../shared/protocol";
import { SENDER_DOWN_STATES, SENDER_UNREACHABLE_ALERT_MS, sovaWhy, type SenderStatus } from "../../shared/outreach";

/**
 * What this host last read of each WhatsApp sender it uses, by its entry id (§app.outreach/sender-health):
 * every status it reads (Settings, a send, the watch in ./core.ts) and every `state` event a local
 * sender sends. Memory only. It answers a send's readiness without a round trip (§app.outreach/send),
 * and raises one Needs you item of no session per sender, `whatsapp-down`, while a person has to deal
 * with that sender. Each sender is judged alone: one being down never says anything about another.
 */

interface Reading {
  status: SenderStatus;
  /** When it was read. */
  at: number;
  /** Since when the state has read the same (unreachable included). */
  since: number;
}

const readings = new Map<string, Reading>();
/** The label each sender's item names, as the last reading's caller said it. */
const labels = new Map<string, string>();
const changeHooks: ((id: string, status: SenderStatus) => void)[] = [];

/** Called with each reading whose state differs from that sender's last one (its first reading too). */
export function onSenderChange(fn: (id: string, status: SenderStatus) => void): void {
  changeHooks.push(fn);
}

/** A status of sender `id` as read now. A reading of the same state keeps when it began; `off` forgets it. */
export function noteSenderStatus(id: string, status: SenderStatus, now = Date.now(), label?: string): SenderStatus {
  if (label) labels.set(id, label);
  if (status.state === "off") {
    readings.delete(id);
    return status;
  }
  const last = readings.get(id);
  const changed = !last || last.status.state !== status.state;
  const since = changed ? now : last!.since;
  const next = { status: { ...status }, at: now, since };
  readings.set(id, next);
  if (changed)
    for (const fn of changeHooks)
      try {
        fn(id, next.status);
      } catch (err) {
        console.warn(`[outreach] sender change listener: ${err instanceof Error ? err.message : String(err)}`);
      }
  return { ...status, since: new Date(since).toISOString() };
}

/** A `state` event of a local sender: its state, why, next try and pause, over its last reading's figures. */
export function noteSenderState(id: string, f: Pick<SenderStatus, "state" | "why" | "retryAt" | "paused">, now = Date.now()): void {
  const base = readings.get(id)?.status ?? { state: f.state };
  const { why: _why, retryAt: _retryAt, ...rest } = base;
  noteSenderStatus(id, { ...rest, state: f.state, ...(f.why ? { why: f.why } : {}), ...(f.retryAt ? { retryAt: f.retryAt } : {}), ...(typeof f.paused === "boolean" ? { paused: f.paused } : {}) }, now);
}

/** Sender `id`'s last reading, or null (none yet, or it is off). */
export function senderReading(id: string): Readonly<Reading> | null {
  return readings.get(id) ?? null;
}

/** Forget the readings of senders no longer in use, so their items clear. */
export function keepReadings(ids: ReadonlySet<string>): void {
  for (const id of [...readings.keys()]) if (!ids.has(id)) readings.delete(id);
}

/** Tests: forget the readings. */
export function resetSenderHealth(): void {
  readings.clear();
  labels.clear();
}

/**
 * The state a person has to deal with now, from one sender's last reading: a stop state, or
 * unreachable for 5 minutes. A `down` with its next try still ahead (the reconnect limit spent) heals
 * itself and never alerts; once that try is overdue it didn't, and it does.
 */
export function senderAlert(id: string, now = Date.now()): SenderStatus | null {
  const last = readings.get(id);
  if (!last) return null;
  const s = last.status;
  if (s.state === "down" && s.retryAt && Date.parse(s.retryAt) > now) return null;
  if (SENDER_DOWN_STATES.has(s.state)) return s;
  if (s.state === "unreachable" && now - last.since >= SENDER_UNREACHABLE_ALERT_MS) return s;
  return null;
}

export const SENDER_ITEM_PREFIX = "whatsapp-sender:";
export const SENDER_SETTINGS_HREF = "#/settings/outreach";

/**
 * Needs you (§app.overseer/attention-digest): per sender, "WhatsApp sending is down for {label}: {why}",
 * act tier, opening Settings → Outreach; while that sender is down, logged out, replaced, blocked or
 * unpaired, or unreachable for 5 minutes. A sender that is connecting, a backoff wait included, or
 * down with its next try still ahead (a self-healing wait), never raises it; nor, built from these
 * items, does a phone notification (§app.notifications/delivery).
 */
export function senderAttention(now = Date.now()): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const [id, last] of readings) {
    const s = senderAlert(id, now);
    if (!s) continue;
    const why = s.state === "unreachable" ? `Sova can't reach the sender${s.why ? `: ${s.why}` : "."}` : (sovaWhy(s) ?? `the sender is ${s.state}.`);
    out.push({
      id: `${SENDER_ITEM_PREFIX}${id}`,
      path: "",
      title: "WhatsApp sending",
      where: "Settings → Outreach",
      tier: "act",
      kind: "whatsapp-down",
      since: last.since,
      detail: clip(`WhatsApp sending is down for ${labels.get(id) ?? id}: ${why}`, 200),
      href: SENDER_SETTINGS_HREF,
    });
  }
  return out;
}

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
