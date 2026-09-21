// Remote targets (~/.pi/agent/targets.json): the registry, the local placeholder layout that gives a
// remote session its identity, a bounded reachability probe and the remote folder browser.
// Schema, validation and every command line come from pi-config's remote argv builder, imported like
// server/mode-state.ts imports the mode extension's pure modules (node builtins only; nothing else
// from pi-config). See CLAUDE.md.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, posix, sep } from "node:path";
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
// The mount module is pi-runtime-free like argv.ts (node builtins only): it owns the sshfs options,
// the mount/unmount operations (bounded, one-line error results) and the real mounted check
// (isMounted parses the mount table — instant, event-loop-safe; verifyMounted bounds a real
// readdir THROUGH the mount). The server imports it the same way (see CLAUDE.md).
import {
  isMounted,
  mount,
  mountPointOf,
  toMountLocal,
  toMountRemote,
  unmount,
} from "../pi-config/extensions/remote/mount.ts";
import type { FolderListing, TargetInfo } from "../shared/protocol";
import { MAX_FOLDER_ENTRIES } from "./folders";

export type { Target };

export const targetsFile = () => targetsFilePath(getAgentDir());
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
// Placeholder layout: ~/.pi/agent/pi-web/targets/<target>/<remote/abs/path>

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

/** A cwd inside a target's mount point → that target and the remote directory it stands for.
 *  Matched against the CONFIGURED mount blocks only: no fs access, no live check — a stat on a
 *  hung fuse path would block the event loop. */
export function parseMountCwd(cwd: string, registry?: readonly Target[]): { target: string; remoteCwd: string } | null {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
  for (const t of registry ?? loadTargets().targets) {
    if (!t.mount) continue;
    const remote = toMountRemote(t.mount, cwd);
    if (remote !== null) return { target: t.name, remoteCwd: remote };
  }
  return null;
}

/** A cwd that stands for a remote directory — the target's local placeholder, or a directory
 *  inside its mount point — → that target, the remote path, and whether it is the mount. */
export function remoteOfCwd(cwd: string, registry?: readonly Target[]): { target: string; remoteCwd: string; mounted: boolean } | null {
  const placeholder = parseTargetCwd(cwd);
  if (placeholder) return { ...placeholder, mounted: false };
  const inMount = parseMountCwd(cwd, registry);
  return inMount ? { ...inMount, mounted: true } : null;
}

/** The remote target a cwd belongs to (chat-manager passes it as the `target` flag, which switches
 *  pi-config's remote extension on — placeholder and mounted sessions alike). */
export const targetOfCwd = (cwd: string): string | null => remoteOfCwd(cwd)?.target ?? null;
export const remoteCwdOfCwd = (cwd: string): string | null => remoteOfCwd(cwd)?.remoteCwd ?? null;

/** The local directory standing for a remote cwd INSIDE the target's mount: <mount.local> + the
 *  remote path relative to <mount.remote> — where the target's real files are visible locally, so
 *  a session created there (and every worker it spawns) works on the real files. Throws with a
 *  clear message when the target has no mount config or the remote cwd is outside the far root. */
export function mountDir(target: Target, remoteCwd: string): string {
  if (!target.mount) throw new Error(`Target ${target.name} has no "mount" configuration in ${targetsFile()}`);
  const remote = normalizeRemotePath(remoteCwd);
  const dir = remote ? toMountLocal(target.mount, remote) : null;
  if (!dir) throw new Error(`Target ${target.name} mounts ${target.mount.remote}; remoteCwd must be inside it: ${remoteCwd}`);
  return dir;
}

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
}

/**
 * Run a spawn spec (argv[0] is the program, no local shell), SIGKILLed after `timeoutMs`. Resolves,
 * never rejects. Resolves at exit even if a grandchild (an ssh ControlPersist master) keeps a pipe open.
 */
export function runArgv(argv: readonly string[], timeoutMs = REMOTE_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (r: { code: number | null; spawnError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, stdout, stderr, timedOut });
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
      if (stdout.length < MAX_OUTPUT) stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += b.toString("utf8");
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

export function targetInfo(t: Target, probe?: Probe, mounted?: boolean): TargetInfo {
  const host = hostOf(t);
  return {
    name: t.name,
    label: t.label?.trim() || t.name,
    kind: t.kind,
    status: probe?.status ?? "unknown",
    ...(probe?.error ? { error: probe.error } : {}),
    ...(t.cwd ? { cwd: t.cwd } : {}),
    ...(host ? { host } : {}),
    // only when the target declares a mount: the real check's answer, not a guess
    ...(t.mount ? { mounted: mounted === true } : {}),
  };
}

/** Longest GET /api/targets waits on a probe. A slower one reports "unknown" and lands in the cache. */
export const LIST_WAIT_MS = 4_000;

/** GET /api/targets: every valid target with its probe status (probes in parallel, each bounded)
 *  and, for a target with a mount block, its real mounted state (a bounded local check). */
export async function listTargets(waitMs = LIST_WAIT_MS): Promise<TargetInfo[]> {
  const { targets } = loadTargets();
  return Promise.all(
    targets.map(async (t) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), waitMs)));
      const probe = await Promise.race([probeTarget(t, targets), pending]);
      clearTimeout(timer);
      // The real mounted state, no cache: isMounted parses the mount table (a procfs read,
      // microseconds, zero fuse traffic), so an external unmount shows on the very next listing.
      const point = t.mount ? mountPointOf(t) : undefined;
      return targetInfo(t, probe, point !== undefined ? isMounted(point) : undefined);
    }),
  );
}

// ---------------------------------------------------------------------------
// Mounts: a target's sshfs mount. The mount module owns the sshfs options and the operations; this
// module owns the REST state (no cache: isMounted reads the mount table, always honest) and the
// cwd↔mount-point derivations above.

/** One mount operation per target at a time: a queued toggle waits for the running one, so two
 *  sshfs never race on one mountpoint. Different targets still run in parallel. */
const mountOps = new Map<string, Promise<unknown>>();
const noop = () => {};
function serializeMountOp<T>(key: string, op: () => Promise<T>): Promise<T> {
  const prev = mountOps.get(key) ?? Promise.resolve();
  const run = prev.then(op, op); // the previous op's outcome never blocks the next
  mountOps.set(key, run);
  run.then(noop, noop).then(() => {
    if (mountOps.get(key) === run) mountOps.delete(key);
  });
  return run;
}

export type MountToggleResult = { ok: true; info: TargetInfo } | { ok: false; status: 400 | 404 | 502; error: string };

/** POST /api/targets/:name/mount {on}: mount or unmount the target's configured mount through the
 *  mount module's operations, one at a time per target. Idempotent — already in the asked state
 *  returns the current info without running anything. Errors say what failed. Never throws. */
export async function toggleTargetMount(name: string, on: boolean): Promise<MountToggleResult> {
  const { targets } = loadTargets();
  const target = isTargetName(name) ? targets.find((t) => t.name === name) : undefined;
  if (!target) return { ok: false, status: 404, error: `Unknown target: ${name}` };
  const point = mountPointOf(target);
  if (point === undefined)
    return {
      ok: false,
      status: 400,
      error: `Target ${target.name} has no "mount" configuration in ${targetsFile()}; add { "mount": { "remote": "/abs/far/path", "local": "~/remote/${target.name}" } } to mount it`,
    };
  return serializeMountOp(name, async (): Promise<MountToggleResult> => {
    try {
      if (isMounted(point) === on)
        return { ok: true, info: targetInfo(target, await probeTarget(target, targets), on) };
      if (on) {
        const rep = await mount(target);
        if (!rep.ok || !isMounted(point))
          return { ok: false, status: 502, error: `${target.name}: ${rep.error ?? "the mount is not on after mounting"}` };
        // the sshfs handshake that just succeeded is itself proof the target answered ssh auth
        return { ok: true, info: targetInfo(target, { status: "ok", at: Date.now() }, true) };
      }
      const rep = await unmount(point);
      // A report that disagrees with the mount table is a failure, never a success.
      if (!rep.ok || isMounted(point))
        return { ok: false, status: 502, error: `${target.name}: ${rep.error ?? "the mount is still on after unmounting"}` };
      if (rep.how === "lazy")
        console.log(`[mount] ${target.name}: lazy unmount — local holders keep their open files; sshfs detaches`);
      // the target may be unreachable with the mount off — probe honestly, that's worth showing
      return { ok: true, info: targetInfo(target, await probeTarget(target, targets), false) };
    } catch (err) {
      return { ok: false, status: 502, error: `${target.name}: ${(err as Error).message}` };
    }
  });
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
