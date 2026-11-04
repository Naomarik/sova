import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENTRY_FINAL, type LandHow, type MergeEntry, type MergeRun, type PauseInfo } from "../../shared/merge-queue";

/**
 * The merge queue's records, per project, under the state root (records only: the merge COPY lives beside the
 * project, server/merge-queue/guard.ts):
 *
 *   <state>/merge-queue/<key>/queue.json       QueueFile (entries, pause, the landing intent, heads)
 *   <state>/merge-queue/<key>/runs/<run>/run.json   MergeRun
 *   <state>/merge-queue/<key>/runs/<run>/<step>.log every step's log, from its first line
 *
 * Every write re-writes the whole file atomically (tmp + rename). A damaged queue.json is kept aside and read as
 * empty, with a warning.
 */

/** Written before master moves and cleared after (server/merge-queue/land.ts): at start, recover.ts reconciles one
 *  left behind by a stop. */
export interface LandIntent {
  run: string;
  entry: string;
  /** The target's head before. */
  from: string;
  /** The tested tip it moves to. */
  to: string;
  at: string;
}

/** Written before each act that publishes to the host (al_3, a17): the push of the chat's branch, then the request's
 *  creation. Cleared once the act's outcome is recorded on the entry. At start, a left-behind one is reconciled with
 *  what origin and the host have (strategy-run.ts reconcilePublish), never repeated blind. */
export interface PublishIntent {
  entry: string;
  run: string;
  how: Exclude<LandHow, "local">;
  branch: string;
  step: "push" | "create";
  /** The tip being published (the chat's branch with its docs commit). */
  head: string;
  at: string;
}

export interface QueueFile {
  v: 1;
  /** The project's id (or its root when not registered). */
  project: string;
  root: string;
  target: string;
  /** Open entries in line order first is not implied: order by `seq`. Final ones kept (newest 60). */
  entries: (MergeEntry & { seq: number })[];
  paused?: PauseInfo;
  /** The merge thread's hold (merge.hold): no new run starts until `until` (epoch ms) or its clear; cleared at start. */
  hold?: { at: string; until: number };
  intent?: LandIntent;
  /** A publication in flight (request strategies). */
  publish?: PublishIntent;
  /** Entries whose publication the user approved (Publish, or Land Again onto an open request) and that wait to go
   *  out (the chat busy, its folder not clean): their text, or null when the request already has one. Retried by the
   *  poller; dropped once published or refused. */
  awaitingPublish?: Record<string, { title: string; body: string; draft: boolean } | null>;
  /** The target's head as the queue last saw it (or moved it): a different head is a move from outside. */
  knownTarget?: string;
  /** Commits the queue moved the target to (tips, docs commits are inside them), newest last: the push rule reads them. */
  landed: string[];
  heads: { pushed?: string; pushWhy?: string; targetRed?: string[] };
  /** Machine failures in a row, per entry (retry once, then pause). */
  machineTries: Record<string, number>;
  /** A settings save waiting for the branch checking now (applied at the next quiet point); `failed`: why it couldn't be. */
  pendingSave?: { at: string; changes: import("../../shared/merge-queue-settings").MergeSettingsChange; failed?: string };
  seq: number;
  /** A release holds the queue: only its entries land, nothing is pushed (queue.ts freezeForRelease). */
  release?: import("../../shared/merge-queue").MergeReleaseHold & { checks?: import("../../shared/project-contract").MergeCheckDecl[] };
}

const KEEP_FINAL = 60;
const KEEP_LANDED = 500;

export const projectKey = (root: string): string => createHash("sha256").update(root).digest("hex").slice(0, 16);

export function newId(prefix: "mq" | "mr"): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

export class QueueStore {
  readonly dir: string;
  constructor(
    base: string,
    readonly root: string,
  ) {
    this.dir = join(base, projectKey(root));
  }

  private get file(): string {
    return join(this.dir, "queue.json");
  }

  read(defaults: { project: string; target: string }): QueueFile {
    const empty: QueueFile = { v: 1, project: defaults.project, root: this.root, target: defaults.target, entries: [], landed: [], heads: {}, machineTries: {}, seq: 0 };
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return empty;
    }
    try {
      const raw = JSON.parse(text) as Partial<QueueFile>;
      if (raw?.v !== 1 || !Array.isArray(raw.entries)) throw new Error("not a queue file");
      return {
        ...empty,
        ...raw,
        root: this.root,
        entries: raw.entries.filter((e) => e && typeof e.id === "string" && typeof e.commit === "string").map((e) => ({ ...e, notes: e.notes ?? [], picks: e.picks ?? [], runs: e.runs ?? [] })),
        landed: Array.isArray(raw.landed) ? raw.landed : [],
        heads: raw.heads ?? {},
        machineTries: raw.machineTries ?? {},
        seq: typeof raw.seq === "number" ? raw.seq : raw.entries.length,
      };
    } catch (err) {
      const aside = `${this.file}.damaged-${Date.now()}`;
      try {
        renameSync(this.file, aside);
      } catch {}
      console.warn(`[merge-queue] ${this.file} is damaged (${err instanceof Error ? err.message : err}); kept as ${aside}, read as empty`);
      return empty;
    }
  }

  write(q: QueueFile): void {
    mkdirSync(this.dir, { recursive: true });
    const open = q.entries.filter((e) => !isFinal(e));
    const final = q.entries.filter((e) => isFinal(e)).sort((a, b) => a.seq - b.seq).slice(-KEEP_FINAL);
    const entries = [...open, ...final].sort((a, b) => a.seq - b.seq);
    writeAtomic(this.file, `${JSON.stringify({ ...q, entries, landed: q.landed.slice(-KEEP_LANDED) }, null, 1)}\n`);
  }

  runDir(run: string): string {
    return join(this.dir, "runs", run);
  }

  readRun(run: string): MergeRun | null {
    if (!/^mr_[0-9a-z]+$/.test(run)) return null;
    try {
      return JSON.parse(readFileSync(join(this.runDir(run), "run.json"), "utf8")) as MergeRun;
    } catch {
      return null;
    }
  }

  writeRun(run: MergeRun): void {
    const d = this.runDir(run.id);
    mkdirSync(d, { recursive: true });
    writeAtomic(join(d, "run.json"), `${JSON.stringify(run, null, 1)}\n`);
  }

  /** A step's log lines (the tail `lines`). */
  readLog(run: string, log: string, lines = 200): string[] | null {
    if (!/^mr_[0-9a-z]+$/.test(run) || log.includes("..") || log.startsWith("/")) return null;
    try {
      const all = readFileSync(join(this.runDir(run), log), "utf8").split("\n");
      if (all.at(-1) === "") all.pop();
      return all.slice(-lines);
    } catch {
      return null;
    }
  }

  /** Every run id on disk, oldest first (by id: time-ordered). */
  runIds(): string[] {
    try {
      return readdirSync(join(this.dir, "runs")).filter((n) => n.startsWith("mr_")).sort();
    } catch {
      return [];
    }
  }

  /** Drop runs beyond the newest `keep`, never one an entry still names. */
  prune(keep: number, named: Set<string>): void {
    const ids = this.runIds();
    for (const id of ids.slice(0, Math.max(0, ids.length - keep))) if (!named.has(id)) rmSync(this.runDir(id), { recursive: true, force: true });
  }

  /** The project's private names file (`<dir>/names.json`, `{v, privateNames, kinds?, sources?}`), or for the
   *  project `legacyRoot` names (Sova's own), the merge round's `<state>/merge-round.json` while it has none of its own.
   *  `exists`: the file is there and reads as JSON with a `privateNames` list (an empty list is an answer). */
  namesFileOf(legacy?: { root: string; file: string }): { file: string; exists: boolean; legacy: boolean } {
    const own = join(this.dir, "names.json");
    const readable = (f: string): boolean => {
      try {
        const raw = JSON.parse(readFileSync(f, "utf8")) as { privateNames?: unknown };
        return Array.isArray(raw.privateNames);
      } catch {
        return false;
      }
    };
    if (readable(own)) return { file: own, exists: true, legacy: false };
    if (legacy && legacy.root === this.root && readable(legacy.file)) return { file: legacy.file, exists: true, legacy: true };
    return { file: own, exists: false, legacy: false };
  }

  exists(): boolean {
    return existsSync(this.file);
  }
}

export const isFinal = (e: Pick<MergeEntry, "state">): boolean => ENTRY_FINAL.includes(e.state);
