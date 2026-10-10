import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ReadinessState, SessionReadiness, SessionSummary } from "../shared/protocol";
import { canonical } from "../pi-config/extensions/worktrees/state.ts";
import { stateRoot } from "./state-root";

/**
 * The merge board (§chat.worktrees/merge-board): Sova's readiness view of every tracked worktree,
 * written to `<state root>/merge-board.json` so a playbook's script (the merge round's driver,
 * §chat.merge-round/driver) learns who owns which branch with no token and no HTTP call, and read
 * in-process by the schedule keeper's `merge-ready` trigger (§chat.schedules/merge-ready).
 *
 * The board is built from readiness's own cache (`readinessReading`), never by reading git or a
 * session file here: a session readiness hasn't read yet is counted as `pending`, so a reader can
 * tell "not read yet" from "no owner".
 */

export const MERGE_BOARD_VERSION = 1;
/** The merge captain's profile: its sessions attach worktrees only to check them, never own them. */
export const CAPTAIN_PROFILE = "merge-captain";
/** How long a refresh waits for the readiness reads a listing asked for. */
export const BOARD_WAIT_MS = 20_000;
/** How often the server rewrites the file. */
export const BOARD_EVERY_MS = 60_000;

export type OwnerStatus = "idle" | "busy" | "archived";

export interface BoardOwner {
  id: string;
  status: OwnerStatus;
  /** The session's profile id; null for Default. */
  profile: string | null;
  lastActiveAt: string;
}

export interface BoardRow {
  /** The worktree's canonical path. */
  path: string;
  branch: string;
  /** The common git directory the worktree belongs to (canonical); null when it can't be read. */
  repo: string | null;
  state: ReadinessState;
  /** Readiness's reason line: "Waiting for your OK · checks passed · 3 commits ahead". */
  reason: string;
  /** When readiness made this reading (ISO). */
  readAt: string;
  owner: BoardOwner;
}

export interface MergeBoard {
  v: typeof MERGE_BOARD_VERSION;
  /** When the board was written (ISO). */
  at: string;
  /** Sessions whose readiness Sova has read. */
  read: number;
  /** Sessions it hasn't read yet: a missing row is unknown while this is above 0. */
  pending: number;
  rows: BoardRow[];
}

type Reading = { known: false } | { known: true; at: number; value?: SessionReadiness };

export interface BoardInputs {
  /** Readiness's last answer for a session, without queueing a read. */
  reading(sessionPath: string): Reading;
  /** Whether readiness ever covers the session. */
  covers(s: SessionSummary): boolean;
  /** The session holds a queued message (Sova's own queue), beyond what its row says. */
  queued?(sessionPath: string): boolean;
  /** The common git directory of a worktree; null when unreadable. */
  repoOf?(path: string): string | null;
}

const running = (s: SessionSummary) => s.busy || s.activity?.state === "working" || (s.workers?.working ?? s.live?.workers?.working ?? 0) > 0;

export function ownerStatus(s: SessionSummary, queued = false): OwnerStatus {
  if (s.archived) return "archived";
  return running(s) || queued ? "busy" : "idle";
}

/** A session the merge captain runs as: never an owner. */
export const isCaptain = (s: SessionSummary) => s.profile?.id === CAPTAIN_PROFILE;

/**
 * The common git directory a worktree belongs to, from its `.git` entry (a directory, or a
 * `gitdir:` file whose folder names its `commondir`), canonical; never by running git.
 */
export function commonGitDir(path: string): string | null {
  const dotGit = join(path, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return canonical(dotGit);
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return null;
    const gitdir = isAbsolute(m[1]!) ? m[1]! : resolve(path, m[1]!);
    let common = gitdir;
    try {
      common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
    } catch {
      // No commondir file: the gitdir is the repository itself.
    }
    return canonical(common);
  } catch {
    return null;
  }
}

/** The board from a listing and readiness's cache (pure apart from `inputs`). */
export function buildBoard(sessions: readonly SessionSummary[], inputs: BoardInputs, now: number): MergeBoard {
  const repoOf = inputs.repoOf ?? commonGitDir;
  let read = 0;
  let pending = 0;
  const best = new Map<string, { s: SessionSummary; status: OwnerStatus; at: number; tree: SessionReadiness["trees"][number] }>();
  for (const s of sessions) {
    if (!inputs.covers(s)) continue;
    const r = inputs.reading(s.path);
    if (!r.known) {
      pending++;
      continue;
    }
    read++;
    if (isCaptain(s) || !r.value) continue;
    const status = ownerStatus(s, inputs.queued?.(s.path) ?? false);
    for (const tree of r.value.trees) {
      const key = canonical(tree.path);
      const prev = best.get(key);
      // Several sessions track the path: one not archived wins, then the most recently active.
      const better = !prev ? true : (prev.status === "archived") !== (status === "archived") ? status !== "archived" : s.lastActiveAt > prev.s.lastActiveAt;
      if (better) best.set(key, { s, status, at: r.at, tree });
    }
  }
  const rows: BoardRow[] = [];
  for (const [path, { s, status, at, tree }] of best) {
    rows.push({
      path,
      branch: tree.branch,
      repo: repoOf(path),
      state: tree.state,
      reason: tree.reason ?? tree.state,
      readAt: new Date(at).toISOString(),
      owner: { id: s.id, status, profile: s.profile?.id ?? null, lastActiveAt: s.lastActiveAt },
    });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return { v: MERGE_BOARD_VERSION, at: new Date(now).toISOString(), read, pending, rows };
}

export const mergeBoardFile = () => join(stateRoot(), "merge-board.json");

/** Replaces the file whole (mode 0600, atomic rename). */
export function writeBoard(file: string, board: MergeBoard): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** The board's rows in one project: worktrees of the git repository `root` belongs to. */
export function rowsIn(board: MergeBoard, root: string, repoOf: (path: string) => string | null = commonGitDir): BoardRow[] {
  const repo = repoOf(root);
  if (!repo) return [];
  return board.rows.filter((r) => r.repo === repo);
}

export interface BoardSourceDeps {
  list(): Promise<SessionSummary[]>;
  /** Resolves once readiness's queued reads are in. */
  idle(): Promise<void>;
  inputs: BoardInputs;
  file: string;
  now(): number;
  waitMs?: number;
}

/**
 * The server's board: rebuilt on demand (a listing asks for every stale readiness read, the
 * rebuild waits up to BOARD_WAIT_MS for them) and written to the file each time. Concurrent asks
 * share one rebuild; one younger than `maxAgeMs` is reused.
 */
export class BoardSource {
  private last: { at: number; board: MergeBoard } | null = null;
  private flight: Promise<MergeBoard> | null = null;
  constructor(readonly deps: BoardSourceDeps) {}

  get(maxAgeMs = 0): Promise<MergeBoard> {
    if (this.last && this.deps.now() - this.last.at < maxAgeMs) return Promise.resolve(this.last.board);
    this.flight ??= this.rebuild().finally(() => {
      this.flight = null;
    });
    return this.flight;
  }

  private async rebuild(): Promise<MergeBoard> {
    const sessions = await this.deps.list();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((done) => {
      timer = setTimeout(done, this.deps.waitMs ?? BOARD_WAIT_MS);
    });
    await Promise.race([this.deps.idle(), waited]);
    clearTimeout(timer);
    const board = buildBoard(sessions, this.deps.inputs, this.deps.now());
    try {
      writeBoard(this.deps.file, board);
    } catch (err) {
      console.warn("[merge-board] not written:", err instanceof Error ? err.message : String(err));
    }
    this.last = { at: this.deps.now(), board };
    return board;
  }
}
