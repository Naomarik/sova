// Run: pnpm test:int -- server/chat-runtime/trial.integration.test.ts. al_3 stage 2 end to end: each
// test runs scripts/chat-runtime-trial/run.mjs on one check, against a hermetic server of its own (a
// scratch agent dir, a free port, the mock LLM in its own process) and reads the check's results.
// With the switch on, the server runs as a stand-in unit sova-trial-server-<pid>.service and its chats
// as units in the stand-in slice sova-trial-<pid>.slice: never sova-runtime.service, never
// sova-chats.slice, never ~/.pi. Those need the systemd user manager and are skipped without one (a
// sandboxed shell); the switch-off check runs the server as a plain child and needs none.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";

const RUN = resolve(import.meta.dirname, "..", "..", "scripts", "chat-runtime-trial", "run.mjs");
const root = mkdtempSync(join(tmpdir(), "sova-chat-trial-"));
after(() => rmSync(root, { recursive: true, force: true }));
/** Whether the systemd user manager answers. */
const bus = spawnSync("systemctl", ["--user", "show", "-p", "Version", "--value"], { stdio: "pipe" }).status === 0;

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

describe("chat runtime stage 2, switch on (stand-in units)", { skip: bus ? false : "no systemd user manager here" }, () => {
  test("a reply in flight survives a server restart: completes once, no 'continue', reconnect shows it", () => void trial("restart"));
  test("a worker the chat spawned survives the restart and finishes", () => void trial("worker"));
  test("a dialog open across the restart stays open and its answer lands", () => void trial("dialog"));
  test("a killed chat process is resumed once and the crash reported", () => void trial("crash"));
  test("an idle chat's process stops after the idle time; reopening shows its history", () => void trial("idle", ["--idle-ms", "15000"]));
  test("new code: badge, reload at the quiet moment, Reload now", () => void trial("build"));
});

describe("chat runtime stage 2, switch off", () => {
  test("behaviour is today's: no chat unit, the restart cuts the reply off, auto-resume tries it once", () => void trial("off", ["--mode", "child"]));
});
