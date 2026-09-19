import { checkFocusable, type FocusTarget } from "./focus.ts";
import { clean, countWorkers, deriveState, parsePresence, type Activity, type Outline, type Presence, type SessionMeta,
  type SessionState, type WorkerCounts, type WorkerEntry } from "./schema.ts";

export { clean, parseOutline, parsePresence } from "./schema.ts";
export type { Presence } from "./schema.ts";
/** Optional topic-outline enrichment; presence must survive without it. */
export type PresenceOutline = Outline;

export const FRESH_MS = 20_000;
/** Heartbeat age beyond which a peer's record is stale even if just received. */
export const STALE_MS = 15_000;
const RECENTS = 8;
const NO_PREVIEW = "Reload this session to enable rich status, worker previews, and focusing.";

export type ViewGroup = "needs-input" | "working" | "idle" | "unreachable";
export const VIEW_GROUPS: readonly ViewGroup[] = ["needs-input", "working", "idle", "unreachable"];
export interface SessionView {
  id: string; name: string; cwd: string; model: string;
  host?: string; pid: number; startedAt: number; sessionId?: string; sessionFile?: string;
  self: boolean; legacy: boolean;
  stale: boolean;
  unseen: boolean;
  group: ViewGroup;
  state: SessionState;
  statusLabel: string;
  tools?: string[]; toolDetail?: string;
  since: number;
  lastActivity: number;
  attention: "needs-input" | "error" | "none";
  workers: WorkerEntry[]; workerCounts: WorkerCounts;
  outline?: Outline; activity?: Activity;
  preview: string; previewAt?: number;
  canFocus: boolean;
  focusReason?: string;
}

const STATE_TEXT: Record<SessionState, string> = { working: "working", idle: "idle", "needs-input": "needs input", error: "error" };

function latest(a: Activity | undefined): number | undefined {
  if (!a) return;
  return Math.max(a.since, a.lastAssistantAt ?? 0, a.lastToolAt ?? 0, a.lastPromptAt ?? 0);
}

export class SessionStore {
  peers = new Map<string, SessionMeta>();
  details = new Map<string, { value: Presence; received: number; heartbeat?: number }>();
  seen = new Map<string, number>();
  /** Ids whose record had no schemaVersion (v1 writers). */
  legacy = new Set<string>();
  /** Most recently visited sessions, newest first. */
  recents: string[] = [];
  connected = false;
  constructor(readonly pid: number) {}

  roster(peers: SessionMeta[]) {
    const ids = new Set(peers.map(p => p.id));
    for (const id of this.peers.keys()) if (!ids.has(id)) this.remove(id);
    for (const p of peers) this.upsert(p);
  }
  upsert(peer: SessionMeta, info: { legacy?: boolean } = {}) {
    const old = this.peers.get(peer.id);
    if (old && (old.endpointEpoch !== peer.endpointEpoch || old.pid !== peer.pid)) {
      this.details.delete(peer.id); this.seen.delete(peer.id); this.legacy.delete(peer.id);
    }
    if (info.legacy === true) this.legacy.add(peer.id);
    else if (info.legacy === false) this.legacy.delete(peer.id);
    this.peers.set(peer.id, peer);
  }
  remove(id: string) {
    this.peers.delete(id); this.details.delete(id); this.seen.delete(id); this.legacy.delete(id);
    this.recents = this.recents.filter(r => r !== id);
  }
  /** `heartbeat` is the source record's heartbeat when known (peer records). */
  receive(id: string, value: unknown, now = Date.now(), heartbeat?: number) {
    const p = parsePresence(value);
    if (!p) return;
    if (!this.seen.has(id)) this.seen.set(id, p.completed);
    this.details.set(id, { value: p, received: now, heartbeat });
  }
  markSeen(id: string) { this.seen.set(id, this.details.get(id)?.value.completed ?? 0); }
  disconnect() { this.connected = false; this.details.clear(); }
  pushRecent(id: string) { this.recents = [id, ...this.recents.filter(r => r !== id)].slice(0, RECENTS); }
  nextRecent(excludeId?: string): string | undefined {
    return this.recents.find(r => r !== excludeId && this.peers.has(r));
  }
  /** Rich presence only while connected and within both freshness windows. */
  fresh(id: string, now = Date.now()): Presence | undefined {
    const detail = this.details.get(id);
    if (!this.connected || !this.peers.has(id) || !detail || now - detail.received > FRESH_MS) return;
    if (detail.heartbeat !== undefined && now - detail.heartbeat > STALE_MS) return;
    return detail.value;
  }
  target(id: string, now = Date.now()): FocusTarget | undefined {
    const p = this.fresh(id, now);
    return p && checkFocusable(p).ok ? p.target : undefined;
  }
  view(peer: SessionMeta, now = Date.now()): SessionView {
    const detail = this.details.get(peer.id);
    const d = this.fresh(peer.id, now);
    const self = peer.pid === this.pid;
    const legacy = !self && this.legacy.has(peer.id);
    const stale = !this.connected || (!!detail && !d);
    const state = deriveState(d, peer);
    const workers = d?.workers ?? [];
    const workerCounts = d?.workerCounts ?? countWorkers(workers);
    const unseen = !self && !!d && d.completed > (this.seen.get(peer.id) ?? d.completed);
    // Metadata-only status (no presence payload received yet) is intentionally
    // labeled as such; it cannot account for background workers or retries.
    const statusLabel = !this.connected ? "Disconnected" : detail && !d ? "Unknown · stale"
      : !d ? `${STATE_TEXT[state]} · basic` : clean(d.status, 80).trim() || STATE_TEXT[state];
    const group: ViewGroup = stale ? "unreachable" : state === "needs-input" || state === "error" ? "needs-input"
      : state === "working" || workerCounts.working > 0 ? "working" : "idle";
    const focus = self || stale ? undefined : checkFocusable(d);
    return {
      id: peer.id, name: clean(peer.name ?? peer.id.slice(0, 8), 160), cwd: clean(peer.cwd, 300), model: clean(peer.model, 160),
      host: peer.host, pid: peer.pid, startedAt: peer.startedAt, sessionId: peer.sessionId, sessionFile: peer.sessionFile,
      self, legacy, stale, unseen, group, state, statusLabel,
      tools: d?.activity?.tools, toolDetail: d?.activity?.toolDetail,
      since: d?.activity?.since ?? d?.since ?? peer.lastActivity,
      lastActivity: latest(d?.activity) ?? d?.since ?? peer.lastActivity,
      attention: state === "needs-input" || state === "error" ? state : "none",
      workers, workerCounts, outline: d?.outline, activity: d?.activity,
      preview: d?.preview ?? NO_PREVIEW, previewAt: d?.previewAt,
      canFocus: self || !!focus?.ok,
      focusReason: self ? undefined : stale ? (this.connected ? "session is stale or unreachable" : "presence bus disconnected")
        : focus?.ok ? undefined : focus?.reason,
    };
  }
  /** Grouped (needs-input, working, idle, unreachable) and sorted; self pinned last in its group. */
  views(now = Date.now()): SessionView[] {
    const all = [...this.peers.values()].map(p => this.view(p, now));
    const completed = (v: SessionView) => this.details.get(v.id)?.value.completed ?? 0;
    const order: Record<ViewGroup, (a: SessionView, b: SessionView) => number> = {
      "needs-input": (a, b) => a.since - b.since,
      working: (a, b) => b.lastActivity - a.lastActivity,
      idle: (a, b) => Number(b.unseen) - Number(a.unseen) || completed(b) - completed(a),
      unreachable: (a, b) => a.name.localeCompare(b.name),
    };
    return VIEW_GROUPS.flatMap(group => all.filter(v => v.group === group)
      .sort((a, b) => Number(a.self) - Number(b.self) || order[group](a, b) || a.id.localeCompare(b.id)));
  }
  /** ≤2 lines about OTHER reachable sessions needing a look; empty when none. */
  attentionLines(now = Date.now()): string[] {
    const items: string[] = [];
    const views = this.views(now).filter(v => !v.self && !v.stale);
    for (const v of views) if (v.state === "needs-input") items.push(`⚑ ${v.name} needs input`);
    for (const v of views) if (v.state === "error") items.push(`✗ ${v.name} errored`);
    for (const v of views) if (v.unseen && v.attention === "none") items.push(`✦ ${v.name} finished`);
    if (items.length <= 2) return items;
    return [items[0], `${items[1]} (+${items.length - 2} more)`];
  }
}
