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

test("a runner killed by SIGKILL takes its test files' processes with it within seconds", { timeout: 60_000 }, async (t) => {
  const bun = process.versions.bun ? { path: process.execPath } : resolveBun();
  if (!("path" in bun)) return t.skip(`no Bun to run the runner on (${bun.missing})`);
  const pidFile = join(base, "pid");
  const probe = join(base, "hang.integration.test.ts");
  writeFileSync(
    probe,
    `import { writeFileSync } from "node:fs";
import { test } from "node:test";
test("hangs", { timeout: 120_000 }, async () => {
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
  } finally {
    runner.kill("SIGKILL");
    if (filePid && alive(filePid)) process.kill(filePid, "SIGKILL");
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
