// Run: npx tsx --test server/decide-llm-inflight.test.ts
// A Claude one-shot's in-flight call lasts until the process has exited, not until Sova gave up
// on it. A fake `claude` (no process, no model): it exits only when the test says so.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";
import { snapshot } from "../pi-config/extensions/llm-inflight/tracker.ts";
import { DecisionError } from "./decide";
import { claudeRun } from "./decide-llm";

type Child = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (sig?: string) => void; pid?: number; killed: boolean };

function lingering(): { spawn: typeof import("node:child_process").spawn; child: () => Child } {
  let last: Child | null = null;
  const spawn = (() => {
    const child = new EventEmitter() as Child;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4242;
    child.killed = false;
    child.kill = () => void (child.killed = true); // the signal is sent; the process is still there
    last = child;
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, child: () => last! };
}

const fail = (failure: string, message: string) => new DecisionError(failure as never, message);

describe("claude one-shot in flight", () => {
  let dir: string;
  let base: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decide-inflight-"));
    base = snapshot().active;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("counted from the spawn, still counted after a timeout's kill, ended at the exit", async () => {
    const f = lingering();
    const run = claudeRun(["-p"], "q", { spawn: f.spawn, agentDir: () => dir }, 30, fail);
    await new Promise((r) => setImmediate(r));
    assert.equal(snapshot().active, base + 1);
    assert.equal(snapshot().approximate >= 1, true);
    await assert.rejects(run, /did not answer/);
    assert.equal(f.child().killed, true);
    assert.equal(snapshot().active, base + 1, "killed but not yet exited: still in flight");
    f.child().emit("exit", null, "SIGKILL");
    f.child().emit("close", null);
    assert.equal(snapshot().active, base);
  });

  test("an abort is the same: the call ends at the exit", async () => {
    const f = lingering();
    const ac = new AbortController();
    const run = claudeRun(["-p"], "q", { spawn: f.spawn, agentDir: () => dir }, 10_000, fail, ac.signal);
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await assert.rejects(run);
    assert.equal(snapshot().active, base + 1);
    f.child().emit("exit", 1);
    assert.equal(snapshot().active, base);
  });

  test("a spawn that never started ends at once", async () => {
    const spawn = (() => {
      throw new Error("ENOENT");
    }) as unknown as typeof import("node:child_process").spawn;
    await assert.rejects(claudeRun(["-p"], "q", { spawn, agentDir: () => dir }, 1000, fail), /cannot run claude/);
    assert.equal(snapshot().active, base);
  });
});
