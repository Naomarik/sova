import type { SessionInfo } from "./intercom.ts";
import type { FocusTarget } from "./focus.ts";
import type { WorkerSummary } from "./workers.ts";
import type { SessionRow } from "./ui.ts";

export const FRESH_MS = 20_000;
/** Optional topic-outline enrichment; presence must survive without it. */
export interface PresenceOutline {
  now?: string;
  overall?: string;
  topics?: string[];
  state?: string;
  generatedAt?: number;
  /** Latest user `#` heading from topic-outline (user-opted short text). */
  lastHeading?: string;
}
export interface Presence {
  type: "presence";
  version: 1;
  status: string;
  since: number;
  completed: number;
  preview: string;
  workers: WorkerSummary[];
  target?: FocusTarget;
  outline?: PresenceOutline;
}
export function clean(value: string, limit = 2000): string {
  // Do not let model output or peer metadata inject terminal controls.
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").slice(0, limit);
}
export function parseOutline(value: unknown): PresenceOutline | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const out: PresenceOutline = {};
  // Any malformed field drops the whole outline, never the presence itself.
  if (o.now !== undefined) {
    if (typeof o.now !== "string") return undefined;
    out.now = clean(o.now, 160);
  }
  if (o.overall !== undefined) {
    if (typeof o.overall !== "string") return undefined;
    out.overall = clean(o.overall, 220);
  }
  if (o.topics !== undefined) {
    if (!Array.isArray(o.topics) || o.topics.length > 12 || o.topics.some(t => typeof t !== "string")) return undefined;
    out.topics = o.topics.map(t => clean(t, 60));
  }
  if (o.state !== undefined) {
    if (typeof o.state !== "string") return undefined;
    out.state = clean(o.state, 24);
  }
  if (o.generatedAt !== undefined) {
    if (typeof o.generatedAt !== "number" || !Number.isFinite(o.generatedAt)) return undefined;
    out.generatedAt = o.generatedAt;
  }
  if (o.lastHeading !== undefined) {
    if (typeof o.lastHeading !== "string") return undefined;
    const heading = clean(o.lastHeading, 80).trim();
    if (heading) out.lastHeading = heading;
  }
  return Object.keys(out).length ? out : undefined;
}
export function parsePresence(value: unknown): Presence | undefined {
  if (!value || typeof value !== "object") return;
  const p = value as Presence;
  if (p.type !== "presence" || p.version !== 1 || typeof p.status !== "string"
    || !Number.isFinite(p.since) || !Number.isFinite(p.completed) || typeof p.preview !== "string"
    || !Array.isArray(p.workers) || p.workers.length > 40) return;
  const workers: WorkerSummary[] = [];
  for (const w of p.workers) {
    if (!w || typeof w.id !== "string" || typeof w.name !== "string" || typeof w.status !== "string") return;
    workers.push({ id: clean(w.id, 150), name: clean(w.name, 120), status: clean(w.status, 80),
      model: typeof w.model === "string" ? clean(w.model, 100) : undefined,
      preview: typeof w.preview === "string" ? clean(w.preview, 180) : undefined });
  }
  return { type: "presence", version: 1, status: clean(p.status, 100), since: p.since,
    completed: p.completed, preview: clean(p.preview), workers, target: p.target,
    outline: parseOutline(p.outline) };
}

export class SessionStore {
  peers = new Map<string, SessionInfo>();
  details = new Map<string, { value: Presence; received: number }>();
  seen = new Map<string, number>();
  connected = false;
  constructor(readonly pid: number) {}

  roster(peers: SessionInfo[]) {
    const ids = new Set(peers.map(p => p.id));
    for (const id of this.peers.keys()) if (!ids.has(id)) this.remove(id);
    for (const p of peers) this.upsert(p);
  }
  upsert(peer: SessionInfo) {
    const old = this.peers.get(peer.id);
    if (old && (old.endpointEpoch !== peer.endpointEpoch || old.pid !== peer.pid)) {
      this.details.delete(peer.id); this.seen.delete(peer.id);
    }
    this.peers.set(peer.id, peer);
  }
  remove(id: string) { this.peers.delete(id); this.details.delete(id); this.seen.delete(id); }
  receive(id: string, value: unknown, now = Date.now()) {
    const p = parsePresence(value);
    if (!p) return;
    if (!this.seen.has(id)) this.seen.set(id, p.completed);
    this.details.set(id, { value: p, received: now });
  }
  markSeen(id: string) { this.seen.set(id, this.details.get(id)?.value.completed ?? 0); }
  disconnect() { this.connected = false; this.details.clear(); }
  target(id: string, now = Date.now()): FocusTarget | undefined {
    const detail = this.details.get(id);
    if (!this.connected || !this.peers.has(id) || !detail || now - detail.received > FRESH_MS) return;
    return detail.value.target;
  }
  rows(now = Date.now()): SessionRow[] {
    return [...this.peers.values()].map(p => {
      const detail = this.details.get(p.id);
      const fresh = this.connected && detail && now - detail.received <= FRESH_MS;
      const d = fresh ? detail.value : undefined;
      const self = p.pid === this.pid;
      return { id: p.id, name: clean(p.name ?? p.id.slice(0, 8), 160), cwd: clean(p.cwd, 300),
        model: clean(p.model, 160), self,
        // Metadata-only status (no presence payload received yet) is intentionally
        // labeled as such; it cannot account for background workers or retries.
        status: !this.connected ? "Disconnected" : d?.status ?? (detail ? "Unknown · stale" : `${clean(p.status ?? "unknown", 80)} · basic`),
        since: d?.since ?? p.lastActivity, stale: !this.connected || (!!detail && !fresh),
        unseen: !self && !!d && d.completed > (this.seen.get(p.id) ?? d.completed),
        preview: d?.preview ?? "Reload this session to enable rich status, worker previews, and focusing.",
        outline: d?.outline,
        workers: d?.workers ?? [], canFocus: self || !!this.target(p.id, now) };
    });
  }
}
