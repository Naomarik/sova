// Shared by the General Projects cutover scripts (backup, restore, one-shot): which live files the cutover
// touches, the "is Sova stopped" check, and a SHA-256 manifest of a set of roots. Throwaway: deleted with
// scripts/oneshot-general-projects.mjs after the live run. Node built-ins only.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const UNIT = "sova-runtime.service";
export const TAG = "pre-general-projects";
/** The live server's port (sova-runtime.service). */
export const LIVE_PORT = 4800;
/** A live record touched this recently means a Sova server is running on that agent dir (heartbeat ≤ 30 s). */
const LIVE_RECORD_FRESH_MS = 90_000;

export function parseArgs(argv, known) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (!(key in known)) throw new Error(`unknown option ${a}`);
    if (known[key] === "flag") out[key] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      out[key] = v;
    }
  }
  return out;
}

const expand = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const canonical = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The agent dir the scripts act on: --agent-dir, else PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export function agentDirOf(args) {
  return canonical(expand(args["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")));
}

export const isLiveAgentDir = (agentDir) => canonical(agentDir) === canonical(join(homedir(), ".pi", "agent"));

/** Whether something accepts a TCP connection on 127.0.0.1:`port`. */
function listening(port) {
  return new Promise((done) => {
    const sock = connect({ host: "127.0.0.1", port });
    sock.setTimeout(2_000);
    sock.on("connect", () => {
      sock.destroy();
      done(true);
    });
    sock.on("timeout", () => {
      sock.destroy();
      done(true);
    });
    sock.on("error", () => done(false));
  });
}

/**
 * Refuse while Sova may be running on `agentDir`. The live agent dir needs a definite "not active" from the
 * systemd unit and nothing listening on the live port (a terminal pi session's own live record must not
 * block the operator). Any other agent dir (a rehearsal copy) is running when a live record under it has a
 * fresh heartbeat.
 */
export async function assertStopped(agentDir, { unit = UNIT, port = LIVE_PORT } = {}) {
  if (isLiveAgentDir(agentDir)) {
    let state;
    try {
      state = execFileSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (err) {
      state = String(err.stdout ?? "").trim();
      if (!state) throw new Error(`can't tell whether ${unit} is stopped (systemctl --user is unreachable here); run this from a login shell with the unit stopped`);
    }
    if (state === "active" || state === "activating" || state === "reloading" || state === "deactivating") throw new Error(`${unit} is ${state}: stop it first (systemctl --user stop ${unit})`);
    if (await listening(port)) throw new Error(`something still listens on 127.0.0.1:${port}: a Sova server outside ${unit}? Stop it first`);
    return;
  }
  const live = join(agentDir, "sessions", "live");
  if (existsSync(live))
    for (const f of readdirSync(live)) {
      const age = Date.now() - statSync(join(live, f)).mtimeMs;
      if (f.endsWith(".json") && age < LIVE_RECORD_FRESH_MS) throw new Error(`a Sova server is running on ${agentDir} (live record ${f}, ${Math.round(age / 1000)} s old): stop it first`);
    }
}

/** The attached orgs: `[{id, dir}]` from `<stateRoot>/orgs.json`. */
export function orgsOf(stateRoot) {
  const file = join(stateRoot, "orgs.json");
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return (Array.isArray(raw.orgs) ? raw.orgs : []).filter((o) => typeof o?.id === "string" && typeof o?.dir === "string").map((o) => ({ id: o.id, dir: canonical(o.dir) }));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Session transcripts outside the workspaces that the orgs' charts name (the builds' coding sessions). */
export function referencedSessionFiles(agentDir, orgs) {
  const ids = new Set();
  const scan = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (e.name.endsWith(".edn")) for (const m of `${decodeURIComponent(e.name)}\n${readFileSync(p, "utf8")}`.matchAll(UUID)) ids.add(m[0]);
    }
  };
  for (const o of orgs) scan(join(o.dir, "statecharts"));
  const sessions = join(agentDir, "sessions");
  const out = [];
  if (existsSync(sessions))
    for (const d of readdirSync(sessions, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === "live") continue;
      for (const f of readdirSync(join(sessions, d.name))) {
        const m = /_([0-9a-f-]{36})\.jsonl$/.exec(f);
        if (m && ids.has(m[1])) out.push(join(sessions, d.name, f));
      }
    }
  return out.sort();
}

/**
 * Every root the cutover touches, with what it is now: `{path, kind: "dir" | "file" | "absent"}`.
 * Absent roots matter to a restore: projects.json and projects/ don't exist before the cutover.
 */
export function cutoverRoots(agentDir) {
  const stateRoot = join(agentDir, "sova");
  const orgs = orgsOf(stateRoot);
  const paths = [
    join(stateRoot, "orgs.json"),
    join(stateRoot, "projects.json"),
    join(stateRoot, "preview-links.json"),
    join(stateRoot, "preview-kept.json"),
    join(stateRoot, "statecharts"),
    join(stateRoot, "projects"),
    ...orgs.map((o) => o.dir),
    ...referencedSessionFiles(agentDir, orgs),
  ];
  const seen = new Set();
  const roots = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    let kind = "absent";
    try {
      kind = lstatSync(path).isDirectory() ? "dir" : "file";
    } catch {}
    roots.push({ path, kind });
  }
  // A root inside another (a workspace under statecharts/ would be odd, but cheap to guard) is covered by it.
  return roots.filter((r) => !roots.some((o) => o !== r && o.kind === "dir" && r.path.startsWith(o.path + "/")));
}

export function present(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** `{<absolute path>: "d" | "l:<target>" | "<sha256>"}` for every entry under the roots that exist. */
export function manifestOf(roots) {
  const out = {};
  const walk = (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) out[p] = `l:${readlinkSync(p)}`;
    else if (st.isDirectory()) {
      out[p] = "d";
      for (const n of readdirSync(p).sort()) walk(join(p, n));
    } else if (st.isFile()) out[p] = sha256File(p);
    else out[p] = "?";
  };
  for (const r of roots) if (present(r.path)) walk(r.path);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The differences between two manifests, at most `max` lines. */
export function manifestDiff(want, got, max = 20) {
  const lines = [];
  for (const [p, h] of Object.entries(want)) if (got[p] !== h) lines.push(`${got[p] === undefined ? "missing" : "changed"}: ${p}`);
  for (const p of Object.keys(got)) if (want[p] === undefined) lines.push(`extra: ${p}`);
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more`] : lines;
}

export function git(dir, args, env = {}) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } }).trim();
}

export const SOVA_IDENTITY = { GIT_AUTHOR_NAME: "Sova", GIT_AUTHOR_EMAIL: "sova@localhost", GIT_COMMITTER_NAME: "Sova", GIT_COMMITTER_EMAIL: "sova@localhost" };
