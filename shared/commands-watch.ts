/**
 * `sova watch`'s events (§app.commands/watch, §app.served-commands/watch): from Sova's event stream
 * when the server has one (`fromStreamFrame`), else the difference between two reads of
 * GET /api/sessions (`diffSessions`). Pure and import-free (the command line loads it through Node's
 * type stripping: erasable syntax only).
 *
 * BEST EFFORT, by construction: a diff of two reads sees only what differs between them. A turn
 * that starts and ends between two reads is never seen, and two renames between reads show once,
 * with the last title. `turn.*` follow the list's `busy`, which only sessions this server runs set.
 */

/** What of a SessionSummary the diff reads (structural, so any newer summary fits). */
export interface WatchedSession {
  id: string;
  path: string;
  title: string;
  archived: boolean;
  busy: boolean;
  tags?: { user?: string[]; topic?: unknown; throwaway?: true };
}

export const WATCH_EVENTS = ["created", "removed", "renamed", "tagged", "archived", "turn.started", "turn.ended"] as const;
export type WatchEventName = (typeof WATCH_EVENTS)[number];

export interface WatchEvent {
  event: WatchEventName;
  id: string;
  path: string;
  title?: string;
  from?: string;
  tags?: WatchedSession["tags"] | null;
  archived?: boolean;
}

const tagsKey = (s: WatchedSession): string => JSON.stringify(s.tags ?? null);

/** The events from `prev` (the last read, by id) to `next` (this read). `next` order is kept;
    removals come last, in `prev` order. */
export function diffSessions(prev: ReadonlyMap<string, WatchedSession>, next: readonly WatchedSession[]): WatchEvent[] {
  const out: WatchEvent[] = [];
  const seen = new Set<string>();
  for (const s of next) {
    seen.add(s.id);
    const before = prev.get(s.id);
    if (!before) {
      out.push({ event: "created", id: s.id, path: s.path, title: s.title });
      if (s.busy) out.push({ event: "turn.started", id: s.id, path: s.path });
      continue;
    }
    if (before.title !== s.title) out.push({ event: "renamed", id: s.id, path: s.path, from: before.title, title: s.title });
    if (tagsKey(before) !== tagsKey(s)) out.push({ event: "tagged", id: s.id, path: s.path, tags: s.tags ?? null });
    if (before.archived !== s.archived) out.push({ event: "archived", id: s.id, path: s.path, archived: s.archived });
    if (!before.busy && s.busy) out.push({ event: "turn.started", id: s.id, path: s.path });
    if (before.busy && !s.busy) out.push({ event: "turn.ended", id: s.id, path: s.path });
  }
  for (const [id, s] of prev) if (!seen.has(id)) out.push({ event: "removed", id, path: s.path });
  return out;
}

/** What `sova watch` prints from the event stream: a diff event's own fields, plus where it came from
    and the cursor a resume names (`--since <stream>:<seq>`), and `at` as the server recorded it. */
export interface StreamWatchEvent extends WatchEvent {
  source: "hosted" | "observed";
  cursor: string;
  at: number;
}

/** A stream `gap` frame, as `sova watch` prints it. */
export interface WatchGap {
  event: "gap";
  reason: string;
  from?: number;
  to?: number;
}

/** `sova watch`'s names: the diff's, plus `gap` from the stream. */
export const STREAM_WATCH_EVENTS = [...WATCH_EVENTS, "gap"] as const;

/** `--since`'s value: `<stream id>:<seq>` (shared/events.ts STREAM_ID_RE and its seq rule). */
export function parseCursor(raw: string): { stream: string; since: number } | null {
  const m = /^([a-z0-9]{8,32}):(0|[1-9][0-9]{0,15})$/.exec(raw);
  if (!m || !Number.isSafeInteger(Number(m[2]))) return null;
  return { stream: m[1]!, since: Number(m[2]) };
}

const STREAM_NAMES: Record<string, WatchEventName> = {
  "session.created": "created",
  "session.removed": "removed",
  "session.renamed": "renamed",
  "session.tagged": "tagged",
  "session.archived": "archived",
  "turn.started": "turn.started",
  "turn.ended": "turn.ended",
};

/**
 * One frame of /ws/events (shared/events.ts EventsServerFrame, read structurally) → the line
 * `sova watch` prints, with the same fields `diffSessions` gives each name; null for a frame it
 * doesn't print (`hello`, `error`, `attention.changed`, anything newer).
 */
export function fromStreamFrame(frame: unknown, stream: string): StreamWatchEvent | WatchGap | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  if (f.type === "gap" && typeof f.reason === "string") {
    const gap: WatchGap = { event: "gap", reason: f.reason };
    if (typeof f.from === "number") gap.from = f.from;
    if (typeof f.to === "number") gap.to = f.to;
    return gap;
  }
  if (f.type !== "event" || typeof f.name !== "string" || typeof f.seq !== "number") return null;
  const event = STREAM_NAMES[f.name];
  if (!event || typeof f.id !== "string" || typeof f.path !== "string") return null;
  const out: WatchEvent = { event, id: f.id, path: f.path };
  if (event === "created") out.title = String(f.title ?? "");
  else if (event === "renamed") {
    out.from = String(f.from ?? "");
    out.title = String(f.title ?? "");
  } else if (event === "tagged") out.tags = (f.tags ?? null) as WatchEvent["tags"];
  else if (event === "archived") out.archived = f.archived === true;
  return { ...out, source: f.source === "hosted" ? "hosted" : "observed", cursor: `${stream}:${f.seq}`, at: typeof f.at === "number" ? f.at : Date.now() };
}

/** A read, keyed by id, for the next diff. Only the fields the diff reads are kept. */
export function indexSessions(list: readonly WatchedSession[]): Map<string, WatchedSession> {
  const m = new Map<string, WatchedSession>();
  for (const s of list) m.set(s.id, { id: s.id, path: s.path, title: s.title, archived: s.archived, busy: s.busy, ...(s.tags ? { tags: s.tags } : {}) });
  return m;
}
