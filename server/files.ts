// The @-mention file index (GET /api/files?cwd=…, shared/protocol.ts FileIndex): every
// non-ignored file under the session cwd, as "/"-separated paths relative to it, capped. Git
// repos use `git ls-files -c -o --exclude-standard` (tracked + untracked, .gitignore respected —
// so no node_modules); anywhere else a bounded walk with the default ignore list decides. One
// index per resolved cwd, cached ~30s and shared by concurrent callers; stale entries are
// recomputed, never served.
//
// Three bounds, and each one is honest about what it costs:
//
//  - **A whole-request deadline.** Every stat, git spawn and readdir spends from one budget, so a
//    wedged filesystem can't hold the request open. Node's fs calls are NOT cancellable: what the
//    deadline does is stop *waiting* and stop *continuing* — an in-flight readdir still runs to
//    completion somewhere, its result is dropped, and nothing it touches is ever written to the
//    cache. A request that ran out of time before it had anything to show is a 504, and it is not
//    cached, so the next open tries again.
//  - **A bounded walk.** The walk stops gathering at the cap rather than collecting everything and
//    slicing afterwards, holds a bounded queue of pending directories, and drops that queue's
//    processed prefix as it goes — a head index bounds what is PENDING, not what is retained. It
//    is breadth-first, which puts shallow entries in first, but `truncated` means exactly "this
//    list is partial": files AND directories are missing from it, at any depth, including the top
//    level, whether the cap, the queue, the depth limit, the byte cap or the clock cut it short.
//    Nothing here promises the top level is complete.
//  - **A bounded git read.** stdout is capped by BYTES before anything is stored, and decoded once
//    at the end, so a multi-byte character split across two chunks survives.
//
// A directory the walk can't read is skipped without marking the index partial — a single
// permission-denied subtree is ordinary, and flagging every repo that has one would make the flag
// meaningless. The ROOT is different: it is the folder the user asked for, so a root we can't stat
// OR can't readdir comes back as 403 or 404, never as an empty success. Both halves matter: stat
// answering "directory" does not mean readdir will answer at all.
//
// Remote sessions have no local files to list. A cwd under the placeholder root (a session that
// runs on a target) and a cwd under the removed sshfs mounts root are both refused with 501,
// lexically, before any filesystem call — a dead mount must not be stat'ed at all. Only a cwd that
// survived both refusals is run through path-map.json (server/path-map.ts): a renamed local root
// is the same folder under a new name, while a placeholder is an identity that must never be
// re-read as one.

import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { FileIndex } from "../shared/protocol";
import { movedPath } from "./path-map";
import { parseLegacyMountCwd, parseTargetCwd } from "./targets";

/** Most files one index holds; the rest sets `truncated`. */
export const MAX_INDEX_FILES = 20_000;
/** How long a computed index stays fresh. */
export const INDEX_TTL_MS = 30_000;
/** One request's whole wall-clock budget: stat + git + walk together, never each. */
export const REQUEST_BUDGET_MS = 6_000;
/** Bound on one git spawn, further clamped by what is left of the request budget. */
const GIT_TIMEOUT_MS = 4_000;
/** git output read cap, in BYTES: 20k paths are well under 1 MB, so this only stops a runaway. */
const GIT_OUTPUT_CAP = 8 * 1024 * 1024;
/** Deepest directory the walk enters (the cwd itself is depth 0). */
const WALK_MAX_DEPTH = 16;
/** Most directories the walk keeps queued. A tree wider than this is listed partially, not at
    the cost of an unbounded queue. */
const WALK_MAX_PENDING_DIRS = 20_000;
/** Non-git trees: the ignore list (git repos get .gitignore through --exclude-standard instead).
    Applies at every depth, like git's own excludes; dot-entries are NOT hidden wholesale, so
    .github lists the way it would in git. */
const DEFAULT_IGNORES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".cache",
  ".next",
  ".turbo",
  "coverage",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".parcel-cache",
  "bower_components",
]);

export type FilesResult = { ok: true; index: FileIndex } | { ok: false; status: 400 | 403 | 404 | 500 | 501 | 504; error: string };

/** What a bounded spawn answers with. `truncated` means the byte cap cut stdout short — then
    `code` is the code of a process we killed, not a verdict on the command. */
export interface ExecResult {
  code: number;
  stdout: string;
  truncated: boolean;
}

/** Why a cwd has no local files to index. */
export type RemoteCwd = { kind: "target"; target: string } | { kind: "legacy-mount"; target: string };

/** Injectable seams; every one has the real default. Tests swap them, callers never pass them. */
export interface FilesDeps {
  /** Spawn (default: execBounded). Note a stubbed exec proves nothing about execBounded itself —
      its decoding, capping and timer handling are tested against a real subprocess. */
  exec?: (argv: readonly string[], opts: { timeoutMs: number; byteCap: number }) => Promise<ExecResult>;
  /** One directory's entries with their is-directory flag (default: fs readdir withFileTypes). */
  listDir?: (path: string) => Promise<{ name: string; dir: boolean }[]>;
  /** Whether the root path is a directory (default: fs stat; it throws, and the errno decides
      403 vs 404). */
  isDirectory?: (path: string) => Promise<boolean>;
  /** The remote reading of a cwd (default: targets.ts, lexical; null = an ordinary local path). */
  remoteOf?: (path: string) => RemoteCwd | null;
  /** Clock (default Date.now), for cache-TTL tests. */
  now?: () => number;
  /** Index cap (default MAX_INDEX_FILES), for truncation tests. */
  max?: number;
  /** Whole-request budget (default REQUEST_BUDGET_MS), for deadline tests. */
  budgetMs?: number;
}

// ---------------------------------------------------------------------------
// the request deadline

interface Deadline {
  /** Milliseconds left, never below 0. */
  remaining(): number;
  expired(): boolean;
}

function deadline(now: () => number, budgetMs: number): Deadline {
  const at = now() + budgetMs;
  return {
    remaining: () => Math.max(0, at - now()),
    expired: () => at - now() <= 0,
  };
}

/** Races a non-cancellable promise against the deadline. The operation keeps running — nothing
    here can stop a readdir on a wedged mount — but we stop waiting on it and its value is
    dropped, so it can never reach the cache or the response. */
function withDeadline<T>(p: Promise<T>, d: Deadline): Promise<{ ok: true; value: T } | { ok: false }> {
  const ms = d.remaining();
  if (ms <= 0) {
    void p.catch(() => {}); // abandoned: its rejection is nobody's error now
    return Promise.resolve({ ok: false as const });
  }
  return new Promise((settle, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      settle({ ok: false });
    }, ms);
    timer.unref?.();
    p.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        settle({ ok: true, value });
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// the bounded spawn

/**
 * Bounded spawn: collects stdout up to `byteCap` BYTES, decodes once at the end (so a multi-byte
 * character split across two chunks is not mangled), kills the child on timeout or at the cap,
 * and clears its timer on every exit — success, failure, timeout and cap alike.
 *
 * Exported for its own tests: an injected exec that returns a string cannot exercise any of this.
 */
export function execBounded(argv: readonly string[], opts: { timeoutMs: number; byteCap: number }): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, [...argv.slice(1)], { stdio: ["ignore", "pipe", "ignore"] });
    } catch (err) {
      reject(err as Error);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      run();
    };
    const timer = setTimeout(() => settle(() => {
      kill();
      reject(new Error(`${argv[0]} timed out after ${opts.timeoutMs}ms`));
    }), opts.timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      const room = opts.byteCap - bytes;
      if (room <= 0) {
        truncated = true;
        kill();
        return;
      }
      if (chunk.length > room) {
        // The cap is enforced BEFORE storing: only what fits is kept, never the whole chunk.
        chunks.push(chunk.subarray(0, room));
        bytes = opts.byteCap;
        truncated = true;
        kill(); // the close handler still settles, with what we kept
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    });
    child.stdout?.on("error", (err: Error) => settle(() => {
      kill();
      reject(err);
    }));
    child.on("error", (err: Error) => settle(() => reject(err)));
    child.on("close", (code) => settle(() => resolvePromise({ code: code ?? -1, stdout: Buffer.concat(chunks).toString("utf8"), truncated })));
  });
}

/** git's non-ignored files under `path`, relative to it; null when git says it isn't a repo, when
    git is missing, or when it failed for any other reason — the walk decides instead. */
async function gitListFiles(path: string, deps: FilesDeps, d: Deadline): Promise<{ files: string[]; truncated: boolean } | null> {
  const exec = deps.exec ?? execBounded;
  const timeoutMs = Math.min(GIT_TIMEOUT_MS, d.remaining());
  if (timeoutMs <= 0) return null;
  try {
    // Raced against the request deadline as well as its own timer: execBounded bounds a real
    // spawn, but the seam is a seam — a git that never answers must not hold the request open,
    // and its late answer must not reach the index or the cache.
    const raced = await withDeadline(
      exec(["git", "-C", path, "ls-files", "-c", "-o", "--exclude-standard", "-z"], { timeoutMs, byteCap: GIT_OUTPUT_CAP }),
      d,
    );
    if (!raced.ok) return null; // out of time: compute() turns an expired deadline into a 504
    const r = raced.value;
    if (!r.truncated && r.code !== 0) return null; // not a repo (or git refused)
    const parts = r.stdout.split("\0");
    if (r.truncated) parts.pop(); // the cap cut the last path mid-way; it is not a path
    return { files: parts.filter(Boolean), truncated: r.truncated };
  } catch {
    return null; // no git, timeout, spawn failure: same fallback
  }
}

// ---------------------------------------------------------------------------
// the bounded walk

/** Which bound ended the walk, or null when it read the whole tree. The walk REPORTS this rather
    than leaving the caller to ask the clock again: a timer that fires a millisecond early would
    otherwise read as "still in budget" and turn a cut-short walk into an empty, cacheable
    success. Every one of these means the index is partial. */
type WalkStop = "cap" | "queue" | "depth" | "deadline" | null;

/** The walk's answer. A ROOT it could not read is a failure, not an empty tree: `rootError` is the
    errno the caller turns into 403 or 404. Deeper directories that fail are skipped instead. */
type WalkResult = { ok: true; files: string[]; stopped: WalkStop } | { ok: false; rootError: unknown };

/** Processed entries are dropped from the queue once this many have piled up behind the head.
    The head index alone bounds how many directories are PENDING, not how much the walk retains:
    without this, a 200k-directory tree keeps all 200k entries alive to the end. */
const WALK_QUEUE_COMPACT_AT = 512;

/** Drops the processed prefix when it has grown past the compaction threshold; returns the new
    head. Pure, and the only thing standing between the walk and unbounded retention. */
export function compactProcessed<T>(queue: T[], head: number): number {
  if (head < WALK_QUEUE_COMPACT_AT) return head;
  queue.splice(0, head);
  return 0;
}

async function walk(root: string, deps: FilesDeps, d: Deadline, max: number): Promise<WalkResult> {
  const listDir = deps.listDir ?? (async (p) => (await readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory() })));
  const out: string[] = [];
  // Breadth-first over a queue read by index: shifting an array of 20k directories is not free,
  // and the head pointer keeps the whole walk O(directories).
  const queue: { rel: string[]; abs: string }[] = [{ rel: [], abs: root }];
  let head = 0;
  let stopped: WalkStop = null;
  while (head < queue.length) {
    if (d.expired()) return { ok: true, files: out, stopped: "deadline" };
    if (out.length >= max) return { ok: true, files: out, stopped: "cap" };
    const { rel, abs } = queue[head++]!;
    head = compactProcessed(queue, head); // the entries behind us are done; let them go
    let entries: { name: string; dir: boolean }[];
    try {
      const r = await withDeadline(listDir(abs), d);
      if (!r.ok) return { ok: true, files: out, stopped: "deadline" }; // out of time: stop walking
      entries = r.value;
    } catch (err) {
      // The ROOT is the folder the user asked for: failing to read it is the answer, not an empty
      // tree. stat can say "directory" and readdir still refuse (a dir with --x and no r), so this
      // is reachable even though compute() stat'ed it a moment ago.
      if (abs === root) return { ok: false, rootError: err };
      continue; // a deeper unreadable subtree: skipped, deliberately not a partial-index signal
    }
    for (const e of entries) {
      if (DEFAULT_IGNORES.has(e.name)) continue;
      const next = [...rel, e.name];
      if (e.dir) {
        if (next.length > WALK_MAX_DEPTH) {
          stopped = "depth"; // everything under here goes unlisted, and the index must say so
          continue;
        }
        if (queue.length - head >= WALK_MAX_PENDING_DIRS) {
          stopped = "queue"; // the queue is full: this subtree goes unlisted
          continue;
        }
        queue.push({ rel: next, abs: join(abs, e.name) });
      } else {
        if (out.length >= max) return { ok: true, files: out, stopped: "cap" }; // bounded gathering, not gather-then-slice
        out.push(next.join("/"));
      }
    }
  }
  return { ok: true, files: out, stopped };
}

/** Sorts and cuts at the cap. `partial` carries a truncation the cap itself didn't cause. */
function toIndex(files: string[], max: number, partial: boolean): FileIndex {
  const sorted = [...files].sort();
  return { files: sorted.slice(0, max), truncated: partial || files.length > max };
}

// ---------------------------------------------------------------------------
// the index

const cache = new Map<string, { index: FileIndex; at: number }>();
const inflight = new Map<string, Promise<FilesResult>>();

/** A computed answer plus whether it may be cached. A result the deadline cut short is NOT
    cacheable: caching a partial read would serve it for the whole TTL instead of retrying. */
type Computed = { result: FilesResult; cacheable: boolean };

function statFailure(err: unknown): FilesResult {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") return { ok: false, status: 403, error: "Sova can't read this folder" };
  if (code === "ENOENT") return { ok: false, status: 404, error: "Folder not found" };
  if (code === "ENOTDIR") return { ok: false, status: 404, error: "Not a folder" };
  return { ok: false, status: 500, error: `Sova couldn't read this folder (${code ?? "unknown error"})` };
}

async function compute(path: string, deps: FilesDeps, d: Deadline): Promise<Computed> {
  const isDirectory = deps.isDirectory ?? (async (p) => (await stat(p)).isDirectory());
  const timedOut: Computed = { result: { ok: false, status: 504, error: "Reading this folder took too long — try the menu again" }, cacheable: false };
  let rooted: { ok: true; value: boolean } | { ok: false };
  try {
    rooted = await withDeadline(isDirectory(path), d);
  } catch (err) {
    return { result: statFailure(err), cacheable: false }; // a failed read retries on the next open
  }
  if (!rooted.ok) return timedOut;
  if (!rooted.value) return { result: { ok: false, status: 404, error: "Not a folder" }, cacheable: false };

  const max = deps.max ?? MAX_INDEX_FILES;
  const viaGit = await gitListFiles(path, deps, d);
  if (viaGit) return { result: { ok: true, index: toIndex(viaGit.files, max, viaGit.truncated) }, cacheable: true };
  if (d.expired()) return timedOut;

  const walked = await walk(path, deps, d, max);
  if (!walked.ok) return { result: statFailure(walked.rootError), cacheable: false }; // never an empty success
  const outOfTime = walked.stopped === "deadline";
  if (outOfTime && walked.files.length === 0) return timedOut; // nothing to show is not a success
  return { result: { ok: true, index: toIndex(walked.files, max, walked.stopped !== null) }, cacheable: !outOfTime };
}

/** Why the cwd is refused, for a cwd whose files don't live on this machine. Neither line offers a
    way to get the menu working: a NEW remote session is refused here exactly like this one, so
    "start a remote session instead" would be a promise this endpoint doesn't keep. */
function remoteRefusal(remote: RemoteCwd): FilesResult {
  return remote.kind === "target"
    ? { ok: false, status: 501, error: `This session's files live on ${remote.target}. The @ menu lists local folders only` }
    : { ok: false, status: 501, error: `This folder was an sshfs mount of ${remote.target} that Sova no longer creates. The @ menu lists local folders only` };
}

/** The lexical remote reading of a resolved cwd: a target placeholder, a legacy mount, or null.
    Exported for server/playbooks.ts, whose project scan refuses the same cwds on the same terms. */
export const defaultRemoteOf = (p: string): RemoteCwd | null => {
  const target = parseTargetCwd(p);
  if (target) return { kind: "target", target: target.target };
  const legacy = parseLegacyMountCwd(p);
  return legacy ? { kind: "legacy-mount", target: legacy.target } : null;
};

/**
 * The cwd's file index: gitignore-respecting in a git repo, default-ignored elsewhere, cached
 * for INDEX_TTL_MS (concurrent callers share one computation). A failure and a result the
 * deadline cut short are never cached, so a menu that couldn't read the folder retries on its
 * next open rather than being told the same thing for 30 seconds.
 */
export async function listProjectFiles(rawCwd: string | undefined, deps: FilesDeps = {}): Promise<FilesResult> {
  const now = deps.now ?? Date.now;
  if (rawCwd === undefined || rawCwd === "" || !isAbsolute(rawCwd)) return { ok: false, status: 400, error: "cwd must be an absolute path" };
  const resolved = resolve(rawCwd);
  const remote = (deps.remoteOf ?? defaultRemoteOf)(resolved);
  if (remote) return remoteRefusal(remote); // lexical, before any fs call: a dead mount isn't stat'ed
  // A session's stored cwd is its identity and is never rewritten, so a session recorded against a
  // renamed repo root asks for the OLD path forever. Map it here, AFTER the remote refusal above —
  // a placeholder cwd must be refused as remote, never re-read as a moved local folder — and the
  // @ menu of a pre-rename session lists the moved folder instead of 404ing. The cache is keyed by
  // the mapped path, so both spellings share one index: it is one folder under two names.
  const path = movedPath(resolved);
  const hit = cache.get(path);
  if (hit && now() - hit.at < INDEX_TTL_MS) return { ok: true, index: hit.index };
  const existing = inflight.get(path);
  if (existing) return existing;
  const d = deadline(now, deps.budgetMs ?? REQUEST_BUDGET_MS);
  const p = compute(path, deps, d)
    .then(({ result, cacheable }) => {
      // The one write to the cache, and the only place a late answer could poison it: a result
      // that came back after the deadline is dropped instead.
      if (result.ok && cacheable && !d.expired()) cache.set(path, { index: result.index, at: now() });
      return result;
    })
    .finally(() => inflight.delete(path)); // always, so a timed-out request doesn't pin the entry
  inflight.set(path, p);
  return p;
}
