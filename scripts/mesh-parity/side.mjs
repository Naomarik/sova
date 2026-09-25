// One side of a parity run: a source tree at a named commit, its own hermetic agent dir, a fake
// HOME, and a Sova server started under strace.

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";

export const NODE_BIN = "/usr/local/bin";
export const PNPM = "/usr/local/bin/pnpm";
export const NODE = join(NODE_BIN, "node");
/** A PATH with node but without the user's ~/.local/bin, mise shims or claude/tailscale CLIs. */
export const BARE_PATH = `${NODE_BIN}:/usr/bin:/bin`;

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, ...opts }).toString();

/**
 * A source tree for `sha` (optionally with a patch applied), extracted by `git archive` — never a
 * git worktree — and installed from the frozen lockfile. Cached by (sha, patch hash): the marker is
 * written last, so a half-built tree is rebuilt, never reused.
 */
export function prepareTree({ repo, sha, dest, patch }) {
  const marker = join(dest, ".parity-tree.json");
  const patchText = patch ? readFileSync(patch, "utf8") : null;
  const want = { sha, patch: patchText ? createHash("sha256").update(patchText).digest("hex") : null };
  if (existsSync(marker)) {
    const have = JSON.parse(readFileSync(marker, "utf8"));
    if (have.sha === want.sha && have.patch === want.patch) return dest;
    throw new Error(`${dest} holds ${JSON.stringify(have)}, not ${JSON.stringify(want)}; remove it or pick another --work dir`);
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  execFileSync("sh", ["-c", `git -C "$0" archive "$1" | tar -x -C "$2"`, repo, sha, dest], { stdio: "inherit" });
  if (patchText) execFileSync("patch", ["-p1", "-s", "-d", dest, "-i", resolve(patch)], { stdio: "inherit" });
  install(dest);
  writeFileSync(marker, JSON.stringify(want) + "\n");
  return dest;
}

export function install(tree) {
  execFileSync(PNPM, ["install", "--frozen-lockfile", "--prefer-offline", "--reporter=silent"], {
    cwd: tree,
    stdio: "inherit",
    env: { ...process.env, PATH: `${NODE_BIN}:${process.env.PATH}` },
  });
}

/** Run a pnpm script in a tree; returns {ok, code, output}. */
export function pnpmRun(tree, script, env, logFile) {
  try {
    // Bounded: a leaked timer or listener keeps a test process alive forever (seen with a canary).
    const out = execFileSync(PNPM, ["run", script], { cwd: tree, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, timeout: 15 * 60_000, killSignal: "SIGKILL" }).toString();
    writeFileSync(logFile, out);
    return { ok: true, code: 0, output: out };
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}${err.signal ? `\n[parity] killed by ${err.signal} after the 15 min limit\n` : ""}`;
    writeFileSync(logFile, out);
    return { ok: false, code: err.status ?? -1, output: out };
  }
}

/**
 * The side's agent dir, built by THAT tree's own scripts/hermetic-agent-dir.mjs (whatever the
 * branch changed there applies to it), pointed at a shim root holding the tree's pi-config; then the
 * API-key-only auth.json copied in at 0600.
 */
export function buildAgentDir({ tree, dir, authSource, expectAuthKeys }) {
  const root = join(dir, "root");
  mkdirSync(join(root, "scripts"), { recursive: true });
  symlinkSync(join(tree, "pi-config"), join(root, "pi-config"));
  copyFileSync(join(tree, "scripts", "hermetic-agent-dir.mjs"), join(root, "scripts", "hermetic-agent-dir.mjs"));
  sh(NODE, [join(root, "scripts", "hermetic-agent-dir.mjs")], { env: { PATH: BARE_PATH, HOME: join(dir, "home") } });
  const agent = join(root, ".agent");
  copyFileSync(authSource, join(agent, "auth.json"));
  execFileSync("chmod", ["600", join(agent, "auth.json")]);
  const keys = Object.keys(JSON.parse(readFileSync(join(agent, "auth.json"), "utf8"))).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expectAuthKeys].sort()))
    throw new Error(`auth.json keys ${keys.join(",")} are not exactly ${[...expectAuthKeys].join(",")}: refusing to run with other credentials`);
  return agent;
}

/** A free TCP port in [lo, hi] on 127.0.0.1 (bind-tested, then released). */
export async function freePort(lo, hi, taken = new Set()) {
  for (let p = lo; p <= hi; p++) {
    if (taken.has(p)) continue;
    const ok = await new Promise((res) => {
      const s = createServer();
      s.once("error", () => res(false));
      s.listen(p, "127.0.0.1", () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error(`no free port in ${lo}-${hi}`);
}

/** Environment for a server or test run: nothing inherited but what is named here. */
export function sideEnv({ home, tmp, agent, port }) {
  const env = { HOME: home, TMPDIR: tmp, PATH: BARE_PATH, LANG: "C.UTF-8", TZ: "UTC", NO_COLOR: "1" };
  if (agent) env.PI_CODING_AGENT_DIR = agent;
  if (port !== undefined) env.PORT = String(port);
  return env;
}

/**
 * Start `node --import tsx server/index.ts` under strace. Traced: every network syscall, execve,
 * file opens/stats (to see any tailscale socket or state path), and the event-loop waits (the
 * idle-wakeup count). Returns { proc, port, stop() }.
 */
export async function startServer({ tree, env, logDir, strace = true }) {
  mkdirSync(logDir, { recursive: true });
  const out = await import("node:fs").then((fs) => fs.openSync(join(logDir, "server.log"), "w"));
  const nodeArgs = ["--import", pathToFileURL(join(import.meta.dirname, "probe.mjs")).href, "--import", "tsx", "server/index.ts"];
  const cmd = strace
    ? ["strace", ["-f", "-qq", "-ttt", "-s", "256", "-e", "trace=%network,execve,openat,newfstatat,statx,access,epoll_wait,epoll_pwait,epoll_pwait2", "-e", "signal=none", "-o", join(logDir, "strace.log"), NODE, ...nodeArgs]]
    : [NODE, nodeArgs];
  const proc = spawn(cmd[0], cmd[1], { cwd: tree, env: { ...env, PARITY_PROBE_OUT: join(logDir, "probe.json") }, stdio: ["ignore", out, out], detached: true });
  const base = `http://127.0.0.1:${env.PORT}`;
  const t0 = Date.now();
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`server in ${tree} exited ${proc.exitCode}; see ${join(logDir, "server.log")}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {}
    if (Date.now() - t0 > 90_000) throw new Error(`server in ${tree} not healthy after 90s`);
    await new Promise((r) => setTimeout(r, 300));
  }
  const stop = async () => {
    if (proc.exitCode !== null) return;
    // SIGTERM the node process (the server's own graceful shutdown), not strace.
    const pids = serverPids(proc.pid);
    for (const pid of pids) try { process.kill(pid, "SIGTERM"); } catch {}
    const deadline = Date.now() + 10_000;
    while (proc.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    if (proc.exitCode === null) {
      stopped.graceful = false;
      try { process.kill(-proc.pid, "SIGKILL"); } catch {}
    }
  };
  const stopped = { graceful: true };
  return { proc, base, port: Number(env.PORT), stop, stopped, pids: () => serverPids(proc.pid) };
}

/** pid → ppid for every process, read once. /proc/<pid>/task/<tid>/children only lists the
 *  children of ONE thread, and node spawns from its libuv threads, so walk the stat files. */
function processTable() {
  const table = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      table.set(Number(name), { ppid: Number(rest[1]), comm: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")) });
    } catch {}
  }
  return table;
}

/** Every pid in the tree under rootPid, rootPid included. */
export function descendants(rootPid) {
  const table = processTable();
  const out = [rootPid];
  for (let i = 0; i < out.length; i++) for (const [pid, p] of table) if (p.ppid === out[i]) out.push(pid);
  return out;
}

/** The node server under a strace (or the pid itself when not traced): the descendant whose
 *  command line runs server/index.ts. By cmdline, not comm: node renames its main thread. */
export function serverPids(rootPid) {
  const node = descendants(rootPid).find((p) => {
    try {
      return readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").includes("server/index.ts") && readFileSync(`/proc/${p}/comm`, "utf8").trim() !== "strace";
    } catch {
      return false;
    }
  });
  return [node ?? rootPid];
}

export { cpSync };
