// Run: node scripts/run-tests.mjs server/claude-pool/agent.integration.test.ts
// The pool against real processes: a process named claude on a login (its lease's child, stopped at
// the cut), a dead owner and a reused pid as the real liveness and `claude` checks see them, and the
// /proc scan for a claude without a lease. The same rules with faked pids: agent.test.ts.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { readLeaving } from "../../pi-config/extensions/claude-code/accounts.ts";
import { scanClaudeProcs } from "./agent";
import { credsPath, holder, L1, MIN, pool, root, usableOn, want } from "./pool-test-fixtures";

after(() => rmSync(root, { recursive: true, force: true }));

describe("returning", () => {
  async function borrowed() {
    const p = await pool();
    const d = p.w.dev("d");
    want(d);
    await d.agent.tick();
    assert.deepEqual(usableOn(p.w, L1), ["d"]);
    return { ...p, d };
  }

  test("a login is not handed over while a process runs on it; at the cut its claude is stopped", async () => {
    const { w, d, k, clock } = await borrowed();
    // A live process (this test's) with a busy user on L1 and its claude child: its lease, which
    // the owner rewrites every few seconds.
    const dir = join(d.agentDir, "claude-accounts", L1);
    const leases = join(dir, ".sova-leases");
    mkdirSync(leases, { recursive: true });
    // A process named claude (macOS reads no other process's environment, only its name and age): sleep, through a link.
    const bin = join(d.agentDir, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(spawnSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim(), join(bin, "claude"));
    const claude = spawn(join(bin, "claude"), ["60"], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, stdio: "ignore" });
    const lease = () => writeFileSync(join(leases, `${process.pid}.json`), JSON.stringify({ v: 1, owner: process.pid, users: 1, busy: 1, children: [claude.pid], lastActiveAt: clock.now, at: clock.now }));
    try {
      await new Promise((r) => setTimeout(r, 100));
      lease();
      k.agent.askReturn(L1);
      await w.syncAll();
      await d.agent.tick();
      assert.equal(readLeaving(d.agentDir, L1)?.reason, "user");
      assert.ok(existsSync(credsPath(d, L1)), "still here: a process runs on it");
      assert.deepEqual(usableOn(w, L1), [], "but no new process may take it");
      clock.now += 16 * MIN;
      lease();
      await d.agent.tick();
      assert.deepEqual(w.killed, [claude.pid], "the cut stops the claude process still on it");
    } finally {
      claude.kill();
    }
    rmSync(leases, { recursive: true });
    await d.agent.tick();
    assert.equal(existsSync(credsPath(d, L1)), false, "then it goes");
    assert.equal(holder(k, L1)!.free, true);
  });

  test("a stale lease (its owner gone, its child pid reused by another process) holds nothing and nothing is stopped", async () => {
    const { w, d, k, clock } = await borrowed();
    const leases = join(d.agentDir, "claude-accounts", L1, ".sova-leases");
    mkdirSync(leases, { recursive: true });
    // A dead owner whose recorded child pid now belongs to an unrelated live process (this test's),
    // and a live pid as owner that stopped rewriting its lease long ago (a reused owner pid).
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    writeFileSync(join(leases, `${dead}.json`), JSON.stringify({ v: 1, owner: dead, users: 1, busy: 1, children: [process.pid, process.pid], lastActiveAt: clock.now, at: clock.now }));
    writeFileSync(join(leases, `${process.pid}.json`), JSON.stringify({ v: 1, owner: process.pid, users: 1, busy: 1, children: [], lastActiveAt: clock.now - 5 * MIN, at: clock.now - 5 * MIN }));
    k.agent.askReturn(L1);
    await w.syncAll();
    await d.agent.tick();
    await d.agent.tick();
    assert.deepEqual(w.killed, [], "no pid from a stale lease is signalled");
    assert.equal(existsSync(credsPath(d, L1)), false, "the login went back without waiting for a cut");
    assert.equal(holder(k, L1)!.free, true);
  });
});

describe("processes without a lease (started before this version, or by hand)", () => {
  test("/proc: a claude process is found by its CLAUDE_CONFIG_DIR; a tool's shell under it is not", { skip: process.platform !== "linux" }, async () => {
    const dir = join(root, "proc-scan", "claude-accounts", L1);
    mkdirSync(dir, { recursive: true });
    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
    const claude = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "fake-claude"], { env, stdio: "ignore" });
    const shell = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "a-tool-shell"], { env, stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const found = scanClaudeProcs().get(dir) ?? [];
      assert.deepEqual(found, [claude.pid]);
    } finally {
      claude.kill();
      shell.kill();
    }
  });
});
