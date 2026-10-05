#!/usr/bin/env node
// The unit suite, on Bun or (when asked) Node: one call for every caller.
//
//   node scripts/run-tests.mjs [<files>] [-- <runner flags>]                  # pnpm test: bun
//   node scripts/run-tests.mjs --runtime node [<files>] [-- <runner flags>]   # pnpm run test:node
//
// The runtime: --runtime node|bun, else node when SOVA_RUNTIME=node (the server's switch,
// §app.server-runtime/choice), else bun. Bun is found as the launcher finds it ($SOVA_BUN, PATH,
// `mise which bun`); none found exits 2 at once, never a quiet Node pass.
//
// The files are GLOBS below, or the ones named (a project's `test.run` appends its
// selectors, so each named file is routed like any other). Two invocations, and a non-zero exit if
// either fails: the main set, then `*.browser.test.ts` under --conditions=browser (Solid's
// browser build; the main set must not get it). Arguments starting with `-` go to the runner.
//
// Node: `tsx --test` with the hermetic-env.mjs preload, which gives each file's process its own
// throwaway home.
// Bun: its os.homedir() ignores a HOME set after it started (docs/bun-quirks.md), so the throwaway
// home is made HERE and put in bun's environment, one home and one `bun test <file>` per file (as
// node --test isolates files), at most half the cores at once (TEST_BUN_JOBS=<n> sets the width;
// at full width tests with ready timeouts starve). The preload finds the home (SOVA_TEST_HOME),
// keeps it, and refuses to run if os.homedir() disagrees. Bun's default per-test timeout is 5 s and
// node:test has none: --timeout=60000 unless you pass one. PATH gets the real node's directory and
// mise's tool paths first (shims refuse an untrusted config in a throwaway HOME), and
// SOVA_PRICES_FETCH=off (bun test sets no NODE_TEST_CONTEXT). bun test itself sets TZ=UTC and
// NODE_ENV=test.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chosenRuntime, resolveBun } from "../server/runtime-choice.ts";

const ROOT = path.join(import.meta.dirname, "..");
const PRELOAD = "./pi-config/extensions/claude-code/tests/hermetic-env.mjs";
const BROWSER_CONDITION = "--conditions=browser";
const GLOBS = [
  "shared/*.test.ts",
  "server/*.test.ts",
  "server/project-services/*.test.ts",
  "server/projects/*.test.ts",
  "server/mesh/*.test.ts",
  "server/sync/*.test.ts",
  "server/org-host/*.test.ts",
  "server/claude-pool/*.test.ts",
  "server/voice/*.test.ts",
  "server/usage-helper/*.test.ts",
  "server/harness/**/*.test.ts",
  "src/lib/*.test.ts",
  "src/lib/voice/*.test.ts",
  "src/vis/**/*.test.ts",
];
const isBrowserTest = (f) => f.endsWith(".browser.test.ts");

// macOS: the default tmpdir (/var/folders/…) is reached through the /var -> /private/var symlink, so
// a path built from tmpdir() differs from its realpath, and a unix socket under it passes the
// 104-byte limit. On darwin both runtimes get a short, symlink-free TMPDIR of their own, removed at exit.
if (process.platform === "darwin") {
  const tmp = fs.realpathSync(fs.mkdtempSync("/tmp/sova-t-"));
  process.env.TMPDIR = tmp;
  process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
}

const argv = process.argv.slice(2);
const at = argv.indexOf("--runtime");
const runtime = at >= 0 ? argv[at + 1] : chosenRuntime();
if (runtime !== "node" && runtime !== "bun") {
  console.error("usage: node scripts/run-tests.mjs [--runtime node|bun] [files] [-- flags]");
  process.exit(2);
}
const rest = argv.filter((a, i) => a !== "--" && (at < 0 || (i !== at && i !== at + 1)));
const flags = rest.filter((a) => a.startsWith("-"));
const named = rest.filter((a) => !a.startsWith("-"));
const files = named.length ? named : [...new Set(GLOBS.flatMap((g) => fs.globSync(g, { cwd: ROOT })))].sort();
const sets = [
  { extra: [], files: files.filter((f) => !isBrowserTest(f)) },
  { extra: [BROWSER_CONDITION], files: files.filter(isBrowserTest) },
].filter((s) => s.files.length);

if (runtime === "node") {
  // A pass still running after NODE_PASS_LIMIT_MS is stuck (seen: a file whose tests all reported
  // but whose process never exits, under heavy load): its whole process group is killed and the run
  // FAILS, never hangs. Not --test-force-exit: that ends a file before tests it registers after a
  // top-level await, so the run would pass with tests silently missing.
  const limitMs = Number(process.env.NODE_PASS_LIMIT_MS) || 15 * 60_000;
  let failed = false;
  for (const s of sets) {
    const child = spawn("pnpm", ["exec", "tsx", ...s.extra, "--import", PRELOAD, ...flags, "--test", ...s.files], { cwd: ROOT, stdio: "inherit", detached: true });
    let stuck = false;
    const timer = setTimeout(() => {
      stuck = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, limitMs);
    for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} process.exit(130); });
    const code = await new Promise((r) => child.on("close", (c) => r(c)));
    clearTimeout(timer);
    if (stuck) console.error(`\nrun-tests (node): still running after ${limitMs / 60_000} min; killed. A test file most likely finished its tests but never exited (an open server, socket or timer): the last file without a summary above is the one.`);
    if (code !== 0 || stuck) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

// ─── Bun ────────────────────────────────────────────────────────────────────────────────────────
const found = resolveBun();
if ("missing" in found) {
  console.error(`run-tests: bun not found (${found.missing}); install it with mise, or run pnpm run test:node`);
  process.exit(2);
}
const bun = found.path;
const FILE_LIMIT_MS = Number(process.env.TEST_FILE_LIMIT_MS) || 300_000;
const bunFlags = [...["--timeout=60000"].filter((d) => !flags.some((f) => f.split("=")[0] === d.split("=")[0])), ...flags];
let misePaths = "";
try {
  misePaths = execFileSync("mise", ["bin-paths"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").join(path.delimiter);
} catch {
  /* no mise: the inherited PATH */
}

/** A fresh throwaway home and the environment bun starts with. */
function hermeticEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sova-test-home-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    SOVA_TEST_HOME: root,
    PATH: [path.dirname(process.execPath), misePaths, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    SOVA_PRICES_FETCH: "off",
  };
  // The same list hermetic-env.mjs drops.
  for (const name of [
    "PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_SESSIONS_DIR", "CLAUDE_CONFIG_DIR", "SOVA_EXTENSIONS_FILE",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "SOVA_DEVICE_ID", "SOVA_MESH_IDENTITY", "SOVA_CLAUDE_ACCOUNTS_DEV",
  ]) delete env[name];
  return { root, env };
}

function runFile(file, extra) {
  const { root, env } = hermeticEnv();
  const target = file.startsWith("/") || file.startsWith("./") ? file : `./${file}`;
  return new Promise((resolve) => {
    const child = spawn(bun, ["test", "--preload", PRELOAD, ...extra, ...bunFlags, target], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    // A file still running after FILE_LIMIT_MS is stuck (a hang, or tests done with a handle left
    // open): killed and reported as a failure, so one file never stalls the run.
    const limit = setTimeout(() => {
      out += `run-tests: ${file} still running after ${FILE_LIMIT_MS / 1000} s; killed\n`;
      child.kill("SIGKILL");
    }, FILE_LIMIT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => (out += `run-tests: could not start ${bun}: ${err.message}\n`));
    child.on("close", (code) => {
      clearTimeout(limit);
      fs.rmSync(root, { recursive: true, force: true });
      const count = (what) => Number(out.match(new RegExp(`^\\s*(\\d+) ${what}$`, "m"))?.[1] ?? 0);
      resolve({ file, code: code ?? 1, out, pass: count("pass"), fail: count("fail"), skip: count("skip") });
    });
  });
}

const queue = sets.flatMap((s) => s.files.map((f) => ({ file: f, extra: s.extra })));
const jobs = Math.max(1, Number(process.env.TEST_BUN_JOBS) || Math.floor(os.availableParallelism() / 2));
const results = [];
let next = 0;
const t0 = Date.now();
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (next < queue.length) {
      const { file, extra } = queue[next++];
      const r = await runFile(file, extra);
      results.push(r);
      // A passing file prints one line; a failing one, all of its output.
      if (r.code === 0) console.log(`ok   ${r.file} (${r.pass} pass${r.skip ? `, ${r.skip} skip` : ""})`);
      else console.log(`FAIL ${r.file} (exit ${r.code}, ${r.pass} pass, ${r.fail} fail)\n${r.out}`);
    }
  }),
);
const failed = results.filter((r) => r.code !== 0);
const sum = (k) => results.reduce((n, r) => n + r[k], 0);
console.log(`\nrun-tests (bun): ${results.length} files, ${sum("pass")} pass, ${sum("fail")} fail, ${sum("skip")} skip, ${failed.length} failing files, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const r of failed) console.log(`  FAIL ${r.file}`);
process.exit(failed.length ? 1 : 0);
