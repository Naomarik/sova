// The unit tier's guard and the suite's audit, a second preload beside hermetic-env.mjs
// (scripts/run-tests.mjs loads both). A unit test file (`*.test.ts`, not `*.integration.test.ts`)
// runs in-process: it may run git (Sova's own org store is a git repository), but no other program,
// no socket (bound or connected, TCP or unix), no network fetch, and no import of server/index.ts
// (which listens and starts a helper process on import). Whatever a file does of these is recorded,
// in either tier, so one run of the suite shows what each file really touches.
//
// SOVA_TEST_FILE (set by the runner per bun process; under node --test, the file is the process's
// argv[1]) names the file. SOVA_TEST_GUARD: `enforce` (the default) also refuses the call in a unit
// file with an error that says to rename the file, so the test fails where it happened; `report`
// only records; `off` does nothing. SOVA_TEST_GUARD_DIR: where each process writes its record at exit
// (`<dir>/<pid>.json`), for the runner to gather; unset, nothing is written.
import cp from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import * as nodeModule from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(import.meta.dirname, "..");
const SERVER_INDEX = path.join(ROOT, "server", "index.ts");
const mode = process.env.SOVA_TEST_GUARD || "enforce";
const isIntegration = (file) => file.endsWith(".integration.test.ts");

/** The test file this process runs, relative to the root; null when it runs none (a runner's parent). */
function testFile() {
  const named = process.env.SOVA_TEST_FILE;
  if (named) return path.relative(ROOT, path.resolve(ROOT, named));
  const main = process.argv[1];
  return main && /\.test\.[cm]?[jt]s$/.test(main) ? path.relative(ROOT, path.resolve(main)) : null;
}

const file = testFile();
// A file's process never outlives its runner: started by run-tests.mjs (SOVA_TEST_RUNNER_PID), it ends
// its own process group, children included, once its parent is another (the runner killed by SIGKILL,
// which can't stop the groups itself). Polled every 2 s; whatever the guard's mode.
// Its run's own chat slice (run-tests.mjs's SOVA_CHAT_SLICE) is stopped first, which that runner can't do
// either: by the name the runner gave, never another slice; with the spawn taken before the guard wraps it.
const runner = Number(process.env.SOVA_TEST_RUNNER_PID);
const runSlice = process.env.SOVA_CHAT_SLICE ?? "";
const spawnRaw = cp.spawnSync;
if (runner > 0 && process.ppid === runner)
  setInterval(() => {
    if (process.ppid === runner) return;
    if (/^sova_test_[A-Za-z0-9_]+\.slice$/.test(runSlice)) {
      try {
        spawnRaw("systemctl", ["--user", "stop", runSlice], { stdio: "ignore", timeout: 30_000 });
      } catch {
        // no user manager: nothing to stop
      }
    }
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      // not a group leader: only this process goes
    }
    process.exit(1);
  }, 2000).unref();
// A unit file's project engine takes the detached driver rather than probing systemd (a
// `systemctl` child); integration files keep the real probe. Set whatever the guard's mode.
if (file && !isIntegration(file)) process.env.SOVA_PROJECT_NO_SYSTEMD ??= "1";
if (file && mode !== "off") install(file);

// ─── Git commands that read this repository's history ──────────────────────────────────────────────────────────────
//
// A test that runs git on this checkout's own repository (its commits, its index, its branches, master) depends on
// more than the files on disk: uncommitted work, the spec commit landing adds, where master is. Its pass is never
// remembered (scripts/test-cache.mjs). The repository is found as git finds it: GIT_DIR, else the directory (the
// spawn's cwd, else this process's, then each -C) and its parents up to GIT_CEILING_DIRECTORIES, the first holding a
// .git; it is this one when its common git dir is this checkout's. Not a read: init, --version/--help/version, var,
// config (but --blob), a clone of another repository, and rev-parse asking only for HEAD's name or where the
// repository is (server/app.ts asks on import).

/** `node`'s internal ["K=V", ...] env, as an object; null when absent. */
function envOfPairs(pairs) {
  if (!Array.isArray(pairs)) return null;
  const env = {};
  for (const p of pairs) {
    const i = String(p).indexOf("=");
    if (i > 0) env[String(p).slice(0, i)] = String(p).slice(i + 1);
  }
  return env;
}

/** The real path of `p`, or of its nearest existing parent joined with the rest; `p` itself when nothing resolves. */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    const up = path.dirname(p);
    return up === p ? p : path.join(real(up), path.basename(p));
  }
}

/** A git dir's common dir (a linked worktree's `commondir`), real. */
function commonOf(gitDir) {
  try {
    const c = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    return real(path.resolve(gitDir, c));
  } catch {
    return real(gitDir);
  }
}

/** The git dir `dir` sits in, by git's upward search stopping at `ceilings`; null when none. */
function gitDirAround(dir, ceilings) {
  let cur = real(dir);
  for (;;) {
    const dot = path.join(cur, ".git");
    try {
      const st = fs.statSync(dot);
      if (st.isDirectory()) return dot;
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, "utf8"));
      if (m) return path.resolve(cur, m[1].trim());
    } catch {
      // none here
    }
    const up = path.dirname(cur);
    if (up === cur || ceilings.includes(up)) return null;
    cur = up;
  }
}

let ownCommon;
/** This checkout's common git dir, real (computed once). */
function ownCommonDir() {
  if (ownCommon === undefined) {
    const g = gitDirAround(ROOT, []);
    ownCommon = g ? commonOf(g) : null;
  }
  return ownCommon;
}

/** Whether a git command run in `dir` (with `env`) reaches this checkout's repository. */
function reachesOwnRepo(dir, env) {
  const own = ownCommonDir();
  if (!own) return false;
  const gitDirVar = env?.GIT_DIR;
  if (gitDirVar) return commonOf(path.resolve(dir, gitDirVar)) === own;
  const ceilings = String(env?.GIT_CEILING_DIRECTORIES ?? "").split(path.delimiter).filter(Boolean).map(real);
  const g = gitDirAround(dir, ceilings);
  return !!g && commonOf(g) === own;
}

/** rev-parse arguments that only name HEAD or say where the repository is. */
const IDENTITY = new Set(["HEAD", "--show-toplevel", "--git-dir", "--absolute-git-dir", "--git-common-dir", "--is-inside-work-tree", "--is-inside-git-dir", "--is-bare-repository", "--show-prefix", "--show-cdup", "--verify", "-q", "--quiet", "--short"]);
/** git's options before the subcommand that take a separate value. */
const GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix", "--list-cmds"]);

/**
 * Whether git run with `args` and spawn options `opts` reads this repository's history: the command line when it
 * does, else null.
 */
export function historyRead(args, opts = {}) {
  const env = { ...process.env, ...(opts?.env ?? {}) };
  let dir = path.resolve(String(opts?.cwd ?? process.cwd()));
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--version" || a === "--help" || a === "-h" || a === "--exec-path" || a === "--html-path" || a === "--man-path" || a === "--info-path") return null;
    if (!a.startsWith("-")) break;
    if (a === "-C") dir = path.resolve(dir, String(args[++i] ?? "."));
    else if (a === "--git-dir") env.GIT_DIR = path.resolve(dir, String(args[++i] ?? ""));
    else if (a.startsWith("--git-dir=")) env.GIT_DIR = path.resolve(dir, a.slice("--git-dir=".length));
    else if (GLOBAL_WITH_VALUE.has(a)) i++;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub || sub === "init" || sub === "version" || sub === "help" || sub === "var") return null;
  // Settings, not history (a blob's config is read from the object store, so it counts).
  if (sub === "config" && !rest.some((a) => a === "--blob" || a.startsWith("--blob="))) return null;
  if (sub === "clone") {
    // A clone reads its source: this repository when the source is a path into it.
    const source = rest.find((a) => !a.startsWith("-"));
    if (!source || /^[a-z][a-z0-9+.-]*:\/\//i.test(source) && !source.startsWith("file://")) return null;
    const p = path.resolve(dir, source.replace(/^file:\/\//, ""));
    return reachesOwnRepo(p, { ...env, GIT_DIR: undefined }) ? `git ${args.join(" ")}` : null;
  }
  if (sub === "rev-parse" && rest.every((a) => IDENTITY.has(a) || a.startsWith("--path-format"))) return null;
  return reachesOwnRepo(dir, env) ? `git ${args.join(" ")}` : null;
}

function install(file) {
  const unit = !isIntegration(file);
  const enforce = unit && mode === "enforce";
  /** One entry per distinct thing done: `{kind, what, count, at}` (`at`: the first call's caller in this repository). */
  const seen = new Map();
  const offences = new Set();
  const guardDir = process.env.SOVA_TEST_GUARD_DIR;
  /** Writes this process's record (`<dir>/<pid>.json`) as it stands. Best effort. */
  function flush() {
    if (!guardDir) return;
    try {
      const record = { v: 1, file, tier: unit ? "unit" : "integration", mode, acts: [...seen.values()], offences: [...offences], history: [...history] };
      fs.writeFileSync(path.join(guardDir, `${process.pid}.json`), `${JSON.stringify(record)}\n`);
    } catch {
      /* best effort */
    }
  }
  /** The git commands this file ran that read this repository's history (historyRead): such a file's pass depends on
   *  more than the files on disk, so the runner never remembers it. */
  const history = new Set();
  // A call made inside another wrapped call (Bun's child_process runs Bun.spawn; its net runs Bun.listen) is the same act.
  let depth = 0;
  // Inside trial(): every act but git is refused, whatever the mode or tier, and none is recorded.
  let trying = 0;
  /** The guard's own test (server/tier-guard.test.ts): runs `fn` with the unit tier's rule enforced
   *  and returns the error it refused with (null when nothing was refused). */
  globalThis[Symbol.for("sova:test-tier-guard")] = {
    file,
    tier: unit ? "unit" : "integration",
    mode,
    async trial(fn) {
      trying++;
      try {
        await fn();
        return null;
      } catch (err) {
        return err;
      } finally {
        trying--;
      }
    },
  };

  const callerOf = () => {
    const lines = (new Error().stack ?? "").split("\n").slice(1);
    const own = lines.find((l) => l.includes(ROOT) && !l.includes("test-tier-guard.mjs") && !l.includes("node_modules"));
    return own ? own.trim().replace(/^at /, "").replace(`${ROOT}/`, "") : undefined;
  };

  /** Notes one act; in the unit tier an offence (unless `allowed`), which enforce mode refuses. */
  function note(kind, what, allowed = false) {
    if (trying) {
      if (!allowed) throw refusal(kind, what);
      return;
    }
    const key = `${kind} ${what}`;
    const entry = seen.get(key);
    if (entry) entry.count++;
    // Bounded: past 200 distinct acts, the rest only count as "more".
    else if (seen.size < 200) seen.set(key, { kind, what, count: 1, at: callerOf() });
    else (seen.get("more") ?? seen.set("more", { kind: "more", what: "distinct acts not listed", count: 0 }).get("more")).count++;
    if (!unit || allowed) return;
    if (offences.size < 200 && !offences.has(key)) {
      offences.add(key);
      flush();
    }
    if (enforce) throw refusal(kind, what);
  }
  const refusal = (kind, what) =>
    new Error(`tier guard: ${file} is a unit test file and ${describe(kind, what)}; a test that needs real processes, sockets or the whole server belongs in the integration tier: rename it (or split those cases into) ${file.replace(/\.test\.([cm]?[jt]s)$/, ".integration.test.$1")}`);
  const describe = (kind, what) => ({ spawn: `started ${what}`, listen: `listened on ${what}`, connect: `connected to ${what}`, fetch: `fetched ${what}`, import: `imported ${what}` })[kind] ?? `${kind} ${what}`;

  /** The program a command line runs: `sh -c "<cmd>"` reads as its command's first word. */
  function program(argv) {
    const [cmd, ...args] = argv.map(String);
    const base = path.basename(cmd ?? "");
    if (/^(ba|da|z)?sh$/.test(base) && args[0] === "-c" && args[1]) {
      const words = args[1].trim().split(/\s+/);
      return { name: path.basename(words[0] ?? ""), line: args[1], args: words.slice(1).map((w) => w.replace(/^(["'])(.*)\1$/, "$2")) };
    }
    return { name: base, line: [cmd, ...args].join(" ") };
  }
  const spawnNote = (argv, opts) => {
    const p = program(argv);
    if (p.name === "git") {
      const read = historyRead(p.args ?? argv.slice(1).map(String), opts);
      if (read && history.size < 50 && !history.has(read.slice(0, 160))) {
        history.add(read.slice(0, 160));
        flush();
      }
    }
    note("spawn", p.name === "git" ? "git" : p.line.slice(0, 160), p.name === "git");
  };

  /** Wraps obj[key] so `before(args)` runs first (and may throw), once per outermost call. */
  function wrap(obj, key, before) {
    const orig = obj?.[key];
    if (typeof orig !== "function") return;
    const wrapped = function (...args) {
      if (depth === 0) before.apply(this, args);
      depth++;
      try {
        return new.target ? Reflect.construct(orig, args, new.target) : orig.apply(this, args);
      } finally {
        depth--;
      }
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(orig));
    try {
      obj[key] = wrapped;
    } catch {
      /* a read-only global: not wrapped */
    }
  }

  const where = (o) => (o?.path || o?.unix ? `unix:${o.path ?? o.unix}` : `${o?.host ?? o?.hostname ?? "localhost"}:${o?.port ?? 0}`);
  const listenArgs = (a) => {
    if (typeof a[0] === "string" && !/^\d+$/.test(a[0])) return `unix:${a[0]}`;
    if (a[0] && typeof a[0] === "object") return a[0].fd !== undefined || a[0]._handle ? "a handle" : where(a[0]);
    return `${typeof a[1] === "string" ? a[1] : "*"}:${a[0] ?? 0}`;
  };
  const connectArgs = (a) => {
    const o = Array.isArray(a[0]) ? a[0][0] : a[0]; // node's internal normalized [options, cb]
    if (o && typeof o === "object") return where(o);
    if (typeof o === "string" && !/^\d+$/.test(o)) return `unix:${o}`;
    return `${typeof a[1] === "string" ? a[1] : "localhost"}:${o}`;
  };

  // Programs. Node: every async spawn is a ChildProcess's spawn; the sync ones are each their own.
  wrap(cp.ChildProcess.prototype, "spawn", (o) => spawnNote(o?.args?.length ? o.args : [o?.file], { cwd: o?.cwd, env: envOfPairs(o?.envPairs) ?? o?.env }));
  for (const k of ["spawnSync", "execFileSync"]) wrap(cp, k, (f, args, opts) => spawnNote([f, ...(Array.isArray(args) ? args : [])], Array.isArray(args) ? opts : args));
  wrap(cp, "execSync", (cmd, opts) => spawnNote(["/bin/sh", "-c", cmd], opts));
  // Sockets.
  wrap(net.Server.prototype, "listen", (...a) => note("listen", listenArgs(a)));
  // Bun's http(s) servers have their own listen (over Bun.serve), which turns a throw into an 'error' event.
  for (const S of [http.Server, https.Server]) if (Object.hasOwn(S.prototype, "listen")) wrap(S.prototype, "listen", (...a) => note("listen", listenArgs(a)));
  wrap(net.Socket.prototype, "connect", (...a) => note("connect", connectArgs(a)));
  // Network fetches (a data:, blob: or file: URL touches no socket).
  wrap(globalThis, "fetch", (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input?.href ?? input));
    if (/^(https?|wss?):/i.test(url) || init?.unix) note("fetch", init?.unix ? `unix:${init.unix}` : url.replace(/[?#].*$/, ""));
  });
  wrap(globalThis, "WebSocket", (url) => note("connect", String(url).replace(/[?#].*$/, "")));
  if (globalThis.Bun) {
    const B = globalThis.Bun;
    const cmdOf = (a) => (Array.isArray(a[0]) ? a[0] : (a[0]?.cmd ?? []));
    const optsOf = (a) => (Array.isArray(a[0]) ? a[1] : a[0]);
    wrap(B, "spawn", (...a) => spawnNote(cmdOf(a), optsOf(a)));
    wrap(B, "spawnSync", (...a) => spawnNote(cmdOf(a), optsOf(a)));
    wrap(B, "listen", (o) => note("listen", where(o)));
    wrap(B, "serve", (o) => note("listen", where(o)));
    wrap(B, "connect", (o) => note("connect", where(o)));
    // The whole server.
    B.plugin({
      name: "sova-test-tier-guard",
      setup(build) {
        build.onLoad({ filter: new RegExp(`^${SERVER_INDEX.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`) }, (args) => {
          note("import", "server/index.ts");
          return { contents: fs.readFileSync(args.path, "utf8"), loader: "ts" };
        });
      },
    });
  } else if (typeof nodeModule.registerHooks === "function") {
    nodeModule.registerHooks({
      resolve(spec, ctx, next) {
        const r = next(spec, ctx);
        if (r.url?.startsWith("file:") && fileURLToPath(r.url) === SERVER_INDEX) note("import", "server/index.ts");
        return r;
      },
    });
  }
  // ESM named imports of node builtins (`import { spawn } from "node:child_process"`) see the wrapped functions.
  nodeModule.syncBuiltinESMExports?.();

  // The record is written at once, again on each new offence or history read, and last at exit: `bun test` runs no
  // exit handler for a file that imports bun:test, and the runner reads a missing record as "the guard never ran".
  if (guardDir) {
    flush();
    process.on("exit", flush);
  }
}
