// Shared by scripts/chat-homes/backup.mjs and rollback.mjs: where this install's Sova state, chat homes
// and shared folders are, resolved exactly as the server resolves them (server/chat-homes/root.ts,
// pi-config/extensions/sandbox/shared-folder.ts), with Node's built-ins only, so both run on a plain
// copy with no install and before master's code is back.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const expand = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** The agent dir: $PI_CODING_AGENT_DIR, else ~/.pi/agent (pi's own rule). */
export function agentDir(env = process.env) {
  const own = env.PI_CODING_AGENT_DIR;
  return resolve(own ? expand(own) : join(homedir(), ".pi", "agent"));
}

/** A path made canonical through its nearest existing ancestor (root.ts `canonical`). */
export function canonical(p) {
  const abs = resolve(p);
  let at = abs;
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return abs;
      rest.push(at.slice(up.length + (up.endsWith("/") ? 0 : 1)));
      at = up;
    }
  }
}

export const stateRootOf = (agent) => join(agent, "sova");

/** The homes root: $SOVA_CHAT_HOMES (absolute), else the state root's marker, else ~/.local/state/sova/chats/<12 hex>. */
export function homesRoot(agent, env = process.env) {
  const own = env.SOVA_CHAT_HOMES;
  if (own && isAbsolute(own)) return resolve(own);
  const state = canonical(stateRootOf(agent));
  try {
    const m = JSON.parse(readFileSync(join(state, "chat-homes.json"), "utf8"));
    if (m && typeof m.homes === "string" && isAbsolute(m.homes)) return m.homes;
  } catch {
    // no marker: no home made yet, or an older install
  }
  const key = createHash("sha256").update(state).digest("hex").slice(0, 12);
  return join(homedir(), ".local", "state", "sova", "chats", key);
}

/** The homes folders this install's chats were in before a Chats folder move (the marker's `movedFrom`), newest first. */
export function previousHomesRoots(agent) {
  try {
    const m = JSON.parse(readFileSync(join(canonical(stateRootOf(agent)), "chat-homes.json"), "utf8"));
    return Array.isArray(m?.movedFrom) ? m.movedFrom.filter((r) => typeof r === "string" && isAbsolute(r)) : [];
  } catch {
    return [];
  }
}

/** The base of every older chat's shared folder: $SOVA_SHARED_BASE (absolute), else ~/.local/state/sova/shared. */
export function sharedBase(env = process.env) {
  const own = env.SOVA_SHARED_BASE;
  return own && isAbsolute(own) ? resolve(own) : join(homedir(), ".local", "state", "sova", "shared");
}

/** pi's folder for a cwd's sessions (session-manager.js getDefaultSessionDirPath). */
export function cwdSessionsDir(agent, cwd) {
  const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agent, "sessions", safe);
}

/** The live records naming a process still alive: a TUI, a Sova server or a chat process on this agent dir. */
export function liveProcesses(agent) {
  const dir = join(agent, "sessions", "live");
  const out = [];
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, n), "utf8"));
      const pid = Number(rec?.pid);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        process.kill(pid, 0);
        out.push({ pid, file: join(dir, n) });
      } catch (err) {
        if (err?.code === "EPERM") out.push({ pid, file: join(dir, n) });
      }
    } catch {
      // unreadable: not a record
    }
  }
  return out;
}

/**
 * What still runs on this agent dir, seen without pids (a sandbox's own pid namespace hides them): the
 * Sova server its state root names (server-running.json), when that port's /api/health answers with
 * the same start; and every chat process, by a connect to its socket under <state>/chats/s/.
 */
export async function runningSova(agent) {
  const state = join(agent, "sova");
  const out = [];
  const mark = (() => {
    try {
      return JSON.parse(readFileSync(join(state, "server-running.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  if (mark && Number.isInteger(mark.port) && mark.port > 0) {
    try {
      const res = await fetch(`http://127.0.0.1:${mark.port}/api/health`, { signal: AbortSignal.timeout(1500) });
      const h = await res.json().catch(() => null);
      if (h && h.startedAt === mark.startedAt) out.push(`the Sova server on port ${mark.port} (pid ${mark.pid})`);
    } catch {
      // nothing answers: that server is gone
    }
  }
  // Chat processes outlive their server: each is recorded in <state>/chats/registry/, naming its socket
  // wherever it is (<state>/chats/s/, or a runtime dir when that path is too long). A record that hasn't
  // ended counts as running when something positively answers: its socket, its systemd unit, or its pid.
  // A record left by a crash or reboot (no socket, no unit, no process) stops nothing.
  const { connect } = await import("node:net");
  const probe = (sock) =>
    new Promise((ok) => {
      const c = connect(sock);
      const done = (v) => {
        c.destroy();
        ok(v);
      };
      c.once("connect", () => done("open"));
      c.once("error", () => done("refused"));
      setTimeout(() => done("refused"), 1000).unref?.();
    });
  const reg = join(state, "chats", "registry");
  let recs = [];
  try {
    recs = readdirSync(reg).filter((n) => n.endsWith(".json"));
  } catch {
    // no chat was ever recorded
  }
  for (const n of recs) {
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(reg, n), "utf8"));
    } catch {
      continue;
    }
    if (!rec || rec.death || typeof rec.sock !== "string") continue;
    const what = `a chat process (${rec.unit ?? n}, ${rec.sessionPath ?? "?"})`;
    if (existsSync(rec.sock)) {
      if ((await probe(rec.sock)) === "open") out.push(what);
      continue;
    }
    if (unitActive(rec.unit)) out.push(`${what}, its unit active`);
    else if (pidAlive(rec.pid)) out.push(`${what}, pid ${rec.pid} alive`);
  }
  return out;
}

/** Whether a systemd user unit is active (false where there is no systemd, or it says anything else). */
function unitActive(unit) {
  if (process.platform !== "linux" || typeof unit !== "string" || !/^[A-Za-z0-9@._:-]+$/.test(unit)) return false;
  try {
    return execFileSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim() === "active";
  } catch {
    return false; // inactive, unknown or no systemd: it exits non-zero
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function sha256File(file) {
  return new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", fail)
      .on("end", () => ok(h.digest("hex")));
  });
}

/** The Sova checkout these scripts are in: its commit and branch, when it is a Git checkout. */
export function checkoutInfo(here) {
  try {
    const root = execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const branch = execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    return { root, commit, branch };
  } catch {
    return null;
  }
}

/** tar, the system's (GNU or BSD): every Sova host has one. */
export function tar(args, opts = {}) {
  return execFileSync("tar", args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30, ...opts });
}

export const exists = existsSync;

export function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (!(key in spec)) throw new Error(`unknown option ${a}`);
    if (spec[key] === "flag") out[key] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      out[key] = v;
    }
  }
  return out;
}
