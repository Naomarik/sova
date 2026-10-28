#!/usr/bin/env node
// The test suite, on Bun or (when asked) Node: one call for every caller.
//
//   node scripts/run-tests.mjs [<files>] [-- <runner flags>]                  # pnpm test: the unit tier, bun
//   node scripts/run-tests.mjs --integration [--changed [--base <rev>]]       # pnpm test:int
//   node scripts/run-tests.mjs --integration --landing [--base <rev>] [--plan] # what a landing runs
//   node scripts/run-tests.mjs --integration --groups <name,…|all>            # only those slow groups
//   node scripts/run-tests.mjs --all                                          # pnpm test:all: both tiers
//   node scripts/run-tests.mjs --runtime node [<files>] [-- <runner flags>]   # pnpm run test:node
//
// The runtime: --runtime node|bun, else node when SOVA_RUNTIME=node (the server's switch,
// §app.server-runtime/choice), else bun. Bun is found as the launcher finds it ($SOVA_BUN, PATH,
// `mise which bun`); none found exits 2 at once, never a quiet Node pass.
//
// Two tiers, by name: a `*.integration.test.ts` file is the integration tier (real processes other
// than git, sockets, the whole server, timing), every other test file the unit tier (in-process).
// The files are GLOBS below, of the tier asked for (the unit tier unless --integration or --all),
// or the ones named, whatever their tier (a project's `test.run` appends its selectors, so each
// named file is routed like any other). --changed keeps only the files a change may break: those
// whose import closure holds a file changed since the merge base with --base (master), committed or
// not, and those in the same folder as one, plus every file of each slow group whose triggers the
// change touches (scripts/test-groups.mjs: Chat processes, Tours; a group's file never by its
// imports alone). --landing keeps every integration file in no group (the everyday set) plus each
// group a landing runs when triggered (Chat processes), never Tours, and prints a line per group it
// skipped and why; --groups <name,…|all> keeps only those groups' files; --plan prints the selection
// as JSON (files, groups run and skipped, lanes, an estimate from the recorded times) and runs
// nothing. Plain --integration runs the whole tier, every group included (a release runs that).
// The integration tier runs at a lower width (a quarter
// of the cores; TEST_INT_JOBS=<n>) and keeps its own durations. Per tier, two invocations, and a
// non-zero exit if either fails: the main set, then `*.browser.test.ts` under --conditions=browser
// (Solid's browser build; the main set must not get it). Arguments starting with `-` go to the runner.
//
// The tier guard (test-tier-guard.mjs, a second preload) records what each file starts, binds,
// connects to, fetches and whether it imports server/index.ts, into .cache/test-audit.json; a unit
// file doing any of it but git fails ("rename to .integration.test.ts") and is listed at the end of
// the run. SOVA_TEST_GUARD=report only lists it; =off turns the guard off.
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
// SOVA_PRICES_FETCH=off (bun test sets no NODE_TEST_CONTEXT), and SOVA_GIT_MAINTENANCE=off (a server a
// test starts registers no repository with git's scheduled maintenance and starts no systemd
// timer; server/git-maintenance.ts's own tests drive it with their own deps). bun test itself sets TZ=UTC and
// NODE_ENV=test. Both runtimes: a stand-in `claude` (scripts/fake-claude.mjs) leads every test
// process's PATH, so no test runs the installed Claude CLI, or a paid model through it; a test that
// needs another `claude` sets its own PATH.
// Bun's queue runs longest first: each file's wall time is recorded in its tier's durations file
// (gitignored, in the worktree itself: a worktree's node_modules is a symlink into the main
// checkout, which a sandboxed session can't write) and the next run sorts by it; a file never timed
// falls back to KNOWN_SLOW, then to its alphabetical place. The run ends with the 10 slowest files.
// Both: a temp dir inside a git repository is refused (exit 2) before anything runs, and no test
// process gets a GIT_DIR-like variable; git's search stops at its temp dir (GIT_CEILING_DIRECTORIES).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chosenRuntime, resolveBun } from "../server/runtime-choice.ts";
import { affected, changedSince } from "./test-changed.mjs";
import { GROUPS, groupOf, selectFiles } from "./test-groups.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const PRELOAD = "./pi-config/extensions/claude-code/tests/hermetic-env.mjs";
const GUARD = "./scripts/test-tier-guard.mjs";
const BROWSER_CONDITION = "--conditions=browser";
/** The integration tier's suffix; every other test file the globs match is the unit tier. */
const INTEGRATION_SUFFIX = ".integration.test.ts";
const isIntegration = (f) => f.endsWith(INTEGRATION_SUFFIX);
const GLOBS = [
  "shared/*.test.ts",
  "scripts/*.test.ts",
  "server/*.test.ts",
  "server/project-services/*.test.ts",
  "server/tours/*.test.ts",
  "server/share/*.test.ts",
  "server/chat-runtime/*.test.ts",
  "server/projects/*.test.ts",
  "server/mesh/*.test.ts",
  "server/sync/*.test.ts",
  "server/org-host/*.test.ts",
  "server/org-history/*.test.ts",
  "server/claude-pool/*.test.ts",
  "server/voice/*.test.ts",
  "server/usage-helper/*.test.ts",
  "server/memory/*.test.ts",
  "server/updates/*.test.ts",
  "server/harness/**/*.test.ts",
  "src/lib/*.test.ts",
  "src/commands/*.test.ts",
  "src/lib/voice/*.test.ts",
  "src/vis/**/*.test.ts",
  // The model-levels core (builtins only) that Sova's pi adapter imports.
  "pi-config/extensions/model-levels/*.test.ts",
  // The Claude Code bridge's memory-view layout (pi-free, pure): a chat that stops caching its view fails here.
  "pi-config/extensions/claude-code/provider/memory-layout.test.ts",
  // Which Claude program every spawn runs (builtins only; the server imports it).
  "pi-config/extensions/claude-code/claude-executable.test.ts",
];
const isBrowserTest = (f) => f.endsWith(".browser.test.ts");
/** Each tier's recorded wall times, and how many files it runs at once. */
const TIERS = {
  unit: { durations: path.join(ROOT, ".cache", "test-durations.json"), jobs: () => Number(process.env.TEST_BUN_JOBS) || Math.floor(os.availableParallelism() / 2) },
  integration: { durations: path.join(ROOT, ".cache", "test-durations-integration.json"), jobs: () => Number(process.env.TEST_INT_JOBS) || Math.floor(os.availableParallelism() / 4) },
};
/** What each file did that the unit tier refuses, gathered from the tier guard (test-tier-guard.mjs). */
const AUDIT = path.join(ROOT, ".cache", "test-audit.json");
/** A file stem matching `<stem>.test.ts` and `<stem>.integration.test.ts` alike. */
const slow = (stem) => new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.integration)?\\.test\\.ts$`);
/** The files measured at 5-60 s (spawned services, real ports, git fixtures, timers), slowest
 *  first: the order when no duration was recorded yet, in either tier. */
const KNOWN_SLOW = [
  slow("server/statecharts-replay"),
  slow("server/reconcile"),
  slow("server/project-services/test-verb"),
  slow("server/mesh/mesh"),
  slow("server/org-host/kill9"),
  slow("server/project-services/ports-grace"),
  slow("server/worktree-cleanup"),
  slow("server/outreach"),
  slow("server/stream-guard-runtime"),
  slow("server/worktrees"),
  slow("server/project-overseer"),
  slow("server/project-services/deploy-run"),
  slow("server/voice/runtime"),
  /^server\/project-services\/[^/]+\.integration\.test\.ts$/,
  /^server\/mesh\/lan-[^/]+\.test\.ts$/,
];

/**
 * The chat processes a test's server left on the detached driver (no user manager: macOS) under `root`,
 * stopped before `root` goes: each one its record (`…/sova/chats/procs/*.json`) names, only while it is
 * still that process (its start time, as the driver's own stop checks) and still Sova's chat runtime.
 * Its session gets SIGTERM, then SIGKILL after 5 s. By records, never by name.
 */
function sweepDetachedChats(root) {
  let recs = [];
  try {
    recs = fs.globSync("**/sova/chats/procs/*.json", { cwd: root });
  } catch {
    return;
  }
  if (!recs.length) return;
  // A process's start time as the driver recorded it (server/project-services/proctable.ts, read here
  // because plain node can't load that module): /proc's starttime, else ps's lstart.
  const procfs = process.platform === "linux" && fs.existsSync(`/proc/${process.pid}/stat`);
  const ps = (args) => {
    try {
      return execFileSync("ps", args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
    } catch {
      return "";
    }
  };
  const startOf = (pid) => {
    if (!procfs) return ps(["-o", "lstart=", "-p", String(pid)]).trim().replace(/\s+/g, " ") || null;
    try {
      const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return st.slice(st.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    } catch {
      return null;
    }
  };
  const command = (pid) => {
    try {
      return procfs ? fs.readFileSync(`/proc/${pid}/cmdline`, "utf8") : ps(["-o", "command=", "-p", String(pid)]);
    } catch {
      return "";
    }
  };
  const ours = [];
  for (const f of recs) {
    let r;
    try {
      r = JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
    } catch {
      continue;
    }
    if (!Number.isInteger(r?.pid) || r.pid <= 1 || !r.start || (r.clock ?? "procfs") !== (procfs ? "procfs" : "ps") || startOf(r.pid) !== r.start) continue;
    if (command(r.pid).includes("server/chat-runtime/main.ts")) ours.push(r.pid);
  }
  const signal = (pid, sig) => {
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } }
  };
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  for (const pid of ours) signal(pid, "SIGTERM");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const end = Date.now() + 5000; ours.some(alive) && Date.now() < end; ) Atomics.wait(pause, 0, 0, 100);
  for (const pid of ours.filter(alive)) signal(pid, "SIGKILL");
}

/** rm -rf that survives read-only dirs a test left behind, and never throws. */
function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    try {
      execFileSync("chmod", ["-R", "u+w", dir], { stdio: "ignore" });
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`run-tests: could not remove ${dir}: ${err.message}`);
    }
  }
}

/** What points git at a repository whatever its cwd: never passed to a test (hermetic-env.mjs drops the same list). */
const GIT_LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX"];

/** The git repository `dir` is in (its work tree's top, else its git dir), by git's own search with
    nothing inherited steering or stopping it; null when there is none (or no git). */
function repoAround(dir) {
  const env = { ...process.env };
  for (const name of [...GIT_LOCATION_VARS, "GIT_CEILING_DIRECTORIES"]) delete env[name];
  const ask = (flag) => {
    try {
      return execFileSync("git", ["rev-parse", flag], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  };
  return ask("--show-toplevel") ?? ask("--absolute-git-dir");
}

const USAGE = "usage: node scripts/run-tests.mjs [--runtime node|bun] [--integration | --all] [--changed [--base <rev>] | --landing [--base <rev>] | --groups <name,…|all>] [--plan] [files] [-- flags]";
const argv = process.argv.slice(2);
/** The runner's own options (each with its value, if it takes one); everything else is files and the runner's flags. */
const own = { "--runtime": 1, "--base": 1, "--integration": 0, "--all": 0, "--changed": 0, "--landing": 0, "--groups": 1, "--plan": 0 };
const opts = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") continue;
  if (!(a in own)) { rest.push(a); continue; }
  if (own[a] && (i + 1 >= argv.length || argv[i + 1].startsWith("-"))) { console.error(`run-tests: ${a} needs a value\n${USAGE}`); process.exit(2); }
  opts[a] = own[a] ? argv[++i] : true;
}
const runtime = opts["--runtime"] ?? chosenRuntime();
const picks = ["--changed", "--landing", "--groups"].filter((o) => opts[o]);
const groupNames = opts["--groups"] ? opts["--groups"].split(",").map((s) => s.trim()).filter(Boolean) : [];
const badGroup = groupNames.find((n) => n !== "all" && !GROUPS.some((g) => g.name === n));
if (badGroup) console.error(`run-tests: no test group ${badGroup} (groups: ${GROUPS.map((g) => g.name).join(", ")}, all)`);
if ((runtime !== "node" && runtime !== "bun") || (opts["--integration"] && opts["--all"]) || picks.length > 1 || (opts["--base"] && !opts["--changed"] && !opts["--landing"]) || badGroup || (opts["--groups"] && !groupNames.length)) {
  console.error(USAGE);
  process.exit(2);
}
// The slow groups are integration files: --landing and --groups mean that tier unless one is named.
if ((opts["--landing"] || opts["--groups"]) && !opts["--all"]) opts["--integration"] = true;
// Tests make plain folders in the temp dir and register them as projects; inside a checkout each one
// would be that checkout, and promotions and coding worktrees would land in it (they once did, in
// Sova's own). The preload stops git's search at the temp dir; refusing first says so. Each runtime
// checks the dir its temp roots go in, before any test file runs.
function refuseTmpInRepo(tmpBase) {
  const enclosing = repoAround(tmpBase);
  if (!enclosing) return;
  console.error(`run-tests: the temp dir ${tmpBase} is inside the git repository ${enclosing}, where tests could commit, branch or add worktrees; run with a TMPDIR outside every repository (e.g. TMPDIR=/tmp pnpm test)`);
  process.exit(2);
}
const flags = rest.filter((a) => a.startsWith("-"));
const named = rest.filter((a) => !a.startsWith("-"));
const tiersAsked = opts["--all"] ? ["unit", "integration"] : opts["--integration"] ? ["integration"] : ["unit"];
let files = named.length
  ? named
  : [...new Set(GLOBS.flatMap((g) => fs.globSync(g, { cwd: ROOT })))].sort().filter((f) => tiersAsked.includes(isIntegration(f) ? "integration" : "unit"));
/** What --changed, --landing or --groups chose, for --plan: the groups run and those skipped. */
let picked = null;
if (opts["--changed"]) files = changedOnly(files, opts["--base"] ?? "master");
else if (opts["--landing"]) files = landingOnly(files, opts["--base"] ?? "master");
else if (opts["--groups"]) files = groupsOnly(files, groupNames);
if (opts["--plan"]) {
  // The selection, and what it should take: the recorded times of the files chosen over the tier's
  // lanes, never less than the longest one. Nothing runs.
  const recorded = readDurations(TIERS.integration.durations);
  const ms = (f) => (Number.isFinite(recorded[f]?.ms) ? recorded[f].ms : 0);
  const jobs = Math.max(1, TIERS.integration.jobs());
  const integ = files.filter(isIntegration);
  const sum = integ.reduce((n, f) => n + ms(f), 0);
  const longest = integ.reduce((n, f) => Math.max(n, ms(f)), 0);
  console.log(JSON.stringify({
    v: 1, files, groups: GROUPS.map(({ name, title, landing }) => ({ name, title, landing })), ran: picked?.ran ?? null, skipped: picked?.skipped ?? [], jobs,
    timed: integ.filter((f) => ms(f) > 0).length, estimateMs: Math.max(longest, Math.round(sum / jobs)), longestMs: longest,
  }));
  process.exit(0);
}
/** Per tier (unit first), its two passes: the main set, then the browser set. */
const sets = ["unit", "integration"].flatMap((tier) => {
  const mine = files.filter((f) => (isIntegration(f) ? "integration" : "unit") === tier);
  return [
    { tier, extra: [], files: mine.filter((f) => !isBrowserTest(f)) },
    { tier, extra: [BROWSER_CONDITION], files: mine.filter(isBrowserTest) },
  ];
}).filter((s) => s.files.length);
if (!sets.length) {
  console.log("run-tests: no test file to run.");
  process.exit(0);
}

/** `files` narrowed to those a change since `base` may break (scripts/test-changed.mjs). */
function changedOnly(files, base) {
  let changed;
  try {
    changed = changedSince(ROOT, base);
  } catch (err) {
    console.error(`run-tests: --changed: no merge base with ${base} (${String(err.stderr ?? err.message).trim().split("\n")[0]})`);
    process.exit(2);
  }
  const pick = selectFiles(files, changed, { mode: "changed", closure: (fs) => affected(ROOT, fs, changed) });
  say(`run-tests: --changed (${changed.length} file${changed.length === 1 ? "" : "s"} changed since the merge base with ${base}): ${pick.files.length} of ${files.length} test files.`);
  for (const name of pick.ran) say(`run-tests: added group ${name} (${titleOf(name)}): its triggers changed (${shortList(pick.hits[name])}).`);
  picked = pick;
  return pick.files;
}

/** `files` narrowed to what a landing runs: the everyday set, plus each group a landing runs that the change since `base` triggers. */
function landingOnly(files, base) {
  let changed;
  try {
    changed = changedSince(ROOT, base);
  } catch (err) {
    console.error(`run-tests: --landing: no merge base with ${base} (${String(err.stderr ?? err.message).trim().split("\n")[0]})`);
    process.exit(2);
  }
  const pick = selectFiles(files, changed, { mode: "landing" });
  const recorded = readDurations(TIERS.integration.durations);
  const secs = (name) => Math.round(files.filter((f) => groupOf(f)?.name === name).reduce((n, f) => n + (recorded[f]?.ms ?? 0), 0) / 1000);
  say(`run-tests: --landing (${changed.length} file${changed.length === 1 ? "" : "s"} changed since the merge base with ${base}): ${pick.files.length} of ${files.length} test files, the everyday set${pick.ran.map((n) => ` + ${titleOf(n)}`).join("")}.`);
  for (const name of pick.ran) say(`run-tests: running group ${name} (${titleOf(name)}): its triggers changed (${shortList(pick.hits[name])}).`);
  for (const s of pick.skipped) say(`run-tests: skipped group ${s.name} (${s.title}; ${s.files} files, ~${secs(s.name)} s recorded): ${s.why === "never" ? "never at landing" : "no change to its triggers"}.`);
  picked = pick;
  return pick.files;
}

/** `files` narrowed to the named groups' ("all": every group's). */
function groupsOnly(files, names) {
  const pick = selectFiles(files, [], { mode: "groups", only: names });
  say(`run-tests: --groups ${names.join(",")}: ${pick.files.length} of ${files.length} test files (${pick.ran.map(titleOf).join(", ")}).`);
  picked = pick;
  return pick.files;
}

function titleOf(name) {
  return GROUPS.find((g) => g.name === name)?.title ?? name;
}
function shortList(list) {
  return `${list.slice(0, 3).join(", ")}${list.length > 3 ? `, +${list.length - 3} more` : ""}`;
}
/** A selection line: on stdout, or stderr under --plan (whose stdout is the JSON alone). */
function say(line) {
  (opts["--plan"] ? console.error : console.log)(line);
}

// The temp dir every test file shares (server/test-ports.ts keeps its cross-process port locks there):
// this runner's own, before each runtime gives the files a throwaway TMPDIR. An outer runner's wins.
process.env.SOVA_TEST_SHARED_TMP ||= os.tmpdir();

// The chat processes a test's server starts (§app/chat-processes) run as units in a slice of this run's
// own, never the live sova-chats.slice, and the slice is stopped when the run ends (its exit, which the
// signal handlers reach too): a server stop leaves its chats running, by design, so nothing else would.
// An outer run's test slice is kept (a run inside a test); any other inherited slice is not. No dash in
// its name: systemd nests a dashed slice under parents (sova.slice, …) that would stay behind.
if (!/^sova_test_[A-Za-z0-9_]+\.slice$/.test(process.env.SOVA_CHAT_SLICE ?? "")) {
  const slice = `sova_test_${process.pid}_${randomBytes(3).toString("hex")}.slice`;
  process.env.SOVA_CHAT_SLICE = slice;
  process.on("exit", () => {
    // No user manager (macOS, a container): nothing to stop.
    spawnSync("systemctl", ["--user", "stop", slice], { stdio: "ignore", timeout: 60_000 });
  });
}

// No test reaches the installed Claude program, nor a paid model through it: every test process finds
// scripts/fake-claude.mjs first on its PATH as `claude` (§app.server-runtime/test-tiers). Code under
// test resolves the Claude program from PATH (claude-code/claude-executable.ts), and the inherited
// PATH holds the real one (/usr/local/bin, …): an in-process chat's topic-outline summary once ran
// it from a unit file. A test that needs another `claude` sets its own PATH. Returns the directory.
function fakeClaudeDir(parent) {
  const dir = path.join(parent, "fake-claude-bin");
  fs.mkdirSync(dir, { recursive: true });
  const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  fs.writeFileSync(path.join(dir, "claude"), `#!/bin/sh\nexec ${q(process.execPath)} ${q(path.join(ROOT, "scripts", "fake-claude.mjs"))} "$@"\n`, { mode: 0o755 });
  return dir;
}

if (runtime === "node") {
  // A pass still running after NODE_PASS_LIMIT_MS is stuck (seen: a file whose tests all reported
  // but whose process never exits, under heavy load): its whole process group is killed and the run
  // FAILS, never hangs. Not --test-force-exit: that ends a file before tests it registers after a
  // top-level await, so the run would pass with tests silently missing.
  // One short, symlink-free TMPDIR for the run, removed at exit (the signal handlers below exit
  // too), so temp dirs tests make and never remove don't pile up in /tmp. Short, because a unix
  // socket path has a limit (108 bytes on Linux, 104 on macOS). Symlink-free for macOS: its default
  // tmpdir (/var/folders/…) is reached through the /var -> /private/var symlink, so a path built from
  // tmpdir() differs from its realpath. (Bun: each file's TMPDIR is its throwaway root, hermeticEnv.)
  refuseTmpInRepo("/tmp");
  const tmp = fs.realpathSync(fs.mkdtempSync("/tmp/sova-t-"));
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = tmp;
  process.env.PATH = [fakeClaudeDir(tmp), process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  process.on("exit", () => {
    sweepDetachedChats(tmp);
    removeTree(tmp);
  });
  process.env.SOVA_TEST_GUARD_DIR = fs.mkdtempSync(path.join(tmp, "guard-"));
  const limitMs = Number(process.env.NODE_PASS_LIMIT_MS) || 15 * 60_000;
  let failed = false;
  for (const s of sets) {
    // node --test runs each file in its own process, as many at once as the tier's width.
    const width = flags.some((f) => f.startsWith("--test-concurrency")) ? [] : [`--test-concurrency=${Math.max(1, TIERS[s.tier].jobs())}`];
    const child = spawn("pnpm", ["exec", "tsx", ...s.extra, "--import", PRELOAD, "--import", GUARD, ...width, ...flags, "--test", ...s.files], { cwd: ROOT, stdio: "inherit", detached: true });
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
  const refused = guardReport(process.env.SOVA_TEST_GUARD_DIR);
  process.exit(failed || refused.length ? 1 : 0);
}

/** The tier guard's records from `dir` (one per test process), merged into AUDIT by file, and the unit
 *  files that did what that tier refuses listed; in enforce mode those are returned, as failures. */
function guardReport(dir) {
  const records = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      try { records.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))); } catch { /* a torn record */ }
    }
  } catch {
    return [];
  }
  const byFile = new Map();
  for (const r of records) {
    if (r?.v !== 1 || typeof r.file !== "string") continue;
    const into = byFile.get(r.file) ?? { tier: r.tier, acts: [], offences: [] };
    into.acts.push(...r.acts);
    into.offences.push(...r.offences);
    byFile.set(r.file, into);
  }
  try {
    let audit = {};
    try {
      const d = JSON.parse(fs.readFileSync(AUDIT, "utf8"));
      if (d?.v === 1 && d.files && typeof d.files === "object") audit = d.files;
    } catch { /* none yet */ }
    const at = new Date().toISOString();
    for (const [file, r] of byFile) audit[file] = { tier: r.tier, at, offences: [...new Set(r.offences)], acts: r.acts };
    for (const f of Object.keys(audit)) if (!fs.existsSync(path.resolve(ROOT, f))) delete audit[f];
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    const tmp = `${AUDIT}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, files: audit }, null, 1)}\n`);
    fs.renameSync(tmp, AUDIT);
  } catch (err) {
    console.error(`run-tests: could not record the tier audit in ${AUDIT}: ${err.message}`);
  }
  const offenders = [...byFile].filter(([, r]) => r.tier === "unit" && r.offences.length).sort(([a], [b]) => a.localeCompare(b));
  if (!offenders.length) return [];
  const enforce = (process.env.SOVA_TEST_GUARD || "enforce") === "enforce";
  console.log(`\ntier guard (${enforce ? "enforce" : "report"}): ${offenders.length} unit file${offenders.length === 1 ? "" : "s"} did what the unit tier refuses (each belongs in, or should split cases into, a .integration.test.ts sibling; details in ${path.relative(ROOT, AUDIT)}):`);
  for (const [file, r] of offenders) console.log(`  ${enforce ? "FAIL " : ""}${file}: ${[...new Set(r.offences)].slice(0, 4).join("; ")}${new Set(r.offences).size > 4 ? "; …" : ""}`);
  return enforce ? offenders.map(([f]) => f) : [];
}

// ─── Bun ────────────────────────────────────────────────────────────────────────────────────────
const found = resolveBun();
if ("missing" in found) {
  console.error(`run-tests: bun not found (${found.missing}); install it with mise, or run pnpm run test:node`);
  process.exit(2);
}
refuseTmpInRepo(os.tmpdir());
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
  // TMPDIR is the root itself, so the file's temp dirs go when it does; not a subdir of it, since
  // tests check the home is inside tmpdir(). Short, for socket path limits.
  const tmp = root;
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    SOVA_TEST_HOME: root,
    PATH: [fakeClaudeDir(root), path.dirname(process.execPath), misePaths, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    SOVA_PRICES_FETCH: "off",
    SOVA_GIT_MAINTENANCE: "off",
    // No per-server copy of the code (§app.chat-processes/code-generations): a server a test starts has
    // its state root here, on another filesystem than the checkout, where each copy is ~350 MB.
    SOVA_CHAT_CODE: "live",
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    // Git's repository search stops at the root and the temp dir above it (the preload sets the same).
    GIT_CEILING_DIRECTORIES: [fs.realpathSync(root), fs.realpathSync(path.dirname(root))].join(path.delimiter),
  };
  // The same list hermetic-env.mjs drops.
  for (const name of [
    "PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_SESSIONS_DIR", "CLAUDE_CONFIG_DIR", "SOVA_EXTENSIONS_FILE",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "SOVA_DEVICE_ID", "SOVA_MESH_IDENTITY", "SOVA_CLAUDE_ACCOUNTS_DEV",
    ...GIT_LOCATION_VARS,
  ]) delete env[name];
  return { root, env };
}

// The tier guard's records, one per file process; gathered after the run (guardReport).
const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), "sova-test-guard-"));
process.on("exit", () => removeTree(guardDir));
const enforce = (process.env.SOVA_TEST_GUARD || "enforce") === "enforce";

// Each file's bun runs in a process group of its own, killed whole: on FILE_LIMIT_MS, and when this
// runner stops (a signal, its exit, or its parent gone: a wrapper's timeout killing only the runner left
// a bun test running on, growing to ~100 GB). Its children (servers, workers a test starts) go with it.
// A runner killed by SIGKILL can do none of this: each file's process then ends its own group once its
// parent is no longer this runner (SOVA_TEST_RUNNER_PID, polled by test-tier-guard.mjs).
const fileGroups = new Set();
const killGroup = (pid) => {
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
};
let groupGuard = false;
function guardGroups() {
  if (groupGuard) return;
  groupGuard = true;
  const killAll = () => { for (const pid of fileGroups) killGroup(pid); };
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => { killAll(); process.exit(130); });
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) { killAll(); process.exit(1); } }, 2000).unref();
}

function runFile(file, extra) {
  guardGroups();
  const { root, env } = hermeticEnv();
  const target = file.startsWith("/") || file.startsWith("./") ? file : `./${file}`;
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(bun, ["test", "--preload", PRELOAD, "--preload", GUARD, ...extra, ...bunFlags, target], { cwd: ROOT, env: { ...env, SOVA_TEST_FILE: file, SOVA_TEST_GUARD_DIR: guardDir, SOVA_TEST_RUNNER_PID: String(process.pid) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (child.pid) fileGroups.add(child.pid);
    let out = "";
    // A file still running after FILE_LIMIT_MS is stuck (a hang, or tests done with a handle left
    // open): killed and reported as a failure, so one file never stalls the run.
    const limit = setTimeout(() => {
      out += `run-tests: ${file} still running after ${FILE_LIMIT_MS / 1000} s; killed\n`;
      killGroup(child.pid);
    }, FILE_LIMIT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => (out += `run-tests: could not start ${bun}: ${err.message}\n`));
    child.on("close", (code) => {
      clearTimeout(limit);
      fileGroups.delete(child.pid);
      const ms = Date.now() - started;
      sweepDetachedChats(root);
      removeTree(root);
      const count = (what) => Number(out.match(new RegExp(`^\\s*(\\d+) ${what}$`, "m"))?.[1] ?? 0);
      // Enforced, a unit file that did what its tier refuses fails, even when its test caught the refusal.
      let refused = [];
      if (enforce) {
        try { refused = JSON.parse(fs.readFileSync(path.join(guardDir, `${child.pid}.json`), "utf8")).offences ?? []; } catch { /* no record */ }
        if (refused.length) out += `run-tests: the tier guard refused, in a unit test file: ${[...new Set(refused)].join("; ")}\n`;
      }
      resolve({ file, code: code === 0 && refused.length ? 1 : (code ?? 1), out, ms, pass: count("pass"), fail: count("fail"), skip: count("skip") });
    });
  });
}

/** A tier's recorded wall times, `{ v: 1, files: { <file>: { ms, at } } }`; none or unreadable = {}. */
function readDurations(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return d?.v === 1 && d.files && typeof d.files === "object" ? d.files : {};
  } catch {
    return {};
  }
}

/** This run's times merged into the tier's file (re-read first: other runs may have written since),
 *  by atomic rename. Best effort: a read-only tree only loses the ordering. */
function writeDurations(file, results) {
  try {
    const files = readDurations(file);
    const at = new Date().toISOString();
    for (const r of results) files[r.file] = { ms: r.ms, at };
    // A deleted or renamed file's entry goes.
    for (const f of Object.keys(files)) if (!fs.existsSync(path.resolve(ROOT, f))) delete files[f];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, files })}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`run-tests: could not record durations in ${file}: ${err.message}`);
  }
}

const results = [];
const t0 = Date.now();
// Each tier asked for, unit first, at its own width and ordered by its own times.
for (const tier of ["unit", "integration"]) {
  const mine = sets.filter((s) => s.tier === tier);
  if (!mine.length) continue;
  const recorded = readDurations(TIERS[tier].durations);
  /** A file's expected wall time: its last recorded one, else a guess from KNOWN_SLOW (above every
   *  untimed file, in the list's order), else 0. */
  const expectedMs = (file) => {
    const ms = recorded[file]?.ms;
    if (Number.isFinite(ms)) return ms;
    const i = KNOWN_SLOW.findIndex((p) => (typeof p === "string" ? p === file : p.test(file)));
    return i < 0 ? 0 : 20_000 - i;
  };
  // Longest first across both passes (each entry keeps its pass's flags); ties keep their order.
  const queue = mine
    .flatMap((s) => s.files.map((f) => ({ file: f, extra: s.extra, expect: expectedMs(f) })))
    .sort((a, b) => b.expect - a.expect);
  const jobs = Math.max(1, TIERS[tier].jobs());
  const done = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      while (next < queue.length) {
        const { file, extra } = queue[next++];
        const r = await runFile(file, extra);
        done.push(r);
        // A passing file prints one line; a failing one, all of its output.
        if (r.code === 0) console.log(`ok   ${r.file} (${r.pass} pass${r.skip ? `, ${r.skip} skip` : ""})`);
        else console.log(`FAIL ${r.file} (exit ${r.code}, ${r.pass} pass, ${r.fail} fail)\n${r.out}`);
      }
    }),
  );
  writeDurations(TIERS[tier].durations, done);
  results.push(...done);
}
guardReport(guardDir);
const failed = results.filter((r) => r.code !== 0);
const sum = (k) => results.reduce((n, r) => n + r[k], 0);
if (results.length > 1) {
  console.log("\nslowest files:");
  for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, 10)) console.log(`  ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${r.file}`);
}
const tierNames = [...new Set(sets.map((s) => s.tier))].join(" + ");
console.log(`\nrun-tests (bun): ${results.length} files (${tierNames}), ${sum("pass")} pass, ${sum("fail")} fail, ${sum("skip")} skip, ${failed.length} failing files, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const r of failed) console.log(`  FAIL ${r.file}`);
process.exit(failed.length ? 1 : 0);
