import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PUSH_KINDS, type PushDevice, type PushKind, type PushSettings } from "../shared/protocol";
import { contactProblem, HHMM } from "../shared/push";
import { writeAtomic } from "./overseer-store";
import { stateRoot } from "./state-root";
import { fromB64url, generateVapidKeys, type PushTarget, validVapidKeys, type VapidKeys } from "./web-push";

/**
 * Phone notifications' Sova-owned files under the state root, each read per call (the tests move
 * PI_CODING_AGENT_DIR), with the store rules of overseer-store.ts: atomic tmp+rename, re-read
 * before every write, tolerant on read.
 * - `secrets/vapid.json`: the signing key pair, made on first use and never rotated (a new key
 *   orphans every subscription). Dir 0700, file 0600, like decide-secret.ts; the private key never
 *   reaches the wire, and overseer-redact.ts hides it from the Overseer.
 * - `push-subscriptions.json`: the devices, keyed by endpoint.
 * - `push.json`: the settings.
 */
export const vapidFile = () => join(stateRoot(), "secrets", "vapid.json");
export const pushDevicesFile = () => join(stateRoot(), "push-subscriptions.json");
export const pushSettingsFile = () => join(stateRoot(), "push.json");

// ---- VAPID keys ------------------------------------------------------------------------------------

/** The key pair, made and stored on first use. A file that holds no valid pair is never overwritten. */
export function readOrCreateVapid(file = vapidFile()): VapidKeys {
  let raw: string | null = null;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // none yet
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!validVapidKeys(parsed)) throw new Error(`${file} holds no valid key pair; move it aside to make a new one (every device then subscribes again)`);
    return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
  }
  const keys = generateVapidKeys();
  const dir = join(file, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...keys, createdAt: Date.now() }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return keys;
}

// ---- settings --------------------------------------------------------------------------------------

/** The kind "open-questions" replaced (the asks-you classifier), still found in older push.json files. */
const LEGACY_ASKS_YOU = "asks-you";
/** A retired kind (a stuck subagent is a decide item now, never a blocker): a stored choice is dropped. */
const RETIRED_LOOPING = "looping";

export const DEFAULT_KINDS: Record<PushKind, boolean> = {
  "needs-input": true,
  "open-questions": true,
  error: true,
  "baton-needs-you": true,
  "worker-error": false,
  "playbook-review": true,
  "whatsapp-down": true,
};

export function defaultPushSettings(): PushSettings {
  return { version: 1, enabled: true, contact: null, kinds: { ...DEFAULT_KINDS }, quietHours: { enabled: false, start: "22:00", end: "07:00" } };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Parse settings. `strict` (a PUT): the first problem, as a sentence. Tolerant (a read): per-field defaults. */
export function parsePushSettings(raw: unknown, strict: boolean): PushSettings | { error: string } {
  const out = defaultPushSettings();
  if (!isObj(raw)) return strict ? { error: "Expected a JSON object." } : out;
  const fail = (error: string) => (strict ? { error } : null);
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
    else {
      const e = fail("enabled must be true or false.");
      if (e) return e;
    }
  }
  if (raw.contact !== undefined && raw.contact !== null) {
    const c = typeof raw.contact === "string" ? raw.contact.trim() : null;
    const problem = c === null ? "contact must be a string or null." : c === "" ? null : contactProblem(c);
    if (problem) {
      const e = fail(problem);
      if (e) return e;
    } else out.contact = c || null;
  }
  if (raw.kinds !== undefined) {
    if (!isObj(raw.kinds)) {
      const e = fail("kinds must be an object.");
      if (e) return e;
    } else
      for (const [k, v] of Object.entries(raw.kinds)) {
        // "asks-you" became "open-questions": a stored choice carries over (an explicit
        // open-questions wins), and a stale client still sending the old key is not refused for it.
        if (k === LEGACY_ASKS_YOU && typeof v === "boolean") {
          if (!isObj(raw.kinds) || raw.kinds["open-questions"] === undefined) out.kinds["open-questions"] = v;
          continue;
        }
        // Dropped, and a stale client still sending it is not refused for it.
        if (k === RETIRED_LOOPING && typeof v === "boolean") continue;
        if (!(PUSH_KINDS as readonly string[]).includes(k) || typeof v !== "boolean") {
          const e = fail(`kinds.${k} isn't a notification kind with a true or false value.`);
          if (e) return e;
          continue;
        }
        out.kinds[k as PushKind] = v;
      }
  }
  if (raw.quietHours !== undefined) {
    const q = raw.quietHours;
    if (!isObj(q) || typeof q.enabled !== "boolean" || typeof q.start !== "string" || typeof q.end !== "string" || !HHMM.test(q.start) || !HHMM.test(q.end)) {
      const e = fail("quietHours needs enabled (true or false), and start and end as HH:MM.");
      if (e) return e;
    } else if (q.start === q.end) {
      const e = fail("Quiet hours can't start and end at the same time.");
      if (e) return e;
    } else out.quietHours = { enabled: q.enabled, start: q.start, end: q.end };
  }
  return out;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function readPushSettings(file = pushSettingsFile()): PushSettings {
  return parsePushSettings(readJson(file), false) as PushSettings;
}

/** Strict: the reason on a bad body, else the settings as written. A save that changes nothing writes nothing. */
export function writePushSettings(raw: unknown, file = pushSettingsFile()): PushSettings | { error: string } {
  const parsed = parsePushSettings(raw, true);
  if ("error" in parsed) return parsed;
  if (JSON.stringify(readPushSettings(file)) !== JSON.stringify(parsed) || readJson(file) === undefined) writeAtomic(file, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

/** Inside quiet hours at `now`, server-local time. A range that crosses midnight (22:00–07:00) wraps. */
export function inQuietHours(q: PushSettings["quietHours"], now: Date): boolean {
  if (!q.enabled) return false;
  const min = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const t = now.getHours() * 60 + now.getMinutes();
  const a = min(q.start);
  const b = min(q.end);
  return a < b ? t >= a && t < b : t >= a || t < b;
}

// ---- devices ---------------------------------------------------------------------------------------

export interface StoredDevice extends PushTarget {
  label: string;
  createdAt: number;
  lastOkAt?: number;
  lastError?: string;
  lastErrorAt?: number;
}

interface DevicesFile {
  version: 1;
  subscriptions: StoredDevice[];
  /** Ids removed on purpose (Remove, Turn Off): a load-time re-sync of one is refused. Newest last, capped. */
  removed: string[];
}

const REMOVED_MAX = 50;
export const LABEL_MAX = 80;

/** A device's wire id: the first 16 hex of SHA-256 over its endpoint (src/lib/push.ts computes the same). */
export const deviceId = (endpoint: string): string => createHash("sha256").update(endpoint).digest("hex").slice(0, 16);

/** A subscription a browser can have made: an https endpoint, a 65-byte P-256 point and a 16-byte secret. The reason, or null. */
export function subscriptionProblem(raw: unknown): string | null {
  if (!isObj(raw) || typeof raw.endpoint !== "string" || !isObj(raw.keys)) return "subscription needs endpoint and keys.";
  let url: URL;
  try {
    url = new URL(raw.endpoint);
  } catch {
    return "The endpoint isn't a URL.";
  }
  if (url.protocol !== "https:" || raw.endpoint.length > 2000) return "The endpoint must be an https URL.";
  const { p256dh, auth } = raw.keys;
  if (typeof p256dh !== "string" || typeof auth !== "string") return "keys needs p256dh and auth.";
  const pub = fromB64url(p256dh);
  if (pub.length !== 65 || pub[0] !== 4) return "keys.p256dh isn't a P-256 public key.";
  if (fromB64url(auth).length !== 16) return "keys.auth must be 16 bytes.";
  return null;
}

function validStored(d: unknown): d is StoredDevice {
  return isObj(d) && subscriptionProblem(d) === null && typeof d.label === "string" && typeof d.createdAt === "number";
}

function readDevicesFile(file: string): DevicesFile {
  const raw = readJson(file);
  if (!isObj(raw)) return { version: 1, subscriptions: [], removed: [] };
  const subscriptions = Array.isArray(raw.subscriptions) ? raw.subscriptions.filter(validStored) : [];
  const removed = Array.isArray(raw.removed) ? raw.removed.filter((x): x is string => typeof x === "string") : [];
  return { version: 1, subscriptions, removed };
}

const writeDevicesFile = (f: DevicesFile, file: string) => writeAtomic(file, `${JSON.stringify(f, null, 2)}\n`);

export const readDevices = (file = pushDevicesFile()): StoredDevice[] => readDevicesFile(file).subscriptions;

export const wireDevice = (d: StoredDevice): PushDevice => {
  let service = "";
  try {
    service = new URL(d.endpoint).host;
  } catch {
    // validStored checked it
  }
  return {
    id: deviceId(d.endpoint),
    label: d.label,
    service,
    createdAt: d.createdAt,
    ...(d.lastOkAt !== undefined ? { lastOkAt: d.lastOkAt } : {}),
    ...(d.lastError !== undefined ? { lastError: d.lastError, ...(d.lastErrorAt !== undefined ? { lastErrorAt: d.lastErrorAt } : {}) } : {}),
  };
};

export type UpsertResult = { device: StoredDevice } | { removed: true } | { error: string };

/**
 * Add or refresh a device, keyed by endpoint. A re-sync (`resync`) of a device removed on purpose is
 * refused; an Enable (no `resync`) clears that. `replaces` (a renewed subscription) carries the old
 * one's label and age over and drops it.
 */
export function upsertDevice(
  input: { subscription: unknown; label?: unknown; resync?: unknown; replaces?: unknown },
  now = Date.now(),
  file = pushDevicesFile(),
): UpsertResult {
  const problem = subscriptionProblem(input.subscription);
  if (problem) return { error: problem };
  const sub = input.subscription as PushTarget;
  const f = readDevicesFile(file);
  const id = deviceId(sub.endpoint);
  const replacesId = typeof input.replaces === "string" ? deviceId(input.replaces) : null;
  if (input.resync === true && (f.removed.includes(id) || (replacesId && f.removed.includes(replacesId)))) return { removed: true };
  const old = typeof input.replaces === "string" ? f.subscriptions.find((d) => d.endpoint === input.replaces) : undefined;
  const existing = f.subscriptions.find((d) => d.endpoint === sub.endpoint) ?? old;
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, LABEL_MAX) : existing?.label ?? "Browser";
  const device: StoredDevice = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    label,
    createdAt: existing?.createdAt ?? now,
    ...(existing?.lastOkAt !== undefined ? { lastOkAt: existing.lastOkAt } : {}),
    ...(existing?.lastError !== undefined && existing.endpoint === sub.endpoint ? { lastError: existing.lastError, lastErrorAt: existing.lastErrorAt } : {}),
  };
  const next: DevicesFile = {
    version: 1,
    subscriptions: [...f.subscriptions.filter((d) => d.endpoint !== sub.endpoint && d !== old), device],
    removed: f.removed.filter((r) => r !== id),
  };
  const unchanged = JSON.stringify(next) === JSON.stringify(f);
  if (!unchanged) writeDevicesFile(next, file);
  return { device };
}

/** Remove by endpoint or id. `onPurpose` (the user's Remove or Turn Off) remembers it so a re-sync can't add it back; a 404/410 doesn't. */
export function removeDevice(which: { endpoint?: string; id?: string }, onPurpose: boolean, file = pushDevicesFile()): boolean {
  const f = readDevicesFile(file);
  const id = which.id ?? (which.endpoint ? deviceId(which.endpoint) : undefined);
  if (!id) return false;
  const hit = f.subscriptions.some((d) => deviceId(d.endpoint) === id);
  const removed = onPurpose ? [...f.removed.filter((r) => r !== id), id].slice(-REMOVED_MAX) : f.removed;
  if (!hit && removed === f.removed) return false;
  writeDevicesFile({ version: 1, subscriptions: f.subscriptions.filter((d) => deviceId(d.endpoint) !== id), removed }, file);
  return hit;
}

/** Record one delivery's outcome on a device (re-read, so a device added meanwhile stays). */
export function noteDelivery(endpoint: string, outcome: { ok: true; at: number } | { ok: false; at: number; error: string }, file = pushDevicesFile()): void {
  const f = readDevicesFile(file);
  let hit = false;
  const subscriptions = f.subscriptions.map((d) => {
    if (d.endpoint !== endpoint) return d;
    hit = true;
    if (outcome.ok) {
      const { lastError: _e, lastErrorAt: _a, ...rest } = d;
      return { ...rest, lastOkAt: outcome.at };
    }
    return { ...d, lastError: outcome.error.slice(0, 200), lastErrorAt: outcome.at };
  });
  if (hit) writeDevicesFile({ ...f, subscriptions }, file);
}
