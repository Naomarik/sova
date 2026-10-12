// Run: pnpm test:int -- server/chat-runtime/trial.integration.test.ts. al_3 stage 2 end to end
// (.agent/sova-runtime/stage2-design.md §8.2): each test runs scripts/chat-runtime-trial/run.mjs on
// one check, against a hermetic server of its own (a scratch agent dir, a free port, the mock LLM in
// its own process), and reads that check's results. Never sova-runtime.service, never ~/.pi.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";

const RUN = resolve(import.meta.dirname, "..", "..", "scripts", "chat-runtime-trial", "run.mjs");
const root = mkdtempSync(join(tmpdir(), "sova-chat-trial-"));
after(() => rmSync(root, { recursive: true, force: true }));

type Check = { ok?: boolean; what?: string; detail?: string | null; note?: string };

/** One check of the trial, in its own scratch dir; its PASS/FAIL lines, failures first. */
function trial(check: string, extra: string[] = []): Check[] {
  const scratch = join(root, check);
  const r = spawnSync("node", [RUN, check, "--scratch", scratch, ...extra], { encoding: "utf8", timeout: 600_000 });
  let checks: Check[] = [];
  try {
    checks = JSON.parse(readFileSync(join(scratch, "results.json"), "utf8")).checks;
  } catch {}
  const failed = checks.filter((c) => c.ok === false);
  assert.ok(checks.length > 0, `no results from the trial (exit ${r.status}):\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`);
  assert.equal(failed.length, 0, `${failed.map((c) => `${c.what}${c.detail ? `: ${c.detail}` : ""}`).join("\n")}\n--- stdout\n${r.stdout.slice(-4000)}`);
  assert.equal(r.status, 0, r.stdout.slice(-3000));
  return checks;
}

// stage2-design.md §8.2: the server a plain child, its chats on the detached test driver
// (SOVA_CHAT_DRIVER=detached), so these need no user bus. The systemd pass (§8.3) is run.mjs --mode unit.
const T: [string, string][] = [
  ["t1", "T1: a reply in flight survives a server restart (same pid, hello.live, one entry, no resume)"],
  ["t1b", "T1b: a bash call across the restart returns once"],
  ["t1c", "T1c: a dialog open across the restart is re-sent and answered"],
  ["t1d", "T1d: a steer queued before the restart is delivered once"],
  ["t1e", "T1e: a compaction across the restart completes and is written once"],
  ["t1f", "T1f: a worker across the restart keeps its pid and reports once"],
  ["t2", "T2: a killed chat process: pane error, new process, one crash continue, never twice"],
  ["t3", "T3: idle stop only when quiet and unattended; reopens on attach"],
  ["t4", "T4: new code: older badge, reload at a quiet moment, Reload now, never mid-reply"],
  ["t4fail", "T4: a replacement that fails to boot halts the rollout and keeps the old process"],
  ["t5", "T5: the switch off is today's behaviour"],
  ["t6", "T6: the Overseer's chat stays in the server with the switch on"],
  ["t7", "T7: a server-hosted action cut by a restart reports outcome unknown and ran once"],
  ["t8", "T8: two servers never adopt or stop each other's chats"],
];
describe("chat runtime stage 2 (hermetic server, detached chat processes)", () => {
  for (const [check, name] of T) test(name, { timeout: 600_000 }, () => void trial(check, ["--mode", "child", "--driver", "detached"]));
});
