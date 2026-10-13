import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, existsSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildCommit, realMachine } from "../mesh/details-collect";
import { agentRoot, stateRoot } from "../state-root";
import { chatsRoot } from "./supervisor";

/**
 * Per-chat fixed code (§app.chat-processes/code-generations, al_3 stage 5): a server start copies its
 * checkout's code (tracked files, and untracked ones Git does not ignore) to `<code root>/<id>`,
 * read-only, with `node_modules` a link to one hardlinked copy per lockfile; every chat process it
 * starts runs that copy, so nothing later written to the checkout reaches a running chat. A deployed
 * tree with no Git (stamped with BUILD_COMMIT) is copied whole, but for its deploy's own artifacts and
 * state. Copies no chat uses are collected. When no copy can be made, chats run from the checkout as before.
 */

const REPO = resolve(import.meta.dirname, "..", "..");
const DEPS = "deps";
const COMPLETE = ".complete";
const GOOD = "good";
/** A copy younger than this is never collected: a server may be about to start a chat on it. */
export const GC_GRACE_MS = 10 * 60_000;

export interface Generation {
  /** The build every chat on this copy reports (SOVA_CHAT_BUILD). */
  id: string;
  /** Where its chat processes run from. */
  dir: string;
  /** True: the checkout itself (no copy was made; `why` says why). */
  live: boolean;
  why?: string;
  /** Its node_modules is a full copy, not hardlinks: the copies root is on another filesystem. */
  depsCopied?: boolean;
}

/** Where this server puts the copies: `SOVA_CHAT_CODE_ROOT` (trials only; never a chat process's own
    variable, which is SOVA_CHAT_COPIES_ROOT), else `<state root>/chats/code`. */
export const codeRoot = (env: NodeJS.ProcessEnv = process.env): string => env.SOVA_CHAT_CODE_ROOT?.trim() || join(chatsRoot(), "code");

/** A build id as a directory name: kept when it is one already (a commit, `commit+digest`), else hashed. */
export function generationDir(id: string, root = codeRoot()): string {
  const name = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(id) && id !== DEPS && id !== GOOD ? id : `h-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
  return join(root, name);
}

const git = (repo: string, args: string[], maxBuffer = 256 * 1024 * 1024): Promise<Buffer> =>
  new Promise((done, fail) =>
    execFile("git", args, { cwd: repo, encoding: "buffer", maxBuffer, timeout: 30_000 }, (err, out) => (err ? fail(err) : done(out))),
  );
const nulList = (b: Buffer): string[] => b.toString("utf8").split("\0").filter(Boolean);

/**
 * The build of `repo`'s code (moved from chat-host's serverBuild): `SOVA_BUILD` when set (tests); else
 * the commit (a deploy's BUILD_COMMIT, or HEAD) when `git status` shows nothing, untracked files
 * included; else `commit+<sha8 of the diff against HEAD and each untracked, not-ignored file's path and
 * bytes>`; "unknown" when nothing says.
 */
export async function buildId(repo = REPO, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.SOVA_BUILD) return env.SOVA_BUILD;
  const commit = buildCommit(realMachine, repo);
  if (!commit) return "unknown";
  let status: Buffer;
  try {
    status = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  } catch {
    return commit; // no Git here (a deploy's copy): the stamp is all there is
  }
  if (!status.length) return commit;
  try {
    const h = createHash("sha256");
    h.update(await git(repo, ["diff", "HEAD", "--no-ext-diff", "--binary"]));
    for (const path of nulList(await git(repo, ["ls-files", "-z", "--others", "--exclude-standard"])).sort()) {
      h.update(`\0${path}\0`);
      h.update(await readFile(join(repo, path)).catch(() => Buffer.alloc(0)));
    }
    return `${commit}+${h.digest("hex").slice(0, 8)}`;
  } catch {
    return "unknown";
  }
}

let current: Generation | null = null;

/** The checkout itself as the generation (no copy), with the reason. */
export async function liveGeneration(why: string, o: { repo?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Generation> {
  const repo = o.repo ?? REPO;
  return { id: await buildId(repo, o.env), dir: repo, live: true, why };
}

/** For `GET /api/health`'s chatHost (§app.server-runtime/health): fixed short words only. */
export function generationHealth(): { code: "copy" | "live"; codeWhy?: string } | null {
  if (!current) return null;
  if (!current.live) return current.depsCopied ? { code: "copy", codeWhy: "full node_modules copy (another filesystem)" } : { code: "copy" };
  return { code: "live", codeWhy: current.why === "test switch" ? "test switch" : "copy failed" };
}

/**
 * Make, or reuse, the generation of `repo`'s current code under `root`. Never throws: on any failure
 * the checkout itself, with the reason logged once. `SOVA_CHAT_CODE=live` (tests) skips the copy.
 */
export async function currentGeneration(o: { repo?: string; root?: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void; link?: LinkFile } = {}): Promise<Generation> {
  const repo = o.repo ?? REPO;
  const env = o.env ?? process.env;
  const log = o.log ?? ((l: string) => console.log(`[chat-code] ${l}`));
  if (env.SOVA_CHAT_CODE?.trim() === "live") {
    current = await liveGeneration("test switch", { repo, env });
    return current;
  }
  const root = o.root ?? codeRoot(env);
  const t0 = Date.now();
  try {
    for (let attempt = 0; ; attempt++) {
      const id = await buildId(repo, env);
      if (id === "unknown") throw new Error("this checkout's build is unknown");
      const dir = generationDir(id, root);
      const mk = { link: o.link ?? link, log };
      let deps: Deps | null;
      if (isComplete(dir)) {
        deps = await ensureDeps(repo, root, dir, mk);
        log(`chats run code ${id} (reused ${dir}, ${Date.now() - t0} ms)`);
      } else {
        deps = await makeGeneration(repo, root, id, dir, mk);
        // Written to while copied: the copy may hold another tree than its id says. Once more, else no copy.
        if ((await buildId(repo, env)) !== id) {
          await rm(dir, { recursive: true, force: true });
          if (attempt >= 1) throw new Error("the checkout kept changing while its code was copied");
          continue;
        }
        log(`chats run code ${id} (copied to ${dir} in ${Date.now() - t0} ms)`);
      }
      current = { id, dir, live: false, ...(deps?.how === "copied" ? { depsCopied: true } : {}) };
      break;
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log(`chats run from the checkout itself: no copy of its code could be made (${why})`);
    current = await liveGeneration(why, { repo, env }).catch(() => ({ id: "unknown", dir: repo, live: true, why }));
  }
  return current;
}

const isComplete = (dir: string) => existsSync(join(dir, COMPLETE));
const tmpIn = (root: string) => join(root, `.tmp-${randomBytes(6).toString("hex")}`);

/** Move a finished copy into place; another server that made the same copy first wins, and ours goes. */
async function publish(tmp: string, dir: string): Promise<void> {
  try {
    renameSync(tmp, dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if ((code === "ENOTEMPTY" || code === "EEXIST") && isComplete(dir)) {
      await rm(tmp, { recursive: true, force: true });
      return;
    }
    if ((code === "ENOTEMPTY" || code === "EEXIST") && !isComplete(dir)) {
      // A half-made copy (a server died writing it): replaced.
      await rm(dir, { recursive: true, force: true });
      renameSync(tmp, dir);
      return;
    }
    throw err;
  }
}

/** How a copy's shared node_modules was made: hardlinked, or copied in full (another filesystem); its bytes copied. */
interface Deps {
  how: "linked" | "copied";
  bytes: number;
}
/** Hardlink one file (fs.link; a test injects EXDEV). */
type LinkFile = (src: string, dst: string) => Promise<void>;
interface Making {
  link: LinkFile;
  log: (line: string) => void;
}

async function makeGeneration(repo: string, root: string, id: string, dir: string, mk: Making): Promise<Deps | null> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true }); // half-made: rebuilt
  const tmp = tmpIn(root);
  try {
    const files = existsSync(join(repo, ".git"))
      ? nulList(await git(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
      : await deployedFiles(repo, [root, stateRoot(), agentRoot()]);
    await copyFiles(repo, tmp, files);
    const lock = await lockHash(join(tmp, "pnpm-lock.yaml"));
    if (lock) await symlink(join("..", DEPS, lock, "node_modules"), join(tmp, "node_modules"));
    writeFileSync(join(tmp, COMPLETE), `${JSON.stringify({ id, lock, at: new Date().toISOString() })}\n`, { mode: 0o444 });
    const deps = lock ? await depsSnapshot(repo, root, lock, mk) : null;
    await publish(tmp, dir);
    return deps;
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/** Top-level entries of a deployed tree that are its deploy's own, never its code. */
const DEPLOY_ONLY = new Set([".git", ".bun", ".accept", "dist", "dist-share"]);

/**
 * The files of a deployed tree with no Git of its own (a `git archive` stamped with BUILD_COMMIT), relative
 * to `repo`: everything but any `node_modules` (linked per lockfile), DEPLOY_ONLY, and the directories
 * inside `outside` (the copies root, the state root, the agent dir), so no session or login is copied.
 */
async function deployedFiles(repo: string, outside: string[]): Promise<string[]> {
  const out: string[] = [];
  const inside = (p: string, dir: string) => {
    const rel = relative(dir, p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const top = await realpath(repo).catch(() => resolve(repo));
  // Only those inside the tree: a tree that is itself inside the agent dir still copies.
  const reals = (await Promise.all(outside.map((p) => realpath(p).catch(() => resolve(p))))).filter((r) => r !== top && inside(r, top));
  const within = (p: string) => reals.some((r) => inside(p, r));
  const walk = async (rel: string): Promise<void> => {
    const dir = join(repo, rel);
    if (rel && within(await realpath(dir).catch(() => dir))) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || (!rel && DEPLOY_ONLY.has(e.name))) continue;
      const p = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() || e.isSymbolicLink()) out.push(p);
    }
  };
  await walk("");
  return out;
}

/** Copy `files` (paths relative to `from`) to `to`, cloned where the filesystem can, then read-only. */
async function copyFiles(from: string, to: string, files: string[]): Promise<void> {
  const made = new Set<string>();
  const dirOf = async (p: string) => {
    const d = dirname(p);
    if (made.has(d)) return;
    await mkdir(d, { recursive: true });
    made.add(d);
  };
  let next = 0;
  const one = async (rel: string) => {
    const src = join(from, rel);
    const st = await lstat(src).catch(() => null);
    if (!st) return; // deleted in the tree, not yet in the index: not part of this code
    const dst = join(to, rel);
    await dirOf(dst);
    if (st.isSymbolicLink()) return void (await symlink(await readlink(src), dst));
    if (!st.isFile()) return;
    await copyFile(src, dst, constants.COPYFILE_FICLONE);
    await chmod(dst, st.mode & 0o111 ? 0o555 : 0o444);
  };
  const worker = async () => {
    while (next < files.length) await one(files[next++]!);
  };
  await Promise.all(Array.from({ length: 32 }, worker));
}

async function lockHash(file: string): Promise<string | null> {
  const b = await readFile(file).catch(() => null);
  return b ? createHash("sha256").update(b).digest("hex").slice(0, 16) : null;
}

/**
 * Copy the tree `from` to `to`: each file hardlinked (cloned, else copied, across filesystems), each link as
 * it is. A directory that is `skip` (the copies root, should it lie inside the tree) is left out: never a
 * copy of itself.
 */
async function linkTree(from: string, to: string, linkFile: LinkFile, skip: string): Promise<Deps> {
  let crossDevice = false;
  let bytes = 0;
  const skipReal = await realpath(skip).catch(() => resolve(skip));
  const walk = async (src: string, dst: string): Promise<void> => {
    if ((await realpath(src).catch(() => src)) === skipReal) return;
    await mkdir(dst);
    const entries = await readdir(src, { withFileTypes: true });
    let next = 0;
    const one = async () => {
      while (next < entries.length) {
        const e = entries[next++]!;
        const s = join(src, e.name);
        const d = join(dst, e.name);
        if (e.isDirectory()) await walk(s, d);
        else if (e.isSymbolicLink()) await symlink(await readlink(s), d);
        else if (e.isFile()) {
          if (!crossDevice)
            try {
              await linkFile(s, d);
              continue;
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
              crossDevice = true;
            }
          await copyFile(s, d, constants.COPYFILE_FICLONE);
          bytes += (await stat(d)).size;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, entries.length) }, one));
  };
  await walk(from, to);
  return { how: crossDevice ? "copied" : "linked", bytes };
}

/**
 * The shared dependencies of every copy with lockfile `lock`: the checkout's `node_modules`, hardlinked
 * (pnpm replaces files rather than writing them in place, so the inodes keep what they held), else
 * copied. Guarded against a `pnpm install` running meanwhile: the checkout's lockfile must read `lock`
 * before and after the copy (one retry).
 */
async function depsSnapshot(repo: string, root: string, lock: string, mk: Making): Promise<Deps> {
  const dir = join(root, DEPS, lock);
  if (isComplete(dir)) return depsMade(dir);
  const src = join(repo, "node_modules");
  if (!existsSync(src)) throw new Error(`the checkout has no node_modules`);
  await mkdir(join(root, DEPS), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    if ((await lockHash(join(repo, "pnpm-lock.yaml"))) !== lock) throw new Error("the checkout's lockfile changed since its code was copied");
    const tmp = tmpIn(join(root, DEPS));
    await mkdir(tmp);
    try {
      const made = await linkTree(src, join(tmp, "node_modules"), mk.link, root);
      if ((await lockHash(join(repo, "pnpm-lock.yaml"))) !== lock) throw new Error("the checkout's lockfile changed during the copy of its node_modules");
      writeFileSync(join(tmp, COMPLETE), `${JSON.stringify({ lock, at: new Date().toISOString(), ...made })}\n`);
      await publish(tmp, dir);
      if (made.how === "copied") mk.log(`copies root on another filesystem: full node_modules copy, ${Math.round(made.bytes / 1048576)} MB`);
      return made;
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      if (attempt >= 1) throw err;
    }
  }
}

/** How a finished deps snapshot was made (its .complete says; an older one without it: hardlinked). */
function depsMade(dir: string): Deps {
  try {
    const c = JSON.parse(readFileSync(join(dir, COMPLETE), "utf8")) as Partial<Deps>;
    return { how: c.how === "copied" ? "copied" : "linked", bytes: c.bytes ?? 0 };
  } catch {
    return { how: "linked", bytes: 0 };
  }
}

/** A reused copy's shared dependencies, made again when they were collected (or never finished). */
async function ensureDeps(repo: string, root: string, dir: string, mk: Making): Promise<Deps | null> {
  const lock = depsOf(dir);
  return lock ? depsSnapshot(repo, root, lock, mk) : null;
}

/** The lockfile hash a copy's `node_modules` link names, or null. */
function depsOf(dir: string): string | null {
  try {
    const m = /(?:^|\/)deps\/([0-9a-f]+)\/node_modules$/.exec(readlinkSync(join(dir, "node_modules")));
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** The newest code a chat process booted and opened on (kept by every collection). */
export function noteGood(id: string, root = codeRoot()): void {
  try {
    if (lastGood(root) === id) return;
    writeFileSync(join(root, GOOD), `${id}\n`);
  } catch {
    // no copies here (the checkout runs): nothing to keep
  }
}
export function lastGood(root = codeRoot()): string | null {
  try {
    return readFileSync(join(root, GOOD), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Whether copy `id` can start a chat process: finished (its `.complete` marker), with its shared
    node_modules there too. A chat that can't start on the current copy starts on `lastGood()` only
    when this holds and it is another copy (§app.chat-processes/code-generations). */
export function isGenerationComplete(id: string, root = codeRoot()): boolean {
  const dir = generationDir(id, root);
  if (!isComplete(dir)) return false;
  const lock = depsOf(dir);
  return lock === null ? !existsSync(join(dir, "pnpm-lock.yaml")) : isComplete(join(root, DEPS, lock));
}

/**
 * Remove the copies nobody uses: not named in `keep` (the current generation, every build a chat or
 * worker process still runs), not `lastGood`, and older than `graceMs`; then the shared dependencies
 * no remaining copy links, and leftovers of copies never finished. Returns what it removed.
 */
export async function collectGenerations(
  keep: Set<string>,
  o: { root?: string; graceMs?: number; now?: () => number; kept?: (name: string, why: "in use" | "last good" | "young") => void } = {},
): Promise<string[]> {
  const root = o.root ?? codeRoot();
  const grace = o.graceMs ?? GC_GRACE_MS;
  const now = (o.now ?? Date.now)();
  const good = lastGood(root);
  const inUse = new Set([...keep].map((id) => generationDir(id, root)));
  const goodDir = good ? generationDir(good, root) : null;
  // A copy's age is its `.complete` marker's (read-only, written once), never its directory's: a chat
  // process runs with the copy as its working directory, and a file it writes there must not make the
  // copy look new. A copy never finished (`.tmp-*`, or no marker) goes by its directory.
  const young = async (p: string) => {
    const st = (await stat(join(p, COMPLETE)).catch(() => null)) ?? (await stat(p).catch(() => null));
    return !st || now - st.mtimeMs < grace;
  };
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return removed;
  }
  const remaining: string[] = [];
  for (const n of names) {
    if (n === DEPS || n === GOOD) continue;
    const p = join(root, n);
    const why = inUse.has(p) ? "in use" : p === goodDir ? "last good" : (await young(p)) ? "young" : null;
    if (why) {
      if (!n.startsWith(".tmp-")) {
        remaining.push(p);
        o.kept?.(n, why);
      }
      continue;
    }
    await rm(p, { recursive: true, force: true });
    removed.push(n);
  }
  // A copy still being made (`.tmp-*`) links no deps yet: on a root shared with another server, its deps
  // could go here before it is published. Only a shared root has that race, and none is collected
  // (startGenerationGc); here a young deps snapshot is kept anyway.
  const used = new Set(remaining.map(depsOf).filter((l): l is string => !!l));
  for (const n of await readdir(join(root, DEPS)).catch(() => [] as string[])) {
    const p = join(root, DEPS, n);
    if (used.has(n) || (await young(p))) continue;
    await rm(p, { recursive: true, force: true });
    removed.push(`${DEPS}/${n}`);
  }
  return removed;
}

/** The processes running now, as far as a copy's use goes: their command lines, and their working folders. */
export interface ProcScan {
  commands: string[];
  cwds: string[];
}

const run = (file: string, args: string[], timeoutMs = 10_000): Promise<{ code: number; stdout: string; missing: boolean; timedOut: boolean }> =>
  new Promise((done) =>
    execFile(file, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null;
      done({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: stdout ?? "", missing: e?.code === "ENOENT", timedOut: !!e?.killed });
    }),
  );

/** /proc as the Linux scan reads it (tests: a fake one). */
export interface ProcFs {
  list(): Promise<string[]>;
  cmdline(pid: string): Promise<string>;
  cwd(pid: string): Promise<string>;
}
const realProcFs: ProcFs = {
  list: () => readdir("/proc"),
  cmdline: (pid) => readFile(`/proc/${pid}/cmdline`, "utf8"),
  cwd: (pid) => readlink(`/proc/${pid}/cwd`),
};

/**
 * Every process's command line and working folder. Linux: /proc (a pid that ended or isn't readable,
 * another user's, is skipped). macOS: `ps -axww -o pid=,command=` and `lsof -a -u <uid> -d cwd -Fpn -w`
 * (whatever their exit: a pid lsof may not read makes it exit 1 with the rest printed). A listing that
 * doesn't hold this server's own pid, ps or lsof missing or past 10 s, fails the scan. Elsewhere: no scan.
 */
export async function scanProcesses(platform: NodeJS.Platform = process.platform, proc: ProcFs = realProcFs, exec: typeof run = run, own: number = process.pid): Promise<ProcScan> {
  // A listing is whole only when it holds this server's own process (always there, with a working
  // folder): one without it, whatever its exit, is no listing at all.
  const whole = (what: string, has: boolean) => {
    if (!has) throw new Error(`${what} does not list this server's own process`);
  };
  if (platform === "linux") {
    const pids = (await proc.list()).filter((n) => /^\d+$/.test(n));
    whole("/proc", pids.includes(String(own)));
    const out: ProcScan = { commands: [], cwds: [] };
    for (const pid of pids) {
      const cmd = await proc.cmdline(pid).catch(() => null);
      if (cmd) out.commands.push(cmd.split("\0").join(" "));
      const cwd = await proc.cwd(pid).catch(() => null);
      if (cwd) out.cwds.push(cwd);
    }
    return out;
  }
  if (platform === "darwin") {
    const fail = (what: string, r: { code: number; missing: boolean; timedOut: boolean }) =>
      new Error(`${what} ${r.missing ? "is missing" : r.timedOut ? "timed out" : `failed (${r.code})`}`);
    const ps = await exec("ps", ["-axww", "-o", "pid=,command="]);
    if (ps.missing || ps.timedOut) throw fail("ps", ps);
    const rows = ps.stdout.split("\n").flatMap((l) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(l);
      return m ? [{ pid: Number(m[1]), command: m[2]! }] : [];
    });
    whole("ps", rows.some((r) => r.pid === own));
    // -Fpn: a "p<pid>" line, then its "n<path>"; -w: no warnings for processes it may not read.
    const lsof = await exec("lsof", ["-a", "-u", String(process.getuid?.() ?? ""), "-d", "cwd", "-Fpn", "-w"]);
    if (lsof.missing || lsof.timedOut) throw fail("lsof", lsof);
    const lines = lsof.stdout.split("\n");
    whole("lsof", lines.includes(`p${own}`));
    return { commands: rows.map((r) => r.command), cwds: lines.flatMap((l) => (l.startsWith("n") ? [l.slice(1)] : [])) };
  }
  throw new Error(`no process scan on ${platform}`);
}

/** The copies under `root` a running process uses: its command line names a path inside one (`/<n>/`), or
    its working folder is inside one (by real path, or by the `/<n>` segment, so a linked root matches). */
export async function copiesRunning(scan: ProcScan, root: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(root)).filter((n) => n !== DEPS && n !== GOOD && !n.startsWith(".tmp-"));
  } catch {
    return [];
  }
  const realRoot = await realpath(root).catch(() => resolve(root));
  const cwds = await Promise.all(scan.cwds.map((c) => realpath(c).catch(() => c)));
  return names.filter((n) => {
    const seg = `/${n}/`;
    if (scan.commands.some((c) => c.includes(seg))) return true;
    const inCopy = join(realRoot, n);
    return cwds.some((c) => c === inCopy || c.startsWith(`${inCopy}/`) || c.includes(seg) || c.endsWith(`/${n}`));
  });
}

/** The grace before an unused copy goes: `SOVA_CHAT_CODE_GRACE_MIN` (fractional minutes; tests and trials), else 10 min. */
function graceOf(env: NodeJS.ProcessEnv): number {
  const v = env.SOVA_CHAT_CODE_GRACE_MIN?.trim();
  const n = v ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 60_000) : GC_GRACE_MS;
}

/**
 * Collect now and every hour (the server: once its chats are taken back). `inUse` names every build a
 * chat or worker process still runs; the current generation is always kept. A live fallback has no
 * copies of its own to collect, but older copies under the root still go. `collect` runs one more
 * (the rollout's, after a run of reloads); `stop` ends the hourly one.
 */
export function startGenerationGc(
  inUse: () => Iterable<string>,
  o: { root?: string; env?: NodeJS.ProcessEnv; everyMs?: number; log?: (line: string) => void; scan?: () => Promise<ProcScan> } = {},
): { collect: () => Promise<void>; stop: () => void } {
  const log = o.log ?? ((l: string) => console.log(`[chat-code] ${l}`));
  // A root set by SOVA_CHAT_CODE_ROOT may be shared by several servers (trials): what one keeps is not
  // what the others' chats run, so none of them collects there; the trial removes its scratch root.
  // SOVA_CHAT_CODE_GC=on (trials) says the root is this server's alone, and it collects there.
  const env = o.env ?? process.env;
  if (!o.root && env.SOVA_CHAT_CODE_ROOT?.trim() && env.SOVA_CHAT_CODE_GC?.trim() !== "on") {
    log(`unused code is not collected under SOVA_CHAT_CODE_ROOT (${codeRoot(o.env)}), a root other servers may share`);
    return { collect: async () => {}, stop: () => {} };
  }
  let running: Promise<void> | null = null;
  const once = async () => {
    const root = o.root ?? codeRoot(env);
    // What runs now, read right before the collection (never cached): a process the supervisor lost
    // track of (a stop that failed) still keeps the copy it runs. Unsure, nothing goes.
    let scan: ProcScan;
    try {
      scan = await (o.scan ?? scanProcesses)();
    } catch (err) {
      log(`unused code is not collected now: ownership uncertain (${(err as Error).message})`);
      return;
    }
    try {
      const keep = new Set(inUse());
      if (current) keep.add(current.id);
      for (const n of await copiesRunning(scan, root)) keep.add(n);
      const kept: string[] = [];
      const own = current ? basename(current.dir) : null;
      const gone = await collectGenerations(keep, { root, graceMs: graceOf(env), kept: (n, why) => void (n !== own && kept.push(`${n} (${why})`)) });
      if (gone.length) log(`removed unused code: ${gone.join(", ")}`);
      if (kept.length) log(`kept older code: ${kept.join(", ")}`);
    } catch (err) {
      log(`collecting unused code failed: ${(err as Error).message}`);
    }
  };
  // One at a time: a request during a collection waits for it, then runs its own.
  const run = (): Promise<void> => {
    const next = (running ?? Promise.resolve()).then(once);
    const mine = next.finally(() => {
      if (running === mine) running = null;
    });
    running = mine;
    return mine;
  };
  void run();
  const timer = setInterval(() => void run(), o.everyMs ?? 60 * 60_000);
  timer.unref?.();
  return { collect: run, stop: () => clearInterval(timer) };
}

/** Tests: forget the current generation. */
export function resetGenerations(): void {
  current = null;
}
/** The generation this server's chats start on (null before currentGeneration ran). */
export const currentGenerationOf = (): Generation | null => current;
