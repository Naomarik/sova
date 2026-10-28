// Run: node --test .sova/playbooks/merge-round/tests/round.test.mjs
// The driver against a throwaway repository (a bare origin, a main checkout, one worktree per kind of
// branch), a temp agent dir, and fakes for pnpm, the spec tools, systemctl and the health endpoint.
// Nothing here reads or writes ~/.pi or the live tree. HOME is the throwaway root, and its path and
// basename are private names, as discover-names.mjs lists the real home's.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireLock, alsoUpdateNudges, durationShown, expectedTime, goAheadWord, areaGuides, dirtyPaths, expandArgs, failingTestFiles, globRe, groupOf, guideFrontMatter, hasScript, homeShown, intKey, landingAnswer, landingAnswerAt, needsRestart, ownerOf, parseBoard, parseLanding, shellPath, skippedShown, suiteOf, tempCommitOf, timeoutFor, touchesSpecReplay } from "../scripts/round.mjs";

const ROUND = fileURLToPath(new URL("../scripts/round.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PLANTED = "quokkahost7";
const OWNER = "0199aaaa-owner";
const ME = "0199bbbb-captain";

const root = mkdtempSync(join(tmpdir(), "round-test-"));
const bare = join(root, "origin.git");
const main = join(root, "main");
const agent = join(root, "agent");
const bin = join(root, "bin");
const core = join(root, "spec-core");
const pnpmLog = join(root, "pnpm.log");
const systemctlLog = join(root, "systemctl.log");
const settingsFile = join(agent, "sova", "merge-round.json");
const SETTINGS = { privateNames: [PLANTED, root, basename(root)], kinds: { [PLANTED]: "user", [root]: "home", [basename(root)]: "home" }, restartUnit: "sova-runtime.service" };
const stateFile = join(agent, "sova", "playbooks", "merge-round", "state.json");
const boardFile = join(agent, "sova", "merge-board.json");
/** Sova's merge board as the server writes it (server/merge-board.ts): rows [branch, state, owner, status, path?]. */
const writeBoard = (rows, { pending = 0, at = Date.now() } = {}) => {
  mkdirSync(dirname(boardFile), { recursive: true });
  const words = { "waiting-approval": "Waiting for your OK", ready: "Ready to merge" };
  const iso = new Date(at).toISOString();
  writeFileSync(boardFile, JSON.stringify({
    v: 1, at: iso, read: 10, pending,
    rows: rows.map(([branch, state, owner, status, path = wt(branch), landing]) => ({ path, branch, repo: join(main, ".git"), state, reason: `${words[state] ?? "In progress"} · reason`, ...(landing ? { landing } : {}), readAt: iso, owner: { id: owner, title: `Chat of ${owner}`, status, profile: null, lastActiveAt: iso } })),
  }));
};
const outputs = [];
/** Ready to land at the branch's current head (§chat.worktrees/ready-to-land), as the board says it. */
const landed = (branch, over = {}) => ({ state: "ready", commit: execFileSync("git", ["-C", main, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim(), ...over });

const gitEnv = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig") };
const baseEnv = () => {
  const env = { ...process.env, ...gitEnv, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOME: root, PI_CODING_AGENT_DIR: agent, PI_SESSION_ID: ME, SOVA_ROUND_PNPM: join(bin, "pnpm"), SOVA_ROUND_SPEC_CORE: core, SOVA_ROUND_HEALTH_URL: "http://127.0.0.1:9/api/health", FAKE_PNPM_LOG: pnpmLog, FAKE_MAIN: main, FAKE_PRUNE_LOG: join(root, "prune.log"), CLAUDE_CONFIG_DIR: join(root, "claude-login") };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  return env;
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: { ...process.env, ...gitEnv }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd, file, text, subject) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", "--", file);
  git(cwd, "commit", "-q", "-m", subject);
  return git(cwd, "rev-parse", "HEAD");
};
const wt = (name) => join(root, `wt-${name.replace(/\//g, "-")}`);
/** A git command that may fail (a merge expected to conflict). */
const spawnSyncGit = (cwd, args) => { try { execFileSync("git", args, { cwd, env: { ...process.env, ...gitEnv }, stdio: "ignore" }); } catch {} };

/** Runs round.mjs (or another script) asynchronously, so the test's own health server can answer. */
function run(args, { env = {}, input, script = ROUND, cwd = main } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...baseEnv(), ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      outputs.push(out);
      done({ code, out });
    });
    child.stdin.end(input ?? "");
  });
}
const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
const objectFiles = () => {
  const list = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : list.push(join(d, e.name)); };
  walk(join(main, ".git", "objects"));
  return list.sort();
};

before(() => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(core, { recursive: true });
  mkdirSync(join(agent, "sessions", "live"), { recursive: true });
  writeFileSync(join(root, "gitconfig"), "[user]\n\tname = Round Test\n\temail = round@test.invalid\n[init]\n\tdefaultBranch = master\n[commit]\n\tgpgsign = false\n");
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify({ args, cwd: process.cwd(), claude: "CLAUDE_CONFIG_DIR" in process.env }) + "\\n");
const mode = process.env.FAKE_PNPM_MODE || "pass";
if (args[0] === "test" && mode === "fail") {
  console.log("✖ server/new-fail.test.ts (3ms)");
  console.log("  test at server/pre-fail.test.ts:3:1");
  process.exit(1);
}
if (args[0] === "test" && mode === "flaky") {
  console.log("✖ server/new-fail.test.ts (3ms)");
  process.exit(1);
}
if (args[0] === "test:int" && mode === "int-fail") {
  console.log("FAIL server/new-int.integration.test.ts (exit 1, 0 pass, 1 fail)");
  console.log("  FAIL server/pre-fail.test.ts");
  process.exit(1);
}
if (args[0] === "exec" && args.includes("--plan")) {
  // The tree's runner asked what a landing runs (run-tests.mjs --landing --plan): FAKE_PLAN, else only the everyday set.
  console.error("run-tests: --landing (1 file changed since the merge base): 3 of 5 test files, the everyday set.");
  console.log(process.env.FAKE_PLAN || JSON.stringify({ v: 1, files: [], ran: [], skipped: [{ name: "trial", title: "Chat processes", why: "untriggered", files: 19 }, { name: "tours", title: "Tours", why: "never", files: 18 }], jobs: 8, estimateMs: 90000, longestMs: 40000 }));
  process.exit(0);
}
if (args[0] === "test" && mode === "hang") {
  const c = spawn("sleep", ["1000"], { stdio: "ignore" });
  fs.writeFileSync(process.env.FAKE_HANG_PID, String(c.pid));
  setInterval(() => {}, 1000);
} else if (args[0] === "exec") {
  // A file run alone: pre-fail fails everywhere; one FAKE_ALONE_FAIL names also fails alone in a worktree (never on master's checkout).
  const file = args.at(-1);
  const onMain = fs.realpathSync(process.cwd()) === fs.realpathSync(process.env.FAKE_MAIN);
  process.exit(file.includes("pre-fail") || (!onMain && (process.env.FAKE_ALONE_FAIL || "").split(",").includes(file)) ? 1 : 0);
}
else process.exit(0);
`);
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(systemctlLog)}\necho 0\n`);
  writeFileSync(join(bin, "systemd-run"), `#!/bin/sh\necho "systemd-run $@" >> ${JSON.stringify(systemctlLog)}\n`);
  for (const f of ["pnpm", "systemctl", "systemd-run"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(core, "sova-spec.mjs"), `import { existsSync, readFileSync } from "node:fs";
const c = process.argv[2];
const bad = process.env.FAKE_SPEC_BAD === "1";
// records: mixed when the tree holds both layouts' markers (claims/v1-marker and claims/v2-marker.json); broken when
// manifest.json isn't JSON; FAKE_RECORDS_GARBAGE=1 prints no JSON at all.
if (c === "records") {
  if (process.env.FAKE_RECORDS_GARBAGE === "1") { console.log("not json"); process.exit(2); }
  const spec = process.argv[process.argv.indexOf("--root") + 1] + "/.sova/spec";
  let readable = true;
  try { JSON.parse(readFileSync(spec + "/manifest.json", "utf8")); } catch { readable = false; }
  const mixed = existsSync(spec + "/claims/v1-marker") && existsSync(spec + "/claims/v2-marker.json");
  const findings = mixed ? [{ severity: "error", code: "layout-mixed", message: "holds records two ways; One command finishes it: sova-spec-draft.mjs migrate --write" }]
    : readable ? [] : [{ severity: "error", code: "manifest-unreadable", message: "manifest.json: not JSON" }];
  console.log(JSON.stringify({ exit: findings.length ? 2 : 0, findings }));
  process.exit(findings.length ? 2 : 0);
}
console.log(JSON.stringify(c === "census" ? { census: { unclaimed: bad ? ["src/x.ts"] : [] } } : { exit: bad ? 2 : 0 }));
if (bad && c === "check") process.exitCode = 2;
`);
  writeFileSync(join(core, "sova-spec-draft.mjs"), `import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const rootDir = a[a.indexOf("--root") + 1];
if (a[0] === "merge-manifest") {
  if (process.env.FAKE_MANIFEST_REFUSE === "1") { console.log(JSON.stringify({ exit: 1, conflicts: [{ key: "claims.§x", kind: "record" }] })); process.exit(1); }
  writeFileSync(rootDir + "/.sova/spec/manifest.json", '{"merged":true}\\n');
  // A tree holding both layouts' markers is finished into the per-area layout: the old layout's marker goes.
  if (existsSync(rootDir + "/.sova/spec/claims/v1-marker")) {
    rmSync(rootDir + "/.sova/spec/claims/v1-marker");
    console.log(JSON.stringify({ exit: 0, files: [".sova/spec/manifest.json", ".sova/spec/claims/v1-marker"] }));
  }
}
// FAKE_DRAFT_IDS: {draft: [ids not promoted]}; a draft it lists with none has one record already current;
// one it lists as "garbage" reads as unreadable; FAKE_DRAFTS_GARBAGE=1 makes the whole reading non-JSON.
const named = (n) => (process.env.FAKE_DRAFT_IDS ? JSON.parse(process.env.FAKE_DRAFT_IDS)[n] : undefined);
if (a[0] === "drafts") {
  if (process.env.FAKE_DRAFTS_GARBAGE === "1") { console.log("not json"); process.exit(1); }
  const dir = rootDir + "/.sova/spec/drafts";
  const names = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort() : [];
  const drafts = names.map((name) => {
    const n = named(name);
    if (n === "garbage") return { name, state: "unreadable", reasons: ["corrupt"], pending: [], conflict: [] };
    const pending = n ? n : process.env.FAKE_SPEC_BAD === "1" ? ["§a/b"] : [];
    return { name, state: pending.length ? "active" : "promoted", official: !pending.length, pending, conflict: [], current: n && !n.length ? ["§z/done"] : [] };
  });
  console.log(JSON.stringify({ exit: 0, drafts }));
}
// prune --official [--from DIR] [--write]: the drafts (or copies) FAKE_OFFICIAL names are official, deleted only with
// --write; FAKE_PRUNE_FAIL=1 fails, deleting nothing.
if (a[0] === "prune") {
  writeFileSync(process.env.FAKE_PRUNE_LOG, JSON.stringify(a) + "\\n", { flag: "a" });
  if (process.env.FAKE_PRUNE_FAIL === "1") { console.log("not json"); process.exit(2); }
  const from = a.includes("--from") ? a[a.indexOf("--from") + 1] : rootDir + "/.sova/spec/drafts";
  const write = a.includes("--write"), official = JSON.parse(process.env.FAKE_OFFICIAL || "[]");
  const hit = [], kept = [];
  for (const name of readdirSync(from).sort()) {
    if (official.includes(name)) { if (write) rmSync(from + "/" + name, { recursive: true, force: true }); hit.push({ name }); }
    else kept.push({ name, state: "pending", reasons: [] });
  }
  console.log(JSON.stringify({ exit: 0, deleted: write ? hit : [], wouldDelete: hit, kept }));
}
`);

  execFileSync("git", ["init", "-q", "--bare", "-b", "master", bare], { env: { ...process.env, ...gitEnv } });
  execFileSync("git", ["init", "-q", "-b", "master", main], { env: { ...process.env, ...gitEnv } });
  commit(main, "conflict.txt", "base\n", "base: conflict.txt");
  commit(main, ".sova/spec/manifest.json", '{"base":1}\n', "base: manifest");
  commit(main, "server/pre-fail.test.ts", "// fails on master too\n", "base: a test");
  git(main, "remote", "add", "origin", bare);
  git(main, "push", "-q", "origin", "master");
  git(main, "fetch", "-q", "origin");

  const branch = (name, file, text, subject) => {
    git(main, "worktree", "add", "-q", wt(name), "-b", name);
    commit(wt(name), file, text, subject);
  };
  branch("feat/clean", "server/clean.ts", "export const x = 1;\n", "clean: a server file");
  branch("feat/temp", "a.txt", "a\n", "TEMP: trying something");
  branch("feat/firstrun", "b.txt", "b\n", "firstrun: b");
  mkdirSync(join(wt("feat/firstrun"), "pi-config/extensions/sandbox/tests"), { recursive: true });
  writeFileSync(join(wt("feat/firstrun"), "pi-config/extensions/sandbox/tests/FIRST-RUN.txt"), "sandbox output\n");
  branch("feat/dirty", "c.txt", "c\n", "dirty: c");
  writeFileSync(join(wt("feat/dirty"), "junk.txt"), "uncommitted\n");
  branch("feat/conflict", "conflict.txt", "branch\n", "conflict: edit");
  branch("feat/manifest", ".sova/spec/manifest.json", '{"branch":1}\n', "manifest: edit");
  branch("feat/slow", "e.txt", "e\n", "slow: e");
  branch(`feat/${PLANTED}-notes`, "d.txt", "d\n", "notes");
  commit(main, "conflict.txt", "master\n", "master: conflict.txt");
  commit(main, ".sova/spec/manifest.json", '{"master":1}\n', "master: manifest");
  git(main, "push", "-q", "origin", "master");
});

after(() => {
  // No output and no stored state ever holds the planted name.
  for (const out of outputs) assert.ok(!out.toLowerCase().includes(PLANTED), `output leaked the planted name:\n${out}`);
  if (existsSync(stateFile)) assert.ok(!readFileSync(stateFile, "utf8").includes(PLANTED), "the state file holds the planted name");
  // Nothing ever ran a restart.
  const calls = existsSync(systemctlLog) ? readFileSync(systemctlLog, "utf8") : "";
  assert.ok(!/restart|systemd-run/.test(calls), `a restart was run: ${calls}`);
  rmSync(root, { recursive: true, force: true });
});

test("pure rules: temporary subjects, restart files, dirty paths, timeouts", () => {
  assert.equal(tempCommitOf(["fine", "WIP: x", "TEMP"]), "WIP: x");
  assert.equal(tempCommitOf(["amend! x"]), "amend! x");
  assert.equal(tempCommitOf(["template work"]), undefined);
  assert.ok(needsRestart("server/a.ts") && !needsRestart("server/a.test.ts") && !needsRestart("src/a.ts") && needsRestart("pnpm-lock.yaml"));
  assert.deepEqual(dirtyPaths(" M a.ts\0?? pi-config/extensions/sandbox/tests/FIRST-RUN.txt\0R  new.ts\0old.ts\0?? pi-config/extensions/sandbox/tests/NAIVE-RUN.txt\0"), ["a.ts", "new.ts"]);
  assert.equal(timeoutFor(1000, []), 1000);
  assert.equal(timeoutFor(1000, [800, 900, 4000]), 1800);
  assert.equal(homeShown("/h/u/w/x and /h/u, not /h/us or /x/h/u", "/h/u"), "~/w/x and ~, not /h/us or /x/h/u");
  assert.equal(shellPath("/h/u/w/it's", "/h/u"), `"$HOME"'/w/it'\\''s'`);
  assert.equal(shellPath("/srv/w", "/h/u"), "'/srv/w'");
  assert.deepEqual(failingTestFiles("✖ server/a.test.ts (3ms)\n  test at file:///r/src/lib/b.test.ts:1:2\n  test at /elsewhere/c.test.ts:1:1", "/r"), ["server/a.test.ts", "src/lib/b.test.ts"]);
  // scripts/run-tests.mjs on Bun: each failing file's FAIL line, then the summary's list.
  const bun = "ok   server/ok.test.ts (3 pass)\nFAIL server/sync/logins.test.ts (exit 1, 20 pass, 1 fail)\nerror: FAIL inside output.test.ts\n\nrun-tests (bun): 2 files\n  FAIL server/sync/logins.test.ts\n  FAIL src/lib/x.test.tsx";
  assert.deepEqual(failingTestFiles(bun, "/r"), ["server/sync/logins.test.ts", "src/lib/x.test.tsx"]);
});

test("suiteOf reads an extension's line from pi-config/README.md, and globs expand without a shell", () => {
  const readme = readFileSync(join(REPO_ROOT, "pi-config", "README.md"), "utf8");
  const s = suiteOf(readme, "spec");
  assert.equal(s.dir, "extensions/spec");
  assert.deepEqual(s.commands, [["node", "--test", "--test-concurrency=4", "tests/*.test.mjs"]]);
  assert.equal(suiteOf(readme, "no-such-extension"), null);
  const cwd = join(REPO_ROOT, "pi-config", "extensions", "spec");
  const expanded = expandArgs(s.commands[0], cwd);
  assert.ok(expanded.length > 3 && expanded.slice(3).every((f) => /^tests\/[^/]+\.test\.mjs$/.test(f)));
});

test("start without settings turns the push hold on, and push refuses under it", async () => {
  const s = await run(["start"]);
  assert.equal(s.code, 1, s.out);
  assert.match(s.out, /First round/);
  assert.match(s.out, /Push hold: on/);
  const before = git(bare, "rev-parse", "master");
  commit(main, "pushme.txt", "x\n", "master: something to push");
  const p = await run(["push"]);
  assert.equal(p.code, 1, p.out);
  assert.match(p.out, /Push hold/);
  assert.equal(git(bare, "rev-parse", "master"), before);
  assert.equal((statSync(stateFile).mode & 0o777).toString(8), "600");
});

test("status without the board: git facts, owners unknown and why, exit 2", async () => {
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(SETTINGS, null, 2));
  rmSync(boardFile, { force: true });
  const r = await run(["status"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out.split("\n")[0], /^Owners unknown: the merge board file is missing/);
  assert.match(r.out, /^feat\/clean: readiness unknown · owner unknown · \+1\/-\d+ · clean · merges cleanly/m);
  assert.match(r.out, /next: say owners are unknown and why; land nothing this round/);
  writeBoard([], { at: Date.now() - 6 * 60_000 });
  const stale = await run(["status"]);
  assert.equal(stale.code, 2, stale.out);
  assert.match(stale.out, /^Owners unknown: the merge board was written 6m ago/);
  writeFileSync(boardFile, "{not json");
  assert.match((await run(["status"])).out, /^Owners unknown: the merge board file isn't valid JSON/);
});

test("status: the whole board sorted by the next action, counts first, owners from the board", async () => {
  writeBoard([
    ["feat/clean", "waiting-approval", OWNER, "idle", undefined, landed("feat/clean")],
    ["feat/firstrun", "ready", "0199cccc-busy", "busy", undefined, landed("feat/firstrun")],
    ["feat/dirty", "ready", "0199dddd-archived", "archived"],
    ["feat/temp", "in-progress", "0199eeee-temp", "idle"],
    ["feat/slow", "ready", "0199ffff-elsewhere", "idle", join(root, "not-a-worktree")],
    ["feat/manifest", "ready", "0199ffff-moved", "idle", wt("feat/conflict")],
  ]);
  const objects = objectFiles();
  const r = await run(["status"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(objectFiles(), objects, "merge-tree wrote into the shared object store");
  const out = r.out.split("\n");
  assert.match(out[0], /^Merge board \(written \d+s ago\): 0 to check · 0 to land · 1 to queue now · 0 card shown · 1 owner busy · 1 owner archived · 4 no session tracks · 0 owner unknown · 1 not ready\.$/);
  const at = (re) => out.findIndex((l) => re.test(l));
  assert.ok(at(/^== Ready to land, owner idle: queue it \(Sova shows the Landing card\) \(1\)$/) === at(/^feat\/clean: /) - 1, "under its group's head");
  const order = ["feat/clean", "feat/firstrun", "feat/dirty", "feat/conflict", "feat/temp"].map((b) => at(new RegExp(`^${b}: `)));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "ask, busy, archived, untracked, not ready");
  const line = (b) => out.find((l) => l.startsWith(`${b}:`)) ?? "";
  assert.ok(line("feat/clean").startsWith(`feat/clean: Waiting for your OK · reason · owner ${OWNER} idle (board, `), line("feat/clean"));
  assert.match(line("feat/clean"), /\+1\/-\d+ · clean · merges cleanly .* · landing needs a restart$/);
  assert.match(line("feat/dirty"), /owner 0199dddd-archived archived/);
  assert.match(line("feat/conflict"), /no readiness on the board · no session tracks this worktree/, "a row for its path on another branch is not its row");
  assert.match(line("feat/slow"), /no session tracks this worktree/, "a row outside this repository's worktrees is ignored");
  assert.match(line("feat/temp"), /temporary commit: "TEMP: trying something"/);
  assert.match(line("feat/firstrun"), / · clean · /);
  assert.match(line("feat/dirty"), /1 uncommitted \(junk\.txt\)/);
  assert.match(line("feat/conflict"), /conflicts with master in 1 file/);
  assert.match(line("feat/manifest"), /conflicts with master in 1 file/);
  assert.match(r.out, /next: round\.mjs ask feat\/clean \(Ready to land: queues it, and Sova shows its owner the Landing card\)/);
  assert.equal(state().branches["feat/clean"].board.owner, OWNER, "the board's owner is recorded");
  // While Sova hasn't read every session, a worktree with no row is unknown, never untracked.
  writeBoard([["feat/clean", "waiting-approval", OWNER, "idle"]], { pending: 7 });
  const partial = await run(["status"]);
  assert.match(partial.out.split("\n")[0], /, 7 sessions not read yet\): .* 0 no session tracks · \d+ owner unknown/);
  assert.match(partial.out, /^feat\/conflict: no readiness on the board · owner unknown: Sova hasn't read 7 sessions yet/m);
  rmSync(boardFile, { force: true });
  assert.match(line("feat/temp"), /temporary commit: "TEMP: trying something"/);
  assert.match(line("feat/firstrun"), / · clean · /);
  assert.match(line("feat/dirty"), /1 uncommitted \(junk\.txt\)/);
  assert.match(line("feat/conflict"), /conflicts with master in 1 file/);
  assert.match(line("feat/manifest"), /conflicts with master in 1 file/);
  assert.match(r.out, /feat\/\[private name\]-notes: /);
  assert.match(r.out, /Main checkout: on master, 0 uncommitted, \+1\/-0 vs origin\/master/);
  writeBoard([["feat/clean", "waiting-approval", OWNER, "idle", undefined, landed("feat/clean")]]);
  const j = await run(["status", "--json"]);
  const parsed = JSON.parse(j.out);
  assert.deepEqual([parsed.branches.find((b) => b.branch === "feat/clean").group, parsed.branches.find((b) => b.branch === "feat/temp").group], ["ask", "untracked"]);
  rmSync(boardFile, { force: true });
});

test("note and ask: never a busy owner; ask only queues a branch Ready to land", async () => {
  assert.equal((await run(["note", "feat/clean", `owner=${OWNER}`, "idle=no"])).code, 0);
  const busy = await run(["ask", "feat/clean"]);
  assert.equal(busy.code, 1);
  assert.match(busy.out, /busy/);
  assert.equal((await run(["note", "feat/clean", `owner=${OWNER}`, "idle=yes"])).code, 0);
  for (const extra of ["source=user", "chip=ready"]) assert.equal((await run(["note", "feat/clean", `owner=${OWNER}`, "idle=yes", extra])).code, 2, `${extra} is not a note field`);
  assert.equal((await run(["ask", "feat/clean", "topic=merge-k7m4qz"])).code, 2, "ask takes no topic: no owner is asked in words");
  const none = await run(["ask", "feat/clean"]);
  assert.equal(none.code, 1, none.out);
  assert.match(none.out, /isn't Ready to land at [0-9a-f]{7}: nothing to queue/);
  assert.equal(state().branches["feat/clean"].ask, undefined);
});

test("check refuses a temporary commit and uncommitted files, and stops on a conflict", async () => {
  const temp = await run(["check", "feat/temp"]);
  assert.equal(temp.code, 1);
  assert.match(temp.out, /temporary commit/);
  const dirty = await run(["check", "feat/dirty"]);
  assert.equal(dirty.code, 1);
  assert.match(dirty.out, /1 uncommitted file \(junk\.txt\)/);
  const master = git(main, "rev-parse", "master");
  const conflict = await run(["check", "feat/conflict"]);
  assert.equal(conflict.code, 1, conflict.out);
  assert.match(conflict.out, /conflicts in 1 file: conflict\.txt/);
  assert.ok(existsSync(join(main, ".git", "worktrees", "wt-feat-conflict", "MERGE_HEAD")), "the conflict was not left for the captain");
  assert.equal(git(main, "rev-parse", "master"), master, "check wrote to master");
});

test("check: a manifest-only conflict goes through merge-manifest, then the checks run", async () => {
  const masterBefore = git(main, "rev-parse", "master");
  const r = await run(["check", "feat/manifest"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /merge-manifest --write/);
  assert.match(r.out, /landable at [0-9a-f]{7}/);
  assert.equal(readFileSync(join(wt("feat/manifest"), ".sova/spec/manifest.json"), "utf8"), '{"merged":true}\n');
  assert.equal(git(main, "rev-parse", "master"), masterBefore, "check wrote to master");
});

test("check: a failing spec check and unclaimed files hold nothing; a draft not promoted holds the branch and hands it back", async () => {
  const exclude = join(main, ".git", "info", "exclude");
  const was = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  writeFileSync(exclude, `${was}.sova/spec/drafts/\n`);
  mkdirSync(join(wt("feat/manifest"), ".sova", "spec", "drafts", "left"), { recursive: true });
  try {
    const r = await run(["check", "feat/manifest"], { env: { FAKE_SPEC_BAD: "1" } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^spec check: ERRORS\.$/m);
    assert.match(r.out, /^spec census: 1 unclaimed \(src\/x\.ts\)\.$/m);
    assert.match(r.out, /^draft left: not promoted: §a\/b\.$/m);
    assert.match(r.out, /^needs: docs not promoted: left$/m, "the draft is the only need: the spec check and census hold nothing");
    // Owner gone (none recorded): the hand-back is the user's call, and the branch can't land with its docs missing.
    assert.match(r.out, /^Hand-back, for its owner \(none known: the user's call\):$/m);
    assert.match(r.out, /^feat\/manifest isn't landing yet: its docs aren't official\. Your spec drafts aren't promoted: left \(§a\/b\)\. Promote them on feat\/manifest and commit that/m);
    const land = await run(["land", "feat/manifest"]);
    assert.equal(land.code, 1, land.out);
    assert.match(land.out, /needs: docs not promoted: left/);
    assert.doesNotMatch(land.out, /call: worktree/);
    // Promoted (the draft confirmed promoted): the same spec errors and unclaimed files land.
    const promoted = await run(["check", "feat/manifest"], { env: { FAKE_SPEC_BAD: "1", FAKE_DRAFT_IDS: JSON.stringify({ left: [] }) } });
    assert.equal(promoted.code, 0, promoted.out);
    assert.match(promoted.out, /^draft left: promoted\.$/m);
    assert.match(promoted.out, /landable at [0-9a-f]{7}/);
    assert.doesNotMatch(promoted.out, /needs:|Hand-back/);
  } finally {
    rmSync(join(wt("feat/manifest"), ".sova", "spec", "drafts"), { recursive: true, force: true });
    writeFileSync(exclude, was);
  }
});

test("check: a test file failing in the full run but passing alone is flaky and holds nothing", async () => {
  writeFileSync(pnpmLog, "");
  const r = await run(["check", "feat/clean"], { env: { FAKE_PNPM_MODE: "flaky" } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^  failing files: server\/new-fail\.test\.ts \(flaky: passes alone\)\.$/m);
  assert.match(r.out, /^Flaky \(failed in the full run, passed alone; not blocking\): server\/new-fail\.test\.ts\.$/m);
  assert.match(r.out, /^landable at [0-9a-f]{7}$/m);
  assert.deepEqual(state().branches["feat/clean"].check.flaky, ["server/new-fail.test.ts"]);
  const calls = readFileSync(pnpmLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const testCall = calls.find((c) => c.args[0] === "test");
  assert.equal(testCall.claude, false, "pnpm test runs without CLAUDE_CONFIG_DIR");
  assert.equal(testCall.cwd, wt("feat/clean"));
  // Rerun on its own in the branch's worktree, with the same runner and runtime (Bun unless SOVA_RUNTIME=node); never on master.
  const reruns = calls.filter((c) => c.args[0] === "exec");
  assert.deepEqual(reruns.map((c) => [c.cwd, c.args]), [[wt("feat/clean"), ["exec", "node", "scripts/run-tests.mjs", "--runtime", process.env.SOVA_RUNTIME === "node" ? "node" : "bun", "server/new-fail.test.ts"]]]);
});

test("check: a file failing alone holds the branch only when it passes on master; one failing on master too is pre-existing", async () => {
  writeFileSync(pnpmLog, "");
  const r = await run(["check", "feat/clean"], { env: { FAKE_PNPM_MODE: "fail", FAKE_ALONE_FAIL: "server/new-fail.test.ts" } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^needs: new test failure: server\/new-fail\.test\.ts$/m);
  assert.match(r.out, /server\/new-fail\.test\.ts \(fails alone; passes on master\), server\/pre-fail\.test\.ts \(fails alone; pre-existing: also fails on master\)/);
  assert.match(r.out, /^Pre-existing on master \(not blocking\): server\/pre-fail\.test\.ts\.$/m);
  assert.deepEqual(state().branches["feat/clean"].check.preexisting, ["server/pre-fail.test.ts"]);
  assert.doesNotMatch(r.out, /^Flaky/m);
  const calls = readFileSync(pnpmLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.args[0] === "exec");
  const runtime = process.env.SOVA_RUNTIME === "node" ? "node" : "bun";
  assert.deepEqual(calls.filter((c) => c.cwd === wt("feat/clean")).map((c) => c.args.at(-1)), ["server/new-fail.test.ts", "server/pre-fail.test.ts"], "each alone in the worktree first");
  // master's runs are cached per (master, file); the first check of this master runs both there.
  for (const c of calls) assert.deepEqual(c.args.slice(0, 5), ["exec", "node", "scripts/run-tests.mjs", "--runtime", runtime]);
  // One flaky, one pre-existing: neither holds the branch.
  const mixed = await run(["check", "feat/clean"], { env: { FAKE_PNPM_MODE: "fail" } });
  assert.equal(mixed.code, 0, mixed.out);
  assert.match(mixed.out, /^Pre-existing on master \(not blocking\): server\/pre-fail\.test\.ts\.$/m);
  assert.match(mixed.out, /^Flaky \(failed in the full run, passed alone; not blocking\): server\/new-fail\.test\.ts\.$/m);
  assert.match(mixed.out, /^landable at [0-9a-f]{7}$/m);
});

test("check runs pnpm test:int after pnpm test, with the same alone-then-master rule; a tree without the script skips it", async () => {
  writeFileSync(pnpmLog, "");
  const skipped = await run(["check", "feat/clean"]);
  assert.match(skipped.out, /pnpm test:int: skipped \(this tree's package\.json has no test:int script\)\./);
  assert.ok(!readFileSync(pnpmLog, "utf8").includes('"test:int"'), "ran test:int in a tree without the script");

  git(main, "worktree", "add", "-q", wt("feat/int"), "-b", "feat/int");
  commit(wt("feat/int"), "package.json", `${JSON.stringify({ scripts: { test: "x", "test:int": "y" } })}\n`, "int: the tiers' scripts");
  writeFileSync(pnpmLog, "");
  const r = await run(["check", "feat/int"], { env: { FAKE_PNPM_MODE: "int-fail", FAKE_ALONE_FAIL: "server/new-int.integration.test.ts" } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^pnpm test: ok, \d+s\.$/m);
  assert.match(r.out, /^pnpm test:int: FAILED \(exit 1\), \d+s\.$/m);
  assert.match(r.out, /needs: new test failure: server\/new-int\.integration\.test\.ts$/m);
  assert.match(r.out, /Pre-existing on master \(not blocking\): server\/pre-fail\.test\.ts/);
  const calls = readFileSync(pnpmLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const order = calls.map((c) => c.args[0]).filter((a) => a === "test" || a === "test:int");
  assert.deepEqual(order, ["test", "test:int"]);
  const intCall = calls.find((c) => c.args[0] === "test:int");
  assert.equal(intCall.claude, false);
  assert.equal(intCall.cwd, wt("feat/int"));
});

test("check groups and time: pure rules for the expected time, the timings key per group set and the skipped wording", () => {
  assert.equal(durationShown(45_000), "45s");
  assert.equal(durationShown(200_000), "3m 20s");
  assert.equal(durationShown(3_900_000), "1h 5m");
  assert.equal(intKey({ full: true, ran: [] }), "test-int");
  assert.equal(intKey({ ran: [] }), "test-int:core");
  assert.equal(intKey({ ran: ["trial"] }), "test-int:core+trial");
  assert.deepEqual(skippedShown([{ name: "trial", title: "Chat processes", why: "untriggered" }, { name: "tours", title: "Tours", why: "never" }]), ["Skipped: Chat processes (no change to its areas)", "Not run at landing: Tours"]);
  assert.deepEqual(skippedShown([]), []);
  // 8 everyday-only runs and 1 full one: each set is estimated from its own runs, never the other's.
  const timings = { "test-int:core": Array(8).fill(100_000), "test-int": [400_000] };
  const step = (key, fallbackMs) => [{ label: "int", key, floorMs: 1000, fallbackMs }];
  assert.equal(expectedTime(step("test-int"), timings).expectedMs, 400_000);
  assert.equal(expectedTime(step("test-int:core"), timings).expectedMs, 100_000);
  // A set never run takes the runner's estimate, and says so; with none it is unknown.
  const fresh = expectedTime(step("test-int:core+trial", 250_000), timings);
  assert.equal(fresh.expectedMs, 250_000);
  assert.deepEqual(fresh.parts, ["int 4m 10s from recorded file times"]);
  assert.deepEqual(expectedTime(step("test-int:core+trial"), timings).unknown, ["int"]);
  assert.equal(expectedTime(step("test-int"), timings).limitMs, 800_000, "the limit is the step's timeout");
});

test("check runs the integration tests a landing runs, names what it skipped, and keeps their timings per group set; full runs everything", async () => {
  git(main, "worktree", "add", "-q", wt("feat/groups"), "-b", "feat/groups");
  commit(wt("feat/groups"), "package.json", `${JSON.stringify({ scripts: { test: "x", "test:int": "y" } })}\n`, "groups: the tiers' scripts");
  commit(wt("feat/groups"), "scripts/test-groups.mjs", "export const GROUPS = [];\n", "groups: a tree with test groups");
  commit(wt("feat/groups"), ".gitignore", ".cache/\n", "groups: the runner's cache is ignored");
  // Seeded: 8 everyday-only runs at 100 s and one full run at 400 s.
  const st = state();
  st.timings["test-int:core"] = Array(8).fill(100_000);
  st.timings["test-int"] = [400_000];
  writeFileSync(stateFile, JSON.stringify(st));
  writeFileSync(pnpmLog, "");
  const r = await run(["check", "feat/groups"]);
  assert.equal(r.code, 0, r.out);
  const master = git(main, "rev-parse", "master");
  const calls = readFileSync(pnpmLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(calls.find((c) => c.args.includes("--plan"))?.args, ["exec", "node", "scripts/run-tests.mjs", "--integration", "--landing", "--base", master, "--plan"]);
  assert.deepEqual(calls.find((c) => c.args[0] === "test:int")?.args, ["test:int", "--", "--landing", "--base", master]);
  // The expected time comes first, from the everyday set's own runs, never the full run's.
  const expected = r.out.split("\n").findIndex((l) => l.startsWith("Expected: about "));
  assert.ok(expected >= 0 && expected < r.out.split("\n").findIndex((l) => l.startsWith("typecheck: ")), r.out);
  assert.match(r.out, /^Expected: about .*pnpm test:int \(everyday set\) 1m 40s.*Time limit: .* \(\d+ s, the steps' timeouts\)/m);
  assert.match(r.out, /^Skipped: Chat processes \(no change to its areas\)\.$/m);
  assert.match(r.out, /^Not run at landing: Tours\.$/m);
  const rec = state().branches["feat/groups"].check;
  assert.deepEqual(rec.skipped.map((s) => s.name), ["trial", "tours"]);
  assert.equal(rec.full, false);
  assert.equal(state().timings["test-int:core"].length, 9, "the run is kept under its group set's key");
  assert.deepEqual(state().timings["test-int"], [400_000], "the full tier's key is left alone");
  const report = await run(["report"]);
  assert.match(report.out, /feat\/groups landable \(Skipped: Chat processes \(no change to its areas\); Not run at landing: Tours\)/);

  // A full run for one check: the whole tier, its own estimate, and it says so.
  writeFileSync(pnpmLog, "");
  const f = await run(["check", "feat/groups", "full"]);
  assert.equal(f.code, 0, f.out);
  assert.match(f.out, /^Expected: about .*pnpm test:int \(full run\) 6m 40s/m, "a full run is estimated from full runs");
  assert.match(f.out, /^Integration tests: full run \(every group\)\.$/m);
  assert.doesNotMatch(f.out, /^Skipped: /m);
  const fullCalls = readFileSync(pnpmLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(fullCalls.find((c) => c.args[0] === "test:int")?.args, ["test:int"]);
  assert.ok(!fullCalls.some((c) => c.args.includes("--plan")), "a full run plans nothing");
  assert.equal(state().branches["feat/groups"].check.full, true);
  assert.match((await run(["report"])).out, /feat\/groups landable \(full run\)/);
  assert.equal((await run(["check", "feat/groups", "everything"])).code, 2, "an unknown word is refused");

  // Globally until told otherwise.
  assert.match((await run(["full", "on"])).out, /Full runs on/);
  assert.match((await run(["check", "feat/groups"])).out, /^Integration tests: full run \(every group\)\.$/m);
  assert.match((await run(["full", "off"])).out, /Full runs off/);
  assert.match((await run(["check", "feat/groups"])).out, /^Not run at landing: Tours\.$/m);
  assert.equal((await run(["full", "maybe"])).code, 2);
});

test("check: a group set never run takes the runner's estimate; a failing file's rerun says what it adds first; new fixed waits are a note, never a need", async () => {
  // A ran group listed as skipped too (a confused runner) is never named skipped.
  const plan = JSON.stringify({ v: 1, files: [], ran: ["trial"], skipped: [{ name: "trial", title: "Chat processes", why: "untriggered", files: 19 }, { name: "tours", title: "Tours", why: "never", files: 18 }], jobs: 8, estimateMs: 250_000, longestMs: 200_000 });
  mkdirSync(join(wt("feat/groups"), ".cache"), { recursive: true });
  writeFileSync(join(wt("feat/groups"), ".cache", "test-durations-integration.json"), JSON.stringify({ v: 1, files: { "server/new-int.integration.test.ts": { ms: 200_000 } } }));
  const r = await run(["check", "feat/groups"], { env: { FAKE_PLAN: plan, FAKE_PNPM_MODE: "int-fail", FAKE_ALONE_FAIL: "server/new-int.integration.test.ts" } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^Expected: about .*pnpm test:int \(everyday set \+ Chat processes\) 4m 10s from recorded file times/m);
  assert.doesNotMatch(r.out, /^Skipped: /m, "a group that ran isn't named skipped");
  assert.match(r.out, /^Not run at landing: Tours\.$/m);
  const out = r.out.split("\n");
  const said = out.findIndex((l) => l.startsWith("Rerunning server/new-int.integration.test.ts on its own: adds about 3m 20s, at most "));
  assert.ok(said >= 0, r.out);
  assert.match(r.out, /^Rerunning server\/pre-fail\.test\.ts on its own: adds an unknown time \(none recorded\)/m);
  // A file master doesn't have is new without a run there, so no line says it runs on master.
  assert.doesNotMatch(r.out, /^Running server\/new-int\.integration\.test\.ts on master/m);
  assert.ok(said < out.findIndex((l) => l.startsWith("  failing files: ")), "said before the digest");
  assert.ok(state().timings["test-int:core+trial"] === undefined, "a failing run records no timing");

  // The fixed-wait note, from the branch's own scanner.
  commit(wt("feat/groups"), "scripts/fixed-wait-scan.mjs", `const a = process.argv;\nif (a[a.indexOf("--base") + 1].length < 7 || !a.includes("--json")) process.exit(3);\nconsole.log(JSON.stringify({ waits: [{ file: "server/x.integration.test.ts", line: 12, ms: 6000 }, { file: "server/y.test.ts", line: 3, ms: 1500 }] }));\n`, "groups: a fixed-wait scanner");
  const n = await run(["check", "feat/groups"]);
  assert.equal(n.code, 0, n.out);
  assert.match(n.out, /^fixed waits: 1 new fixed wait over 2 s in changed tests: server\/x\.integration\.test\.ts:12 \(6 s\)\. Ask the owner to wait on a condition instead \(not blocking\)\.$/m);
  assert.match(n.out, /^landable at [0-9a-f]{7}$/m);
});

test("check --background: a detached check with a log, its expected time echoed; wait blocks until it ends and prints its digest", async () => {
  assert.equal((await run(["wait", "feat/groups"])).code, 2, "no background check yet");
  const b = await run(["check", "feat/groups", "--background"]);
  assert.equal(b.code, 0, b.out);
  const m = /^Background check of feat\/groups started: pid (\d+), log (\S+)\.$/m.exec(b.out);
  assert.ok(m, b.out);
  assert.match(b.out, /^Expected: about /m);
  assert.match(b.out, /next: wake at the expected time, then round\.mjs wait feat\/groups/);
  const w = await run(["wait", "feat/groups", "--timeout", "120"], { env: { SOVA_ROUND_WAIT_POLL_MS: "100" } });
  assert.equal(w.code, 0, w.out);
  assert.match(w.out, /^The background check of feat\/groups ended .* \(exit 0\):$/m);
  assert.match(w.out, /^landable at [0-9a-f]{7}$/m);
  assert.match(w.out, /^Expected: about /m, "the log holds the whole output");
  const rec = JSON.parse(readFileSync(join(agent, "sova", "playbooks", "merge-round", "background", "feat_groups.json"), "utf8"));
  assert.equal(rec.exit, 0);
  assert.ok(rec.expectedMs >= 0 && rec.limitMs > 0, JSON.stringify(rec));
  assert.equal((await run(["wait", "feat/groups", "--timeout", "x"])).code, 2);
});

test("hasScript: a package.json script by name; none, or unreadable, is no", () => {
  const dir = mkdtempSync(join(root, "pkg-"));
  assert.equal(hasScript(dir, "test:int"), false);
  writeFileSync(join(dir, "package.json"), "{not json");
  assert.equal(hasScript(dir, "test:int"), false);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "a", "test:int": "b" } }));
  assert.equal(hasScript(dir, "test:int"), true);
  assert.equal(hasScript(dir, "test:all"), false);
});

test("touchesSpecReplay: the spec core, its replay tests and spec-guard only", () => {
  for (const f of ["pi-config/extensions/spec/core/sova-spec.mjs", "pi-config/extensions/spec/tests/replay/replay.test.mjs", "pi-config/extensions/mode/spec-guard.ts"]) assert.ok(touchesSpecReplay(f), f);
  for (const f of ["pi-config/extensions/spec/tests/core.test.mjs", "pi-config/extensions/spec/README.md", "pi-config/extensions/mode/spec.ts", "server/spec-settings.ts", "pi-config/extensions/claude-code/spec-hooks.ts", "x/pi-config/extensions/spec/core/a.mjs"]) assert.ok(!touchesSpecReplay(f), f);
});

test("acquireLock: a fresh lock is waited for whatever its pid, a stale one taken over, the holder's beat keeps it fresh", async () => {
  const file = join(root, "locks-unit", "x.lock");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  mkdirSync(dirname(file), { recursive: true });
  // A pid this namespace can't see (another sandbox's holder), with a fresh `at`: waited for.
  writeFileSync(file, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  let got = null;
  const w = acquireLock(file, { pollMs: 20, staleMs: 5000 }).then((l) => (got = l));
  await sleep(150);
  assert.equal(got, null, "took a fresh lock of an unseen pid");
  // Once its `at` is old, it is taken over.
  writeFileSync(file, JSON.stringify({ pid: 999999, at: new Date(Date.now() - 10_000).toISOString() }));
  await w;
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, process.pid);
  got.release();
  assert.ok(!existsSync(file));
  // The holder's beat refreshes `at`, so a waiter with a short window still waits.
  const a = await acquireLock(file, { pollMs: 20, beatMs: 30 });
  const first = JSON.parse(readFileSync(file, "utf8")).at;
  await sleep(120);
  assert.ok(Date.parse(JSON.parse(readFileSync(file, "utf8")).at) > Date.parse(first), "at not refreshed");
  got = null;
  const b = acquireLock(file, { pollMs: 20, staleMs: 100 }).then((l) => (got = l));
  await sleep(300);
  assert.equal(got, null, "took a beating holder's lock");
  a.release();
  await b;
  assert.ok(got.waitedMs >= 250, `waited ${got.waitedMs}`);
  got.release();
  assert.ok(!existsSync(file));
  // The beat stops at release.
  await sleep(100);
  assert.ok(!existsSync(file), "a beat after release rewrote the lock");
  assert.deepEqual(readdirSync(dirname(file)), [], "a draft or aside file was left behind");
});

test("check runs a touched extension's suite and the spec replay under the tree's nice.mjs, one replay at a time", async () => {
  const niceLog = join(root, "nice.log");
  const replayLog = join(root, "replay.log");
  const lockFile = join(agent, "locks", "spec-replay.lock");
  // The tree's own nice.mjs, faked: it logs and runs the command.
  const niceJs = `import { appendFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nconst [c, ...a] = process.argv.slice(2);\nappendFileSync(process.env.FAKE_NICE_LOG, JSON.stringify({ cmd: c, args: a, cwd: process.cwd() }) + "\\n");\nprocess.exit(spawnSync(c, a, { stdio: "inherit" }).status ?? 1);\n`;
  const replayJs = `import { appendFileSync } from "node:fs";\nimport { test } from "node:test";\ntest("replay", () => { appendFileSync(process.env.FAKE_REPLAY_LOG, (process.env.SOVA_SPEC_REPLAY ?? "unset") + "\\n"); if (process.env.SOVA_SPEC_REPLAY !== "1") throw new Error("not a landing"); });\n`;
  const readme = "# x\n\n## Tests\n\n```sh\ncd extensions/spec && node --test tests/*.test.mjs\n```\n";
  const make = (name, withReplay) => {
    git(main, "worktree", "add", "-q", wt(name), "-b", name);
    commit(wt(name), "scripts/nice.mjs", niceJs, `${name}: nice`);
    commit(wt(name), "pi-config/README.md", readme, `${name}: readme`);
    commit(wt(name), "pi-config/extensions/spec/tests/unit.test.mjs", `import { test } from "node:test";\ntest("unit", () => {});\n`, `${name}: unit`);
    if (withReplay) commit(wt(name), "pi-config/extensions/spec/tests/replay/replay.test.mjs", replayJs, `${name}: replay`);
    commit(wt(name), "pi-config/extensions/spec/core/a.mjs", "export {};\n", `${name}: core`);
  };
  make("feat/replay", true);
  make("feat/noreplay", false);
  const env = { FAKE_NICE_LOG: niceLog, FAKE_REPLAY_LOG: replayLog, SOVA_ROUND_LOCK_POLL_MS: "100" };

  // Another landing's live replay holds the lock: check waits for it, then runs.
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  mkdirSync(dirname(lockFile), { recursive: true });
  writeFileSync(lockFile, JSON.stringify({ pid: holder.pid, at: new Date().toISOString() }));
  const freed = setTimeout(() => { rmSync(lockFile, { force: true }); holder.kill(); }, 1500);
  const r = await run(["check", "feat/replay"], { env });
  clearTimeout(freed);
  holder.kill();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^spec replay: waited \d+s for another landing's replay\.$/m);
  assert.match(r.out, /^spec replay: node --test tests\/replay\/\*\.test\.mjs: ok, \d+s\.$/m);
  assert.match(r.out, /^pi-config spec: node --test tests\/\*\.test\.mjs: ok, \d+s\.$/m);
  assert.equal(readFileSync(replayLog, "utf8"), "1\n");
  assert.ok(!existsSync(lockFile), "the lock was not released");
  const niced = readFileSync(niceLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const specDir = join(wt("feat/replay"), "pi-config", "extensions", "spec");
  assert.deepEqual(niced.map((n) => [n.cmd, n.args, n.cwd]), [
    [process.execPath, ["--test", "tests/unit.test.mjs"], specDir],
    [process.execPath, ["--test", "tests/replay/replay.test.mjs"], specDir],
  ]);

  // A tree without the replay test says so and runs no replay.
  const n = await run(["check", "feat/noreplay"], { env });
  assert.equal(n.code, 0, n.out);
  assert.match(n.out, /^spec replay: skipped \(no tests\/replay\/replay\.test\.mjs in this tree\)\.$/m);
  assert.equal(readFileSync(replayLog, "utf8"), "1\n");

  // A stale lock (its `at` past the window) is taken over at once; a failing replay is a need.
  writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 7, at: new Date(Date.now() - 10 * 60_000).toISOString() }));
  commit(wt("feat/replay"), "pi-config/extensions/spec/tests/replay/replay.test.mjs", replayJs.replace('"1") throw', '"1" || true) throw'), "replay: fail");
  const f = await run(["check", "feat/replay"], { env });
  assert.equal(f.code, 1, f.out);
  assert.doesNotMatch(f.out, /waited/);
  assert.match(f.out, /^needs: .*spec replay fails/m);
  assert.ok(!existsSync(lockFile));
});

test("land only at the checked head and master; landed records the restart", async () => {
  assert.equal((await run(["check", "feat/clean"])).code, 0);
  const land = await run(["land", "feat/clean"]);
  assert.equal(land.code, 0, land.out);
  // The home path is a private name, yet the worktree under it lands: printed as ~/…, never the home path.
  assert.ok(land.out.includes(`call: worktree {"action":"merge","path":"~/wt-feat-clean"}`), land.out);
  assert.ok(!land.out.includes(root) && !land.out.includes("[private name]"), land.out);
  commit(main, "moved.txt", "m\n", "master: moves on");
  const masterMoved = await run(["land", "feat/clean"]);
  assert.equal(masterMoved.code, 1);
  assert.match(masterMoved.out, /master moved since/);
  assert.equal((await run(["check", "feat/clean"])).code, 0);
  commit(wt("feat/clean"), "server/more.ts", "export const y = 2;\n", "clean: more");
  const headMoved = await run(["land", "feat/clean"]);
  assert.equal(headMoved.code, 1);
  assert.match(headMoved.out, /feat\/clean moved since its check/);
  const early = await run(["landed", "feat/clean"]);
  assert.equal(early.code, 1, early.out);
  assert.equal((await run(["check", "feat/clean"])).code, 0);
  assert.equal((await run(["land", "feat/clean"])).code, 0);
  git(main, "merge", "-q", "--ff-only", "feat/clean"); // what `worktree merge` does
  const landed = await run(["landed", "feat/clean"]);
  assert.equal(landed.code, 0, landed.out);
  assert.match(landed.out, /can't be told \(the server's health can't be read\): a restart is treated as needed/);
  assert.match(landed.out, /A restart is needed: round\.mjs restart-check/);
  assert.match(landed.out, new RegExp(`session_send to ${OWNER}, after the clean up:`));
  assert.equal(state().restart.pending, true);
  // The clean up is its next line: plain git from the main checkout, never --force.
  const next = landed.out.split("\n").find((l) => l.startsWith("next: "));
  assert.ok(next.includes(`git -C "$HOME"'/main' worktree remove -- "$HOME"'/wt-feat-clean' (never --force), then git -C "$HOME"'/main' branch -d -- 'feat/clean'`), next);
  assert.ok(!next.includes(root), next);
  assert.ok(!/--force'|remove --force|-D /.test(next), next);
  assert.ok(next.endsWith("then round.mjs push"), next);
  assert.match(landed.out, /^Only when the remove succeeded, add: Its worktree folder was removed\.$/m);
  // Git's record of the worktree read-only (a sandboxed captain): no command, a reason instead.
  const admin = git(wt("feat/clean"), "rev-parse", "--path-format=absolute", "--git-dir");
  chmodSync(admin, 0o555);
  try {
    const ro = await run(["landed", "feat/clean"]);
    assert.match(ro.out, /^Clean up: Git's record of this worktree is read-only here/m);
    assert.doesNotMatch(ro.out, /worktree remove/);
    assert.doesNotMatch(ro.out, /Its worktree folder was removed/);
    assert.match(ro.out, /^next: round\.mjs push$/m);
  } finally {
    chmodSync(admin, 0o755);
  }
});

/** A stand-in /api/health answering with `head`, for the length of `fn`. */
async function withHealth(head, fn) {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, startedAt: new Date().toISOString(), head }));
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  try {
    return await fn({ SOVA_ROUND_HEALTH_URL: `http://127.0.0.1:${server.address().port}/api/health` });
  } finally {
    server.close();
  }
}

test("a private name in a worktree's path beyond the home prefix still refuses land and the clean up", async () => {
  const branch = `feat/${PLANTED}-notes`;
  // Merging master in writes the branch's name into a merge commit's message: the leak scan finds it.
  const c = await run(["check", branch]);
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /message line 1 · private name #1/);
  git(wt(branch), "reset", "-q", "--hard", "HEAD^1"); // the fixture's own branch, back before that merge
  // A branch named after a private name keeps no state (its key is masked too), so land has no check
  // for it; the path's own refusal is what stands, shown with a check put on record by hand.
  assert.ok(!(branch in state().branches));
  const st = state();
  st.branches[branch] = { check: { ok: true, needs: [], head: git(main, "rev-parse", branch), masterSha: git(main, "rev-parse", "master"), at: Date.now() } };
  writeFileSync(stateFile, JSON.stringify(st));
  const land = await run(["land", branch]);
  assert.equal(land.code, 2, land.out);
  assert.match(land.out, /The worktree's path holds a private name/);
  assert.doesNotMatch(land.out, /call: worktree/);
  git(main, "merge", "-q", "--no-ff", "-m", "land the notes", branch);
  const landed = await run(["landed", branch]);
  assert.match(landed.out, /^Clean up: The worktree's path holds a private name/m);
  assert.doesNotMatch(landed.out, /worktree remove/);
});

test("check and land scan the commits landing would publish: a scrubbed leak still in history is caught", async () => {
  git(main, "worktree", "add", "-q", wt("feat/leaky"), "-b", "feat/leaky");
  commit(wt("feat/leaky"), "notes/plan.md", `ssh to ${PLANTED}\n`, "leaky: a plan");
  commit(wt("feat/leaky"), "notes/plan.md", "ssh to the box\n", "leaky: scrubbed in the tree, not in history");
  const c = await run(["check", "feat/leaky"]);
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /notes\/plan\.md:1 · private name #1/);
  assert.match(c.out, /needs: .*leak-scan hits in commits origin\/master doesn't have/);
  assert.equal((await run(["land", "feat/leaky"])).code, 1);

  // A green check, then a name the user adds: land scans again, and lands nothing.
  git(main, "worktree", "add", "-q", wt("feat/later"), "-b", "feat/later");
  commit(wt("feat/later"), "later.txt", "wallabyhost3 is fine\n", "later: a file");
  assert.equal((await run(["check", "feat/later"])).code, 0);
  writeFileSync(settingsFile, JSON.stringify({ ...SETTINGS, privateNames: [...SETTINGS.privateNames, "wallabyhost3"] }, null, 2));
  try {
    const land = await run(["land", "feat/later"]);
    assert.equal(land.code, 1, land.out);
    assert.match(land.out, /later\.txt:1 · private name #4/);
    assert.match(land.out, /Land nothing: feat\/later carries a leak-scan hit/);
    assert.doesNotMatch(land.out, /call: worktree|wallabyhost3/);
  } finally {
    writeFileSync(settingsFile, JSON.stringify(SETTINGS, null, 2));
  }
  assert.equal((await run(["land", "feat/later"])).code, 0);
});

test("landed needs only the head in master; the restart need is the live server's head against master", async () => {
  // The owner merged it themselves: no check, no ask on record.
  const before = git(main, "rev-parse", "master");
  git(main, "worktree", "add", "-q", wt("feat/self"), "-b", "feat/self");
  commit(wt("feat/self"), "server/self.ts", "export const s = 1;\n", "self: a server file");
  assert.equal(state().branches["feat/self"], undefined);
  const early = await run(["landed", "feat/self"]);
  assert.equal(early.code, 1, early.out);
  assert.match(early.out, /isn't in master yet/);
  git(main, "merge", "-q", "--no-edit", "--no-ff", "feat/self");
  const st = state();
  delete st.restart;
  writeFileSync(stateFile, JSON.stringify(st));
  const landed = await withHealth(before, (env) => run(["landed", "feat/self"], { env }));
  assert.equal(landed.code, 0, landed.out);
  assert.match(landed.out, /^feat\/self is in master at /m);
  assert.match(landed.out, new RegExp(`Restart needed: the server runs ${before.slice(0, 7)}, and master [0-9a-f]{7} changes 1 file that needs? one \\(server/self\\.ts\\)`));
  assert.equal(state().restart.pending, true);
  assert.deepEqual(state().restart.merges.map((m) => m.branch), ["feat/self"]);

  // A merge no `landed` recorded counts too: start reads the server's head against master.
  const st2 = state();
  delete st2.restart;
  writeFileSync(stateFile, JSON.stringify(st2));
  commit(main, "server/direct.ts", "export const d = 1;\n", "an owner's merge, straight on master");
  const master = git(main, "rev-parse", "master");
  const s = await withHealth(git(main, "rev-parse", "master~1"), (env) => run(["start"], { env }));
  assert.match(s.out, /Restart needed: the server runs [0-9a-f]{7}, and master [0-9a-f]{7} changes 1 file that needs? one \(server\/direct\.ts\)/);
  assert.equal(state().restart.pending, true);
  // A docs-only difference needs none, and confirms the pending one.
  commit(main, "docs-only.md", "d\n", "master: docs");
  const ok = await withHealth(master, (env) => run(["start"], { env }));
  assert.match(ok.out, /Restart confirmed: the server runs [0-9a-f]{7}, with master [0-9a-f]{7}'s runtime code/);
  assert.equal(state().restart.pending, false);
  const none = await withHealth(master, (env) => run(["start"], { env }));
  assert.match(none.out, /no restart needed/);
  assert.equal(state().restart.pending, false);
  // A head this repository doesn't have can't be told: nothing is made pending.
  const unknown = await withHealth("f".repeat(40), (env) => run(["start"], { env }));
  assert.match(unknown.out, /can't be told: the server's head fffffff isn't in this repository/);
  assert.equal(state().restart.pending, false);
});

test("a hanging step is killed with its whole process group", async () => {
  const pidFile = join(root, "hang.pid");
  const r = await run(["check", "feat/slow"], { env: { FAKE_PNPM_MODE: "hang", FAKE_HANG_PID: pidFile, SOVA_ROUND_FLOOR_MS: "1500" } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /pnpm test: TIMED OUT/);
  assert.match(r.out, /needs: .*pnpm test timed out/);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((res) => setTimeout(res, 300));
  let alive = true;
  try {
    process.kill(pid, 0);
    alive = !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "the step's grandchild outlived its timeout");
});

test("push: refused on a leak-scan hit, pushed when clean, refused when not a fast-forward", async () => {
  assert.equal((await run(["names-answered"])).code, 0);
  const origin = git(bare, "rev-parse", "master");
  commit(main, "notes.md", `deploy to ${PLANTED} on friday\n`, "master: notes");
  const hit = await run(["push"]);
  assert.equal(hit.code, 1, hit.out);
  assert.match(hit.out, /private name #1/);
  assert.match(hit.out, /Push nothing/);
  assert.equal(git(bare, "rev-parse", "master"), origin);
  git(main, "reset", "-q", "--hard", "HEAD~1"); // the fixture's own throwaway checkout
  const ok = await run(["push"]);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(git(bare, "rev-parse", "master"), git(main, "rev-parse", "master"));
  const other = join(root, "other");
  execFileSync("git", ["clone", "-q", bare, other], { env: { ...process.env, ...gitEnv } });
  commit(other, "theirs.txt", "t\n", "someone else's push");
  git(other, "push", "-q", "origin", "master");
  const theirs = git(bare, "rev-parse", "master");
  commit(main, "ours.txt", "o\n", "master: ours");
  const nf = await run(["push"]);
  assert.equal(nf.code, 1, nf.out);
  assert.match(nf.out, /isn't a fast-forward/);
  assert.equal(git(bare, "rev-parse", "master"), theirs);
});

test("restart-check: a pending restart prints the systemctl restart line whatever the sessions are doing; it reads no live records and finds no server", async () => {
  const live = join(agent, "sessions", "live");
  mkdirSync(live, { recursive: true });
  // A busy session of some server: before chat processes it held the restart; now it doesn't matter.
  const now = Date.now();
  writeFileSync(join(live, `p${process.pid}-eeeeeeee.json`), JSON.stringify({ v: 1, session: { id: `p${process.pid}-eeeeeeee`, pid: process.pid, sessionId: "busy-one", name: "busy-one", cwd: "/", model: "m", startedAt: now, lastActivity: now }, presence: { workerCounts: { working: 1 }, activity: { state: "working" } }, heartbeat: now }));
  // Nothing pending: no line.
  const idle = state();
  idle.restart = { pending: false };
  writeFileSync(stateFile, JSON.stringify(idle));
  const none = await run(["restart-check"]);
  assert.equal(none.code, 0, none.out);
  assert.match(none.out, /No restart pending\./);
  assert.ok(!none.out.includes("systemctl --user restart"));
  // A restart pending, and no health to read: it stays pending (the next test confirms it), so the line is printed.
  const st = state();
  st.restart = { pending: true, since: Date.now(), merges: [] };
  writeFileSync(stateFile, JSON.stringify(st));
  const due = await run(["restart-check"]);
  assert.equal(due.code, 0, due.out);
  assert.match(due.out, /Restart pending since \d+s ago; the server's health can't be read, so it isn't confirmed\./);
  assert.match(due.out, /^systemctl --user restart sova-runtime\.service$/m);
  assert.ok(!/busy/.test(due.out), "no busy list, no hold");
  assert.ok(!due.out.includes("systemd-run"));
  // macOS: the launchd agent's kickstart, its label the unit's name without .service.
  const mac = await run(["restart-check"], { env: { SOVA_ROUND_PLATFORM: "darwin" } });
  assert.equal(mac.code, 0, mac.out);
  assert.match(mac.out, new RegExp(`^launchctl kickstart -k gui/${process.getuid()}/sova-runtime$`, "m"));
  assert.ok(!mac.out.includes("systemctl"));
  for (const f of readdirSync(live)) rmSync(join(live, f));
});

test("start confirms a restart from /api/health, and report gives the skeleton", async () => {
  const master = git(main, "rev-parse", "master");
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, startedAt: new Date(Date.now() + 1000).toISOString(), head: master }));
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  try {
    const r = await run(["start"], { env: { SOVA_ROUND_HEALTH_URL: `http://127.0.0.1:${server.address().port}/api/health` } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Later round/);
    assert.match(r.out, /Restart confirmed/);
  } finally {
    server.close();
  }
  assert.equal(state().restart.pending, false);
  const rep = await run(["report"]);
  assert.equal(rep.code, 0, rep.out);
  assert.match(rep.out, /^- Merged: /m);
  assert.match(rep.out, /^- For you, once \(no live owner, so no Landing card\): /m);
});

test("report: a branch with no live owner reaches the user once; a quiet round is one line", async () => {
  writeBoard([["feat/dirty", "ready", "0199dddd-archived", "archived"]]);
  assert.equal((await run(["start"])).code, 0);
  assert.equal((await run(["status"])).code, 0);
  const first = await run(["report"]);
  assert.match(first.out, /^- For you, once \(no live owner, so no Landing card\): .*feat\/dirty \(owner archived: say "land feat\/dirty" here to land it\).*feat\/slow \(no session tracks this worktree: say "land feat\/slow" here to land it\)/m);
  assert.equal((await run(["status"])).code, 0);
  const again = await run(["report"]);
  assert.equal(again.out.split("\n")[0], "Nothing new on the merge board.", again.out);
  rmSync(boardFile, { force: true });
});

test("b1: the driver never reads Sova's token, and the board works with the token file unreadable", async () => {
  assert.doesNotMatch(readFileSync(ROUND, "utf8"), /auth-token|Authorization|x-sova-token/);
  const token = join(agent, "sova", "auth-token");
  writeFileSync(token, "secret-token\n");
  chmodSync(token, 0o000);
  try {
    writeBoard([["feat/slow", "ready", OWNER, "idle"]]);
    const r = await run(["status"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`^feat/slow: Ready to merge · reason · owner ${OWNER} idle \\(board`, "m"));
  } finally {
    chmodSync(token, 0o600);
    rmSync(token, { force: true });
    rmSync(boardFile, { force: true });
  }
});

test("b2: the board's newer reading beats an older note: idle and fresh, so ask queues it", async () => {
  const branch = "feat/firstrun";
  assert.equal((await run(["note", branch, `owner=${OWNER}`, "idle=no"])).code, 0);
  // An hour passes (the note is moved back an hour, as the clock would move on).
  const st = state();
  st.branches[branch].notedAt -= 3600_000;
  writeFileSync(stateFile, JSON.stringify(st));
  const refused = await run(["ask", branch]);
  assert.equal(refused.code, 1, "with no board, the hour-old busy note refuses");
  // The board now reads the owner idle, and the branch Ready to land.
  writeBoard([[branch, "ready", OWNER, "idle", undefined, landed(branch)]]);
  const ask = await run(["ask", branch]);
  assert.equal(ask.code, 0, ask.out);
  assert.match(ask.out, new RegExp(`^Queued ${branch} at [0-9a-f]{7}: Sova shows the Landing card in `, "m"));
  // A hand note newer than the board names the owner, and only that.
  assert.equal((await run(["note", branch, "owner=0199aaaa-other", "idle=yes"])).code, 0);
  assert.equal(ownerOf(state().branches[branch]).owner, "0199aaaa-other");
  for (const f of [boardFile, join(agent, "sova", "landing-queue.json")]) rmSync(f, { force: true });
});

test("pure board rules: the file's shape, the owner rule and the groups", () => {
  const now = Date.parse("2026-10-05T10:00:00Z");
  const file = (o) => JSON.stringify(o);
  assert.equal(parseBoard(file({ v: 1, at: "2026-10-05T09:59:00Z", pending: 2, rows: [{ path: "/w", branch: "b", state: "ready", owner: { id: "o", status: "idle" } }, { path: "/x" }] }), now).board.rows.length, 1);
  assert.equal(parseBoard(file({ v: 2, at: "2026-10-05T09:59:00Z", rows: [] }), now).ok, false);
  assert.equal(parseBoard(file({ v: 1, at: "2026-10-05T09:54:00Z", rows: [] }), now).ok, false, "over 5 minutes old");
  const board = { owner: "A", status: "idle", at: 2000 };
  assert.deepEqual(ownerOf({ owner: "A", idle: "no", notedAt: 1000, board }), { owner: "A", from: "board", status: "idle", at: 2000, via: "board" });
  assert.deepEqual(ownerOf({ owner: "B", idle: "yes", notedAt: 3000, board }), { owner: "B", from: "note", status: "idle", at: 3000, via: "note" });
  assert.deepEqual(ownerOf({ owner: "A", idle: "no", notedAt: 3000, board }), { owner: "A", from: "note", status: "busy", at: 3000, via: "note" }, "the newest reading of that owner");
  assert.equal(ownerOf({}), null);
  const g = (rec, row, pending = 0, extra = {}) => groupOf({ rec, row, head: "h", master: "m", pending, ...extra });
  const L = { state: "ready", commit: "h" };
  const row = (state, landing = L) => ({ state, ...(landing ? { landing } : {}) });
  assert.equal(g({ check: { ok: true, head: "h", masterSha: "m" } }, null), "land");
  assert.equal(g({ board }, row("waiting-approval")), "ask");
  assert.equal(g({ board: { ...board, status: "busy" } }, row("ready")), "busy");
  assert.equal(g({ board: { ...board, status: "archived" } }, row("in-progress")), "archived");
  assert.equal(g({}, null), "untracked");
  assert.equal(g({}, null, 3), "unknown");
  assert.equal(g({ board }, row("in-progress", null)), "not-ready");
  // Ready to land (§chat.worktrees/ready-to-land): what the captain queues; Ready to merge alone isn't finished work.
  assert.equal(g({ board }, row("waiting-approval", null)), "not-ready");
  assert.equal(g({ board }, row("ready", { ...L, commit: "old" })), "not-ready", "Ready to land at another head");
  assert.equal(g({ board }, row("ready", { state: "specs", commit: "h", drafts: ["d"] })), "not-ready", "landing its specs");
  assert.equal(g({ board }, row("ready", { state: "specs", commit: "h", drafts: ["d"], specsWhy: "no tools" })), "ask", "its specs can't land: the card offers Merge Without Specs…");
  // The user's word in the captain's chat (`go`): a go-ahead, straight to check, whatever the board reads.
  assert.equal(g({ board }, row("in-progress", null), 0, { answer: { kind: "go-ahead", by: "chat" } }), "check", "the user's word");
  // The Landing card: shown, waiting; refused, to ask again (ask then says the user decides); the user's answer at this head.
  const queued = { board, ask: { queued: "lq_1", head: "h", at: 1, owner: "A" } };
  assert.equal(g(queued, row("ready"), 0, { queued: { at: 1, card: "of_1" } }), "waiting");
  assert.equal(g(queued, row("ready"), 0, { queued: { at: 1, refused: "an open offer" } }), "ask");
  assert.equal(g({ board }, row("in-progress", null), 0, { answer: { kind: "go-ahead" } }), "check", "Land It at this head is the go-ahead");
  assert.equal(g({ board }, row("ready"), 0, { answer: { kind: "not-yet" } }), "not-ready", "Not Yet waits for a new commit");
  assert.deepEqual(landingAnswer(parseLanding(JSON.stringify({ v: 1, goAheads: [{ branch: "b", commit: "a".repeat(40), by: "land-it", withoutSpecs: true }], notYet: [{ branch: "c", commit: "a".repeat(40) }] })), "b", "a".repeat(40)), { kind: "go-ahead", withoutSpecs: true, by: "land-it" });
  assert.equal(landingAnswer(parseLanding("{bad"), "b", "a".repeat(40)), null);
});

test("groupOf: the user's go-ahead checks, a green check lands, Not Yet holds; no merge guard", () => {
  const board = { owner: "A", status: "idle", at: 2000 };
  const g = (rec, row, extra = {}) => groupOf({ rec, row, head: "h", master: "m", pending: 0, ...extra });
  const row = { state: "ready", landing: { state: "ready", commit: "h" } };
  const green = { check: { ok: true, head: "h", masterSha: "m" } };
  assert.equal(g({ board }, row, { answer: { kind: "go-ahead" } }), "check", "Land It is the go-ahead");
  // Land It at the pre-check head P, carried to the check's clean master merge (landingAnswerAt's `at`): it lands.
  assert.equal(g({ board, ...green }, row, { answer: { kind: "go-ahead", at: "p" } }), "land");
  assert.equal(g({ board, ...green }, row), "land", "a check that passed at this head and master lands");
  assert.equal(g({ board }, row), "ask", "neither: queued for the Landing card");
  const shown = { board, ask: { queued: "lq_1", head: "h", at: 1, owner: "A" } };
  assert.equal(g(shown, row, { queued: { at: 1, card: "of_1" } }), "waiting");
  // Not Yet holds, at this head or carried from P, a green check notwithstanding.
  for (const answer of [{ kind: "not-yet" }, { kind: "not-yet", at: "p" }]) {
    assert.equal(g({ board, ...green }, row, { answer }), "not-ready");
    assert.equal(g({ board }, row, { answer }), "not-ready");
  }
  // The user's word needs no owner, board row or ask: an archived owner's branch, or one no session tracks.
  const word = { answer: { kind: "go-ahead", by: "chat" } };
  assert.equal(g({ board: { ...board, status: "archived" } }, null, word), "check");
  assert.equal(g({}, null, word), "check");
  assert.equal(goAheadWord("chat"), "word in this chat");
  assert.equal(goAheadWord("captain-chat"), "word in this chat");
  // Go on an Overseer card's Ready to land row (§app.overseer/card-land): a go-ahead like Land It, under its own name.
  assert.equal(g({ board }, row, { answer: { kind: "go-ahead", by: "overseer-card" } }), "check");
  assert.equal(goAheadWord("overseer-card"), "Apply on the Overseer's card");
});

test("also-update rules: globs, the guides' front-matter and which touched areas missed their files", () => {
  assert.ok(globRe("pi-config/extensions/spec/**").test("pi-config/extensions/spec/core/a.mjs"));
  assert.ok(!globRe("pi-config/extensions/spec/**").test("pi-config/extensions/spec2/a.mjs"));
  assert.ok(globRe("server/**/*.ts").test("server/a.ts") && globRe("server/**/*.ts").test("server/harness/pi/b.ts"));
  assert.ok(!globRe("server/*.ts").test("server/harness/b.ts"));
  assert.ok(globRe("src/App.tsx").test("src/App.tsx") && !globRe("src/App.tsx").test("src/AppXtsx"));
  assert.deepEqual(guideFrontMatter('---\nwatches: ["a/**", "b.ts"]\nalsoUpdate: ["a/CHANGELOG.md"]\n---\n# A\n'), { watches: ["a/**", "b.ts"], alsoUpdate: ["a/CHANGELOG.md"] });
  assert.deepEqual(guideFrontMatter("---\nwatches:\n  - a/**\n  - 'b.ts'\nalsoUpdate:\n  - \"c.md\"\n---\n"), { watches: ["a/**", "b.ts"], alsoUpdate: ["c.md"] });
  assert.deepEqual(guideFrontMatter('# no front-matter\nwatches: ["a"]\n'), { watches: [], alsoUpdate: [] });
  assert.deepEqual(guideFrontMatter("---\nwatches: [not json\n---\n"), { watches: [], alsoUpdate: [] });

  const dir = mkdtempSync(join(root, "guides-"));
  const guide = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  guide("agents/modes/spec/overview.md", '---\nwatches: ["pi-config/extensions/spec/**"]\nalsoUpdate: ["pi-config/extensions/spec/docs/CHANGELOG.md"]\n---\n');
  guide("agents/server/overview.md", '---\nwatches: ["server/**"]\nalsoUpdate: []\n---\n');
  guide("agents/frontend/overview.md", "# no front-matter\n");
  guide("agents/frontend/notes.md", '---\nwatches: ["src/**"]\nalsoUpdate: ["x.md"]\n---\n');
  const guides = areaGuides(dir);
  assert.deepEqual(guides.map((x) => x.guide), ["agents/frontend/overview.md", "agents/modes/spec/overview.md", "agents/server/overview.md"]);
  assert.equal(guides[1].area, "modes/spec");
  assert.deepEqual(areaGuides(join(dir, "none")), []);

  assert.deepEqual(alsoUpdateNudges(["pi-config/extensions/spec/core/a.mjs", "server/x.ts", "src/y.tsx"], guides), [
    { area: "modes/spec", guide: "agents/modes/spec/overview.md", touched: ["pi-config/extensions/spec/core/a.mjs"], missing: ["pi-config/extensions/spec/docs/CHANGELOG.md"] },
  ]);
  assert.deepEqual(alsoUpdateNudges(["pi-config/extensions/spec/core/a.mjs", "pi-config/extensions/spec/docs/CHANGELOG.md"], guides), []);
  assert.deepEqual(alsoUpdateNudges(["README.md"], guides), []);
});

test("check prints an also-update line for an area touched without its files, and it holds nothing", async () => {
  git(main, "worktree", "add", "-q", wt("feat/guide"), "-b", "feat/guide");
  commit(wt("feat/guide"), "agents/modes/spec/overview.md", '---\nwatches: ["pi-config/extensions/spec/**"]\nalsoUpdate: ["pi-config/extensions/spec/docs/CHANGELOG.md"]\n---\n# Spec\n', "guide: spec");
  commit(wt("feat/guide"), "pi-config/extensions/spec/core/x.mjs", "export {};\n", "spec: core change");
  const r = await run(["check", "feat/guide"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^also update: touched modes\/spec \(1 file, agents\/modes\/spec\/overview\.md\), not pi-config\/extensions\/spec\/docs\/CHANGELOG\.md: ask the owner \("updated" or "not needed because …"\)\.$/m);
  assert.match(r.out, /landable at [0-9a-f]{7}/);
  commit(wt("feat/guide"), "pi-config/extensions/spec/docs/CHANGELOG.md", "# Changelog\n", "spec: changelog");
  const again = await run(["check", "feat/guide"]);
  assert.equal(again.code, 0, again.out);
  assert.doesNotMatch(again.out, /^also update:/m);
});

test("landed copies the worktree's drafts folder once, and names the drafts left unpromoted", async () => {
  const branch = "feat/drafts";
  git(main, "worktree", "add", "-q", wt(branch), "-b", branch);
  const promotedHead = commit(wt(branch), "drafts.txt", "d\n", "drafts: a file");
  const exclude = join(main, ".git", "info", "exclude");
  const was = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  writeFileSync(exclude, `${was}.sova/spec/drafts/\n`);
  const drafts = join(wt(branch), ".sova", "spec", "drafts");
  const noticeLine = (out) => { const l = out.split("\n"); return l[l.indexOf(`session_send to ${OWNER}, after the clean up:`) + 1]; };
  const DRAFT_ENV = { FAKE_DRAFT_IDS: JSON.stringify({ open: ["§a/one", "§a/two", "§a/three", "§a/four", "§a/five"], done: [] }) };
  const NAMED = "open (§a/one, §a/two, §a/three, §a/four, +1 more)";
  try {
    assert.equal((await run(["note", branch, `owner=${OWNER}`, "idle=yes"])).code, 0);
    // One draft with five unpromoted records, one fully promoted: only the first is named, four ids shown.
    for (const name of ["open", "done"]) { mkdirSync(join(drafts, name, "spec"), { recursive: true }); writeFileSync(join(drafts, name, "draft.json"), `{"name":"${name}"}\n`); }
    // Landed with the drafts still there: a copy is kept, the notice names them and that copy, and the clean up still runs.
    git(main, "merge", "-q", "--no-edit", "--no-ff", branch);
    const master = git(main, "rev-parse", "master");
    const keptDir = join(agent, "sova", "playbooks", "merge-round", "drafts", promotedHead);
    const kept = await run(["landed", branch], { env: DRAFT_ENV });
    assert.equal(kept.code, 0, kept.out);
    assert.equal(noticeLine(kept.out), `${branch} is merged into master at ${master.slice(0, 7)}. Don't touch master; start any new work on a fresh branch. Its docs didn't land with the code: its spec drafts weren't promoted: ${NAMED}. Promote them on a fresh branch from master, never on master itself: copy each draft's folder from ~/agent/sova/playbooks/merge-round/drafts/${promotedHead}/ into that worktree's .sova/spec/drafts/, then promote and commit it there.`);
    assert.equal(readFileSync(join(keptDir, "open", "draft.json"), "utf8"), '{"name":"open"}\n');
    assert.ok(existsSync(join(keptDir, "done")), "the whole drafts folder is copied, once");
    assert.doesNotMatch(kept.out, /§a\/five|done \(/, "a promoted draft, and ids past four, are never named");
    assert.match(kept.out.split("\n").find((l) => l.startsWith("next: ")), /worktree remove -- /);

    // The copy can't be written: no clean up, so the drafts stay where they are, and the notice points there.
    rmSync(keptDir, { recursive: true, force: true });
    chmodSync(dirname(keptDir), 0o555);
    try {
      const stuck = await run(["landed", branch], { env: DRAFT_ENV });
      assert.equal(stuck.code, 0, stuck.out);
      assert.match(stuck.out, /^Clean up: its drafts couldn't be kept \(EACCES\), and removing it would delete them: leave it, and say so in the report\.$/m);
      assert.doesNotMatch(stuck.out, /worktree remove/);
      assert.ok(noticeLine(stuck.out).endsWith(`copy each draft's folder from ~/wt-feat-drafts/.sova/spec/drafts/ into that worktree's .sova/spec/drafts/, then promote and commit it there.`), stuck.out);
    } finally {
      chmodSync(dirname(keptDir), 0o755);
    }

    // No drafts left: the notice is word for word what it was.
    rmSync(drafts, { recursive: true, force: true });
    const none = await run(["landed", branch]);
    assert.equal(none.code, 0, none.out);
    assert.equal(noticeLine(none.out), `${branch} is merged into master at ${master.slice(0, 7)}. Don't touch master; start any new work on a fresh branch.`);
    assert.doesNotMatch(none.out, /Unpromoted drafts kept/);
  } finally {
    rmSync(drafts, { recursive: true, force: true });
    writeFileSync(exclude, was);
  }
});

test("landed keeps every draft not confirmed promoted: an unreadable status, or no spec tools, is kept and named", async () => {
  const branch = "feat/drafts-unread";
  git(main, "worktree", "add", "-q", wt(branch), "-b", branch);
  const head = commit(wt(branch), "unread.txt", "u\n", "unread: a file");
  const exclude = join(main, ".git", "info", "exclude");
  const was = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  writeFileSync(exclude, `${was}.sova/spec/drafts/\n`);
  const drafts = join(wt(branch), ".sova", "spec", "drafts");
  for (const name of ["broken", "fine"]) { mkdirSync(join(drafts, name), { recursive: true }); writeFileSync(join(drafts, name, "draft.json"), `{"name":"${name}"}\n`); }
  const noticeLine = (out) => { const l = out.split("\n"); return l[l.indexOf(`session_send to ${OWNER}, after the clean up:`) + 1]; };
  const keptDir = join(agent, "sova", "playbooks", "merge-round", "drafts", head);
  try {
    assert.equal((await run(["note", branch, `owner=${OWNER}`, "idle=yes"])).code, 0);
    git(main, "merge", "-q", "--no-edit", "--no-ff", branch);
    const master = git(main, "rev-parse", "master");
    const BASE = `${branch} is merged into master at ${master.slice(0, 7)}. Don't touch master; start any new work on a fresh branch.`;
    const TAIL = `Promote them on a fresh branch from master, never on master itself: copy each draft's folder from ~/agent/sova/playbooks/merge-round/drafts/${head}/ into that worktree's .sova/spec/drafts/, then promote and commit it there.`;

    // One draft's status can't be read; the other is fully promoted.
    const unread = await run(["landed", branch], { env: { FAKE_DRAFT_IDS: JSON.stringify({ broken: "garbage", fine: [] }) } });
    assert.equal(unread.code, 0, unread.out);
    assert.equal(noticeLine(unread.out), `${BASE} Its docs didn't land with the code: its spec drafts may not be promoted: broken (status unreadable). ${TAIL}`);
    assert.equal(readFileSync(join(keptDir, "broken", "draft.json"), "utf8"), '{"name":"broken"}\n');
    assert.ok(existsSync(join(keptDir, "fine")), "the whole drafts folder is copied, once");
    assert.match(unread.out.split("\n").find((l) => l.startsWith("next: ")), /worktree remove -- /, "kept first, so the clean up runs");

    // No spec tools at all: no status can be read, so every draft is kept and named.
    rmSync(keptDir, { recursive: true, force: true });
    const noTools = await run(["landed", branch], { env: { SOVA_ROUND_SPEC_CORE: join(root, "no-spec-core") } });
    assert.equal(noTools.code, 0, noTools.out);
    assert.equal(noticeLine(noTools.out), `${BASE} Its docs didn't land with the code: its spec drafts may not be promoted: broken (status unreadable); fine (status unreadable). ${TAIL}`);
    for (const name of ["broken", "fine"]) assert.equal(readFileSync(join(keptDir, name, "draft.json"), "utf8"), `{"name":"${name}"}\n`);

    // No spec tools and the copy fails: no clean up, so nothing is deleted.
    rmSync(keptDir, { recursive: true, force: true });
    chmodSync(dirname(keptDir), 0o555);
    try {
      const stuck = await run(["landed", branch], { env: { SOVA_ROUND_SPEC_CORE: join(root, "no-spec-core") } });
      assert.match(stuck.out, /^Clean up: its drafts couldn't be kept \(EACCES\)/m);
      assert.doesNotMatch(stuck.out, /worktree remove/);
    } finally {
      chmodSync(dirname(keptDir), 0o755);
    }
  } finally {
    rmSync(drafts, { recursive: true, force: true });
    writeFileSync(exclude, was);
  }
});

test("two branches promote the same claim: once A lands, check B hands it back to re-promote on top of master, never 'resolve, commit'", async () => {
  // Master gains a claim file both branches then promote differently.
  commit(main, ".sova/spec/claims/x.md", "# §x/one\n\nOne does X.\n", "spec: x");
  const a = "feat/spec-a", b = "feat/spec-b";
  for (const [br, text] of [[a, "One does X, twice."], [b, "One does X, once."]]) {
    git(main, "worktree", "add", "-q", wt(br), "-b", br);
    commit(wt(br), `${br.slice(5)}.txt`, "code\n", `${br}: code`);
    commit(wt(br), ".sova/spec/claims/x.md", `# §x/one\n\n${text}\n`, `spec: ${br} promoted`);
  }
  git(main, "merge", "-q", "--no-edit", "--no-ff", a);
  const masterAfterA = git(main, "rev-parse", "master");
  const headB = git(main, "rev-parse", b);
  assert.equal((await run(["note", b, `owner=${OWNER}`, "idle=yes"])).code, 0);
  const r = await run(["check", b]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^Merging master into feat\/spec-b conflicts in the spec \(\.sova\/spec\/claims\/x\.md\): the merge was aborted/m);
  assert.doesNotMatch(r.out, /resolve, commit|left in .* for you/, "a spec conflict is never the captain's to resolve");
  const l = r.out.split("\n");
  assert.equal(l[l.indexOf(`session_send to ${OWNER}:`) + 1], `${b} isn't landing yet: merging master into it conflicts in the spec (.sova/spec/claims/x.md). Merge master into ${b} yourself and recover the spec as PROMOTE.md says: take master's whole spec with \`git checkout --no-overlay master -- .sova/spec/manifest.json .sova/spec/claims\`, resolve the rest and commit the merge, promote your drafts again with the same --ids (re-record stale evidence), and commit the claims (the user's go-ahead to merge covers it: don't ask for it again), so the branch shows Ready to land again.`);
  // The owner's worktree is as it was: no merge in progress, nothing changed, the head unmoved.
  assert.ok(!existsSync(join(main, ".git", "worktrees", "wt-feat-spec-b", "MERGE_HEAD")), "the conflicted merge was left in the owner's worktree");
  assert.equal(git(wt(b), "status", "--porcelain"), "");
  assert.equal(git(main, "rev-parse", b), headB);
  assert.equal(git(main, "rev-parse", "master"), masterAfterA, "check wrote to master");
  assert.equal(state().branches[b].check.ok, false);
  const land = await run(["land", b]);
  assert.equal(land.code, 1, land.out);
  assert.doesNotMatch(land.out, /call: worktree/);
});

test("check: a manifest conflict merge-manifest refuses is handed back like a claims conflict", async () => {
  const br = "feat/spec-manifest";
  git(main, "worktree", "add", "-q", wt(br), "-b", br);
  commit(wt(br), ".sova/spec/manifest.json", '{"branch":2}\n', "spec: manifest on the branch");
  commit(main, ".sova/spec/manifest.json", '{"master":2}\n', "spec: manifest on master");
  const headBefore = git(main, "rev-parse", br);
  const r = await run(["check", br], { env: { FAKE_MANIFEST_REFUSE: "1" } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /merge-manifest --write didn't resolve it/);
  assert.match(r.out, /^Merging master into feat\/spec-manifest conflicts in the spec \(\.sova\/spec\/manifest\.json\): the merge was aborted/m);
  assert.match(r.out, /^For its owner \(none known: the user's call\):$/m);
  assert.equal(git(wt(br), "status", "--porcelain"), "");
  assert.equal(git(main, "rev-parse", br), headBefore);
});

test("landed deletes kept draft copies only when the draft tool confirms them official, and keeps the rest", async () => {
  const br = "feat/prune-kept";
  git(main, "worktree", "add", "-q", wt(br), "-b", br);
  commit(wt(br), "prune.txt", "p\n", "prune: a file");
  git(main, "merge", "-q", "--no-edit", "--no-ff", br);
  const base = join(agent, "sova", "playbooks", "merge-round", "drafts");
  rmSync(base, { recursive: true, force: true }); // earlier tests' landings kept copies of their own
  const old = join(base, "a".repeat(40));
  for (const n of ["landed-one", "waiting-one"]) { mkdirSync(join(old, n), { recursive: true }); writeFileSync(join(old, n, "draft.json"), "{}\n"); }
  const pruneLog = join(root, "prune.log");
  writeFileSync(pruneLog, "");
  // The prune fails: nothing is deleted.
  const failed = await run(["landed", br], { env: { FAKE_OFFICIAL: JSON.stringify(["landed-one"]), FAKE_PRUNE_FAIL: "1" } });
  assert.match(failed.out, /^Kept draft copies: the prune failed for aaaaaaa; nothing there was deleted\.$/m);
  assert.deepEqual(readdirSync(old).sort(), ["landed-one", "waiting-one"]);
  // It works: only the confirmed copy goes, against the main checkout's spec.
  const r = await run(["landed", br], { env: { FAKE_OFFICIAL: JSON.stringify(["landed-one"]) } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^Kept draft copies already official in master, deleted: aaaaaaa\/landed-one\.$/m);
  assert.match(r.out, /^Kept draft copies not confirmed official: 1, kept\.$/m);
  assert.deepEqual(readdirSync(old), ["waiting-one"]);
  const call = readFileSync(pruneLog, "utf8").trim().split("\n").map((x) => JSON.parse(x)).at(-1);
  assert.deepEqual(call, ["prune", "--official", "--from", old, "--write", "--root", main, "--json"]);
  // Once every copy is official, the folder goes too.
  await run(["landed", br], { env: { FAKE_OFFICIAL: JSON.stringify(["waiting-one"]) } });
  assert.ok(!existsSync(old), "an emptied folder of copies is removed");
});

test("landed tidies the drafts already official out of the worktree once its check passed at that head, a copy kept", async () => {
  const br = "feat/tidy";
  git(main, "worktree", "add", "-q", wt(br), "-b", br);
  const head = commit(wt(br), "tidy.txt", "t\n", "tidy: a file");
  const exclude = join(main, ".git", "info", "exclude");
  const was = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  writeFileSync(exclude, `${was}.sova/spec/drafts/\n`);
  const drafts = join(wt(br), ".sova", "spec", "drafts");
  for (const n of ["done", "open"]) { mkdirSync(join(drafts, n), { recursive: true }); writeFileSync(join(drafts, n, "draft.json"), `{"name":"${n}"}\n`); }
  git(main, "merge", "-q", "--no-edit", "--no-ff", br);
  const copy = join(agent, "sova", "playbooks", "merge-round", "drafts", head);
  const env = { FAKE_OFFICIAL: JSON.stringify(["done"]), FAKE_DRAFT_IDS: JSON.stringify({ done: [], open: ["§o/x"] }) };
  try {
    const owned = await run(["landed", br], { env });
    assert.doesNotMatch(owned.out, /Official drafts/, "no passing check at this head (its owner merged it): nothing tidied");
    assert.deepEqual(readdirSync(drafts).sort(), ["done", "open"]);
    const st = JSON.parse(readFileSync(stateFile, "utf8"));
    st.branches[br].check = { head, masterSha: git(main, "rev-parse", "master"), ok: true, needs: [], flaky: [], preexisting: [], at: Date.now() };
    writeFileSync(stateFile, JSON.stringify(st));
    const r = await run(["landed", br], { env });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`^Official drafts tidied out of the worktree \\(a copy at .*/drafts/${head}/\\): done\\.$`, "m"));
    assert.deepEqual(readdirSync(drafts), ["open"], "a draft that isn't official stays");
    assert.equal(readFileSync(join(copy, "done", "draft.json"), "utf8"), '{"name":"done"}\n');
  } finally {
    rmSync(drafts, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
    writeFileSync(exclude, was);
  }
});

test("B1: a § the draft promoted before, now in conflict after taking master's spec without re-promoting, is not promoted: check hands it back", async () => {
  // Its own repository with a real spec and the real draft tool: the hold-back reads what the tool says.
  const REAL_CORE = join(REPO_ROOT, "pi-config", "extensions", "spec", "core");
  const DRAFT = join(REAL_CORE, "sova-spec-draft.mjs");
  const r2 = join(root, "b1");
  const main2 = join(r2, "main");
  const origin2 = join(r2, "origin.git");
  const env2 = { ...process.env, ...gitEnv, HOME: root };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env2[k];
  const tool = (cwd, ...a) => execFileSync(process.execPath, [DRAFT, ...a, "--root", cwd, "--json"], { cwd, env: env2, encoding: "utf8" });
  const toolJ = (cwd, ...a) => { try { return JSON.parse(tool(cwd, ...a)); } catch (e) { return JSON.parse(e.stdout); } };
  mkdirSync(r2, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "master", origin2], { env: env2 });
  execFileSync("git", ["init", "-q", "-b", "master", main2], { env: env2 });
  const MANIFEST = { formatVersion: 1, claims: { "§x/top": { kind: "surface", authority: "accepted" }, "§x.top/one": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/one.txt"] } } };
  const TOP = (one) => `# §x/top\n\nThe top surface.\n\n## §x.top/one\n\n${one}\n`;
  mkdirSync(join(main2, ".sova", "spec", "claims", "x"), { recursive: true });
  writeFileSync(join(main2, ".sova/spec/manifest.json"), JSON.stringify(MANIFEST, null, 2) + "\n");
  writeFileSync(join(main2, ".sova/spec/claims/x/top.md"), TOP("One does X."));
  writeFileSync(join(main2, ".sova/spec/.gitignore"), "/drafts/\n");
  commit(main2, "lib/one.txt", "v1\n", "base: spec and code");
  git(main2, "add", "-A"); git(main2, "commit", "-q", "-m", "base: spec");
  git(main2, "remote", "add", "origin", origin2);
  git(main2, "push", "-q", "origin", "master");
  git(main2, "fetch", "-q", "origin");
  const wt2 = (b) => join(r2, `wt-${b.replace(/\//g, "-")}`);
  // A and B each build §x.top/one differently and promote it on their own branch.
  for (const [br, text] of [["feat/b1-a", "One does X twice."], ["feat/b1-b", "One does X once."]]) {
    git(main2, "worktree", "add", "-q", wt2(br), "-b", br);
    const w = wt2(br);
    assert.equal(toolJ(w, "new", "d", "--write").exit, 0);
    writeFileSync(join(w, ".sova/spec/drafts/d/spec/claims/x/top.md"), TOP(text));
    commit(w, "lib/one.txt", `${text}\n`, `${br}: build`);
    assert.equal(toolJ(w, "evidence", "d", "--id", "§x.top/one", "--by", "t", "--verification", "built", "--commit", "HEAD", "--write").exit, 0);
    const pv = toolJ(w, "promote", "d", "--id", "§x.top/one");
    assert.equal(pv.exit, 0, JSON.stringify(pv.findings));
    assert.equal(toolJ(w, "promote", "d", "--id", "§x.top/one", "--plan", pv.plan, "--write").exit, 0);
    git(w, "add", "--", ".sova/spec/manifest.json", ".sova/spec/claims"); git(w, "commit", "-q", "-m", `spec: ${br} promoted`);
  }
  // A lands; B's check is handed back for the spec conflict.
  git(main2, "merge", "-q", "--no-edit", "--no-ff", "feat/b1-a");
  const B = "feat/b1-b", wB = wt2(B), OWNER2 = "0199cccc-owner2";
  const SPEC_ENV = { SOVA_ROUND_SPEC_CORE: REAL_CORE };
  assert.equal((await run(["note", B, `owner=${OWNER2}`, "idle=yes"], { cwd: main2 })).code, 0);
  const first = await run(["check", B], { cwd: main2, env: SPEC_ENV });
  assert.equal(first.code, 1, first.out);
  assert.match(first.out, /conflicts in the spec/);
  // The owner takes master's whole spec as the hand-back says, but never promotes again.
  spawnSyncGit(wB, ["merge", "--no-edit", "master"]);
  git(wB, "checkout", "--no-overlay", "master", "--", ".sova/spec/manifest.json", ".sova/spec/claims");
  git(wB, "add", "-A"); git(wB, "commit", "-q", "--no-edit");
  assert.equal(readFileSync(join(wB, ".sova/spec/claims/x/top.md"), "utf8"), TOP("One does X twice."), "fixture: B's branch now holds A's prose, not its own");
  // At the new head B's own docs are gone from its branch, so the check hands it back, naming the §.
  const check = await run(["check", B], { cwd: main2, env: SPEC_ENV });
  assert.equal(check.code, 1, check.out);
  assert.match(check.out, /^needs: (.*; )?docs not promoted: d(;|$)/m);
  assert.match(check.out, /spec drafts aren't promoted: d \(§x\.top\/one\)/);
});

test("Ready to land: ask queues the branch for Sova's Landing card; status reads Sova's answer, then the user's Land It or Not Yet at that head", async () => {
  const sova = join(agent, "sova");
  const queueFile = join(sova, "landing-queue.json");
  const shownFile = join(sova, "landing-shown.json");
  const landingFile = join(sova, "landing.json");
  const saved = readFileSync(stateFile, "utf8");
  try {
    git(main, "worktree", "add", "-q", "-b", "feat/landq", wt("feat/landq"), "master");
    writeFileSync(join(wt("feat/landq"), "landq.txt"), "landq\n");
    git(wt("feat/landq"), "add", "landq.txt");
    git(wt("feat/landq"), "commit", "-q", "-m", "landq");
    const head = git(main, "rev-parse", "feat/landq");
    writeBoard([["feat/landq", "waiting-approval", OWNER, "idle", undefined, landed("feat/landq")]]);
    const q = await run(["ask", "feat/landq"]);
    assert.equal(q.code, 0, q.out);
    assert.match(q.out, new RegExp(`^Queued feat/landq at ${head.slice(0, 7)}: Sova shows the Landing card in "Chat of ${OWNER}" \\(#/sid/${OWNER}\\), and the branch as a row on the landing card in this chat\\.$`, "m"));
    assert.match(q.out, /don't poll/);
    const entries = JSON.parse(readFileSync(queueFile, "utf8")).entries;
    assert.deepEqual(entries.map((e) => [e.branch, e.head, e.owner, e.captain, e.path === wt("feat/landq")]), [["feat/landq", head, OWNER, ME, true]]);
    assert.equal((await run(["ask", "feat/landq"])).code, 1, "queued once per head");
    const line = async () => (await run(["status"])).out.split("\n").find((l) => l.startsWith("feat/landq:")) ?? "";
    assert.match(await line(), /queued \d+s ago at [0-9a-f]{7}; Sova hasn't read the queue yet/);
    writeFileSync(shownFile, JSON.stringify({ v: 1, results: { [entries[0].id]: { at: Date.now(), card: "of_1" } } }));
    const shown = await run(["status", "--json"]);
    assert.equal(JSON.parse(shown.out).branches.find((b) => b.branch === "feat/landq").group, "waiting");
    // The owner's chat by its title and a link, never "its card is shown" alone; the report lists it too.
    assert.match(await line(), new RegExp(`Landing card shown in "Chat of ${OWNER}" \\(#/sid/${OWNER}\\)`));
    const rep = await run(["report"]);
    assert.match(rep.out, new RegExp(`^- Waiting for your Land It \\(or "land it" typed there\\): feat/landq at ${head.slice(0, 7)} in "Chat of ${OWNER}" \\(#/sid/${OWNER}\\)$`, "m"));
    writeFileSync(landingFile, JSON.stringify({ v: 1, goAheads: [], notYet: [{ branch: "feat/landq", commit: head, at: "x" }] }));
    assert.match(await line(), /the user said Not Yet at [0-9a-f]{7}: it waits for a new commit/);
    assert.equal(JSON.parse((await run(["status", "--json"])).out).branches.find((b) => b.branch === "feat/landq").group, "not-ready");
    writeFileSync(landingFile, JSON.stringify({ v: 1, goAheads: [{ branch: "feat/landq", commit: head, at: "x", by: "land-it" }], notYet: [] }));
    assert.match(await line(), /the user's go-ahead \(Land It\) at [0-9a-f]{7}/);
    const go = await run(["status", "--json"]);
    assert.equal(JSON.parse(go.out).branches.find((b) => b.branch === "feat/landq").group, "check", "Land It is the go-ahead");
    // The press survives a clean merge of master into the branch (the check's own), and nothing else.
    const masterBefore = git(main, "rev-parse", "master");
    writeFileSync(join(main, "landq-master.txt"), "master moved\n");
    git(main, "add", "landq-master.txt");
    git(main, "commit", "-q", "-m", "master moves");
    git(wt("feat/landq"), "merge", "--no-edit", "-q", "master");
    const merged = git(main, "rev-parse", "feat/landq");
    writeBoard([["feat/landq", "waiting-approval", OWNER, "idle", undefined, landed("feat/landq")]]);
    assert.equal(JSON.parse((await run(["status", "--json"])).out).branches.find((b) => b.branch === "feat/landq").group, "check", "carried over the clean merge");
    assert.match(await line(), new RegExp(`the user's go-ahead \\(Land It\\) at ${head.slice(0, 7)}, carried to ${merged.slice(0, 7)} over clean master merges`));
    writeFileSync(join(wt("feat/landq"), "landq.txt"), "edited after the press\n");
    git(wt("feat/landq"), "commit", "-q", "-am", "more work");
    assert.notEqual(JSON.parse((await run(["status", "--json"])).out).branches.find((b) => b.branch === "feat/landq").group, "check", "a commit of its own needs a new press");
    git(wt("feat/landq"), "reset", "-q", "--hard", head);
    git(main, "update-ref", "refs/heads/master", masterBefore);
    git(main, "reset", "-q", "--hard", masterBefore);
    // Sova refused to show it: ask says so, and the branch is the user's word to land.
    writeFileSync(landingFile, JSON.stringify({ v: 1, goAheads: [], notYet: [] }));
    writeFileSync(shownFile, JSON.stringify({ v: 1, results: { [entries[0].id]: { at: Date.now(), refused: "an open offer" } } }));
    assert.match(await line(), /Sova didn't show the card: an open offer/);
    const old = await run(["ask", "feat/landq"]);
    assert.equal(old.code, 1, old.out);
    assert.match(old.out, /Sova didn't show feat\/landq's Landing card at [0-9a-f]{7}: an open offer\./);
    assert.match(old.out, /round\.mjs go/);
    // q1: refused for a reason of the owner's chat alone, but Sova gave it a row on the captain's card: it waits
    // there, never stopped on the refusal, and the captain says it is "on the card below".
    writeBoard([["feat/landq", "waiting-approval", OWNER, "idle", undefined, landed("feat/landq")]]);
    writeFileSync(shownFile, JSON.stringify({ v: 1, results: { [entries[0].id]: { at: Date.now(), refused: "an open offer", row: { card: "of_2", row: "r_1" } } } }));
    assert.equal(JSON.parse((await run(["status", "--json"])).out).branches.find((b) => b.branch === "feat/landq").group, "waiting");
    assert.match(await line(), new RegExp(`on the card below; the owner's card in "Chat of ${OWNER}" \\(#/sid/${OWNER}\\) wasn't shown: an open offer`));
    const again = await run(["ask", "feat/landq"]);
    assert.equal(again.code, 1, again.out);
    assert.doesNotMatch(again.out, /Sova didn't show/);
    assert.match(again.out, /already queued at [0-9a-f]{7}: on the card below/);
    const rows = await run(["report"]);
    assert.match(rows.out, new RegExp(`^- Waiting for your answer on the card below: feat/landq at ${head.slice(0, 7)} \\(owner "Chat of ${OWNER}" \\(#/sid/${OWNER}\\)\\)$`, "m"));
    assert.doesNotMatch(rows.out, /Waiting for your Land It/);
    // Shown in both places: the row and the owner's card.
    writeFileSync(shownFile, JSON.stringify({ v: 1, results: { [entries[0].id]: { at: Date.now(), card: "of_1", row: { card: "of_2", row: "r_1" } } } }));
    assert.match(await line(), new RegExp(`on the card below, and its Landing card in "Chat of ${OWNER}"`));
  } finally {
    writeFileSync(stateFile, saved);
    for (const f of [queueFile, shownFile, landingFile, boardFile]) rmSync(f, { force: true });
  }
});

test("go: the user's word in this chat is a go-ahead at the head, straight to check whatever the board reads; a later Not Yet holds it", async () => {
  const landingFile = join(agent, "sova", "landing.json");
  const saved = readFileSync(stateFile, "utf8");
  try {
    git(main, "worktree", "add", "-q", "-b", "feat/word", wt("feat/word"), "master");
    writeFileSync(join(wt("feat/word"), "word.txt"), "word\n");
    git(wt("feat/word"), "add", "word.txt");
    git(wt("feat/word"), "commit", "-q", "-m", "word");
    const head = git(main, "rev-parse", "feat/word");
    writeBoard([["feat/word", "in-progress", OWNER, "busy"]]);
    const group = async () => JSON.parse((await run(["status", "--json"])).out).branches.find((b) => b.branch === "feat/word").group;
    assert.equal(await group(), "not-ready");
    const go = await run(["go", "feat/word"]);
    assert.equal(go.code, 0, go.out);
    assert.match(go.out, /^next: round\.mjs check feat\/word$/m);
    // b1: the word is in Sova's landing.json too, marked as given in the captain's chat, so the owner's Landing
    // card and the captain's row settle and say where (§chat.worktrees/landing-answers).
    const kept = JSON.parse(readFileSync(landingFile, "utf8"));
    assert.deepEqual(kept.goAheads.map((g) => [g.branch, g.commit, g.by, g.in]), [["feat/word", head, "captain-chat", ME]]);
    assert.equal(goAheadWord("captain-chat"), "word in this chat");
    assert.equal(await group(), "check", "in progress, its owner busy: the user's word checks it anyway");
    assert.match((await run(["status"])).out, new RegExp(`the user's go-ahead \\(word in this chat\\) at ${head.slice(0, 7)}`));
    writeFileSync(landingFile, JSON.stringify({ v: 1, goAheads: [], notYet: [{ branch: "feat/word", commit: head, at: new Date(Date.now() + 60_000).toISOString() }] }));
    assert.equal(await group(), "not-ready", "a Not Yet pressed after the word holds it");
    assert.equal((await run(["go", "feat/word", "now"])).code, 2, "only without-specs");
  } finally {
    writeFileSync(stateFile, saved);
    rmSync(landingFile, { force: true });
    git(main, "worktree", "remove", "--force", wt("feat/word"));
    git(main, "branch", "-D", "feat/word");
  }
});

test("owner chat: the user's \"land it\" typed in the branch's own chat (worktree land) is a go-ahead at the head, straight to check, named as such", async () => {
  const landingFile = join(agent, "sova", "landing.json");
  const saved = readFileSync(stateFile, "utf8");
  try {
    git(main, "worktree", "add", "-q", "-b", "feat/typed", wt("feat/typed"), "master");
    writeFileSync(join(wt("feat/typed"), "typed.txt"), "typed\n");
    git(wt("feat/typed"), "add", "typed.txt");
    git(wt("feat/typed"), "commit", "-q", "-m", "typed");
    const head = git(main, "rev-parse", "feat/typed");
    // Not Ready to land, no card ever shown: the typed word alone checks it.
    writeBoard([["feat/typed", "in-progress", OWNER, "idle"]]);
    const group = async () => JSON.parse((await run(["status", "--json"])).out).branches.find((b) => b.branch === "feat/typed").group;
    assert.equal(await group(), "not-ready");
    writeFileSync(landingFile, JSON.stringify({ v: 1, goAheads: [{ branch: "feat/typed", commit: head, session: OWNER, at: new Date().toISOString(), by: "owner-chat" }], notYet: [] }));
    assert.equal(await group(), "check", "the user's typed word in the owner's chat checks it, card or not");
    const st = (await run(["status"])).out;
    assert.match(st, new RegExp(`the user's go-ahead \\(word typed in its own chat\\) at ${head.slice(0, 7)}`));
    assert.doesNotMatch(st, /press/i);
  } finally {
    writeFileSync(stateFile, saved);
    rmSync(landingFile, { force: true });
    git(main, "worktree", "remove", "--force", wt("feat/typed"));
    git(main, "branch", "-D", "feat/typed");
  }
});

test("Land It before the check: the check's own clean merge of master keeps it, and the branch lands with no new press", async () => {
  const sova = join(agent, "sova");
  const landingFile = join(sova, "landing.json");
  const saved = readFileSync(stateFile, "utf8");
  const masterBefore = git(main, "rev-parse", "master");
  try {
    git(main, "worktree", "add", "-q", "-b", "feat/carry", wt("feat/carry"), "master");
    const P = commit(wt("feat/carry"), "carry.txt", "carry\n", "carry: a file");
    writeBoard([["feat/carry", "waiting-approval", OWNER, "idle", undefined, landed("feat/carry")]]);
    writeFileSync(landingFile, JSON.stringify({ v: 1, goAheads: [{ branch: "feat/carry", commit: P, at: new Date().toISOString(), by: "land-it" }], notYet: [] }));
    const group = async () => JSON.parse((await run(["status", "--json"])).out).branches.find((b) => b.branch === "feat/carry").group;
    assert.equal(await group(), "check", "Land It at P");
    // Master moves on; the check merges it into the branch, so the head is no longer P.
    commit(main, "carry-master.txt", "master moved\n", "master: moves on for carry");
    const c = await run(["check", "feat/carry"]);
    assert.equal(c.code, 0, c.out);
    const M = git(main, "rev-parse", "feat/carry");
    assert.notEqual(M, P, "the check merged master in");
    assert.equal(git(main, "rev-parse", "feat/carry^1"), P);
    assert.equal(await group(), "land", "the press at P counts at M");
    const land = await run(["land", "feat/carry"]);
    assert.equal(land.code, 0, land.out);
    assert.match(land.out, new RegExp(`^The user's Land It at ${P.slice(0, 7)}\\.$`, "m"));
    assert.match(land.out, /call: worktree \{"action":"merge"/);
    // The user's Not Yet at P after it holds the branch, at M too, and land refuses.
    writeFileSync(landingFile, JSON.stringify({ v: 1, goAheads: [{ branch: "feat/carry", commit: P, at: "2026-10-24T00:00:00Z", by: "land-it" }], notYet: [{ branch: "feat/carry", commit: P, at: "2026-10-24T00:05:00Z" }] }));
    assert.equal(await group(), "not-ready");
    const held = await run(["land", "feat/carry"]);
    assert.equal(held.code, 1, held.out);
    assert.match(held.out, new RegExp(`The user said Not Yet to feat/carry at ${P.slice(0, 7)}`));
  } finally {
    writeFileSync(stateFile, saved);
    for (const f of [landingFile, boardFile]) rmSync(f, { force: true });
    spawnSyncGit(main, ["worktree", "remove", "--force", wt("feat/carry")]);
    spawnSyncGit(main, ["branch", "-D", "feat/carry"]);
    git(main, "update-ref", "refs/heads/master", masterBefore);
    git(main, "reset", "-q", "--hard", masterBefore);
  }
});

test("landingAnswerAt: a later Not Yet on the way stops the carry; the newest answer at a commit wins", async () => {
  const [A, B, C] = ["a", "b", "c"].map((c) => c.repeat(40));
  const parentOf = async (s) => (s === C ? B : s === B ? A : undefined);
  const go = (commit, at) => ({ branch: "f", commit, at, by: "land-it" });
  const no = (commit, at) => ({ branch: "f", commit, at });
  const kind = async (landing, head) => (await landingAnswerAt(landing, "f", head, parentOf))?.kind ?? null;
  assert.deepEqual(await landingAnswerAt({ goAheads: [go(A, "2026-10-24T00:00:00Z")], notYet: [] }, "f", C, parentOf), { kind: "go-ahead", withoutSpecs: false, by: "land-it", at: A });
  const later = { goAheads: [go(A, "2026-10-24T00:00:00Z")], notYet: [no(B, "2026-10-24T00:05:00Z")] };
  assert.deepEqual(await landingAnswerAt(later, "f", C, parentOf), { kind: "not-yet", at: B }, "Not Yet at B is never walked past, and holds C");
  assert.equal(await kind(later, B), "not-yet");
  assert.equal(await kind({ goAheads: [go(A, "2026-10-24T00:00:00Z")], notYet: [no(A, "2026-10-24T00:05:00Z")] }, C), "not-yet", "Not Yet at A after its go-ahead");
  assert.equal(await kind({ goAheads: [], notYet: [no(A, "2026-10-24T00:05:00Z")] }, C), "not-yet", "a Not Yet alone carries too");
  assert.equal(await kind({ goAheads: [go(A, "2026-10-24T00:00:00Z")], notYet: [] }, "d".repeat(40)), null, "a commit of its own: no answer");
  assert.equal(await kind({ goAheads: [go(A, "2026-10-24T00:00:00Z"), go(B, "2026-10-24T00:10:00Z")], notYet: [no(B, "2026-10-24T00:05:00Z")] }, C), "go-ahead", "a go-ahead at B after its Not Yet");
  assert.equal(await kind({ goAheads: [go(B, "2026-10-24T00:05:00Z")], notYet: [no(B, "2026-10-24T00:05:00Z")] }, B), "not-yet", "a tie is Not Yet");
});

// ---------------------------------------------------------------- the spec's record layout after a master merge
// Branches cut before master gains the per-area layout's marker; each merge of master is clean in Git.
const layoutCase = { made: false };
const makeLayoutBranches = () => {
  if (layoutCase.made) return;
  layoutCase.made = true;
  const cut = (name, file, text) => { git(main, "worktree", "add", "-q", wt(name), "-b", name); commit(wt(name), file, text, `${name}: ${file}`); };
  cut("feat/plain", "plain.txt", "plain\n");
  cut("feat/plain-garbage", "plain2.txt", "plain\n");
  cut("feat/plain-notool", "plain3.txt", "plain\n");
  cut("feat/v1side", ".sova/spec/claims/v1-marker", "v1\n");
  cut("feat/v1side-refused", ".sova/spec/claims/v1-marker", "v1\n");
  cut("feat/records-broken", ".sova/spec/manifest.json", "{ not json\n");
  commit(main, ".sova/spec/claims/v2-marker.json", "{}\n", "master: per-area records");
};
const headOf = (name) => git(wt(name), "rev-parse", "HEAD");
const merging = (name) => { try { git(wt(name), "rev-parse", "-q", "--verify", "MERGE_HEAD"); return true; } catch { return false; } };
const asItWas = (name, head) => {
  assert.equal(headOf(name), head, `${name}: no commit was made`);
  assert.equal(merging(name), false, `${name}: no merge left in progress`);
  assert.equal(git(wt(name), "status", "--porcelain", "--untracked-files=all"), "", `${name}: the tree is as it was`);
};

test("check: a clean master merge still makes the merge commit Git's own merge makes", async () => {
  makeLayoutBranches();
  const before = headOf("feat/plain"), master = git(main, "rev-parse", "master");
  // What the round's merge made before it stopped short of the commit: `git merge --no-edit refs/heads/master`.
  const old = join(root, "old-merge");
  git(main, "worktree", "add", "-q", "--detach", old, before);
  git(old, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", "refs/heads/master");
  // (Detached there, Git names the target HEAD; on the branch it names the branch.)
  const [tree, subject] = [git(old, "rev-parse", "HEAD^{tree}"), git(old, "log", "-1", "--format=%s").replace(/ into HEAD$/, " into feat/plain")];
  git(main, "worktree", "remove", "--force", old);
  const r = await run(["check", "feat/plain"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Merged master [0-9a-f]{7} into feat\/plain\./);
  assert.doesNotMatch(r.out, /records both ways/);
  assert.equal(git(wt("feat/plain"), "rev-parse", "HEAD^1"), before, "first parent: the branch");
  assert.equal(git(wt("feat/plain"), "rev-parse", "HEAD^2"), master, "second parent: master");
  assert.equal(git(wt("feat/plain"), "rev-parse", "HEAD^{tree}"), tree, "the tree Git's merge gives");
  assert.equal(git(wt("feat/plain"), "log", "-1", "--format=%s"), subject, "the message the one-step merge gave");
  assert.match(subject, /^Merge branch '.*master' into feat\/plain$/);
  assert.equal(merging("feat/plain"), false);
  assert.equal(git(wt("feat/plain"), "status", "--porcelain", "--untracked-files=all"), "");
});

test("check: a clean merge that leaves the spec in both record layouts is finished by merge-manifest before the merge commit", async () => {
  makeLayoutBranches();
  const before = headOf("feat/v1side");
  const r = await run(["check", "feat/v1side"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /records both ways; merge-manifest --write finished it per record/);
  assert.equal(git(wt("feat/v1side"), "rev-parse", "HEAD^1"), before);
  assert.equal(git(wt("feat/v1side"), "rev-parse", "HEAD^2"), git(main, "rev-parse", "master"));
  // The committed merge is never mixed: the old layout's marker went in the same commit, the new one stayed.
  assert.equal(git(wt("feat/v1side"), "ls-tree", "--name-only", "HEAD", ".sova/spec/claims/v1-marker"), "");
  assert.equal(git(wt("feat/v1side"), "ls-tree", "--name-only", "HEAD", ".sova/spec/claims/v2-marker.json"), ".sova/spec/claims/v2-marker.json");
  assert.equal(git(wt("feat/v1side"), "show", "HEAD:.sova/spec/manifest.json"), '{"merged":true}');
  assert.equal(git(wt("feat/v1side"), "status", "--porcelain", "--untracked-files=all"), "");
});

test("check: a merge whose spec can't be finished, whose records don't read, or that no tool answers for, is aborted as it was", async () => {
  makeLayoutBranches();
  const masterBefore = git(main, "rev-parse", "master");
  const refusedHead = headOf("feat/v1side-refused");
  const refused = await run(["check", "feat/v1side-refused"], { env: { FAKE_MANIFEST_REFUSE: "1" } });
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /leaves its spec holding records both ways, and it couldn't be finished \(merge-manifest --write: exit 1\): the merge was aborted/);
  assert.match(refused.out, /next: merge master in .* merge-manifest --root .* --write before committing/);
  asItWas("feat/v1side-refused", refusedHead);

  const brokenHead = headOf("feat/records-broken");
  const broken = await run(["check", "feat/records-broken"]);
  assert.equal(broken.code, 1, broken.out);
  assert.match(broken.out, /leaves spec records that don't read \(manifest-unreadable: manifest\.json: not JSON\): the merge was aborted/);
  asItWas("feat/records-broken", brokenHead);

  const garbageHead = headOf("feat/plain-garbage");
  const garbage = await run(["check", "feat/plain-garbage"], { env: { FAKE_RECORDS_GARBAGE: "1" } });
  assert.equal(garbage.code, 1, garbage.out);
  assert.match(garbage.out, /leaves a spec whose records the spec tool couldn't read \(the spec tool printed no JSON \(exit 2\)\): the merge was aborted/);
  asItWas("feat/plain-garbage", garbageHead);

  // A spec and no spec tool to read it: never committed unread.
  const noToolHead = headOf("feat/plain-notool");
  const noTool = await run(["check", "feat/plain-notool"], { env: { SOVA_ROUND_SPEC_CORE: join(root, "no-spec-core") } });
  assert.equal(noTool.code, 1, noTool.out);
  assert.match(noTool.out, /leaves a spec whose records the spec tool couldn't read \(no spec tool to read the records\): the merge was aborted/);
  asItWas("feat/plain-notool", noToolHead);
  assert.equal(git(main, "rev-parse", "master"), masterBefore, "check wrote to master");
});
