import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Context, Hono } from "hono";
import type { DecisionSettings, SessionSummary, TagsBackfillProgress, TagsBackfillScope } from "../shared/protocol";
import { DecisionError, type DecisionProvider } from "./decide";
import { cleanUserTags, liveTagPass, SessionTagger, setUserTags, tagSkipReason } from "./session-tags";
import { stateRoot } from "./state-root";

/**
 * The tags backfill (plan §5.3): classify existing sessions in the background, through the same
 * chain as everything else (whose global concurrency cap bounds it), with progress the Settings tab
 * reads and the session feed pushes. Resumable by construction: a session already classified for
 * its current last reply is `fresh` and costs nothing, so a restarted job (the job file says it was
 * running) walks the list again and only pays for what is left.
 *
 * Also the runtime of session tags: the singleton tagger, the live pass ticker and the routes.
 */

/** "recent" = sessions active in the last RECENT_DAYS days. */
export const RECENT_DAYS = 30;
/** Parallel classifications the job asks for; the chain's own cap (2) is the real bound. */
export const BACKFILL_CONCURRENCY = 2;
/** This many failures in a row stop the job (a provider that fails everything, not one bad file). */
export const BACKFILL_MAX_CONSECUTIVE_FAILURES = 5;
/** Per-session progress reaches the feed at most this often. */
const PUBLISH_MS = 500;
/** The live pass runs this often. */
export const LIVE_TICK_MS = 60_000;

const jobFile = () => join(stateRoot(), "session-tags-backfill.json");

/** Rows the job covers for a scope: eligible now (not deferred for a running turn — the live pass
    gets those) and, for "recent", active within RECENT_DAYS. */
export function backfillRows(rows: SessionSummary[], scope: TagsBackfillScope, settings: DecisionSettings, now: number, held?: (path: string) => boolean): SessionSummary[] {
  const cutoff = now - RECENT_DAYS * 86_400_000;
  return rows.filter((r) => {
    const reason = tagSkipReason(r, settings, held ? { held } : {});
    if (reason && reason !== "defer") return false;
    if (scope === "all") return true;
    const t = Date.parse(r.lastActiveAt);
    return Number.isFinite(t) && t >= cutoff;
  });
}

export interface BackfillDeps {
  list: () => Promise<SessionSummary[]>;
  tagger: SessionTagger;
  settings: () => DecisionSettings;
  /** Whether the chain has any provider to try right now (DecisionChainStatus.ready). */
  ready: () => { ready: boolean; reason?: string };
  now?: () => number;
  /** Progress changed (throttled by the caller if needed). */
  publish?: (p: TagsBackfillProgress) => void;
  file?: string;
}

export class TagsBackfill {
  private progress: TagsBackfillProgress = { running: false, done: 0, total: 0, failed: 0 };
  private abort: AbortController | null = null;
  private job: Promise<void> | null = null;
  constructor(private readonly deps: BackfillDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private file() {
    return this.deps.file ?? jobFile();
  }

  status(): TagsBackfillProgress {
    return { ...this.progress };
  }

  /** The job that was running when the server stopped, if any (its scope). */
  pendingScope(): TagsBackfillScope | null {
    try {
      const v = JSON.parse(readFileSync(this.file(), "utf8"));
      return v?.running === true && (v.scope === "recent" || v.scope === "all") ? v.scope : null;
    } catch {
      return null;
    }
  }

  private persist(running: boolean): void {
    try {
      const file = this.file();
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, running, scope: this.progress.scope, startedAt: this.progress.startedAt }));
      renameSync(tmp, file);
    } catch (err) {
      console.warn("[tags-backfill] job file write failed:", err instanceof Error ? err.message : String(err));
    }
  }

  private lastPublish = 0;
  /** Progress to the feed: every start/stop/total, and per session at most every PUBLISH_MS. */
  private changed(force = true): void {
    const now = Date.now();
    if (!force && now - this.lastPublish < PUBLISH_MS) return;
    this.lastPublish = now;
    this.deps.publish?.(this.status());
  }

  /**
   * Start a job, or return the running one's progress (a second click is not a second job).
   * Refuses — `{error}` — while the feature is off or the chain has nothing to try.
   */
  start(scope: TagsBackfillScope): { progress: TagsBackfillProgress } | { error: string } {
    if (this.progress.running) return { progress: this.status() };
    if (!this.deps.settings().features.tags) return { error: "Session tags are off." };
    const r = this.deps.ready();
    if (!r.ready) return { error: r.reason ?? "No decision provider is available." };
    this.progress = { running: true, scope, done: 0, total: 0, failed: 0, startedAt: this.now() };
    this.persist(true);
    this.abort = new AbortController();
    this.job = this.run(scope, this.abort.signal).catch((err) => {
      this.finish(err instanceof Error ? err.message : String(err));
    });
    this.changed();
    return { progress: this.status() };
  }

  /** Stop the running job; what it classified stays. */
  cancel(): TagsBackfillProgress {
    if (this.progress.running) {
      this.abort?.abort();
      this.finish("Stopped.");
    }
    return this.status();
  }

  /** Resolves when the current job (if any) has ended — for tests and shutdown. */
  async settled(): Promise<void> {
    await this.job;
  }

  private finish(stoppedReason?: string): void {
    if (!this.progress.running) return;
    this.progress = { ...this.progress, running: false, finishedAt: this.now(), ...(stoppedReason ? { stoppedReason } : {}) };
    this.persist(false);
    this.changed();
  }

  private async run(scope: TagsBackfillScope, signal: AbortSignal): Promise<void> {
    const rows = backfillRows(await this.deps.list(), scope, this.deps.settings(), this.now(), this.deps.tagger.held);
    if (signal.aborted) return;
    this.progress.total = rows.length;
    this.changed();
    let next = 0;
    let streak = 0;
    let stop: string | null = null;
    const worker = async () => {
      while (!signal.aborted && stop === null && next < rows.length) {
        const row = rows[next++];
        if (!row) break;
        if (!this.deps.settings().features.tags) {
          stop = "Session tags were switched off.";
          break;
        }
        const out = await this.deps.tagger.tag(row, { signal });
        if (signal.aborted) break;
        if (out.kind === "failed") {
          const e = out.error;
          if (e instanceof DecisionError && e.failure === "unavailable") {
            stop = `No decision provider is available: ${e.message}`;
            break;
          }
          if (e instanceof DecisionError && e.failure === "timeout" && signal.aborted) break;
          this.progress.failed++;
          if (++streak >= BACKFILL_MAX_CONSECUTIVE_FAILURES) stop = `${streak} sessions in a row failed; last: ${e.message}`;
        } else {
          streak = 0;
        }
        this.progress.done++;
        this.changed(false);
      }
    };
    await Promise.all(Array.from({ length: Math.min(BACKFILL_CONCURRENCY, Math.max(1, rows.length)) }, worker));
    if (signal.aborted) return; // cancel() already finished it
    this.finish(stop ?? undefined);
  }
}

// --- runtime ---------------------------------------------------------------------------------

export interface SessionTagsRuntime {
  tagger: SessionTagger;
  backfill: TagsBackfill;
}

let runtime: SessionTagsRuntime | null = null;

export interface StartSessionTagsOpts {
  list: () => Promise<SessionSummary[]>;
  /** Hosted chats' agent_settled (server/chat-manager.ts registry); returns the unsubscribe. */
  onAgentSettled?: (fn: (path: string) => void) => () => void;
  /** This server hosts the chat at `path` (heldChat): a web-hosted external session is not a TUI one. */
  held?: (path: string) => boolean;
  /** The decision seam's runtime; injectable for tests. */
  provider: () => DecisionProvider;
  settings: () => DecisionSettings;
  ready: () => { ready: boolean; reason?: string };
  publish?: (p: TagsBackfillProgress) => void;
  tickMs?: number;
}

/**
 * Start session tags on this server: the live pass every LIVE_TICK_MS (and shortly after a hosted
 * turn settles), and a backfill the job file says was interrupted. Idempotent; returns the stop.
 */
export function startSessionTags(opts: StartSessionTagsOpts): () => void {
  const tagger = new SessionTagger({ provider: opts.provider, settings: opts.settings, ...(opts.held ? { held: opts.held } : {}) });
  const backfill = new TagsBackfill({ list: opts.list, tagger, settings: opts.settings, ready: opts.ready, ...(opts.publish ? { publish: opts.publish } : {}) });
  runtime = { tagger, backfill };
  let passing = false;
  const pass = async () => {
    if (passing) return;
    passing = true;
    try {
      const settings = opts.settings();
      if (settings.features.tags && !opts.ready().ready) return;
      await liveTagPass(settings.features.tags ? await opts.list() : [], tagger, settings, Date.now());
    } catch (err) {
      console.warn("[session-tags] live pass failed:", err instanceof Error ? err.message : String(err));
    } finally {
      passing = false;
    }
  };
  const timer = setInterval(pass, opts.tickMs ?? LIVE_TICK_MS);
  timer.unref?.();
  // A settled turn: one pass a few seconds later (the file's last reply is written by then).
  let soon: NodeJS.Timeout | null = null;
  const unsub = opts.onAgentSettled?.(() => {
    if (soon) return;
    soon = setTimeout(() => {
      soon = null;
      void pass();
    }, 3000);
    soon.unref?.();
  });
  const pending = backfill.pendingScope();
  if (pending) backfill.start(pending);
  return () => {
    clearInterval(timer);
    if (soon) clearTimeout(soon);
    unsub?.();
    backfill.cancel();
    if (runtime?.tagger === tagger) runtime = null;
  };
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await c.req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const IDLE: TagsBackfillProgress = { running: false, done: 0, total: 0, failed: 0 };

/**
 * The routes, mounted by index.ts at /api/sessions/tags:
 *   POST /            {id, user: string[] | null} → { tags: SessionTags | null }
 *   POST /backfill    {scope: "recent" | "all"}   → TagsBackfillProgress (409 {error} while off/unavailable)
 *   GET  /backfill                                → TagsBackfillProgress
 *   POST /backfill/cancel                         → TagsBackfillProgress
 */
export const tagRoutes = new Hono();

tagRoutes.post("/", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Expected JSON body { id, user }" }, 400);
  if (typeof body.id !== "string" || !body.id) return c.json({ error: "id must be a session id" }, 400);
  let user: string[] | null = null;
  if (body.user !== null) {
    const clean = cleanUserTags(body.user);
    if (typeof clean === "string") return c.json({ error: clean }, 400);
    user = clean;
  }
  const tags = setUserTags(body.id, user);
  return c.json({ tags: tags ?? null });
});

tagRoutes.get("/backfill", (c) => c.json(runtime?.backfill.status() ?? IDLE));

tagRoutes.post("/backfill", async (c) => {
  const body = await jsonBody(c);
  const scope = body?.scope;
  if (scope !== "recent" && scope !== "all") return c.json({ error: 'scope must be "recent" or "all"' }, 400);
  if (!runtime) return c.json({ error: "Session tags are not running on this server." }, 409);
  const r = runtime.backfill.start(scope);
  return "error" in r ? c.json({ error: r.error }, 409) : c.json(r.progress);
});

tagRoutes.post("/backfill/cancel", (c) => c.json(runtime?.backfill.cancel() ?? IDLE));
