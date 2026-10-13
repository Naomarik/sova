// Run: pnpm test:int -- scripts/run-tests.integration.test.ts. A test file's process never outlives the
// runner: a wrapper that kills only run-tests.mjs with SIGKILL (which it can't catch) once left a bun
// test running on, growing to ~100 GB.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
