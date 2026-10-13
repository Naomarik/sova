// The integration tier's side of the chat-runtime trial (server/chat-runtime/trial-*.integration.test.ts):
// each test runs scripts/chat-runtime-trial/run.mjs on one check, against a hermetic server of its own
// (a scratch agent dir, a free port, the mock LLM in its own process), and reads that check's
// results.json. The server is a plain child and its chats run on the detached test driver
// (SOVA_CHAT_DRIVER=detached), so no user bus is needed (stage2-design.md §8.2); the systemd pass
// (§8.3) is run.mjs --mode unit. The checks are split over several files because the runner stops a
// file after 5 min.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
// @ts-expect-error: plain JS, no types
import { sweep } from "./lib.mjs";

const RUN = resolve(import.meta.dirname, "run.mjs");

type Check = { ok?: boolean; what?: string; detail?: string | null; note?: string };

/** One describe block: each [check, title] a test running that check of run.mjs. */
/** `spawnMs`: one check's budget (default 270 s). run-tests.mjs kills a file at 300 s (TEST_FILE_LIMIT_MS), so a file
    with one long check (t25, ~205 s) may take up to 285 s, and the test's own timeout sits 10 s above it. */
export function trialSuite(title: string, checks: [string, string][], { spawnMs = 270_000 } = {}): void {
  const root = mkdtempSync(join(tmpdir(), "sova-chat-trial-"));
  after(async () => {
    await sweep(root);
    rmSync(root, { recursive: true, force: true });
  });
  describe(title, () => {
    for (const [check, name] of checks) test(name, { timeout: spawnMs + 10_000 }, () => trial(root, check, spawnMs));
  });
}

async function trial(root: string, check: string, spawnMs: number): Promise<void> {
  const scratch = join(root, check);
  const r = spawnSync("node", [RUN, check, "--scratch", scratch, "--mode", "child", "--driver", "detached"], { encoding: "utf8", timeout: spawnMs });
  // The runner stops what it started, even on SIGTERM (the timeout here); a runner killed outright
  // cannot, so whatever still runs under its scratch dir is stopped here.
  const left: { pid: number; cmd: string }[] = await sweep(scratch);
  let checks: Check[] = [];
  try {
    checks = JSON.parse(readFileSync(join(scratch, "results.json"), "utf8")).checks;
  } catch {}
  const failed = checks.filter((c) => c.ok === false);
  assert.ok(checks.length > 0, `no results from the trial (exit ${r.status}):\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`);
  assert.equal(left.length, 0, `processes left running under ${scratch} after the runner exited (stopped now): ${left.map((p) => `${p.pid} ${p.cmd.slice(0, 100)}`).join("; ")}`);
  assert.equal(failed.length, 0, `${failed.map((c) => `${c.what}${c.detail ? `: ${c.detail}` : ""}`).join("\n")}\n--- stdout\n${r.stdout.slice(-4000)}`);
  assert.equal(r.status, 0, r.stdout.slice(-3000));
}
