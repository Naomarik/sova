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
// A unit file's project engine takes the detached driver rather than probing systemd (a
// `systemctl` child); integration files keep the real probe. Set whatever the guard's mode.
if (file && !isIntegration(file)) process.env.SOVA_PROJECT_NO_SYSTEMD ??= "1";
if (file && mode !== "off") install(file);

function install(file) {
  const unit = !isIntegration(file);
  const enforce = unit && mode === "enforce";
  /** One entry per distinct thing done: `{kind, what, count, at}` (`at`: the first call's caller in this repository). */
  const seen = new Map();
  const offences = new Set();
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
    if (offences.size < 200) offences.add(key);
    if (enforce) throw refusal(kind, what);
  }
  const refusal = (kind, what) =>
    new Error(`tier guard: ${file} is a unit test file and ${describe(kind, what)}; a test that needs real processes, sockets or the whole server belongs in the integration tier: rename it (or split those cases into) ${file.replace(/\.test\.([cm]?[jt]s)$/, ".integration.test.$1")}`);
  const describe = (kind, what) => ({ spawn: `started ${what}`, listen: `listened on ${what}`, connect: `connected to ${what}`, fetch: `fetched ${what}`, import: `imported ${what}` })[kind] ?? `${kind} ${what}`;

  /** The program a command line runs: `sh -c "<cmd>"` reads as its command's first word. */
  function program(argv) {
    const [cmd, ...args] = argv.map(String);
    const base = path.basename(cmd ?? "");
    if (/^(ba|da|z)?sh$/.test(base) && args[0] === "-c" && args[1]) return { name: path.basename(args[1].trim().split(/\s+/)[0] ?? ""), line: args[1] };
    return { name: base, line: [cmd, ...args].join(" ") };
  }
  const spawnNote = (argv) => {
    const p = program(argv);
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
  wrap(cp.ChildProcess.prototype, "spawn", (o) => spawnNote(o?.args?.length ? o.args : [o?.file]));
  for (const k of ["spawnSync", "execFileSync"]) wrap(cp, k, (f, args) => spawnNote([f, ...(Array.isArray(args) ? args : [])]));
  wrap(cp, "execSync", (cmd) => spawnNote(["/bin/sh", "-c", cmd]));
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
    wrap(B, "spawn", (...a) => spawnNote(cmdOf(a)));
    wrap(B, "spawnSync", (...a) => spawnNote(cmdOf(a)));
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

  const dir = process.env.SOVA_TEST_GUARD_DIR;
  if (dir) {
    process.on("exit", () => {
      try {
        const record = { v: 1, file, tier: unit ? "unit" : "integration", mode, acts: [...seen.values()], offences: [...offences] };
        fs.writeFileSync(path.join(dir, `${process.pid}.json`), `${JSON.stringify(record)}\n`);
      } catch {
        /* best effort */
      }
    });
  }
}
