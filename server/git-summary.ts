// A session's repository (GET /api/sessions/git?path=…, shared/protocol.ts GitSummary): the whole
// repository that contains the session's cwd — branch, what is staged, unstaged, untracked and
// conflicted, divergence from the upstream as this repository last saw it, the latest commit, and
// per-path line counts. Never file contents, never a diff.
//
// Read-only by construction, and every flag below is there for one write or one side effect:
//  - `--no-optional-locks` (and GIT_OPTIONAL_LOCKS=0): `git status` otherwise refreshes the index
//    and takes index.lock to do it — behind the back of a TUI or agent working in that repo;
//  - nothing fetches: ahead/behind is status's own count against the upstream ref as it is on disk;
//  - line counts come from plumbing `git diff-index`, never porcelain `git diff`: the porcelain
//    refreshes and rewrites the index even under --no-optional-locks (git 2.54; this module's
//    read-only test caught it);
//  - `--no-textconv --no-ext-diff`: counting lines must not run a repo-configured driver;
//  - `log.showSignature=false`: no gpg for a subject line;
//  - `core.fsmonitor=false`: a web request must not start a long-lived monitor daemon.
//
// One script, two transports. The same POSIX sh script runs here (spawned `sh -c <script> sh <cwd>`
// without a shell around it — the cwd arrives as $1 and is never interpolated) and on a target
// (targets.runOnTarget: the argv builder quotes the cwd). Both prefix the same `cd -- <cwd> || exit
// 1`, so "couldn't enter the folder" is the same answer on both sides, and a test that drives the
// script against a real local repository has driven the remote one too, transport aside.
//
// Framing. Each section is opened and closed by a marker `\0@@<nonce>:<name>:<code>@@\0` (`-` in
// the opening one). The nonce is random per run, so no path, subject or rc-file chatter can forge a
// marker. The opening marker is printed OUTSIDE the section's `head -c` cap and the closing one
// inside it, so a section that hit its cap is exactly a section with no closing marker: partial,
// and said so. Anything before the `begin` marker (a chatty login shell) is ignored.
//
// Bounds. Each git runs under `timeout -s KILL` where the far side has one, the whole run under the
// transport's own timer, and every section under a byte cap. Here the timer is execGroup's: the
// script runs in its own process group and the WHOLE group is killed, so a git mid-run dies with
// its shell even on a machine without `timeout`. On a target, runArgv kills the local ssh/docker
// client; what keeps running on the far side is bounded by the far `timeout` alone. A cut status makes every count a lower bound (`statusPartial`); a cut or timed-out count
// leaves the summary standing with `lines` saying why the numbers stop. Results are cached per
// folder for GIT_TTL_MS with concurrent callers sharing one read; failures are never cached.
//
// Which folder. The session's STORED cwd (its header) is its identity and is never rewritten.
// Remote placeholders and the removed sshfs mounts root are classified lexically first — a
// placeholder must never be re-read as a moved local folder, and a dead mount is never touched —
// and only then does a local cwd go through the rename bridge (targets.mappedNewCwd: the state-root
// rebase, then path-map.json), the same composition a chat open applies.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { GitChange, GitFileChange, GitRepoSummary, GitSummary, GitWhere } from "../shared/protocol";
import type { ExecResult } from "./files";
import { classifyFailure, mappedNewCwd, parseLegacyMountCwd, parseTargetCwd, runOnTarget, type TargetRunResult } from "./targets";

/** How long a read stays fresh. */
export const GIT_TTL_MS = 10_000;
/** Most changed paths one summary lists; `filesTotal` carries the rest. */
export const MAX_GIT_FILES = 500;
/** The whole local run: sh plus every git in it. */
export const LOCAL_TIMEOUT_MS = 12_000;
/** Most reads running at once, across every session on screen. */
const MAX_CONCURRENT = 3;
/** Section byte caps. status is the one that grows with the repo; 512 KB is ~5k changed paths. */
const CAP = { top: 16 * 1024, status: 512 * 1024, log: 16 * 1024, numstat: 256 * 1024 };
/** Local stdout cap: every section at its cap, plus markers. Under runArgv's 1 MB on a target. */
const LOCAL_BYTE_CAP = 900 * 1024;
/** Longest subject we send; git allows any length. */
const SUBJECT_MAX = 300;

/** Injectable seams; every one has the real default. Tests swap them, callers never pass them. */
export interface GitDeps {
  /** The session header's cwd (default: read the file's first line). */
  storedCwd?: (sessionPath: string) => Promise<string | null>;
  /** Run the script locally in `cwd` (default: execGroup `sh -c`). */
  runLocal?: (script: string, cwd: string) => Promise<ExecResult>;
  /** Run the script on a target in its remote cwd (default: targets.runOnTarget). */
  runRemote?: (target: string, script: string, remoteCwd: string) => Promise<TargetRunResult>;
  /** Whether a local path exists (default: fs.existsSync); asked only after a failed run. */
  exists?: (path: string) => boolean;
  /** Stored cwd → the folder a local read happens in (default: targets.mappedNewCwd). */
  mapCwd?: (cwd: string) => string;
  now?: () => number;
  nonce?: () => string;
}

// ---------------------------------------------------------------------------
// the script

/** The far script, after the transport's own `cd`. Exported for its tests. */
export function gitScript(nonce: string): string {
  if (!/^[0-9a-f]{8,}$/.test(nonce)) throw new Error("nonce must be hex");
  return [
    `N=${nonce}`,
    `m() { printf '\\000@@%s:%s:%s@@\\000' "$N" "$1" "$2"; }`,
    `export LC_ALL=C GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0`,
    `m begin 0`,
    `command -v git >/dev/null 2>&1 || { m nogit 127; exit 0; }`,
    `if command -v timeout >/dev/null 2>&1; then T=1; else T=; fi`,
    `g() { s=$1; shift; set -- git --no-optional-locks -c core.fsmonitor=false -c log.showSignature=false -c color.ui=false "$@"; if [ -n "$T" ]; then timeout -s KILL "$s" "$@"; else "$@"; fi; }`,
    // The root is never captured into a shell variable: `$(…)` would strip its trailing newlines
    // and nothing would bound it. A quiet run decides the flow; a refusal's stderr (never its
    // stdout) is the `toperr` section, and a success's raw stdout is the `top` section, both
    // under a cap. Nothing cds to the root: porcelain v2 and diff-index paths are root-relative
    // from any subfolder, and a root with a newline in it would have to survive a `cd`.
    `if ! g 3 rev-parse --show-toplevel >/dev/null 2>&1; then m toperr -; { g 3 rev-parse --show-toplevel 2>&1 >/dev/null; m toperr $?; } | head -c ${CAP.top}; exit 0; fi`,
    `m top -; { g 3 rev-parse --show-toplevel 2>/dev/null; m top $?; } | head -c ${CAP.top}`,
    `m status -; { g 6 status --porcelain=v2 --branch -z --untracked-files=normal 2>/dev/null; m status $?; } | head -c ${CAP.status}`,
    `m log -; { g 3 log -1 --format=%H%x00%ct%x00%s 2>/dev/null; m log $?; } | head -c ${CAP.log}`,
    // Worktree against HEAD, or against the empty tree before the first commit (hash-object, not a
    // hard-coded id: a sha256 repository has a different one).
    `if g 2 rev-parse -q --verify HEAD >/dev/null 2>&1; then b=HEAD; else b=$(g 2 hash-object -t tree /dev/null 2>/dev/null) || b=; fi`,
    `m numstat -; if [ -n "$b" ]; then { g 4 diff-index --numstat -z -M --no-ext-diff --no-textconv "$b" -- 2>/dev/null; m numstat $?; } | head -c ${CAP.numstat}; else m numstat 128; fi`,
    `m end 0`,
  ].join("\n");
}

/** The local spawn: the transport's `cd`, then the script; the cwd is $1, never spliced in. */
const localArgv = (script: string, cwd: string) => ["sh", "-c", `cd -- "$1" || exit 1\n${script}`, "sh", cwd];

/**
 * files.ts's execBounded, with one difference that is the reason it exists: the child leads its
 * own process group (`detached`), and the timeout and the byte cap SIGKILL the group, not the
 * child. Killing `sh` alone leaves the git it is waiting on running — and, without `timeout(1)`,
 * running for as long as git takes. stdout is capped by bytes before storing and decoded once.
 * Rejects on timeout and spawn failure; resolves with `truncated` at the cap. Exported for its
 * own tests against real processes.
 */
export function execGroup(argv: readonly string[], opts: { timeoutMs: number; byteCap: number }): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, [...argv.slice(1)], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    } catch (err) {
      reject(err as Error);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // the group is already gone
      }
    };
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      run();
    };
    const timer = setTimeout(
      () =>
        settle(() => {
          killGroup();
          reject(new Error(`${argv[0]} timed out after ${opts.timeoutMs}ms`));
        }),
      opts.timeoutMs,
    );
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      const room = opts.byteCap - bytes;
      if (chunk.length >= room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        bytes = opts.byteCap;
        truncated = true;
        killGroup(); // the close handler still settles, with what we kept
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    });
    child.stdout?.on("error", (err: Error) =>
      settle(() => {
        killGroup();
        reject(err);
      }),
    );
    child.on("error", (err: Error) => settle(() => reject(err)));
    child.on("close", (code) => settle(() => resolvePromise({ code: code ?? -1, stdout: Buffer.concat(chunks).toString("utf8"), truncated })));
  });
}

// ---------------------------------------------------------------------------
// parsing (pure)

export interface Section {
  out: string;
  /** git's exit code; null when the section has no closing marker (its cap or the run cut it). */
  code: number | null;
}

/** The script's output as named sections. `begun` is false when the script never started (the
    transport's cd failed, or something before it). */
export function parseSections(stdout: string, nonce: string): { begun: boolean; sections: Map<string, Section> } {
  const re = new RegExp(`\\0@@${nonce}:([a-z]+):(-|\\d+)@@\\0`, "g");
  const sections = new Map<string, Section>();
  let begun = false;
  let open: { name: string; from: number } | null = null;
  for (let m = re.exec(stdout); m; m = re.exec(stdout)) {
    const [whole, name, code] = m as unknown as [string, string, string];
    if (name === "begin") {
      begun = true;
      continue;
    }
    if (!begun) continue;
    if (open) {
      const out = stdout.slice(open.from, m.index);
      if (code !== "-" && name === open.name) {
        sections.set(name, { out, code: Number(code) });
        open = null;
        continue;
      }
      sections.set(open.name, { out, code: null }); // the next marker came first: this one was cut
      open = null;
    }
    if (code === "-") open = { name, from: m.index + whole.length };
    else sections.set(name, { out: "", code: Number(code) }); // a bare verdict: nogit, end
  }
  if (open) sections.set(open.name, { out: stdout.slice(open.from), code: null }); // the run itself was cut
  return { begun, sections };
}

/** NUL-separated records; for a cut section the last one may be half a record, so it goes. */
function records(out: string, whole: boolean): string[] {
  const parts = out.split("\0");
  if (whole) {
    if (parts.at(-1) === "") parts.pop();
  } else parts.pop();
  return parts;
}

const XY: Record<string, GitChange | undefined> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type-changed" };

export interface StatusRead {
  oid: string | null; // null: "(initial)" — no commit yet
  branch: string | null; // null: detached
  upstream: string | null;
  ab: { ahead: number; behind: number } | null;
  entries: Omit<GitFileChange, "lines">[];
}

/** `git status --porcelain=v2 --branch -z`. Paths may hold spaces, tabs, newlines: only the fixed
    leading fields are split off, the rest of the record is the path. */
export function parseStatusV2(out: string, whole: boolean): StatusRead {
  const r: StatusRead = { oid: null, branch: null, upstream: null, ab: null, entries: [] };
  const recs = records(out, whole);
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]!;
    if (rec.startsWith("# ")) {
      const [key, ...rest] = rec.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") r.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") r.branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") r.upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) r.ab = { ahead: Number(m[1]), behind: Number(m[2]) };
      }
      continue;
    }
    const type = rec[0];
    if (type === "?") {
      r.entries.push({ path: rec.slice(2), kind: "untracked" });
      continue;
    }
    if (type === "1" || type === "2" || type === "u") {
      const fixed = type === "1" ? 8 : type === "2" ? 9 : 10;
      const fields = splitFixed(rec, fixed);
      if (!fields) continue;
      const [, xy, sub] = fields.head as [string, string, string];
      const entry: Omit<GitFileChange, "lines"> = { path: fields.rest, kind: type === "u" ? "conflicted" : "tracked" };
      if (type === "2") {
        const from = recs[i + 1];
        if (from === undefined) break; // the pair was cut in two: the record is incomplete
        entry.from = from;
        i++;
      }
      if (type !== "u") {
        const staged = XY[xy[0] ?? "."];
        const unstaged = XY[xy[1] ?? "."];
        if (staged) entry.staged = staged;
        if (unstaged) entry.unstaged = unstaged;
      }
      if (sub?.startsWith("S")) entry.submodule = true;
      r.entries.push(entry);
    }
    // "!" (ignored) is never asked for; anything else is a format we don't know, skipped.
  }
  return r;
}

/** The first `n` space-separated fields, and everything after them as one string. */
function splitFixed(rec: string, n: number): { head: string[]; rest: string } | null {
  const head: string[] = [];
  let at = 0;
  for (let k = 0; k < n; k++) {
    const sp = rec.indexOf(" ", at);
    if (sp < 0) return null;
    head.push(rec.slice(at, sp));
    at = sp + 1;
  }
  return { head, rest: rec.slice(at) };
}

export type LineCount = { added: number; removed: number } | "binary";

/** `git diff-index --numstat -z -M`: `a\tr\tpath\0`, or for a rename `a\tr\t\0from\0to\0`. Keyed by the
    path the file has now. */
export function parseNumstat(out: string, whole: boolean): Map<string, LineCount> {
  const counts = new Map<string, LineCount>();
  const recs = records(out, whole);
  for (let i = 0; i < recs.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([^]*)$/.exec(recs[i]!);
    if (!m) continue;
    let path = m[3]!;
    if (path === "") {
      const to = recs[i + 2];
      if (to === undefined) break; // the pair was cut
      path = to;
      i += 2;
    }
    counts.set(path, m[1] === "-" || m[2] === "-" ? "binary" : { added: Number(m[1]), removed: Number(m[2]) });
  }
  return counts;
}

/** A path's count. A rename status paired but the diff did not (the content moved too far from
    the source for -M) comes back as the source deleted plus the path added: both halves are this
    row's, or the source's removed lines would belong to nobody. */
function lineCount(e: Omit<GitFileChange, "lines">, counts: Map<string, LineCount>): LineCount | null {
  const c = counts.get(e.path);
  const src = e.from !== undefined && e.from !== e.path ? counts.get(e.from) : undefined;
  if (!c || !src) return c ?? null;
  if (c === "binary" || src === "binary") return "binary";
  return { added: c.added + src.added, removed: c.removed + src.removed };
}

const TIMED_OUT = new Set([124, 137]); // timeout's own code, and SIGKILL's

/** git's own words for a refusal: the last line, without "fatal: ". */
function gitMessage(out: string): string {
  const line = out.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return line.replace(/^(fatal|error): /, "");
}

type Place = { where: GitWhere; cwd: string; moved?: true };

/** A finished run's sections as a GitSummary. Pure: the transports and the clock are the caller's. */
export function summarize(sections: Map<string, Section>, place: Place, checkedAt: number): GitSummary {
  const base = { where: place.where, cwd: place.cwd, ...(place.moved ? { moved: true as const } : {}), checkedAt };
  const unavailable = (reason: string): GitSummary => ({ state: "unavailable", where: place.where, cwd: place.cwd, reason, checkedAt });
  const on = place.where.kind === "remote" ? ` on ${place.where.target}` : "";
  if (sections.has("nogit")) return unavailable(`Git isn't installed${on || " on this machine"}.`);
  const refused = sections.get("toperr");
  if (refused) {
    if (refused.code !== null && TIMED_OUT.has(refused.code)) return unavailable(`Git took too long to find this folder's repository${on}.`);
    if (/not a git repository/i.test(refused.out)) return { state: "none", ...base };
    const said = gitMessage(refused.out);
    return unavailable(said ? `Git couldn't read this folder${on}: ${said}.` : `Git couldn't read this folder${on}.`);
  }
  const top = sections.get("top");
  if (!top) return unavailable(`Git stopped before it said which repository this is${on}.`);
  if (top.code === null) return unavailable(`Git's answer about this folder was cut short${on}.`);
  if (TIMED_OUT.has(top.code)) return unavailable(`Git took too long to find this folder's repository${on}.`);
  if (top.code !== 0) return unavailable(`Git couldn't read this folder${on}.`);
  // git prints the root raw and adds exactly one newline. Only that one goes: a root that itself
  // ends in (or contains) a newline stays whole.
  const root = top.out.endsWith("\n") ? top.out.slice(0, -1) : top.out;
  if (root === "") return unavailable(`Git didn't say where this folder's repository is${on}.`);

  const st = sections.get("status");
  if (!st) return unavailable(`git status didn't finish${on}. Nothing was changed.`);
  if (st.code !== null && st.code !== 0) {
    const why = TIMED_OUT.has(st.code) ? "took too long in this repository" : "failed";
    return unavailable(`git status ${why}${on}. Nothing was changed.`);
  }
  const statusPartial = st.code === null;
  const status = parseStatusV2(st.out, !statusPartial);

  const ns = sections.get("numstat");
  let lines: GitRepoSummary["lines"];
  let counts = new Map<string, LineCount>();
  if (!ns || ns.code === null) {
    lines = ns && ns.out.length > 0 ? "partial" : "timeout";
    if (ns) counts = parseNumstat(ns.out, false);
  } else if (TIMED_OUT.has(ns.code)) lines = "timeout";
  else if (ns.code !== 0) lines = "failed";
  else {
    lines = "ok";
    counts = parseNumstat(ns.out, true);
  }

  let added = 0;
  let removed = 0;
  for (const c of counts.values()) {
    if (c === "binary") continue;
    added += c.added;
    removed += c.removed;
  }
  const files: GitFileChange[] = status.entries.map((e) => ({ ...e, lines: e.kind === "untracked" ? null : lineCount(e, counts) }));
  const rank = (f: GitFileChange) => (f.kind === "conflicted" ? 0 : f.kind === "tracked" ? 1 : 2);
  files.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const tally = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  for (const f of files) {
    if (f.kind === "untracked") tally.untracked++;
    else if (f.kind === "conflicted") tally.conflicted++;
    if (f.staged) tally.staged++;
    if (f.unstaged) tally.unstaged++;
  }

  const lg = sections.get("log");
  let lastCommit: GitRepoSummary["lastCommit"] = null;
  if (lg?.code === 0) {
    const [oid, ct, ...subject] = lg.out.replace(/\n$/, "").split("\0");
    const at = Number(ct) * 1000;
    if (oid && Number.isFinite(at)) lastCommit = { oid, subject: subject.join(" ").slice(0, SUBJECT_MAX), at };
  }

  return {
    state: "repo",
    ...base,
    root,
    head: status.branch !== null ? { kind: "branch", name: status.branch } : { kind: "detached", oid: status.oid ?? "" },
    unborn: status.oid === null && !statusPartial,
    upstream: status.upstream === null ? null : status.ab ? { name: status.upstream, ...status.ab } : { name: status.upstream, gone: true },
    counts: tally,
    clean: files.length === 0 && !statusPartial,
    lastCommit,
    files: files.slice(0, MAX_GIT_FILES),
    filesTotal: files.length,
    statusPartial,
    lines,
    added,
    removed,
  };
}

// ---------------------------------------------------------------------------
// the read

/** The session header's cwd: the first line of the file, a `session` entry. */
async function readStoredCwd(path: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, "r");
  } catch {
    return null; // gone or unreadable between the route's check and here
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const first = buf.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
    const header = JSON.parse(first) as { type?: unknown; cwd?: unknown };
    return header?.type === "session" && typeof header.cwd === "string" && header.cwd !== "" ? header.cwd : null;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

const cache = new Map<string, GitSummary & { state: "repo" | "none" }>();
const inflight = new Map<string, Promise<GitSummary>>();

let running = 0;
const waiting: (() => void)[] = [];
/** At most MAX_CONCURRENT reads at once: a workspace of sessions on one big repo shares a cache
    entry, but one on many repos would otherwise start a git per session in the same tick. */
async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    return await run();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Where a stored cwd is read, decided lexically — no fs call before this answers. */
type Plan =
  | { kind: "local"; place: Place }
  | { kind: "remote"; target: string; place: Place }
  | { kind: "refuse"; summary: (now: number) => GitSummary };

function plan(stored: string, deps: GitDeps): Plan {
  const remote = parseTargetCwd(stored);
  if (remote) return { kind: "remote", target: remote.target, place: { where: { kind: "remote", target: remote.target }, cwd: remote.remoteCwd } };
  const legacy = parseLegacyMountCwd(stored);
  if (legacy) {
    const reason = `This folder was an sshfs mount of ${legacy.target} that Sova no longer creates. Its repository lives on ${legacy.target}.`;
    return { kind: "refuse", summary: (now) => ({ state: "unavailable", where: { kind: "local" }, cwd: stored, reason, checkedAt: now }) };
  }
  if (!isAbsolute(stored)) {
    // Never resolved against the server's own directory: that would describe Sova's repository.
    const reason = `This session's folder isn't an absolute path: ${stored}.`;
    return { kind: "refuse", summary: (now) => ({ state: "unavailable", where: { kind: "local" }, cwd: stored, reason, checkedAt: now }) };
  }
  const cwd = (deps.mapCwd ?? mappedNewCwd)(stored);
  return { kind: "local", place: { where: { kind: "local" }, cwd, ...(cwd !== stored ? { moved: true as const } : {}) } };
}

/** read(), with an ordinary failure — a seam or a spawn that threw — as an answer, not a throw. */
async function readSafely(p: Exclude<Plan, { kind: "refuse" }>, deps: GitDeps, now: () => number): Promise<GitSummary> {
  try {
    return await read(p, deps, now);
  } catch (err) {
    const on = p.place.where.kind === "remote" ? ` on ${p.place.where.target}` : "";
    return { state: "unavailable", where: p.place.where, cwd: p.place.cwd, reason: `Sova couldn't read this repository${on}: ${(err as Error)?.message || "unknown error"}.`, checkedAt: now() };
  }
}

async function read(p: Exclude<Plan, { kind: "refuse" }>, deps: GitDeps, now: () => number): Promise<GitSummary> {
  const nonce = (deps.nonce ?? (() => randomBytes(12).toString("hex")))();
  const script = gitScript(nonce);
  const { place } = p;
  const unavailable = (reason: string): GitSummary => ({ state: "unavailable", where: place.where, cwd: place.cwd, reason, checkedAt: now() });

  if (p.kind === "remote") {
    const r = await (deps.runRemote ?? runOnTarget)(p.target, script, place.cwd);
    if (!r.ok) return unavailable(r.status === 404 ? `${p.target} isn't in targets.json anymore.` : r.error);
    const { begun, sections } = parseSections(r.run.stdout, nonce);
    if (!begun) {
      const fail = classifyFailure(r.run);
      if (fail?.status === "offline") return unavailable(`${p.target} didn't answer: ${fail.error}.`);
      if (r.run.code === 1) return unavailable(`Couldn't enter ${place.cwd} on ${p.target}. It may have been moved or removed.`);
      return unavailable(`${p.target}: ${fail?.error ?? "the read stopped before it started"}.`);
    }
    // A run the timer cut still says what it finished: a cut status is a partial one, a count that
    // never started is "timeout" — summarize() reads both from the missing markers.
    return summarize(sections, place, now());
  }

  let r: ExecResult;
  try {
    r = await (deps.runLocal ?? ((s, cwd) => execGroup(localArgv(s, cwd), { timeoutMs: LOCAL_TIMEOUT_MS, byteCap: LOCAL_BYTE_CAP })))(script, place.cwd);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    return unavailable(/timed out/.test(msg) ? `Git took longer than ${LOCAL_TIMEOUT_MS / 1000}s in this folder. Nothing was changed.` : `Sova couldn't run git: ${msg}`);
  }
  const { begun, sections } = parseSections(r.stdout, nonce);
  if (!begun) {
    return (deps.exists ?? existsSync)(place.cwd)
      ? unavailable(`Sova couldn't enter ${place.cwd}.`)
      : unavailable(`This session's folder no longer exists: ${place.cwd}.`);
  }
  return summarize(sections, place, now());
}

/**
 * The repository summary for a session file (the caller has validated the path). Cached per
 * folder for GIT_TTL_MS; `fresh` skips the cache but joins a read already in flight. Never
 * throws: every failure is a `state: "unavailable"` with the reason in words.
 */
export async function getGitSummary(sessionPath: string, opts: { fresh?: boolean } = {}, deps: GitDeps = {}): Promise<GitSummary> {
  const now = deps.now ?? Date.now;
  let stored: string | null;
  try {
    stored = await (deps.storedCwd ?? readStoredCwd)(sessionPath);
  } catch {
    stored = null;
  }
  if (stored === null) {
    return { state: "unavailable", where: { kind: "local" }, cwd: "", reason: "This session file has no header to read its folder from.", checkedAt: now() };
  }
  let p: Plan;
  try {
    p = plan(stored, deps);
  } catch (err) {
    return { state: "unavailable", where: { kind: "local" }, cwd: stored, reason: `Sova couldn't place this session's folder: ${(err as Error)?.message || "unknown error"}.`, checkedAt: now() };
  }
  if (p.kind === "refuse") return p.summary(now());
  // One folder, one entry: a local key is the folder read (after the map, so a session under the
  // old name and one under the new share it), a remote key is target + remote cwd. `moved` is part
  // of the answer, so it is part of the key too.
  const key = JSON.stringify([p.place.where, p.place.cwd, p.place.moved ?? false]);
  const hit = cache.get(key);
  if (!opts.fresh && hit && now() - hit.checkedAt < GIT_TTL_MS) return hit;
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = slot(() => readSafely(p, deps, now))
    .then((summary) => {
      if (summary.state !== "unavailable") cache.set(key, summary);
      else cache.delete(key); // a failure is never served from the cache, and neither is the answer before it
      return summary;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

/** Test seam: forget every cached read. */
export function clearGitCache(): void {
  cache.clear();
}
