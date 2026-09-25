import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type DecisionSettings,
  type SessionSummary,
  type SessionTags,
  TAG_STATUSES,
  TAG_TOPICS,
  type TagStatus,
  type TagTopic,
} from "../shared/protocol";
import { type Answer, DecisionError, type DecisionProvider, type Question } from "./decide";
import { maySend, terminalSession } from "./decide-settings";
import { serverRedactor } from "./overseer-redact";
import { stateRoot } from "./state-root";

/**
 * Session tags (plan §5): a topic, a status and a "throwaway" probability per session, answered
 * through the decision seam (server/decide.ts) — this module never knows which provider answered —
 * plus the user's own manual tags. Stored in `<stateRoot>/session-tags.json`, keyed by session id
 * like titles/archive/groups: a sidecar only, never a byte into a JSONL (a TUI-owned file is read
 * with our own tail scan, never opened for writing).
 *
 * The store keeps the RAW answers; the wire (`tagsFor`) applies the fixed thresholds, so moving a
 * threshold needs no re-classification.
 */

/** A choice answer shows on the wire at this confidence or above (the formula in server/decide.ts). */
export const TAG_CONFIDENCE_MIN = 0.5;
/** Throwaway is a boolean: shown when P(yes) ≥ this — its own confidence |2p−1| is then ≥ 0.5, the
    same gate as the choices, read on the yes side only (a "no" is never a tag). */
export const THROWAWAY_P_MIN = 0.75;
/** A session whose last reply changed is re-tagged at most this often: bounded churn while it runs. */
export const RETAG_MIN_MS = 60 * 60 * 1000;
/** Excerpt caps (characters) — with the short fields the state stays under ~2k tokens. */
export const LAST_ASSISTANT_MAX = 1500;
export const LAST_USER_MAX = 600;
const FIELD_MAX = 300;
/** Manual tags: the ideas store's rule (server/overseer-ideas.ts cleanTags). */
export const USER_TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const USER_TAGS_MAX = 8;

const CHUNK = 16 * 1024;
const MAX_TAIL = 256 * 1024;
const NL = 0x0a;

// --- questions -------------------------------------------------------------------------------

const TOPIC_RUBRIC: Record<TagTopic, string> = {
  feature: "Building new functionality or a new capability.",
  bugfix: "Finding and fixing a defect, crash or wrong behaviour.",
  refactor: "Restructuring or cleaning up code without changing what it does.",
  tests: "Writing, fixing or running tests.",
  docs: "Writing or editing documentation, READMEs, specs or other prose.",
  infra: "Servers, deployment, CI, networking, builds or developer tooling.",
  research: "Investigating, reading or comparing options to answer a question, without changing code.",
  planning: "Designing or planning work before it is implemented.",
  review: "Reviewing code, a change, a pull request or someone else's work.",
  data: "Processing, analysing, cleaning or migrating data.",
  config: "Changing configuration, settings or dotfiles.",
  experiment: "A prototype, a spike, or trying something out to see if it works.",
  chore: "Routine maintenance: dependency bumps, renames, housekeeping.",
  other: "None of the above fits.",
};

const STATUS_RUBRIC: Record<TagStatus, string> = {
  done: "The requested work is finished: `last_assistant` reports it complete and nothing is left open.",
  in_progress: "Work is still under way or its next step is clear, and the session was active recently.",
  abandoned: "Work stopped before it was finished and the session has not been touched for days.",
  blocked: "Work cannot continue until the user answers a question, makes a decision, or fixes something outside the session.",
};

/** The three questions; ids are the store's contract. Built from the fixed taxonomy in the protocol. */
export const TAG_QUESTIONS: Record<"topic" | "status" | "throwaway", Question> = {
  topic: {
    type: "choice",
    instructions:
      "Which kind of work is this coding-assistant session mainly about? `title` is the user's first request; `summary` and `now` summarise the session when present; `last_assistant` is the assistant's latest reply.",
    options: Object.fromEntries(TAG_TOPICS.map((t) => [t, TOPIC_RUBRIC[t]])),
  },
  status: {
    type: "choice",
    instructions:
      "What state is this session's work in now? `days_idle` is how many whole days have passed since its last activity; `last_assistant` is the assistant's latest reply and `last_user` the user's latest message.",
    options: Object.fromEntries(TAG_STATUSES.map((t) => [t, STATUS_RUBRIC[t]])),
  },
  throwaway: {
    type: "boolean",
    instructions:
      "Is this a test or scratch session with no lasting work — a trial prompt to try a model or a feature, a greeting, or a one-off question nobody will come back to?",
    criteria: {
      true: "A test, trial or scratch session; nothing in it is meant to last.",
      false: "Real work the user may come back to.",
    },
  },
};

// --- the store -------------------------------------------------------------------------------

/** One session's stored tags. `basis` + `answers` are the model's; `user` is the user's. */
export interface TagRecord {
  /** ms epoch the session was classified. */
  at?: number;
  /** What was classified: the last assistant entry's id and the file size then. */
  basis?: { turnId: string; size: number };
  /** Raw answers, as the seam returned them. */
  answers?: { topic?: Answer; status?: Answer; throwaway?: Answer };
  provider?: string;
  model?: string;
  user?: string[];
}

interface Store {
  /** ms epoch the live pass began tagging new activity (set when the feature is first seen on). */
  liveSince?: number;
  sessions: Record<string, TagRecord>;
}

const tagsFile = () => join(stateRoot(), "session-tags.json");

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One stored answer back, or undefined when it isn't one (a hand-edited file loses only that field). */
function cleanAnswer(v: unknown): Answer | undefined {
  if (!isObj(v)) return undefined;
  if (v.type === "boolean" && fin(v.p)) return { type: "boolean", p: v.p };
  if (v.type === "choice" && typeof v.choice === "string" && fin(v.confidence) && isObj(v.probabilities)) {
    const probabilities: Record<string, number> = {};
    for (const [k, p] of Object.entries(v.probabilities)) if (fin(p)) probabilities[k] = p;
    return { type: "choice", choice: v.choice, probabilities, confidence: v.confidence };
  }
  if (v.type === "score" && fin(v.score) && fin(v.confidence) && Array.isArray(v.probabilities)) {
    return { type: "score", score: v.score, probabilities: v.probabilities.filter(fin), confidence: v.confidence };
  }
  return undefined;
}

function cleanRecord(v: unknown): TagRecord | null {
  if (!isObj(v)) return null;
  const out: TagRecord = {};
  if (fin(v.at)) out.at = v.at;
  if (isObj(v.basis) && typeof v.basis.turnId === "string" && fin(v.basis.size)) out.basis = { turnId: v.basis.turnId, size: v.basis.size };
  if (isObj(v.answers)) {
    const a: NonNullable<TagRecord["answers"]> = {};
    for (const k of ["topic", "status", "throwaway"] as const) {
      const ans = cleanAnswer(v.answers[k]);
      if (ans) a[k] = ans;
    }
    out.answers = a;
  }
  if (typeof v.provider === "string") out.provider = v.provider;
  if (typeof v.model === "string") out.model = v.model;
  if (Array.isArray(v.user)) {
    const user = v.user.filter((t): t is string => typeof t === "string" && USER_TAG_RE.test(t)).slice(0, USER_TAGS_MAX);
    if (user.length) out.user = user;
  }
  return out.at !== undefined || out.user ? out : null;
}

function load(file: string): Store {
  // No prototype: an id is a plain key, and "__proto__" must stay one.
  const sessions: Record<string, TagRecord> = Object.create(null);
  const store: Store = { sessions };
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isObj(v)) return store;
    if (fin(v.liveSince)) store.liveSince = v.liveSince;
    if (!isObj(v.sessions)) return store;
    for (const [id, r] of Object.entries(v.sessions)) {
      const rec = cleanRecord(r);
      if (rec) sessions[id] = rec;
    }
  } catch {
    // missing or corrupt: start empty
  }
  return store;
}

let cache: { file: string; at: number; store: Store } | null = null;
const CACHE_MS = 1000;

function readStore(file = tagsFile()): Store {
  const now = Date.now();
  if (cache && cache.file === file && now - cache.at < CACHE_MS) return cache.store;
  const store = load(file);
  cache = { file, at: now, store };
  return store;
}

/** Re-read, change, write atomically (tmp + rename): another server's ids survive. */
function update(fn: (s: Store) => boolean, file = tagsFile()): Store {
  const next = load(file);
  if (fn(next)) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, ...(next.liveSince !== undefined ? { liveSince: next.liveSince } : {}), sessions: next.sessions }));
    renameSync(tmp, file);
  }
  cache = { file, at: Date.now(), store: next };
  return next;
}

/** The stored record of one session (raw answers included), for tests and the backfill. */
export function tagRecord(id: string): TagRecord | undefined {
  return readStore().sessions[id];
}

// --- the wire --------------------------------------------------------------------------------

/** A stored record as the wire carries it: fixed thresholds over the raw answers; undefined when
    nothing passes and there are no manual tags. */
export function wireTags(rec: TagRecord | undefined): SessionTags | undefined {
  if (!rec) return undefined;
  const out: SessionTags = {};
  const t = rec.answers?.topic;
  if (t?.type === "choice" && t.confidence >= TAG_CONFIDENCE_MIN && (TAG_TOPICS as readonly string[]).includes(t.choice)) out.topic = t.choice as TagTopic;
  const s = rec.answers?.status;
  if (s?.type === "choice" && s.confidence >= TAG_CONFIDENCE_MIN && (TAG_STATUSES as readonly string[]).includes(s.choice)) out.status = s.choice as TagStatus;
  const w = rec.answers?.throwaway;
  if (w?.type === "boolean" && w.p >= THROWAWAY_P_MIN) out.throwaway = true;
  if (rec.user?.length) out.user = [...rec.user];
  return Object.keys(out).length ? out : undefined;
}

/** The overlay listSessions/getSessionSummary lay over a row (1 s read cache, like seen.ts). */
export function tagsFor(id: string): SessionTags | undefined {
  return wireTags(readStore().sessions[id]);
}

/** Every session with tags on the wire — the `marks` snapshot a new feed socket gets. */
export function allTags(): Map<string, SessionTags> {
  const out = new Map<string, SessionTags>();
  for (const [id, rec] of Object.entries(readStore().sessions)) {
    const t = wireTags(rec);
    if (t) out.set(id, t);
  }
  return out;
}

// --- change events ---------------------------------------------------------------------------

export interface TagsChange {
  id: string;
  /** The session file, when the writer knew it (a manual tag by id may not). */
  path?: string;
  /** What the wire shows now; undefined = no tags (clear the overlay). */
  tags: SessionTags | undefined;
}

const listeners = new Set<(changes: TagsChange[]) => void>();

/** Subscribe to tag writes (the server push forwards them). Returns the unsubscribe. */
export function onTagsChanged(fn: (changes: TagsChange[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(changes: TagsChange[]): void {
  if (!changes.length) return;
  for (const fn of listeners) {
    try {
      fn(changes);
    } catch (err) {
      console.warn("[session-tags] listener failed:", err instanceof Error ? err.message : String(err));
    }
  }
}

const sameTags = (a: SessionTags | undefined, b: SessionTags | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// --- manual tags -----------------------------------------------------------------------------

/** "a, #B c" or ["a","B"] → the stored list (trimmed, lowercase, no leading #, deduped), or an
    error sentence (the route's 400). Same rule as the ideas store. */
export function cleanUserTags(v: unknown): string[] | string {
  if (!Array.isArray(v)) return "user must be a list of tags, or null to clear them.";
  const tags = [...new Set(v.map((t) => (typeof t === "string" ? t.trim().toLowerCase().replace(/^#/, "") : "")))].filter(Boolean);
  for (const t of tags) if (!USER_TAG_RE.test(t)) return `Tag "${t}" is not valid: lowercase letters, digits and dashes, at most 32.`;
  if (tags.length > USER_TAGS_MAX) return `At most ${USER_TAGS_MAX} tags.`;
  return tags;
}

/** Set (or with null / [] clear) one session's manual tags; returns what the wire shows now. */
export function setUserTags(id: string, user: string[] | null, path?: string): SessionTags | undefined {
  let before: SessionTags | undefined;
  const store = update((s) => {
    const cur = s.sessions[id];
    before = wireTags(cur);
    const next: TagRecord = { ...(cur ?? {}) };
    if (user && user.length) next.user = [...user];
    else delete next.user;
    if (JSON.stringify(next.user ?? null) === JSON.stringify(cur?.user ?? null)) return false;
    if (next.at === undefined && !next.user) delete s.sessions[id];
    else s.sessions[id] = next;
    return true;
  });
  const after = wireTags(store.sessions[id]);
  if (!sameTags(before, after)) emit([{ id, ...(path ? { path } : {}), tags: after }]);
  return after;
}

/** Drop the records of deleted sessions (cleanup's ids), like dropSessionTitles. */
export function dropSessionTags(ids: string[]): void {
  const gone: TagsChange[] = [];
  update((s) => {
    for (const id of ids) {
      if (!(id in s.sessions)) continue;
      delete s.sessions[id];
      gone.push({ id, tags: undefined });
    }
    return gone.length > 0;
  });
  emit(gone);
}

// --- eligibility -----------------------------------------------------------------------------

/**
 * Why a row is not sent for tagging, or null when it may be. The privacy rules (feature switch,
 * excluded folders, never-send-TUI with decide-settings' `terminalSession`) are `maySend`, the one
 * gate both features share. `held` = this server hosts the chat (index.ts passes heldChat);
 * without it every external session counts as a terminal one — the conservative side. `defer` = eligible later (a turn
 * is running); the others are never sent while the settings stand.
 */
export function tagSkipReason(
  row: SessionSummary,
  settings: DecisionSettings,
  opts: { home?: string; held?: (path: string) => boolean } = {},
): "feature-off" | "excluded" | "tui" | "overseer" | "worker" | "empty" | "defer" | null {
  const gate = maySend(settings, "tags", { cwd: row.cwd, terminal: terminalSession(row, opts.held?.(row.path) ?? false) }, opts.home);
  if (!gate.ok) return gate.reason;
  if (row.overseer) return "overseer";
  if (row.workerSession) return "worker";
  if (row.draftPreview !== undefined) return "empty";
  if (row.busy || row.activity?.state === "working") return "defer";
  return null;
}

// --- input (head/tail only) ------------------------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

/**
 * The file's last finished assistant reply (its entry id and text) and the last user message
 * before it, scanned backwards from EOF (16 KB chunks, cap 256 KB, torn lines skipped) — the list's
 * own tail window, never a full-file read. null when the window holds no finished reply.
 */
export async function readTailTurn(path: string, size: number): Promise<{ turnId: string; assistant: string; user: string | null } | null> {
  const fh = await open(path, "r");
  try {
    const floor = Math.max(0, size - MAX_TAIL);
    let end = size;
    let carry = Buffer.alloc(0);
    let found: { turnId: string; assistant: string } | null = null;
    const done = (user: string | null) => (found ? { ...found, user } : null);
    while (end > floor) {
      const start = Math.max(floor, end - CHUNK);
      const chunk = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, start);
      if (bytesRead < chunk.length) return done(null);
      end = start;
      const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let stop = buf.length;
      for (;;) {
        const i = stop > 0 ? buf.lastIndexOf(NL, stop - 1) : -1;
        if (i < 0 && start > floor) break;
        const line = buf.subarray(i + 1, stop);
        if (line.includes(found ? '"user"' : '"assistant"')) {
          try {
            const e = JSON.parse(line.toString("utf-8"));
            const m = e?.type === "message" ? e.message : null;
            if (!found && m?.role === "assistant" && m.stopReason !== "toolUse" && typeof e.id === "string") {
              found = { turnId: e.id, assistant: textOf(m.content) };
            } else if (found && m?.role === "user") {
              return done(textOf(m.content));
            }
          } catch {
            // torn line or not JSON: skip
          }
        }
        if (i < 0) return done(null);
        stop = i;
      }
      carry = buf.subarray(0, stop);
    }
    return done(null);
  } finally {
    await fh.close();
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const head = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** The END of a reply is where its conclusion is. */
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-(n - 1))}` : s);

function durationWords(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 2) return "under two minutes";
  if (min < 90) return `about ${min} minutes`;
  const h = Math.round(min / 60);
  if (h < 48) return `about ${h} hours`;
  return `about ${Math.round(h / 24)} days`;
}

/** The decision state for one session: named, capped, pre-computed facts (Jev does no date
    arithmetic), redacted before it leaves the process. */
export function tagState(
  row: Pick<SessionSummary, "title" | "originalTitle" | "outlineGist" | "outlineNow" | "cwd" | "model" | "createdAt" | "lastActiveAt">,
  turn: { assistant: string; user: string | null },
  now: number,
  redact: <T>(v: T) => T = (v) => serverRedactor().redactDeep(v),
): Record<string, string | number> {
  const created = Date.parse(row.createdAt);
  const active = Date.parse(row.lastActiveAt);
  const state: Record<string, string | number> = {
    title: head(oneLine(row.originalTitle ?? row.title), FIELD_MAX),
    ...(row.outlineGist ? { summary: head(oneLine(row.outlineGist), FIELD_MAX) } : {}),
    ...(row.outlineNow ? { now: head(oneLine(row.outlineNow), FIELD_MAX) } : {}),
    project: basename(row.cwd) || row.cwd,
    ...(row.model ? { model: row.model } : {}),
    ...(Number.isFinite(created) && Number.isFinite(active) ? { duration: durationWords(Math.max(0, active - created)) } : {}),
    ...(Number.isFinite(active) ? { days_idle: Math.max(0, Math.floor((now - active) / 86_400_000)) } : {}),
    ...(turn.user ? { last_user: head(turn.user.trim(), LAST_USER_MAX) } : {}),
    last_assistant: tail(turn.assistant.trim(), LAST_ASSISTANT_MAX),
  };
  return redact(state);
}

// --- classification --------------------------------------------------------------------------

/** Whether a stored record needs a (re-)classification for a reply `turnId` at `now`. */
export function needsTagging(rec: TagRecord | undefined, turnId: string, now: number): boolean {
  if (!rec?.basis || rec.at === undefined) return true;
  if (rec.basis.turnId === turnId) return false;
  return now - rec.at >= RETAG_MIN_MS;
}

export interface TaggerDeps {
  /** The decision chain (never names a provider). */
  provider: () => DecisionProvider;
  settings: () => DecisionSettings;
  /** This server hosts the chat at `path` (heldChat) — for the never-send-TUI rule. */
  held?: (path: string) => boolean;
  now?: () => number;
  redact?: <T>(v: T) => T;
}

export type TagOutcome =
  | { kind: "tagged"; tags: SessionTags | undefined }
  | { kind: "fresh" } // already classified for this reply (or within the re-tag bound)
  | { kind: "skipped"; reason: string } // not eligible, or no finished reply yet
  | { kind: "failed"; error: DecisionError | Error };

/** After a failed classification the live pass leaves that session alone this long (in memory):
    one bad transcript must not cost a provider call every tick. The backfill ignores it. */
export const RETRY_FAILED_MS = 15 * 60 * 1000;

/** Classify one session now if it needs it. Never throws; one in flight per session id. */
export class SessionTagger {
  private inflight = new Map<string, Promise<TagOutcome>>();
  private failedAt = new Map<string, number>();
  constructor(private readonly deps: TaggerDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** The never-send-TUI "held" check the tagger was given (the live pass and backfill share it). */
  get held(): (path: string) => boolean {
    return this.deps.held ?? (() => false);
  }

  /** A failure of this session is recent enough that the live pass should not retry it yet. */
  coolingDown(id: string): boolean {
    const at = this.failedAt.get(id);
    return at !== undefined && this.now() - at < RETRY_FAILED_MS;
  }

  tag(row: SessionSummary, opts: { signal?: AbortSignal } = {}): Promise<TagOutcome> {
    const running = this.inflight.get(row.id);
    if (running) return running;
    const p = this.run(row, opts)
      .then((out) => {
        if (out.kind === "failed") this.failedAt.set(row.id, this.now());
        else this.failedAt.delete(row.id);
        return out;
      })
      .finally(() => this.inflight.delete(row.id));
    this.inflight.set(row.id, p);
    return p;
  }

  private async run(row: SessionSummary, opts: { signal?: AbortSignal }): Promise<TagOutcome> {
    try {
      const settings = this.deps.settings();
      const reason = tagSkipReason(row, settings, { ...(this.deps.held ? { held: this.deps.held } : {}) });
      if (reason) return { kind: "skipped", reason };
      const st = await stat(row.path);
      const turn = await readTailTurn(row.path, st.size);
      if (!turn || !turn.assistant.trim()) return { kind: "skipped", reason: "no-reply" };
      const now = this.now();
      if (!needsTagging(readStore().sessions[row.id], turn.turnId, now)) return { kind: "fresh" };
      const state = tagState(row, turn, now, this.deps.redact);
      const result = await this.deps.provider().decide({ purpose: "tags", state, questions: TAG_QUESTIONS, dedupeKey: `tags:${row.id}`, ...(opts.signal ? { signal: opts.signal } : {}) });
      const a = result.answers;
      let before: SessionTags | undefined;
      const store = update((s) => {
        const cur = s.sessions[row.id];
        before = wireTags(cur);
        s.sessions[row.id] = {
          at: now,
          basis: { turnId: turn.turnId, size: st.size },
          answers: { ...(a.topic ? { topic: a.topic } : {}), ...(a.status ? { status: a.status } : {}), ...(a.throwaway ? { throwaway: a.throwaway } : {}) },
          provider: result.provider,
          model: result.model,
          ...(cur?.user ? { user: cur.user } : {}),
        };
        return true;
      });
      const after = wireTags(store.sessions[row.id]);
      if (!sameTags(before, after)) emit([{ id: row.id, path: row.path, tags: after }]);
      return { kind: "tagged", tags: after };
    } catch (err) {
      return { kind: "failed", error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
}

/**
 * The live pass: tags sessions with a finished reply since tags were switched on (`liveSince`),
 * one at a time. Older sessions are the backfill's (server/tags-backfill.ts). Switching the feature
 * off clears `liveSince`, so switching it on again starts a new window rather than silently
 * sending everything that happened in between.
 */
export async function liveTagPass(rows: SessionSummary[], tagger: SessionTagger, settings: DecisionSettings, now: number): Promise<number> {
  if (!settings.features.tags) {
    if (readStore().liveSince !== undefined) update((s) => (s.liveSince !== undefined ? (delete s.liveSince, true) : false));
    return 0;
  }
  let since = readStore().liveSince;
  if (since === undefined) {
    since = now;
    update((s) => {
      if (s.liveSince !== undefined) return false;
      s.liveSince = now;
      return true;
    });
    return 0; // nothing can have finished after "now"
  }
  let n = 0;
  for (const row of rows) {
    const active = Date.parse(row.lastActiveAt);
    if (!(active >= since)) continue;
    if (tagSkipReason(row, settings, { held: tagger.held }) || tagger.coolingDown(row.id)) continue;
    const rec = readStore().sessions[row.id];
    // Cheap pre-check before the tail read: classified within the bound → nothing to do yet.
    if (rec?.at !== undefined && now - rec.at < RETAG_MIN_MS && rec.basis && rec.basis.size === (await stat(row.path).catch(() => null))?.size) continue;
    const out = await tagger.tag(row);
    if (out.kind === "tagged") n++;
    // A chain with nothing to try: stop this pass rather than walk every row into the same wall.
    if (out.kind === "failed" && out.error instanceof DecisionError && out.error.failure === "unavailable") break;
  }
  return n;
}
