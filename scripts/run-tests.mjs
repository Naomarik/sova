#!/usr/bin/env node
// The unit suite, on Node or Bun: one call for every caller.
//
//   node scripts/run-tests.mjs --runtime node [<files>] [-- <runner flags>]   # pnpm test
//   node scripts/run-tests.mjs --runtime bun  [<files>] [-- <runner flags>]   # pnpm run test:bun
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
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  "src/lib/*.test.ts",
  "src/lib/voice/*.test.ts",
  "src/vis/**/*.test.ts",
];
const isBrowserTest = (f) => f.endsWith(".browser.test.ts");

const argv = process.argv.slice(2);
const at = argv.indexOf("--runtime");
const runtime = at >= 0 ? argv[at + 1] : "node";
if (runtime !== "node" && runtime !== "bun") {
  console.error("usage: node scripts/run-tests.mjs --runtime node|bun [files] [-- flags]");
  process.exit(2);
}
const rest = argv.filter((a, i) => a !== "--" && i !== at && i !== at + 1);
const flags = rest.filter((a) => a.startsWith("-"));
const named = rest.filter((a) => !a.startsWith("-"));
const files = named.length ? named : [...new Set(GLOBS.flatMap((g) => fs.globSync(g, { cwd: ROOT })))].sort();
const sets = [
  { extra: [], files: files.filter((f) => !isBrowserTest(f)) },
  { extra: [BROWSER_CONDITION], files: files.filter(isBrowserTest) },
].filter((s) => s.files.length);

if (runtime === "node") {
  let failed = false;
  for (const s of sets) {
    // --test-force-exit: a file whose tests all reported but that leaves a handle open (a server,
    // a timer) ends instead of hanging the whole run; its failures still fail it.
    const force = flags.includes("--test-force-exit") ? [] : ["--test-force-exit"];
    const run = spawnSync("pnpm", ["exec", "tsx", ...s.extra, "--import", PRELOAD, ...force, ...flags, "--test", ...s.files], { cwd: ROOT, stdio: "inherit" });
    if (run.status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

// ─── Bun ────────────────────────────────────────────────────────────────────────────────────────
const bun = process.env.SOVA_BUN || "bun";
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
