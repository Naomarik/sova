// Remote targets (~/.pi/agent/targets.json): the registry, the local placeholder layout that gives a
// remote session its identity, a bounded reachability probe and the remote folder browser.
// Schema, validation and every command line come from pi-config's remote argv builder, imported like
// server/mode-state.ts imports the mode extension's pure modules (node builtins only; nothing else
// from pi-config). See CLAUDE.md.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, sep } from "node:path";
import type { Readable } from "node:stream";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  buildListDirsArgv,
  buildTargetArgv,
  parseListDirsOutput,
  parseTargetsFile,
  placeholderDir,
  placeholderRoot,
  targetsFilePath,
  type Target,
} from "../pi-config/extensions/remote/argv.ts";
import type { FolderListing, TargetInfo } from "../shared/protocol";
import { MAX_FOLDER_ENTRIES } from "./folders";

export type { Target };

export const targetsFile = () => targetsFilePath(getAgentDir());

/** Shared local-create rule for New Session and fresh fanout: trimmed, absolute, an
 *  existing directory. Local statSync has no deadline. The caller creates with the trimmed cwd. */
export async function validateNewSessionCwd(raw: string): Promise<string | null> {
  const cwd = raw.trim();
  if (!cwd || !isAbsolute(cwd)) return "cwd must be an absolute path";
  try {
    if (!statSync(cwd).isDirectory()) return "cwd is not a directory";
  } catch {
    return "cwd does not exist";
  }
  return null;
}
/** Local placeholder root: a remote session's cwd is <root>/<target>/<remote/abs/path>. */
export const targetsRoot = () => dirname(placeholderRoot(getAgentDir(), "x"));

/** A target name is one path segment: the builder's charset, and never "." or "..". */
export const isTargetName = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..";

export interface LoadedTargets {
  targets: Target[];
  /** Entries left out, with the builder's reasons (the file stays usable around a bad entry). */
  invalid: { name: string; errors: string[] }[];
  /** The file as a whole is unreadable or malformed (then `targets` is empty). */
  error?: string;
}

/** Validate targets.json text with the builder's own rules (no second schema here). Never throws. */
export function parseTargets(text: string): LoadedTargets {
  let r: ReturnType<typeof parseTargetsFile>;
  try {
    r = parseTargetsFile(text);
  } catch (err) {
    return { targets: [], invalid: [], error: (err as Error).message };
  }
  const invalid = [...r.invalid];
  const targets = r.targets.filter((t) => {
    if (isTargetName(t.name)) return true;
    invalid.push({ name: t.name, errors: ['name cannot be "." or ".."'] });
    return false;
  });
  return { targets, invalid };
}

/** Read ~/.pi/agent/targets.json fresh (it is tiny). Missing file → no targets, no error. */
export function loadTargets(): LoadedTargets {
  let text: string;
  try {
    text = readFileSync(targetsFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { targets: [], invalid: [] };
    return { targets: [], invalid: [], error: `Cannot read ${targetsFile()}: ${(err as Error).message}` };
  }
  const r = parseTargets(text);
  return r.error ? { ...r, error: `${targetsFile()}: ${r.error}` } : r;
}

export function findTarget(name: string): Target | undefined {
  return isTargetName(name) ? loadTargets().targets.find((t) => t.name === name) : undefined;
}

/** Write targets.json atomically (tmp + rename, like server/web-sessions.ts). Refuses invalid entries. */
export function writeTargets(targets: Target[]): void {
  const text = `${JSON.stringify({ version: 1, targets }, null, 2)}\n`;
  const r = parseTargets(text);
  const bad = r.error ?? (r.invalid[0] && `target ${r.invalid[0].name}: ${r.invalid[0].errors.join("; ")}`);
  if (bad) throw new Error(`Refusing to write targets.json: ${bad}`);
  const file = targetsFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Placeholder layout: ~/.pi/agent/sova/targets/<target>/<remote/abs/path>

/** A remote absolute path, normalized (".." clamps at "/", no trailing slash but "/"), or null. */
export function normalizeRemotePath(p: unknown): string | null {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) return null;
  const n = posix.normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/** The local placeholder directory of one remote folder (not created here). Throws on a bad name/path. */
export function targetDir(name: string, remoteCwd = "/"): string {
  if (!isTargetName(name)) throw new Error(`Invalid target name: ${name}`);
  const remote = normalizeRemotePath(remoteCwd);
  if (!remote) throw new Error(`Remote cwd must be an absolute path: ${remoteCwd}`);
  return remote === "/" ? placeholderRoot(getAgentDir(), name) : placeholderDir(getAgentDir(), name, remote);
}

/** Split a local cwd under the placeholder root into its target and remote cwd, else null. */
export function parseTargetCwd(cwd: string): { target: string; remoteCwd: string } | null {
  const root = targetsRoot() + sep;
  if (typeof cwd !== "string" || !cwd.startsWith(root)) return null;
  const [target, ...parts] = cwd.slice(root.length).split(sep).filter(Boolean);
  if (!isTargetName(target)) return null;
  return { target, remoteCwd: `/${parts.join("/")}` };
}

/** The remote target a cwd belongs to (chat-manager passes it as the `target` flag, which switches
 *  pi-config's remote extension on). */
export const targetOfCwd = (cwd: string): string | null => parseTargetCwd(cwd)?.target ?? null;
export const remoteCwdOfCwd = (cwd: string): string | null => parseTargetCwd(cwd)?.remoteCwd ?? null;

// ---------------------------------------------------------------------------
// Running commands on a target: bounded, never throws.

/** Hard cap on one remote command, over and above ssh's own ConnectTimeout. */
export const REMOTE_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 1024 * 1024;

export interface RunResult {
  code: number | null; // null: killed (timeout) or failed to start
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
  /** stdout reached MAX_OUTPUT bytes and the rest was dropped. */
  stdoutTruncated?: true;
}

/**
 * Run a spawn spec (argv[0] is the program, no local shell), SIGKILLed after `timeoutMs`. Resolves,
 * never rejects. Resolves at exit even if a grandchild (an ssh ControlPersist master) keeps a pipe open.
 */
export function runArgv(argv: readonly string[], timeoutMs = REMOTE_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    // Bytes, capped before storing and decoded once at the end: a character split across two
    // chunks survives (per-chunk decoding turned it into U+FFFD), and the cap is a real byte bound.
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let stdoutTruncated = false;
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (r: { code: number | null; spawnError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      resolve({ ...r, stdout, stderr, timedOut, ...(stdoutTruncated ? { stdoutTruncated: true as const } : {}) });
    };
    const [cmd, ...args] = argv;
    if (!cmd) return done({ code: null, spawnError: "empty command" });
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return done({ code: null, spawnError: (err as Error).message });
    }
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      setTimeout(() => done({ code: null }), 500);
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => {
      const room = MAX_OUTPUT - outBytes;
      if (b.length > room) stdoutTruncated = true;
      if (room <= 0) return;
      const kept = b.length > room ? b.subarray(0, room) : b;
      out.push(kept);
      outBytes += kept.length;
    });
    child.stderr.on("data", (b: Buffer) => {
      const room = MAX_OUTPUT - errBytes;
      if (room <= 0) return;
      const kept = b.length > room ? b.subarray(0, room) : b;
      err.push(kept);
      errBytes += kept.length;
    });
    child.on("error", (err) => done({ code: null, spawnError: err.message }));
    child.on("exit", (code) => setTimeout(() => done({ code: timedOut ? null : code }), 1000));
    child.on("close", (code) => done({ code: timedOut ? null : code }));
  });
}

/** A failed run as { status, error }, or null on success. ssh exits 255 when it cannot connect. */
export function classifyFailure(r: RunResult): { status: "offline" | "error"; error: string } | null {
  if (r.timedOut) return { status: "offline", error: `No answer within ${Math.round(REMOTE_TIMEOUT_MS / 1000)}s` };
  if (r.spawnError) return { status: "error", error: r.spawnError };
  if (r.code === 0) return null;
  const last =
    r.stderr
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "";
  return { status: r.code === 255 ? "offline" : "error", error: last || `exited with code ${r.code}` };
}

export type TargetRunResult = { ok: true; run: RunResult } | { ok: false; status: 404 | 502; error: string };

/**
 * Run far shell code on a named target, in `remoteCwd` (a REMOTE absolute path): the builder
 * composes the argv and quotes the cwd (`cd -- '<cwd>' || exit 1` ahead of `command`), runArgv
 * bounds the run. The caller reads the RunResult (classifyFailure turns a failed one into words).
 * A run the target didn't answer updates the probe cache, as the folder browser does. Never throws.
 */
export async function runOnTarget(name: string, command: string, remoteCwd: string, timeoutMs = REMOTE_TIMEOUT_MS): Promise<TargetRunResult> {
  const { targets } = loadTargets();
  const target = isTargetName(name) ? targets.find((t) => t.name === name) : undefined;
  if (!target) return { ok: false, status: 404, error: `Unknown target: ${name}` };
  const cwd = normalizeRemotePath(remoteCwd);
  if (!cwd) return { ok: false, status: 502, error: `${name}: remote cwd must be an absolute path` };
  let argv: string[];
  try {
    argv = buildTargetArgv(target, { command, cwd, registry: targets });
  } catch (err) {
    return { ok: false, status: 502, error: `${target.name}: ${(err as Error).message}` };
  }
  const run = await runArgv(argv, timeoutMs);
  const fail = classifyFailure(run);
  if (fail?.status === "offline") probes.set(probeKey(target, targets), { ...fail, at: Date.now() });
  return { ok: true, run };
}

// ---------------------------------------------------------------------------
// Probe + listing

/** How long a probe result stands; failures are retried sooner. */
export const PROBE_TTL_MS = 60_000;
const PROBE_FAIL_TTL_MS = 15_000;

export type Probe = { status: "ok" | "offline" | "error"; error?: string; at: number };
const probes = new Map<string, Probe>();
const inflight = new Map<string, Promise<Probe>>();
/** Cache key: the entry itself (an edited entry is a different target) plus its via chain's. */
const probeKey = (t: Target, registry: readonly Target[]) => JSON.stringify([t, registry.find((o) => o.name === t.via) ?? null]);

/** Run `uname -n` on the target (`hostname` is absent from minimal images): cached for a TTL, concurrent callers share one run. Never throws. */
export function probeTarget(target: Target, registry: readonly Target[], opts: { fresh?: boolean } = {}): Promise<Probe> {
  const key = probeKey(target, registry);
  const hit = probes.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < (hit.status === "ok" ? PROBE_TTL_MS : PROBE_FAIL_TTL_MS)) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  const p = (async (): Promise<Probe> => {
    let argv: string[];
    try {
      argv = buildTargetArgv(target, { command: "uname -n", cwd: "", registry });
    } catch (err) {
      return { status: "error", error: (err as Error).message, at: Date.now() };
    }
    const fail = classifyFailure(await runArgv(argv));
    return fail ? { ...fail, at: Date.now() } : { status: "ok", at: Date.now() };
  })().then((probe) => {
    probes.set(key, probe);
    inflight.delete(key);
    return probe;
  });
  inflight.set(key, p);
  return p;
}

function hostOf(t: Target): string | undefined {
  const inner = t.kind === "incus-cell" ? t.incus?.cell : t.kind === "docker" ? t.docker?.container : undefined;
  if (t.via) return inner ? `${inner} via ${t.via}` : `via ${t.via}`;
  const s = t.ssh;
  const ssh = s ? `${s.user ? `${s.user}@` : ""}${s.host}${s.port && s.port !== 22 ? `:${s.port}` : ""}` : undefined;
  return inner && ssh ? `${inner} on ${ssh}` : (inner ?? ssh);
}

export function targetInfo(t: Target, probe?: Probe): TargetInfo {
  const host = hostOf(t);
  return {
    name: t.name,
    label: t.label?.trim() || t.name,
    kind: t.kind,
    status: probe?.status ?? "unknown",
    ...(probe?.error ? { error: probe.error } : {}),
    ...(t.cwd ? { cwd: t.cwd } : {}),
    ...(host ? { host } : {}),
  };
}

/** Longest GET /api/targets waits on a probe. A slower one reports "unknown" and lands in the cache. */
export const LIST_WAIT_MS = 4_000;

/** GET /api/targets: every valid target with its probe status (probes in parallel, each bounded). */
export async function listTargets(waitMs = LIST_WAIT_MS): Promise<TargetInfo[]> {
  const { targets } = loadTargets();
  return Promise.all(
    targets.map(async (t) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), waitMs)));
      const probe = await Promise.race([probeTarget(t, targets), pending]);
      clearTimeout(timer);
      return targetInfo(t, probe);
    }),
  );
}

export type RemoteFoldersResult = { ok: true; listing: FolderListing } | { ok: false; status: 400 | 404 | 502; error: string };

/** buildListDirsArgv's `{path, dirs}` as a FolderListing (the local picker's shape; paths are remote). */
export function toFolderListing(parsed: { path: string; dirs: string[] }, opts: { hidden?: boolean; cap?: number } = {}): FolderListing {
  const path = normalizeRemotePath(parsed.path) ?? "/";
  const names = [...new Set(parsed.dirs.map((l) => l.replace(/\r$/, "")))].filter(
    (n) => n && n !== "." && n !== ".." && !n.includes("/") && (opts.hidden || !n.startsWith(".")),
  );
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : 1));
  const cap = opts.cap ?? MAX_FOLDER_ENTRIES;
  const parent = posix.dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    entries: names.slice(0, cap).map((name) => ({ name, path: posix.join(path, name) })),
    truncated: names.length > cap,
  };
}

/** GET /api/targets/:name/folders: subfolders of a REMOTE folder. No path → the target's cwd, else its $HOME. */
export async function listRemoteFolders(name: string, raw: string | undefined, opts: { hidden?: boolean } = {}): Promise<RemoteFoldersResult> {
  const { targets } = loadTargets();
  const target = isTargetName(name) ? targets.find((t) => t.name === name) : undefined;
  if (!target) return { ok: false, status: 404, error: `Unknown target: ${name}` };
  let path: string;
  if (raw) {
    const n = normalizeRemotePath(raw);
    if (!n) return { ok: false, status: 400, error: "path must be an absolute path" };
    path = n;
  } else path = target.cwd ?? "~"; // the builder expands ~ on the far side
  let argv: string[];
  try {
    argv = buildListDirsArgv(target, path, targets);
  } catch (err) {
    return { ok: false, status: 502, error: `${target.name}: ${(err as Error).message}` };
  }
  const r = await runArgv(argv);
  if (r.code === 3 && !r.timedOut) return { ok: false, status: 502, error: `${target.name}: no such folder: ${path}` };
  const fail = classifyFailure(r);
  if (fail) {
    probes.set(probeKey(target, targets), { ...fail, at: Date.now() }); // the picker's status dot catches up
    return { ok: false, status: 502, error: `${target.name}: ${fail.error}` };
  }
  const parsed = parseListDirsOutput(r.stdout);
  if (!parsed) return { ok: false, status: 502, error: `${target.name}: unexpected listing output` };
  return { ok: true, listing: toFolderListing(parsed, opts) };
}
