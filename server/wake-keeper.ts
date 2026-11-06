import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dropWakeRecords, readWakeRecords, WAKE_DIR_NAME, type WakeRecord } from "../pi-config/extensions/subagents/wake-store.ts";
import { agentRoot, stateRoot } from "./state-root";

/**
 * The wake keeper (§chat/wake-nudges): brings a shut-down chat back when something in the wake store
 * comes due. It only starts chats. Whoever owns an item delivers it and removes it (the chat fires
 * its own nudge), so a wake has one sender, and any later "bring this chat back at time T" is a
 * source that publishes items (pi-config/extensions/subagents/wake-store.ts) with nothing to add here.
 *
 * A try fails when the chat doesn't start, and when it starts and the item is still there once the
 * chat has had time to deliver it. After the last try the item stays and waits for the next open. A
 * chat that started and never published again doesn't know the item (the extension is absent or
 * off): its record is stale and goes. Tries are kept in a file of the keeper's own, so neither a
 * restart of Sova nor a crash loop gets them back.
 *
 * Everything that touches chats is injected (`WakeKeeperDeps`), so the rules are testable;
 * server/wake-keeper-live.ts wires the real ones.
 */

export const TICK_MS = 10_000;
/** How long before an item is due a shut-down chat is started. */
export const LEAD_MS = 15_000;
/** How long after a start, or after the item's time, the chat has to deliver it. */
export const CONFIRM_MS = 60_000;
export const MAX_TRIES = 3;
/** The wait before the second and third tries. */
export const TRY_GAPS_MS = [60_000, 5 * 60_000];

export const wakeDir = () => join(stateRoot(), WAKE_DIR_NAME);
/** A hermetic server holding copies of real sessions (scripts/hermetic-agent-dir.mjs) keeps no store: nothing of a copied chat may come due. */
export const wakesOn = () => !existsSync(join(agentRoot(), "copied-sessions.json"));

/** A worker chat's route back (server/chat-workers.ts `WakeOwner`). */
export interface WakeWorker {
  parentPath: string;
  parentSessionId: string;
  workerId: string;
  running: boolean;
  ended?: string;
}

export interface WakeKeeperDeps {
  dir: string;
  triesFile: string;
  now(): number;
  /** The chat's standing; null when its file is gone. */
  summary(path: string): Promise<{ archived: boolean; live: boolean } | null>;
  /** Whether a chat that is no worker's has a process now. */
  running(path: string): boolean;
  /** The worker a session is, when it is one. */
  worker(sessionId: string): WakeWorker | undefined;
  /** Start a chat (one start at a time; a second open waits for the first). */
  open(path: string): Promise<void>;
  /** Bring a worker back through its parent, already open: the worker's process starts on return. */
  resumeWorker(sessionId: string, w: WakeWorker): Promise<void>;
  log(line: string): void;
  tickMs?: number;
  leadMs?: number;
  confirmMs?: number;
  gapsMs?: number[];
}

/** One chat's tries at its earliest due item. */
interface Tries {
  /** The item they are for: any other item is a new count. */
  key: string;
  tries: number;
  startedAt: number;
  /** After a start: when to look again. */
  confirmAt?: number;
  /** After a failed try: not before this. */
  nextAt?: number;
  gaveUp?: true;
  /** Items whose tries ran out: each waits for the next open, and no later item waits behind it. */
  given?: string[];
}

export class WakeKeeper {
  private tries: Record<string, Tries>;
  private running = false;

  constructor(private readonly d: WakeKeeperDeps) {
    this.tries = this.readTries();
  }

  private readTries(): Record<string, Tries> {
    try {
      const v = JSON.parse(readFileSync(this.d.triesFile, "utf8")) as Record<string, Tries>;
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }

  private saveTries(): void {
    try {
      mkdirSync(dirname(this.d.triesFile), { recursive: true, mode: 0o700 });
      const tmp = `${this.d.triesFile}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.tries)}\n`, { mode: 0o600 });
      renameSync(tmp, this.d.triesFile);
    } catch (err) {
      this.d.log(`tries not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One sweep, one chat at a time. A sweep still running when the next comes skips that one. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sweep();
    } finally {
      this.running = false;
    }
  }

  private drop(sessionId: string, why: string): void {
    this.d.log(`${sessionId}: dropped (${why})`);
    dropWakeRecords(this.d.dir, sessionId);
    this.forget(sessionId);
  }

  private forget(sessionId: string): void {
    if (!this.tries[sessionId]) return;
    delete this.tries[sessionId];
    this.saveTries();
  }

  private async sweep(): Promise<void> {
    const chats = new Map<string, WakeRecord[]>();
    for (const r of readWakeRecords(this.d.dir)) {
      const list = chats.get(r.sessionId);
      if (list) list.push(r);
      else chats.set(r.sessionId, [r]);
    }
    for (const id of Object.keys(this.tries)) if (!chats.has(id)) this.forget(id);
    const lead = this.d.leadMs ?? LEAD_MS;
    const earliest = (rs: WakeRecord[]) => Math.min(...rs.flatMap((r) => r.items.map((i) => i.at)));
    // The longest overdue first: a catch-up goes in the order the items came due.
    for (const [sessionId, records] of [...chats].sort((a, b) => earliest(a[1]) - earliest(b[1]))) {
      const due = records
        .flatMap((r) => r.items.map((i) => ({ ...i, key: `${r.source}:${i.id}`, syncedAt: r.syncedAt })))
        .filter((i) => i.at <= this.d.now() + lead)
        .sort((a, b) => a.at - b.at);
      if (!due.length) {
        this.forget(sessionId);
        continue;
      }
      // A given-up item no longer due (delivered) leaves the list; the earliest left that isn't given up is tried.
      const t = this.tries[sessionId];
      if (t?.given) {
        const given = t.given.filter((k) => due.some((i) => i.key === k));
        if (given.length !== t.given.length) {
          if (given.length) t.given = given;
          else delete t.given;
          this.saveTries();
        }
      }
      const givenUp = new Set([...(t?.given ?? []), ...(t?.gaveUp ? [t.key] : [])]);
      const first = due.find((i) => !givenUp.has(i.key));
      if (!first) continue; // every due item waits for the next open
      await this.consider(sessionId, records[0]!.path, first).catch((err) => this.d.log(`${sessionId}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private async consider(sessionId: string, path: string, first: { at: number; key: string; syncedAt: number }): Promise<void> {
    const d = this.d;
    const summary = await d.summary(path);
    if (!summary) return this.drop(sessionId, "its file is gone");
    if (summary.archived) return this.drop(sessionId, "archived");
    // A chat open in a terminal is left alone, with no try spent.
    if (summary.live) return;
    const worker = d.worker(sessionId);
    if (worker?.ended === "killed") return this.drop(sessionId, "its worker was stopped");
    if (worker) {
      const parent = await d.summary(worker.parentPath);
      if (!parent) return this.drop(sessionId, "its parent's file is gone");
      if (parent.archived) return this.drop(sessionId, "its parent is archived");
      if (parent.live) return;
    }

    let t = this.tries[sessionId];
    const given = t?.given;
    if (t && t.key !== first.key) t = undefined; // what it tried for was delivered or given up: a new count
    const now = d.now();
    if (t?.confirmAt) {
      if (now < t.confirmAt) return;
      // The chat had its time and the item is still here.
      if (first.syncedAt < t.startedAt) return this.drop(sessionId, "the chat started and doesn't know it");
      return this.failed(sessionId, t, "started and did not deliver it");
    }
    if (t?.gaveUp || (t?.nextAt && now < t.nextAt)) return;
    if (worker ? worker.running : d.running(path)) return; // running: it fires by itself

    const attempt: Tries = { key: first.key, tries: (t?.tries ?? 0) + 1, startedAt: now, ...(given ? { given } : {}) };
    this.tries[sessionId] = attempt;
    this.saveTries();
    d.log(`${sessionId}: bringing it back for ${first.key} (try ${attempt.tries} of ${MAX_TRIES})`);
    try {
      if (worker) {
        await d.open(worker.parentPath);
        await d.resumeWorker(sessionId, worker);
      } else await d.open(path);
    } catch (err) {
      return this.failed(sessionId, attempt, `did not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    attempt.confirmAt = Math.max(d.now(), first.at) + (d.confirmMs ?? CONFIRM_MS);
    this.saveTries();
  }

  private failed(sessionId: string, t: Tries, why: string): void {
    const gaps = this.d.gapsMs ?? TRY_GAPS_MS;
    delete t.confirmAt;
    if (t.tries >= MAX_TRIES) {
      t.gaveUp = true;
      t.given = [...new Set([...(t.given ?? []), t.key])];
      this.d.log(`${sessionId}: ${why}; last try, it waits for the next open`);
    } else {
      t.nextAt = this.d.now() + (gaps[t.tries - 1] ?? gaps.at(-1) ?? 0);
      this.d.log(`${sessionId}: ${why}`);
    }
    this.tries[sessionId] = t;
    this.saveTries();
  }

  /** Start ticking. */
  start(): void {
    setInterval(() => void this.tick().catch((err) => this.d.log(`tick failed: ${err instanceof Error ? err.message : String(err)}`)), this.d.tickMs ?? TICK_MS).unref();
  }
}
