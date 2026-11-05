// Ollama Cloud's model list, kept current by Sova's server (§app.model-levels/server-check): the check
// runs once a day on a timer, an hour after a failure, and at once on Check now; only this server
// process runs it (chat processes never fetch ollama-cloud, pi-config/extensions/model-levels/core.ts
// SERVER_CHECKED). Whoever writes model-levels.json, the shared runtime applies it again
// (§app.model-levels/sova-boot), so GET /api/models follows a finished check with no restart.
import { unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import {
  CACHE_FILE,
  CHECK_EVERY_MS,
  type CheckRecord,
  checkServerProvider,
  modelFetchEnabled,
  NEW_FOR_MS,
  readCache,
  RETRY_MS,
} from "../../../pi-config/extensions/model-levels/core.ts";
import type { ModelCheckStatus } from "../../../shared/protocol";
import { agentRoot } from "../../state-root";
import { reapplyModelLevels } from "./open";

/** The one provider the server checks. */
export const CHECKED_PROVIDER = "ollama-cloud";

/** The timers the schedule runs on; a test hands in its own clock. */
export interface CheckClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: CheckClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** When the next check is due after `last`: at once with none, a day after a success, an hour after a failure. */
export function nextCheckAt(last: CheckRecord | undefined, now: number): number {
  if (!last) return now;
  return last.ok ? last.at + CHECK_EVERY_MS : (last.retryAt ?? last.at + RETRY_MS);
}

export interface ModelCheckOptions {
  /** Whether checks may run at all (PI_OFFLINE, SOVA_MODELS_FETCH). */
  enabled: boolean;
  /** Run one check and record it; never throws. */
  run(): Promise<CheckRecord>;
  /** The last check recorded (the cache file's). */
  last(): CheckRecord | undefined;
  clock?: CheckClock;
}

export interface ModelCheck {
  /** Arm the timer from the last recorded check. */
  start(): void;
  stop(): void;
  /** Run now (joins one already running); undefined when checks are off. */
  checkNow(): Promise<CheckRecord | undefined>;
  checking(): boolean;
  /** When the timer fires next; undefined while stopped or off. */
  nextAt(): number | undefined;
}

/** The schedule alone: no file, no network; `run` does the work. */
export function createModelCheck(opts: ModelCheckOptions): ModelCheck {
  const clock = opts.clock ?? realClock;
  let timer: unknown;
  let due: number | undefined;
  let inflight: Promise<CheckRecord> | null = null;
  let started = false;

  const arm = (at: number) => {
    if (timer !== undefined) clock.clearTimeout(timer);
    due = at;
    timer = clock.setTimeout(() => {
      timer = undefined;
      due = undefined;
      void runNow();
    }, Math.max(0, at - clock.now()));
  };
  const runNow = (): Promise<CheckRecord> => {
    if (inflight) return inflight;
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    due = undefined;
    inflight = opts
      .run()
      .catch((e): CheckRecord => {
        const at = clock.now();
        return { at, ok: false, error: e instanceof Error ? e.message : String(e), retryAt: at + RETRY_MS };
      })
      .then((record) => {
        inflight = null;
        if (started) arm(nextCheckAt(record, clock.now()));
        return record;
      });
    return inflight;
  };
  return {
    start() {
      if (!opts.enabled || started) return;
      started = true;
      arm(nextCheckAt(opts.last(), clock.now()));
    },
    stop() {
      started = false;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      due = undefined;
    },
    checkNow: () => (opts.enabled ? runNow() : Promise.resolve(undefined)),
    checking: () => inflight !== null,
    nextAt: () => due,
  };
}

/**
 * Re-apply the cached levels whenever model-levels.json changes, whichever process wrote it: its
 * mtime, polled (an atomic rename replaces the file, which a watch on the file itself would lose).
 */
export function watchLevelsFile(agentDir: string, apply: () => void, intervalMs = 1000): () => void {
  const file = join(agentDir, CACHE_FILE);
  const listener = (cur: { mtimeMs: number }, prev: { mtimeMs: number }) => {
    if (cur.mtimeMs !== prev.mtimeMs) apply();
  };
  watchFile(file, { interval: intervalMs, persistent: false }, listener);
  return () => unwatchFile(file, listener);
}

let check: ModelCheck | null = null;
let stopWatch: (() => void) | null = null;

/** The server's check, made on first use (the routes, or startup's startModelCheck). */
export function modelCheck(): ModelCheck {
  const agentDir = agentRoot();
  check ??= createModelCheck({
    enabled: modelFetchEnabled(process.env),
    run: () => checkServerProvider({ agentDir, provider: CHECKED_PROVIDER }),
    last: () => readCache(agentDir)?.checks?.[CHECKED_PROVIDER],
  });
  return check;
}

/** Startup (server/index.ts): watch the file for every writer and arm the daily check. The server only: a chat process never does. */
export function startModelCheck(): void {
  stopWatch ??= watchLevelsFile(agentRoot(), () => void reapplyModelLevels());
  modelCheck().start();
}

/** Settings → Models' line (§app.model-levels/settings-line): the last check, what's checking, the New models. */
export function modelCheckStatus(now = Date.now()): ModelCheckStatus {
  const c = modelCheck();
  const cache = readCache(agentRoot());
  const provider = cache?.providers[CHECKED_PROVIDER];
  const newModels = Object.entries(provider?.discovered ?? {})
    .filter(([id, d]) => now - d.firstSeenAt < NEW_FOR_MS && !provider?.models[id]?.retired)
    .map(([id, d]) => ({ ref: `${CHECKED_PROVIDER}/${id}`, firstSeenAt: d.firstSeenAt }));
  const last = cache?.checks?.[CHECKED_PROVIDER];
  return {
    provider: CHECKED_PROVIDER,
    enabled: modelFetchEnabled(process.env),
    checking: c.checking(),
    ...(last ? { last: { at: last.at, ok: last.ok, ...(last.error ? { error: last.error } : {}), ...(last.retryAt ? { retryAt: last.retryAt } : {}), added: last.added ?? [], retired: last.retired ?? [] } } : {}),
    newModels,
  };
}

