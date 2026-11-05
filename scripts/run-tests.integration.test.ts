// Run: pnpm test:int -- scripts/run-tests.integration.test.ts. Nothing a run starts outlives it: a test
// file's process (a wrapper that killed only run-tests.mjs with SIGKILL, which it can't catch, once left
// a bun test running on, growing to ~100 GB), nor a chat process a test's server left in its slice.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { resolveBun } from "../server/runtime-choice";
import { scratchRoot } from "../server/test-scratch";

const ROOT = resolve(import.meta.dirname, "..");
const base = scratchRoot("sova-runner-kill-");
after(() => rmSync(base, { recursive: true, force: true }));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (ok: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (ok()) return true;
  return ok();
};

test("a runner killed by SIGKILL takes its test files' processes, and its chat slice, with it within seconds", { timeout: 60_000 }, async (t) => {
  const bun = process.versions.bun ? { path: process.execPath } : resolveBun();
  if (!("path" in bun)) return t.skip(`no Bun to run the runner on (${bun.missing})`);
  const systemd = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;
  const unit = `sova_test_hang_${process.pid}_${Date.now()}.service`;
  const pidFile = join(base, "pid");
  // The file's temp root, which it says itself. The runner killed below can't remove it (on macOS it can
  // be outside this file's own root, under /tmp), so this test does, by that exact path once the file is gone.
  const rootFile = join(base, "killed-root");
  const probe = join(base, "hang.integration.test.ts");
  // A chat process its server left in the run's slice stands in as a unit there.
  writeFileSync(
    probe,
    `import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
test("hangs", { timeout: 120_000 }, async () => {
  const slice = process.env.SOVA_CHAT_SLICE ?? "";
  if (${systemd} && /^sova_test_/.test(slice)) execFileSync("systemd-run", ["--user", "--quiet", "--collect", "--slice=" + slice, "--unit=${unit}", "sleep", "300"]);
  writeFileSync(${JSON.stringify(rootFile)}, process.env.TMPDIR ?? "");
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  await new Promise((r) => setTimeout(r, 90_000));
});
`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, SOVA_BUN: bun.path };
  delete env.SOVA_RUNTIME;
  const runner = spawn("node", [join(ROOT, "scripts", "run-tests.mjs"), "--runtime", "bun", probe], { cwd: ROOT, env, stdio: "ignore" });
  let filePid = 0;
  try {
    assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", 30_000), "the test file started");
    filePid = Number(readFileSync(pidFile, "utf8"));
    assert.match(readFileSync(rootFile, "utf8"), /\/sova-test-home-[^/]+$/, "the file said its root, so the cleanup below can't silently do nothing");
    assert.ok(alive(filePid));
    runner.kill("SIGKILL");
    assert.ok(await until(() => !alive(filePid), 8_000), `the test file's process ${filePid} still runs 8 s after its runner was killed`);
    if (systemd) assert.notEqual(spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8" }).stdout.trim(), "active", "the run's slice was stopped");
  } finally {
    runner.kill("SIGKILL");
    if (filePid && alive(filePid)) process.kill(filePid, "SIGKILL");
    if (systemd) spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
    const killedRoot = existsSync(rootFile) ? readFileSync(rootFile, "utf8") : "";
    if (/\/sova-test-home-[^/]+$/.test(killedRoot)) {
      rmSync(killedRoot, { recursive: true, force: true });
      assert.ok(!existsSync(killedRoot), `the killed runner's root is gone: ${killedRoot}`);
    }
  }
});

test("a run's chat processes go into a slice of its own, never the live sova-chats.slice, and are stopped when the run ends", { timeout: 120_000 }, async (t) => {
  const bun = process.versions.bun ? { path: process.execPath } : resolveBun();
  if (!("path" in bun)) return t.skip(`no Bun to run the runner on (${bun.missing})`);
  const systemd = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;
  const out = join(base, "slice.json");
  const unit = `sova_test_probe_${process.pid}_${Date.now()}.service`;
  const probe = join(base, "slice.integration.test.ts");
  // As a whole-server test would: the slice its chat host's supervisor takes. A unit is started there
  // (never in the live slice) to stand for a chat process the test's server left running.
  writeFileSync(
    probe,
    `import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
const { CHAT_SLICE, supervisorConfig } = await import(${JSON.stringify(join(ROOT, "server", "chat-runtime", "supervisor.ts"))});
test("slice", () => {
  const slice = supervisorConfig().slice;
  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ slice, live: CHAT_SLICE }));
  if (${systemd} && slice !== CHAT_SLICE) execFileSync("systemd-run", ["--user", "--quiet", "--collect", "--slice=" + slice, "--unit=${unit}", "sleep", "300"]);
});
`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, SOVA_BUN: bun.path };
  delete env.SOVA_RUNTIME;
  delete env.SOVA_CHAT_SLICE; // as from a shell: the run makes its own
  try {
    const r = spawnSync("node", [join(ROOT, "scripts", "run-tests.mjs"), "--runtime", "bun", probe], { cwd: ROOT, env, encoding: "utf8", timeout: 100_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const seen = JSON.parse(readFileSync(out, "utf8")) as { slice: string; live: string };
    assert.notEqual(seen.slice, seen.live, "never the live slice");
    assert.match(seen.slice, /^sova_test_\d+_[0-9a-f]+\.slice$/);
    if (!systemd) return;
    const state = spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8" }).stdout.trim();
    assert.notEqual(state, "active", "the run's slice was stopped with the unit in it");
  } finally {
    if (systemd) spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
  }
});

test("a chat process a test's server left on the detached driver is stopped by its record when the file ends; one whose record doesn't match is not", { timeout: 120_000 }, async (t) => {
  const bun = process.versions.bun ? { path: process.execPath } : resolveBun();
  if (!("path" in bun)) return t.skip(`no Bun to run the runner on (${bun.missing})`);
  const out = join(base, "detached.json");
  const probe = join(base, "detached.integration.test.ts");
  // As the detached driver leaves one: a session of its own running server/chat-runtime/main.ts, and its
  // record under the file's state root. A second record names a live process by another start time.
  writeFileSync(
    probe,
    `import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { hostProcTable } = await import(${JSON.stringify(join(ROOT, "server", "project-services", "proctable.ts"))});
test("leaves a chat process behind", async () => {
  const procs = join(tmpdir(), "agent", "sova", "chats", "procs");
  mkdirSync(procs, { recursive: true });
  const start = (argv) => {
    const c = spawn(process.execPath, argv, { detached: true, stdio: "ignore" });
    c.unref();
    return c.pid;
  };
  const chat = start(["-e", "setInterval(() => {}, 1000)", "/x/server/chat-runtime/main.ts"]);
  const other = start(["-e", "setInterval(() => {}, 1000)", "/x/server/chat-runtime/main.ts"]);
  await new Promise((r) => setTimeout(r, 300));
  const table = hostProcTable();
  writeFileSync(join(procs, "a.json"), JSON.stringify({ pid: chat, start: table.startOf(chat), clock: table.kind }));
  writeFileSync(join(procs, "b.json"), JSON.stringify({ pid: other, start: "not its start", clock: table.kind }));
  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ chat, other }));
});
`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, SOVA_BUN: bun.path };
  delete env.SOVA_RUNTIME;
  let pids: { chat: number; other: number } | null = null;
  try {
    const r = spawnSync("node", [join(ROOT, "scripts", "run-tests.mjs"), "--runtime", "bun", probe], { cwd: ROOT, env, encoding: "utf8", timeout: 100_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    pids = JSON.parse(readFileSync(out, "utf8"));
    assert.ok(await until(() => !alive(pids!.chat), 2_000), "the recorded chat process is gone once its file ended");
    assert.ok(alive(pids!.other), "a process whose start time doesn't match its record is never touched");
  } finally {
    for (const pid of [pids?.chat, pids?.other]) if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  }
});

test("macOS, a temp dir too long for Chromium's sockets: a file's root goes under /tmp, and goes when the file ends and when the runner is stopped", { timeout: 90_000, skip: process.platform !== "darwin" ? "macOS only" : false }, async (t) => {
  const bun = process.versions.bun ? { path: process.execPath } : resolveBun();
  if (!("path" in bun)) return t.skip(`no Bun to run the runner on (${bun.missing})`);
  try { rmSync(mkdtempSync("/tmp/sova-root-check-"), { recursive: true }); } catch { return t.skip("/tmp is closed here"); }
  const long = join(base, "x".repeat(60));
  mkdirSync(long, { recursive: true });
  const seen = join(base, "root-seen");
  const probe = (name: string, body: string) => {
    const file = join(base, name);
    writeFileSync(file, `import { writeFileSync } from "node:fs";
import { test } from "node:test";
test("says its temp dir", { timeout: 60_000 }, async () => {
  writeFileSync(${JSON.stringify(seen)}, process.env.TMPDIR ?? "");
  ${body}
});
`);
    return file;
  };
  const env: NodeJS.ProcessEnv = { ...process.env, SOVA_BUN: bun.path, TMPDIR: long };
  delete env.SOVA_RUNTIME;
  const run = (file: string) => spawn("node", [join(ROOT, "scripts", "run-tests.mjs"), "--runtime", "bun", file], { cwd: ROOT, env, stdio: "ignore" });
  const rootSeen = () => {
    const root = readFileSync(seen, "utf8");
    assert.match(root, /^\/tmp\/sova-test-home-[^/]+$/, "a file's temp dir is its own root under /tmp, not the long one");
    return root;
  };

  // A file that ends: its root goes with it.
  const ends = run(probe("ends.integration.test.ts", ""));
  await once(ends, "close");
  assert.ok(!existsSync(rootSeen()), "gone when the file ended");

  // A runner stopped by a signal while the file still runs: its exit takes the root.
  rmSync(seen, { force: true });
  const hangs = run(probe("hangs.integration.test.ts", "await new Promise((r) => setTimeout(r, 50_000));"));
  try {
    assert.ok(await until(() => existsSync(seen) && readFileSync(seen, "utf8") !== "", 30_000), "the test file started");
    const root = rootSeen();
    assert.ok(existsSync(root), "control: the root is there while the file runs");
    hangs.kill("SIGTERM");
    assert.ok(await until(() => !existsSync(root), 8_000), `${root} still there 8 s after its runner was stopped`);
  } finally {
    hangs.kill("SIGKILL");
    // Only when the assertion above failed: the runner never got to remove it.
    const left = existsSync(seen) ? readFileSync(seen, "utf8") : "";
    if (/^\/tmp\/sova-test-home-[^/]+$/.test(left)) rmSync(left, { recursive: true, force: true });
  }
});

test("a usage error writes a report counting no test (SOVA_OUT), so the merge queue can tell \"no test ran\" from a crash", async () => {
  const { ranNoTest, readCheckOut } = await import("../server/merge-queue/checks");
  const cases: [string[], RegExp][] = [
    [["--integration", "--groups"], /--groups needs a value/],
    [["--groups", "no-such-group"], /no test group no-such-group/],
    [["--integration", "--all"], /usage:/],
    [["server"], /is a folder/],
  ];
  for (const [args, said] of cases) {
    const out = join(base, `usage-${args.join("_").replace(/\W/g, "")}.json`);
    const r = spawnSync("node", ["scripts/run-tests.mjs", ...args], { cwd: ROOT, env: { ...process.env, SOVA_OUT: out }, encoding: "utf8" });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, said);
    const report = readCheckOut(out);
    assert.ok(report, `${args.join(" ")}: a report at ${out}`);
    assert.equal(report.passed, 0);
    assert.equal(report.failed, 0);
    assert.equal(ranNoTest({ failingFiles: report.failingFiles, report }), true, args.join(" "));
  }
});
