// scripts/dev-server.mjs: a watched-file change restarts the server after the debounce, whatever the
// sessions are doing. The watcher runs for real from a copy in a scratch tree (its watch root), with
// a stand-in "bun" (SOVA_BUN) that logs each start and writes a busy live record under its own pid.
//   node scripts/run-tests.mjs --integration scripts/dev-server.integration.test.ts
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "sova-dev-server-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const starts = (log: string) => {
  try {
    return readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("start "));
  } catch {
    return [];
  }
};

async function until(what: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (what()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return what();
}

test("a watched-file change restarts the server after the debounce, with a busy live record present", async () => {
  const root = join(scratch, "tree");
  for (const d of ["scripts", "server", "shared", join("pi-config", "extensions", "mode"), "bin"]) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(join(REPO, "scripts", "dev-server.mjs"), join(root, "scripts", "dev-server.mjs"));
  copyFileSync(join(REPO, "server", "runtime-choice.ts"), join(root, "server", "runtime-choice.ts"));
  const agent = join(scratch, "agent");
  const log = join(scratch, "starts.log");
  const bun = join(root, "bin", "bun");
  // The "server": a session with a worker working and a turn in flight, its record fresh, under its pid.
  writeFileSync(
    bun,
    `#!/bin/sh
echo "start $$" >> "$DEV_TEST_LOG"
mkdir -p "$PI_CODING_AGENT_DIR/sessions/live"
now=$(($(date +%s) * 1000))
printf '{"v":1,"session":{"id":"p%s-aaaaaaaa","pid":%s,"sessionId":"busy","name":"busy","cwd":"/","model":"m","startedAt":%s,"lastActivity":%s},"presence":{"workerCounts":{"working":1},"workers":[{"name":"ag_01","status":"running"}],"activity":{"state":"working"}},"heartbeat":%s}' $$ $$ $now $now $now > "$PI_CODING_AGENT_DIR/sessions/live/p$$-aaaaaaaa.json"
trap 'exit 0' TERM INT
while :; do sleep 0.05; done
`,
  );
  chmodSync(bun, 0o755);
  const env: Record<string, string | undefined> = { ...process.env, SOVA_BUN: bun, PI_CODING_AGENT_DIR: agent, DEV_TEST_LOG: log };
  delete env.SOVA_RUNTIME;
  let out = "";
  const watcher = spawn(process.execPath, [join(root, "scripts", "dev-server.mjs")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  watcher.stdout.on("data", (d) => (out += d));
  watcher.stderr.on("data", (d) => (out += d));
  try {
    expect(await until(() => starts(log).length === 1, 10_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 300)); // the record is written and the watch is set up
    writeFileSync(join(root, "server", "edited.ts"), "export const x = 1;\n");
    const restarted = await until(() => starts(log).length === 2, 5_000);
    expect(restarted, out).toBe(true);
    expect(out).toContain("restarting (server/edited.ts)");
    expect(out).not.toContain("pending");
  } finally {
    const exited = new Promise((r) => watcher.on("exit", r));
    watcher.kill("SIGTERM");
    await exited;
  }
}, 30_000);
