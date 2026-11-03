#!/usr/bin/env node
// Merge check: the spec replay suite (pi-config/extensions/spec/tests/replay), only when the change
// touches the spec core, the replay tests or the spec guard; one at a time on this machine (a lock in
// the agent dir). A landing gate: never run while working. See lib.mjs for inputs.
//   node scripts/merge-checks/spec-replay.mjs [--base <rev>] [--changed <file>]
import { existsSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, agentDir, context, expandArgs, niced, report, run, skip, touchesSpecReplay } from "./lib.mjs";

const ctx = context();
if (!ctx.picked && !ctx.changed.some(touchesSpecReplay)) skip(ctx.out, "no change to the spec core, its replay tests or the spec guard");
const specDir = join(ctx.root, "pi-config", "extensions", "spec");
if (!existsSync(join(specDir, "tests", "replay", "replay.test.mjs"))) skip(ctx.out, "no tests/replay/replay.test.mjs in this tree");
const lock = await acquireLock(join(agentDir(), "locks", "spec-replay.lock"), { pollMs: Number(process.env.SOVA_LOCK_POLL_MS) || 5000 });
if (lock.waitedMs >= 1000) console.log(`spec replay: waited ${Math.round(lock.waitedMs / 1000)} s for another run's replay.`);
let code;
try {
  const env = { ...process.env, SOVA_SPEC_REPLAY: "1" };
  delete env.NODE_TEST_CONTEXT;
  code = await run(...niced(ctx.root, "node", ["--test", ...expandArgs(["tests/replay/*.test.mjs"], specDir)]), { cwd: specDir, env });
} finally {
  lock.release();
}
report(ctx.out, { passed: code === 0 ? 1 : 0, failed: code === 0 ? 0 : 1, failures: code === 0 ? [] : [{ name: "spec replay", file: "pi-config/extensions/spec/tests/replay", message: `exit ${code}` }] });
process.exit(code === 0 ? 0 : 1);
