// What every merge check (scripts/merge-checks/*.mjs) shares. Builtins only.
//
// A merge check runs in the tree it checks (its cwd), standalone or as a step of the merge queue's run.
// Its inputs: SOVA_MERGE_BASE (the target's commit the change sits on; else --base <rev>, else the
// merge base with master), SOVA_MERGE_CHANGED (a file of the changed paths, one per line; else
// `git diff --name-only <base>...HEAD`), and SOVA_OUT (a file it writes its report to, as JSON). A
// check with nothing to do exits 0 and writes `{passed: 0, failed: 0, skipped: "<why>"}`.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** The value after `name` in argv, else `fallback`. */
export function opt(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();

/** The check's context: its tree, base, changed paths and report file. Throws when git can't say. */
export function context(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const root = cwd;
  const base = env.SOVA_MERGE_BASE || opt(argv, "--base") || git(root, ["merge-base", "HEAD", env.SOVA_MERGE_TARGET || "master"]);
  let changed;
  const list = env.SOVA_MERGE_CHANGED || opt(argv, "--changed");
  if (list) changed = readFileSync(list, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  else changed = git(root, ["diff", "--name-only", `${base}...HEAD`]).split("\n").filter(Boolean);
  return { root, base, changed, out: env.SOVA_OUT || null, target: env.SOVA_MERGE_TARGET || "master" };
}

/** Writes the report to SOVA_OUT (when set). */
export function report(out, rep) {
  if (!out) return;
  try {
    writeFileSync(out, `${JSON.stringify(rep)}\n`);
  } catch (err) {
    console.error(`merge-check: could not write SOVA_OUT ${out}: ${err.message}`);
  }
}

/** Nothing to do here: say why, report it, exit 0. */
export function skip(out, why) {
  console.log(`skipped: ${why}`);
  report(out, { passed: 0, failed: 0, skipped: why });
  process.exit(0);
}

/** Runs argv with its output on ours, in its own process group (killed whole on our signals). → exit code */
export function run(cmd, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve) => {
    console.log(`$ ${[cmd, ...args].join(" ")}${cwd ? `   (in ${cwd})` : ""}`);
    const child = spawn(cmd, args, { cwd, env, stdio: "inherit", detached: true });
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
    process.once("SIGTERM", kill);
    process.once("SIGINT", kill);
    child.on("error", (err) => { console.error(`could not start ${cmd}: ${err.message}`); resolve(127); });
    child.on("close", (code, sig) => {
      process.removeListener("SIGTERM", kill);
      process.removeListener("SIGINT", kill);
      resolve(code ?? (sig ? 128 : 1));
    });
  });
}

/** argv with `node` as this node, wrapped in the tree's scripts/nice.mjs when it has one (as pnpm test runs). */
export function niced(root, cmd, args) {
  const c = cmd === "node" ? process.execPath : cmd;
  const nice = join(root, "scripts", "nice.mjs");
  return existsSync(nice) ? [process.execPath, [nice, c, ...args]] : [c, args];
}

/** pi's agent dir (PI_CODING_AGENT_DIR, ~ expanded; else ~/.pi/agent). */
export function agentDir(env = process.env) {
  const v = env.PI_CODING_AGENT_DIR;
  if (!v) return join(homedir(), ".pi", "agent");
  return v === "~" ? homedir() : v.startsWith("~/") ? join(homedir(), v.slice(2)) : v;
}

/** The spec tools: SOVA_SPEC_CORE, else the agent's installed extensions/spec/core. */
export const specCore = (env = process.env) => env.SOVA_SPEC_CORE || join(agentDir(env), "extensions", "spec", "core");

/** One extension's line from pi-config/README.md's Tests block, as commands of argv (no shell). */
export function suiteOf(readme, ext) {
  const at = readme.indexOf("\n## Tests");
  if (at < 0) return null;
  const open = readme.indexOf("```", at);
  const close = open < 0 ? -1 : readme.indexOf("```", open + 3);
  if (close < 0) return null;
  const line = readme.slice(readme.indexOf("\n", open) + 1, close).split("\n").find((l) => l.startsWith(`cd extensions/${ext} && `));
  if (!line) return null;
  const cmds = line.split(" && ").map((c) => c.trim().split(/\s+/));
  return { dir: `extensions/${ext}`, commands: cmds.slice(1) };
}

/** A command's argv with `dir/*.ext` patterns expanded against `cwd` (one star, in the last segment). */
export function expandArgs(argv, cwd) {
  return argv.flatMap((a) => {
    if (!a.includes("*")) return [a];
    const d = dirname(a);
    const [pre, post] = basename(a).split("*");
    let names = [];
    try { names = readdirSync(join(cwd, d)); } catch { /* none */ }
    const hits = names.filter((n) => n.startsWith(pre) && n.endsWith(post) && n.length >= pre.length + post.length).sort();
    return hits.length ? hits.map((n) => (d === "." ? n : `${d}/${n}`)) : [a];
  });
}

/** The pi-config extensions a change touches, by folder name, sorted. */
export const changedExtensions = (changed) => [...new Set(changed.map((p) => /^pi-config\/extensions\/([^/]+)\//.exec(p)?.[1]).filter(Boolean))].sort();

/** A changed file that makes the spec replay suite run (a landing gate, never run while working). */
export const touchesSpecReplay = (file) =>
  /^pi-config\/extensions\/spec\/(?:core|tests\/replay)\//.test(file) || file === "pi-config/extensions/mode/spec-guard.ts";

/** A changed file that makes the statecharts' tests run. */
export const touchesStatecharts = (file) =>
  /^statecharts\//.test(file) || /^scripts\/statecharts[^/]*$/.test(file) || /^server\/statecharts[^/]*$/.test(file);

/** A machine-wide lock file `{pid, at}`, created exclusively and whole (a hard link of a written file). The
 *  holder rewrites `at` every `beatMs`; a lock whose `at` is older than `staleMs` is taken over, a fresher one
 *  waited for. Never judged by pid (another PID namespace looks gone). → { release, waitedMs } */
export async function acquireLock(file, { pollMs = 5000, beatMs = 30_000, staleMs = 3 * 60_000, now = Date.now } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const started = now();
  let mine = JSON.stringify({ pid: process.pid, at: new Date(started).toISOString() });
  const draft = `${file}.${process.pid}.new`;
  writeFileSync(draft, mine, { mode: 0o600 });
  for (;;) {
    try {
      linkSync(draft, file);
      rmSync(draft, { force: true });
      const beat = setInterval(() => {
        try {
          if (readFileSync(file, "utf8") !== mine) return;
          const next = JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() });
          writeFileSync(`${file}.${process.pid}.beat`, next, { mode: 0o600 });
          renameSync(`${file}.${process.pid}.beat`, file);
          mine = next;
        } catch { rmSync(`${file}.${process.pid}.beat`, { force: true }); }
      }, beatMs);
      beat.unref();
      const release = () => { clearInterval(beat); try { if (readFileSync(file, "utf8") === mine) rmSync(file, { force: true }); } catch { /* gone */ } };
      return { release, waitedMs: now() - started };
    } catch (e) {
      if (e.code !== "EEXIST") { rmSync(draft, { force: true }); throw e; }
    }
    let held = "";
    try { held = readFileSync(file, "utf8"); } catch { continue; }
    let holder = null;
    try { holder = JSON.parse(held); } catch { /* torn */ }
    if (!(now() - Date.parse(holder?.at) < staleMs)) {
      const aside = `${file}.${process.pid}.stale`;
      try {
        renameSync(file, aside);
        if (readFileSync(aside, "utf8") !== held) linkSync(aside, file);
      } catch { /* raced */ }
      rmSync(aside, { force: true });
      continue;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
