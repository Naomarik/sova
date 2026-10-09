// The history's host-local index: event id → segment and offset, project,
// kind, actor, time, links both ways, source keys, and the words of each event's headline and
// rationale. Rebuildable from the event files; persisted to <stateRoot>/org-history/<org>/index.json so
// an open reads only what was appended since. `refresh()` stats each segment (no read when nothing
// grew) and reads only new bytes; a segment that shrank or whose head changed means a rebuild.
// No read scans every event file.
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  HISTORY_KINDS,
  HISTORY_OUTCOMES,
  HISTORY_SCHEMA,
  KIND_HEADLINES,
  RELATION_TYPES,
  isUnknown,
  type ActorBundle,
  type ActorRef,
  type EventId,
  type HistoryEvent,
  type HistoryProblem,
  type IndexFreshness,
  type Initiation,
  type RelationType,
  type Trigger,
} from "../../shared/org-history";
import { writeAtomic } from "../org-host/store";
import { linesFrom, readLineAt, readRationale, segmentPath, segments, segmentSize, type HistoryPaths } from "./store";

// 2: a note's or a correction's `about` is read as its `about` relation
const INDEX_VERSION = 2;
const KINDS = new Set<string>(HISTORY_KINDS);
const OUTCOMES = new Set<string>(HISTORY_OUTCOMES);
const RELATIONS = new Set<string>(RELATION_TYPES);

/** An event's relations to events, as recorded; an event `about` another (a note, a correction) relates to it
    as `about`, from that recorded field, unless a relation it holds already names that event. */
function relsOf(event: HistoryEvent): { type: RelationType; event: EventId }[] {
  const rels = event.relations.flatMap((r) => (r && RELATIONS.has(r.type) && "event" in r.target ? [{ type: r.type, event: r.target.event }] : []));
  if (typeof event.about === "string" && !rels.some((r) => r.event === event.about)) rels.push({ type: "about", event: event.about });
  return rels;
}

export interface IndexEntry {
  id: EventId;
  seg: string;
  off: number;
  len: number;
  /** Append order across the history (segment, then line). */
  pos: number;
  /** False: the line can't be read by this version (kept, shown in its place). */
  ok: boolean;
  why?: string;
  recordedAt: number | null;
  occurredAt?: number;
  kind?: string;
  outcome?: string;
  primary: string | null;
  affected: string[];
  actorKeys: string[];
  initiation: Initiation;
  triggers: Trigger[];
  rels: { type: RelationType; event: EventId }[];
  about?: EventId;
  txn?: string;
  key?: string;
  aliases?: string[];
  rationale: boolean;
  origin?: string;
  epoch?: string;
  seq?: number;
  disposition?: string;
  correction?: { primary: string | null; affected: string[] };
  /** Words of the headline and rationale (removed on a purge). */
  terms: string[];
  digest: string;
}

interface SegState {
  end: number;
  head: string;
}

interface Persisted {
  v: number;
  org: string;
  segs: Record<string, SegState>;
  entries: IndexEntry[];
  problems: HistoryProblem[];
  rebuiltAt: number | null;
}

export function actorKeysOf(a: ActorBundle | undefined): string[] {
  const out = new Set<string>();
  for (const role of ["initiatedBy", "decidedBy", "recordedBy", "executedBy"] as const) {
    const v = a?.[role];
    if (!v || isUnknown(v)) continue;
    const r = v as ActorRef;
    out.add(r.kind);
    if (r.id) out.add(`${r.kind}:${r.id}`);
  }
  return [...out].sort();
}

export function initiationOf(a: ActorBundle | undefined): Initiation {
  const v = a?.initiatedBy;
  if (!v || isUnknown(v)) return "unknown";
  switch ((v as ActorRef).kind) {
    case "operator":
      return "operator";
    case "person":
      return "person";
    case "project-overseer":
    case "global-overseer":
      return "overseer";
    default:
      return "system";
  }
}

/** Lower-case words of two characters or more, each once, at most 400. */
export function wordsOf(...texts: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const w of t.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 2 && out.size < 400) out.add(w);
  }
  return [...out];
}

const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** The digest of a segment's first bytes, up to `upTo` (at most 1 KiB): what was indexed, checked unchanged. */
function headOf(paths: HistoryPaths, seg: string, upTo: number): string {
  const n = Math.min(segmentSize(paths, seg), upTo, 1024);
  const buf = Buffer.alloc(n);
  if (n) {
    const fd = openSync(segmentPath(paths, seg), "r");
    try {
      readSync(fd, buf, 0, n, 0);
    } finally {
      closeSync(fd);
    }
  }
  return sha(buf);
}

/** A parsed line, checked enough to index; `null` with why when this version can't read it. */
export function parseEvent(text: string): { event: HistoryEvent | null; id: string | null; why?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { event: null, id: null, why: "not JSON" };
  }
  const e = raw as HistoryEvent;
  const id = typeof e?.id === "string" ? e.id : null;
  if (!e || typeof e !== "object") return { event: null, id, why: "not an event" };
  if (e.v !== HISTORY_SCHEMA) return { event: null, id, why: `schema version ${String(e.v)}` };
  if (!id || !/^he_[0-9a-f]{32}$/.test(id)) return { event: null, id, why: "no event id" };
  if (!KINDS.has(e.kind)) return { event: null, id, why: `unknown kind ${String(e.kind)}` };
  if (!OUTCOMES.has(e.outcome)) return { event: null, id, why: `unknown outcome ${String(e.outcome)}` };
  if (typeof e.times?.recordedAt !== "number" || !e.projects || !Array.isArray(e.triggeredBy) || !Array.isArray(e.relations) || !e.actors || !e.source)
    return { event: null, id, why: "a required field is missing" };
  return { event: e, id };
}

export class HistoryIndex {
  private segs = new Map<string, SegState>();
  private entries: IndexEntry[] = [];
  readonly byId = new Map<EventId, IndexEntry>();
  readonly byKey = new Map<string, EventId>();
  readonly children = new Map<EventId, { id: EventId; via: Trigger["via"] }[]>();
  readonly relIn = new Map<EventId, { id: EventId; type: RelationType }[]>();
  readonly later = new Map<EventId, EventId[]>();
  private readonly byProject = new Map<string, Set<EventId>>();
  private readonly byKind = new Map<string, Set<EventId>>();
  private readonly byActor = new Map<string, Set<EventId>>();
  private readonly terms = new Map<string, Set<EventId>>();
  private readonly maxSeq = new Map<string, number>();
  problems: HistoryProblem[] = [];
  rebuiltAt: number | null = null;
  private dirty = 0;
  private readonly cache = new Map<EventId, HistoryEvent>();

  constructor(
    readonly orgId: string,
    readonly paths: HistoryPaths,
    private readonly clock: () => number = Date.now,
  ) {}

  private get file(): string {
    return join(this.paths.local, "index.json");
  }

  /** Load the persisted index (when it matches the files) and read what was appended since; else rebuild. */
  open(): void {
    let loaded = false;
    try {
      const p = JSON.parse(readFileSync(this.file, "utf8")) as Persisted;
      if (p.v === INDEX_VERSION && p.org === this.orgId && Array.isArray(p.entries)) {
        this.reset();
        this.segs = new Map(Object.entries(p.segs));
        this.problems = p.problems ?? [];
        this.rebuiltAt = p.rebuiltAt ?? null;
        for (const e of p.entries) this.add(e);
        loaded = true;
      }
    } catch {
      // missing or unreadable: rebuilt below
    }
    if (!loaded) this.rebuild();
    else this.refresh();
  }

  private reset(): void {
    this.segs.clear();
    this.entries = [];
    for (const m of [this.byId, this.byKey, this.children, this.relIn, this.later, this.byProject, this.byKind, this.byActor, this.terms, this.maxSeq, this.cache]) m.clear();
    this.problems = [];
  }

  /** Every event file read again. */
  rebuild(): void {
    this.reset();
    for (const seg of segments(this.paths)) this.readSeg(seg, 0);
    this.rebuiltAt = this.clock();
    this.persist();
  }

  /** Read what was appended since; rebuild when a segment shrank, changed at its head, or a new one sorts
      before the newest indexed. True when anything new was read. */
  refresh(): boolean {
    const names = segments(this.paths);
    const known = [...this.segs.keys()].sort();
    const newest = known.at(-1) ?? "";
    let grew = false;
    for (const name of known)
      if (!names.includes(name)) {
        this.rebuild();
        return true;
      }
    for (const seg of names) {
      const st = this.segs.get(seg);
      if (!st) {
        if (seg < newest) {
          this.rebuild();
          return true;
        }
        this.readSeg(seg, 0);
        grew = true;
        continue;
      }
      const size = segmentSize(this.paths, seg);
      if (size < st.end) {
        this.rebuild();
        return true;
      }
      if (size > st.end) {
        if (headOf(this.paths, seg, st.end) !== st.head) {
          this.rebuild();
          return true;
        }
        this.readSeg(seg, st.end);
        grew = true;
      }
    }
    if (grew) this.persistSoon();
    return grew;
  }

  /** Whether the files hold bytes not indexed yet (a stat per segment, no read). */
  current(): boolean {
    const names = segments(this.paths);
    if (names.length !== this.segs.size) return false;
    return names.every((n) => this.segs.get(n)?.end === segmentSize(this.paths, n));
  }

  freshness(): IndexFreshness {
    let through: number | null = null;
    for (const e of this.entries) if (e.ok && e.recordedAt != null && (through == null || e.recordedAt > through)) through = e.recordedAt;
    return { through, events: this.entries.filter((e) => e.ok).length, current: this.current(), rebuiltAt: this.rebuiltAt };
  }

  private readSeg(seg: string, from: number): void {
    const { lines, end } = linesFrom(this.paths, seg, from);
    for (const l of lines) this.addLine(seg, l.off, l.len, l.text);
    // the head digest covers the first 1 KiB, so it is taken again until the segment has that much
    this.segs.set(seg, { end, head: headOf(this.paths, seg, end) });
  }

  private addLine(seg: string, off: number, len: number, text: string): void {
    const digest = sha(text);
    const { event, id, why } = parseEvent(text);
    const pos = this.entries.length;
    if (!event) {
      const pid = id && !this.byId.has(id) ? id : `line:${seg}:${off}`;
      const rec = (() => {
        try {
          const r = (JSON.parse(text) as { times?: { recordedAt?: unknown } }).times?.recordedAt;
          return typeof r === "number" ? r : null;
        } catch {
          return null;
        }
      })();
      this.problems.push({ kind: "unreadable", file: `history/events/${seg}`, line: off, ...(id ? { event: id } : {}), why: why ?? "unreadable" });
      this.add({ id: pid, seg, off, len, pos, ok: false, why, recordedAt: rec, primary: null, affected: [], actorKeys: [], initiation: "unknown", triggers: [], rels: [], rationale: false, terms: [], digest });
      return;
    }
    const have = this.byId.get(event.id);
    if (have) {
      if (have.digest !== digest) this.problems.push({ kind: "id-conflict", file: `history/events/${seg}`, line: off, event: event.id, why: "two records under one id differ; both kept, the first is shown" });
      return;
    }
    let terms = wordsOf(KIND_HEADLINES[event.kind]);
    if (event.rationale) {
      const r = readRationale(this.paths, event.id);
      if (r.state === "present")
        terms = wordsOf(KIND_HEADLINES[event.kind], r.rationale.what, r.rationale.reason?.text, ...(r.rationale.options ?? []).flatMap((o) => [o.label, o.reason, o.condition]), ...(r.rationale.quotes ?? []).map((q) => q.text));
    }
    const entry: IndexEntry = {
      id: event.id,
      seg,
      off,
      len,
      pos,
      ok: true,
      recordedAt: event.times.recordedAt,
      ...(typeof event.times.occurredAt === "number" ? { occurredAt: event.times.occurredAt } : {}),
      kind: event.kind,
      outcome: event.outcome,
      primary: event.projects.primary ?? null,
      affected: Array.isArray(event.projects.affected) ? event.projects.affected : [],
      actorKeys: actorKeysOf(event.actors),
      initiation: initiationOf(event.actors),
      triggers: event.triggeredBy.filter((t) => typeof t?.event === "string"),
      rels: relsOf(event),
      ...(event.about ? { about: event.about } : {}),
      ...(event.source.txn ? { txn: event.source.txn } : {}),
      key: event.source.key,
      ...(event.aliases?.length ? { aliases: event.aliases } : {}),
      rationale: !!event.rationale,
      origin: event.capture?.origin,
      epoch: event.writer?.epoch,
      seq: event.writer?.seq,
      ...(event.decision ? { disposition: event.decision.disposition } : {}),
      ...(event.correction?.projects ? { correction: { primary: event.correction.projects.primary ?? null, affected: event.correction.projects.affected ?? [] } } : {}),
      terms,
      digest,
    };
    this.add(entry);
    this.cache.set(entry.id, event);
    this.trimCache();
    // a purge takes its subject's words out of the index at once
    if (event.kind === "rationale.purged" && event.about) this.dropTerms(event.about);
  }

  private add(e: IndexEntry): void {
    e.pos = this.entries.length;
    this.entries.push(e);
    this.byId.set(e.id, e);
    if (!e.ok) return;
    for (const k of [e.key, ...(e.aliases ?? [])]) if (k && !this.byKey.has(k)) this.byKey.set(k, e.id);
    for (const t of e.triggers) push(this.children, t.event, { id: e.id, via: t.via });
    for (const r of e.rels) push(this.relIn, r.event, { id: e.id, type: r.type });
    if (e.about) push(this.later, e.about, e.id);
    for (const p of new Set([e.primary, ...e.affected, e.correction?.primary, ...(e.correction?.affected ?? [])])) if (p) addTo(this.byProject, p, e.id);
    if (e.correction && e.about) {
      // a correction's subject is findable under its corrected projects too
      for (const p of [e.correction.primary, ...e.correction.affected]) if (p) addTo(this.byProject, p, e.about);
    }
    if (e.kind) addTo(this.byKind, e.kind, e.id);
    for (const a of e.actorKeys) addTo(this.byActor, a, e.id);
    for (const w of e.terms) addTo(this.terms, w, e.id);
    if (e.epoch && typeof e.seq === "number") this.maxSeq.set(e.epoch, Math.max(this.maxSeq.get(e.epoch) ?? 0, e.seq));
  }

  private dropTerms(id: EventId): void {
    const e = this.byId.get(id);
    if (!e) return;
    for (const w of e.terms) this.terms.get(w)?.delete(id);
    e.terms = [];
    this.dirty = Number.MAX_SAFE_INTEGER;
  }

  private trimCache(): void {
    while (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value as string);
  }

  /** The full record, read by its offset (cached). */
  event(id: EventId): HistoryEvent | null {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const e = this.byId.get(id);
    if (!e || !e.ok) return null;
    const text = readLineAt(this.paths, e.seg, e.off, e.len);
    if (text == null) return null;
    const { event } = parseEvent(text);
    if (event && event.id === id) {
      this.cache.set(id, event);
      this.trimCache();
    }
    return event && event.id === id ? event : null;
  }

  entry(id: EventId): IndexEntry | undefined {
    return this.byId.get(id);
  }

  /** Every entry in append order (placeholders included). */
  all(): readonly IndexEntry[] {
    return this.entries;
  }

  idsFor(kind: "project" | "kind" | "actor" | "term", key: string): ReadonlySet<EventId> {
    const m = kind === "project" ? this.byProject : kind === "kind" ? this.byKind : kind === "actor" ? this.byActor : this.terms;
    return m.get(key) ?? EMPTY;
  }

  nextSeq(epoch: string): number {
    const n = (this.maxSeq.get(epoch) ?? 0) + 1;
    this.maxSeq.set(epoch, n);
    return n;
  }

  /** Persist now (a purge's removed words must leave index.json at once). */
  persist(): void {
    const p: Persisted = { v: INDEX_VERSION, org: this.orgId, segs: Object.fromEntries(this.segs), entries: this.entries, problems: this.problems, rebuiltAt: this.rebuiltAt };
    try {
      writeAtomic(this.file, JSON.stringify(p), false);
      this.dirty = 0;
    } catch (err) {
      console.warn(`[org-history] ${this.orgId}: index not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private persistSoon(): void {
    this.dirty++;
    if (this.dirty >= 100) this.persist();
  }

  /** After a step that may have changed words (a purge): persist when owed. */
  flush(force = false): void {
    if (force || this.dirty > 0) this.persist();
  }
}

const EMPTY: ReadonlySet<EventId> = new Set();

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

function addTo(m: Map<string, Set<EventId>>, k: string, id: EventId): void {
  const s = m.get(k);
  if (s) s.add(id);
  else m.set(k, new Set([id]));
}
