// Run: npx tsx --test server/chat-config.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// Regression for the "N identical error banners" bug: a session whose stored cwd was reaped
// re-opened on every websocket reconnect, each attempt appending another copy of a permanent
// error to the client's thread. The fix classifies it (ConfigError, not "internal") and
// remembers it, so repeat connects fail fast with the same answer instead of re-running the open.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-chatcfg-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-chatcfg--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { acquireChat, activeConfigFailure, BusyError, ConfigError } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");

after(() => rmSync(agentDir, { recursive: true, force: true }));

let n = 0;
/** A session file whose header names `cwd`, which may or may not exist on disk. */
function session(cwd: string, entries: unknown[] = []): string {
  const id = `s${++n}`;
  const path = join(sessionsDir, `2026-09-20T00-00-00-000Z_${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: "2026-09-20T00:00:00.000Z", cwd };
  writeFileSync(path, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return canonicalPath(path);
}

const missingCwd = () => join(agentDir, "reaped", `gone-${++n}`);

async function failure(path: string, force = false): Promise<unknown> {
  try {
    await acquireChat(path, force);
    return null;
  } catch (err) {
    return err;
  }
}

describe("a session whose stored cwd is gone", () => {
  test("fails as a permanent ConfigError naming the directory and the session file", async () => {
    const cwd = missingCwd();
    const path = session(cwd);
    const err = await failure(path);
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err}`);
    assert.equal(err.cwd, cwd);
    assert.match(err.message, /Stored session working directory does not exist/);
    assert.ok(err.message.includes(cwd));
    assert.ok(err.message.includes(path)); // the user needs to know WHICH session
    assert.ok(!(err instanceof BusyError)); // not the retry-with-force bucket
  });

  test("repeat connects get the SAME memoized error, not a fresh open each time", async () => {
    const path = session(missingCwd());
    const first = await failure(path);
    assert.ok(first instanceof ConfigError);
    // Identity is the assertion that matters: a second open would have built a new Error object.
    // This is what stops one reaped directory from appending a banner per reconnect.
    for (let i = 0; i < 5; i++) assert.equal(await failure(path), first, `attempt ${i + 2} re-opened`);
  });

  test("force=1 does not bypass it: no flag makes a deleted directory exist", async () => {
    const path = session(missingCwd());
    const err = await failure(path, true);
    assert.ok(err instanceof ConfigError);
    assert.equal(await failure(path, true), err);
  });

  test("the failure is remembered per path, so one bad session doesn't poison another", async () => {
    const a = session(missingCwd());
    const b = session(missingCwd());
    const ea = await failure(a);
    const eb = await failure(b);
    assert.ok(ea instanceof ConfigError);
    assert.ok(eb instanceof ConfigError);
    assert.notEqual(ea, eb);
    assert.notEqual(ea.cwd, eb.cwd);
  });

  test("recreating the directory clears the memo, so the next connect opens for real", async () => {
    const cwd = missingCwd();
    const path = session(cwd);
    assert.ok((await failure(path)) instanceof ConfigError);
    assert.ok(activeConfigFailure(path) instanceof ConfigError); // remembered while it applies

    mkdirSync(cwd, { recursive: true }); // the condition clears outside the server
    assert.equal(activeConfigFailure(path), undefined, "memo should be dropped once the cwd exists");
  });
});

describe("sessions that are fine", () => {
  test("an existing cwd is not treated as a config failure", async () => {
    const cwd = join(agentDir, "real-cwd");
    mkdirSync(cwd, { recursive: true });
    const path = session(cwd);
    assert.equal(activeConfigFailure(path), undefined);
  });

  test("a header without a usable cwd is left to the normal open path, not pre-failed", async () => {
    for (const header of [{ type: "session", version: 3, id: "nocwd" }, { type: "session", version: 3, id: "blank", cwd: "" }]) {
      const path = join(sessionsDir, `2026-09-20T00-00-00-000Z_${header.id}.jsonl`);
      writeFileSync(path, `${JSON.stringify(header)}\n`);
      assert.equal(activeConfigFailure(canonicalPath(path)), undefined);
    }
  });
});
