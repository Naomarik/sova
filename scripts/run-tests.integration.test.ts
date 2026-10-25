// Run: pnpm test:int -- scripts/run-tests.integration.test.ts. Nothing a run starts outlives it: a test
// file's process (a wrapper that killed only run-tests.mjs with SIGKILL, which it can't catch, once left
// a bun test running on, growing to ~100 GB), nor a chat process a test's server left in its slice.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.ok(alive(filePid));
    runner.kill("SIGKILL");
    assert.ok(await until(() => !alive(filePid), 8_000), `the test file's process ${filePid} still runs 8 s after its runner was killed`);
    if (systemd) assert.notEqual(spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8" }).stdout.trim(), "active", "the run's slice was stopped");
  } finally {
    runner.kill("SIGKILL");
    if (filePid && alive(filePid)) process.kill(filePid, "SIGKILL");
    if (systemd) spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
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
