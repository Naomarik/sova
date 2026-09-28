import { PUSH_KINDS, type AttentionItem, type PushKind, type PushPayload, type PushSettings, type PushTestResult } from "../shared/protocol";
import { blockerKey } from "./attention";
import { type Redactor, serverRedactor } from "./overseer-redact";
import { inQuietHours, noteDelivery, readDevices, readOrCreateVapid, readPushSettings, removeDevice, deviceId, type StoredDevice } from "./push-store";
import { isViewing } from "./seen";
import { sendPush } from "./web-push";

// Phone notifications (Web Push) for the attention digest's act tier. The Overseer loop calls
// `notifyBlockers` each tick, whether or not an Overseer exists and whatever its proactivity: this
// never starts a model turn. The rules are one pure function, `pushDecision`, like briefDecision.

/** At most one send per this long; blockers that arrive meanwhile wait and go out together. */
export const PUSH_MIN_GAP_MS = 30_000;
/** How long the push service keeps an undelivered message (seconds). */
export const PUSH_TTL_S = 6 * 3600;
const TITLE_MAX = 80;
const BODY_MAX = 300;

export const PUSH_KIND_LABEL: Record<PushKind, string> = {
  "needs-input": "Needs input",
  "open-questions": "Open questions",
  error: "Error",
  looping: "Subagent stuck",
  "baton-needs-you": "Baton",
  "worker-error": "Subagent error",
};

const isPushKind = (k: string): k is PushKind => (PUSH_KINDS as readonly string[]).includes(k);

type Blocker = Pick<AttentionItem, "id" | "kind" | "title" | "detail">;

export interface PushDecisionInput {
  /** The digest's act tier, in its order (most urgent first). */
  current: Blocker[];
  /** What was told (sent, or dropped on purpose), or null before the first reading. */
  announced: Set<string> | null;
  settings: PushSettings;
  /** Devices subscribed now. */
  devices: number;
  now: number;
  lastSentAt: number;
  quiet: boolean;
  viewing: (id: string) => boolean;
}

/**
 * Which blockers go out now. Pure, for the tests. The first reading is the baseline (nothing old is
 * sent); a blocker that clears leaves `announced`, so a recurrence is new. A fresh blocker is told
 * without sending — dropped for good — when sending is off, no contact is set, no device exists,
 * its kind is off, it's quiet hours, or its session is on screen. The rest wait while the last
 * send is under PUSH_MIN_GAP_MS old, then all go in one send.
 */
export function pushDecision(input: PushDecisionInput): { announced: Set<string>; send: Blocker[] } {
  const keys = input.current.map(blockerKey);
  if (input.announced === null) return { announced: new Set(keys), send: [] };
  const current = new Set(keys);
  const announced = new Set([...input.announced].filter((k) => current.has(k)));
  const fresh = input.current.filter((b) => !announced.has(blockerKey(b)));
  const s = input.settings;
  const off = !s.enabled || !s.contact || input.devices === 0 || input.quiet;
  const send: Blocker[] = [];
  for (const b of fresh) {
    if (off || !isPushKind(b.kind) || !s.kinds[b.kind] || input.viewing(b.id)) announced.add(blockerKey(b));
    else send.push(b);
  }
  if (send.length === 0 || input.now - input.lastSentAt < PUSH_MIN_GAP_MS) return { announced, send: [] };
  for (const b of send) announced.add(blockerKey(b));
  return { announced, send };
}

/** Whitespace runs become one space, line breaks stay (the several-sessions body is a line each). */
const clip = (s: string, max: number) => {
  const t = s.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const labelOf = (kind: string) => (isPushKind(kind) ? PUSH_KIND_LABEL[kind] : kind);

/**
 * The notification for one send. One session: "{Kind} · {title}", its details, tagged by the
 * session, opening it. Several: "{n} sessions need you", a line each, opening the Overseer. Titles
 * and details come from other sessions and land on a lock screen: redacted.
 */
export function pushPayload(send: Blocker[], count: number, now: number, redactor: () => Redactor = serverRedactor): PushPayload {
  const r = redactor();
  const bySession = new Map<string, Blocker[]>();
  for (const b of send) bySession.set(b.id, [...(bySession.get(b.id) ?? []), b]);
  const sessions = [...bySession.values()];
  if (sessions.length === 1) {
    const items = sessions[0]!;
    const first = items[0]!;
    const title = clip(r.redact(`${labelOf(first.kind)} · ${first.title || "Untitled session"}`), TITLE_MAX);
    const body = clip(r.redact(items.map((i) => i.detail ?? labelOf(i.kind)).join(" ")), BODY_MAX);
    return { v: 1, title, body, tag: `sova:${first.id}`, hash: `#/sid/${encodeURIComponent(first.id)}`, count, ts: now };
  }
  const body = clip(r.redact(sessions.map((items) => `${items[0]!.title || "Untitled session"} — ${labelOf(items[0]!.kind)}`).join("\n")), BODY_MAX);
  return { v: 1, title: `${sessions.length} sessions need you`, body, tag: "sova:several", hash: "#/overseer", count, ts: now };
}

/** Send one payload to `devices`; record each outcome; drop the ones the push service says are gone. */
export async function deliver(devices: StoredDevice[], payload: PushPayload, subject: string, fetchImpl?: typeof fetch): Promise<PushTestResult["results"]> {
  const keys = readOrCreateVapid();
  const text = JSON.stringify(payload);
  return Promise.all(
    devices.map(async (d) => {
      const out = await sendPush(d, text, { keys, subject, ttl: PUSH_TTL_S, urgency: "high", ...(fetchImpl ? { fetchImpl } : {}) });
      const id = deviceId(d.endpoint);
      const at = Date.now();
      if (out.status === "ok") {
        noteDelivery(d.endpoint, { ok: true, at });
        return { id, label: d.label, ok: true };
      }
      if (out.status === "gone") {
        removeDevice({ endpoint: d.endpoint }, false);
        return { id, label: d.label, ok: false, removed: true, error: `The push service no longer knows this device (${out.code}). It was removed.` };
      }
      noteDelivery(d.endpoint, { ok: false, at, error: out.message });
      return { id, label: d.label, ok: false, error: out.message };
    }),
  );
}

let announced: Set<string> | null = null;
let lastSentAt = 0;

/** Whether a tick has any reason to read the digest for phone notifications: sending is on and a device exists. */
export function pushWanted(): boolean {
  const s = readPushSettings();
  return s.enabled && !!s.contact && readDevices().length > 0;
}

/**
 * One tick's notifications. `act` is the digest's act tier; `count` the sessions that need you now
 * (the app badge). Never throws: a failure is logged and the next tick goes on.
 */
export async function notifyBlockers(act: Blocker[], count: number, now = Date.now()): Promise<void> {
  try {
    const settings = readPushSettings();
    const devices = readDevices();
    const d = pushDecision({
      current: act,
      announced,
      settings,
      devices: devices.length,
      now,
      lastSentAt,
      quiet: inQuietHours(settings.quietHours, new Date(now)),
      viewing: isViewing,
    });
    announced = d.announced;
    if (!d.send.length || !settings.contact) return;
    lastSentAt = now;
    const results = await deliver(devices, pushPayload(d.send, count, now), settings.contact);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) console.warn(`[push] ${failed.length} of ${results.length} device(s) failed: ${failed.map((f) => f.error).join("; ")}`);
  } catch (err) {
    console.warn("[push] skipped:", err instanceof Error ? err.message : String(err));
  }
}

/** Forget the told-set and the last send: the next reading is a new baseline (nothing wanted a
    notification meanwhile, so what is there then was never going to be sent). Also for the tests. */
export function resetPushState(): void {
  announced = null;
  lastSentAt = 0;
}

/** Send Test: one notification to every device (or one), ignoring the switches and quiet hours. */
export async function sendTest(id?: string, fetchImpl?: typeof fetch): Promise<PushTestResult | { status: 404 | 409; error: string }> {
  const settings = readPushSettings();
  if (!settings.contact) return { status: 409, error: "Save a contact address first. Push services refuse requests without one." };
  const devices = readDevices().filter((d) => !id || deviceId(d.endpoint) === id);
  if (!devices.length) return { status: 404, error: id ? "That device isn't subscribed any more." : "No device is subscribed yet." };
  const payload: PushPayload = { v: 1, title: "Test · Sova", body: "Notifications reach this device.", tag: "sova:test", hash: "#/", ts: Date.now() };
  return { results: await deliver(devices, payload, settings.contact, fetchImpl) };
}
