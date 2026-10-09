import type { AttentionItem } from "../../shared/protocol";
import { SENDER_DOWN_STATES, SENDER_UNREACHABLE_ALERT_MS, type SenderStatus } from "../../shared/outreach";

/**
 * What this host last read of the WhatsApp sender (§app.outreach/sender-health): every status it reads
 * (Settings, a send, the watch below) and every `state` event the local sender sends. Memory only. It
 * answers a send's readiness without a round trip (§app.outreach/send), and raises the one Needs you
 * item of no session, `whatsapp-down`, while a person has to deal with the sender.
 */

interface Reading {
  status: SenderStatus;
  /** When it was read. */
  at: number;
  /** Since when the state has read the same (unreachable included). */
  since: number;
}

let last: Reading | null = null;
const changeHooks: ((status: SenderStatus) => void)[] = [];

/** Called with each reading whose state differs from the last one's (the first reading too). */
export function onSenderChange(fn: (status: SenderStatus) => void): void {
  changeHooks.push(fn);
}

/** A status as read now. A reading of the same state keeps when it began; `off` forgets it. */
export function noteSenderStatus(status: SenderStatus, now = Date.now()): SenderStatus {
  if (status.state === "off") {
    last = null;
    return status;
  }
  const changed = !last || last.status.state !== status.state;
  const since = changed ? now : last!.since;
  last = { status: { ...status }, at: now, since };
  if (changed)
    for (const fn of changeHooks)
      try {
        fn(last.status);
      } catch (err) {
        console.warn(`[outreach] sender change listener: ${err instanceof Error ? err.message : String(err)}`);
      }
  return { ...status, since: new Date(since).toISOString() };
}

/** A `state` event of the local sender: its state, why, next try and pause, over the last reading's figures. */
export function noteSenderState(f: Pick<SenderStatus, "state" | "why" | "retryAt" | "paused">, now = Date.now()): void {
  const base = last?.status ?? { state: f.state };
  const { why: _why, retryAt: _retryAt, ...rest } = base;
  noteSenderStatus({ ...rest, state: f.state, ...(f.why ? { why: f.why } : {}), ...(f.retryAt ? { retryAt: f.retryAt } : {}), ...(typeof f.paused === "boolean" ? { paused: f.paused } : {}) }, now);
}

/** The last reading, or null (none yet, or the sender is off). */
export function senderReading(): Readonly<Reading> | null {
  return last;
}

/** Tests: forget the readings. */
export function resetSenderHealth(): void {
  last = null;
}

/** The state a person has to deal with now, from the last reading: a stop state, or unreachable for 5 minutes. */
export function senderAlert(now = Date.now()): SenderStatus | null {
  if (!last) return null;
  const s = last.status;
  if (SENDER_DOWN_STATES.has(s.state)) return s;
  if (s.state === "unreachable" && now - last.since >= SENDER_UNREACHABLE_ALERT_MS) return s;
  return null;
}

export const SENDER_ITEM_ID = "whatsapp-sender";
export const SENDER_SETTINGS_HREF = "#/settings/outreach";

/**
 * Needs you (§app.overseer/attention-digest): "WhatsApp sending is down: {why}", act tier, opening
 * Settings → Outreach; while the sender is down, logged out, replaced, blocked or unpaired, or
 * unreachable for 5 minutes. A sender that is connecting, a backoff wait included, never raises it.
 */
export function senderAttention(now = Date.now()): AttentionItem[] {
  const s = senderAlert(now);
  if (!s || !last) return [];
  const why = s.state === "unreachable" ? `Sova can't reach the sender${s.why ? `: ${s.why}` : "."}` : (s.why ?? `the sender is ${s.state}.`);
  return [
    {
      id: SENDER_ITEM_ID,
      path: "",
      title: "WhatsApp sending",
      where: "Settings → Outreach",
      tier: "act",
      kind: "whatsapp-down",
      since: last.since,
      detail: clip(`WhatsApp sending is down: ${why}`, 200),
      href: SENDER_SETTINGS_HREF,
    },
  ];
}

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
