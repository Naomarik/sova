// Run: npx tsx --test server/chat-config.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// Regression for the "N identical error banners" bug: a session whose stored cwd was reaped
// re-opened on every websocket reconnect, each attempt appending another copy of a permanent
// error to the client's thread. The fix classifies it (ConfigError, not "internal") and
// remembers it, so repeat connects fail fast with the same answer instead of re-running the open.
//
// Also here: which model and thinking switches become the saved default for new sessions. Only
// the composer's own pick on a session with no messages does (`save: true`); a switch without it
// (the Overseer acting on a session, Settings → Overseer) changes that chat only.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-chatcfg-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-chatcfg--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { acquireChat, activeConfigFailure, BusyError, ConfigError } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { markOwned } = await import("./write-guard");

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

describe("the saved default for new sessions", () => {
  const defaultsFile = join(agentDir, "sova", "defaults.json");
  const saved = () => (existsSync(defaultsFile) ? JSON.parse(readFileSync(defaultsFile, "utf8")) : null);
  const cwd = join(agentDir, "defaults-cwd");
  mkdirSync(cwd, { recursive: true });
  const client = {
    send: (m: { type: string; message?: string }) => {
      if (m.type === "error") throw new Error(`chat error: ${m.message}`);
    },
  };
  /** An open chat whose model switch needs no credentials: the model resolves, the SDK's switch is a no-op. */
  async function chatOn(entries: unknown[] = []) {
    const path = session(cwd, entries);
    markOwned(path); // written by us, as POST /api/sessions does, not by an unknown writer
    const chat = await acquireChat(path);
    const inner = chat as unknown as { runtime: { services: { modelRuntime: { getAvailable(): Promise<unknown[]> } } } };
    inner.runtime.services.modelRuntime.getAvailable = async () => [{ provider: "ollama-cloud", id: "glm-5.3" }];
    (chat.session as unknown as { setModel(m: unknown): Promise<void> }).setModel = async () => {};
    return chat;
  }
  async function until(cond: () => boolean): Promise<void> {
    const end = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  test("the composer's model and thinking on a brand-new session become the default", async () => {
    rmSync(defaultsFile, { force: true });
    const chat = await chatOn();
    chat.handle(client, { type: "set_model", ref: "ollama-cloud/glm-5.3" });
    await until(() => saved()?.model === "ollama-cloud/glm-5.3");
    chat.handle(client, { type: "set_thinking", level: "low" });
    assert.equal(saved()?.thinking, chat.session.thinkingLevel);
  });

  test("the same switch without save: true changes that chat and never the default", async () => {
    rmSync(defaultsFile, { force: true });
    const chat = await chatOn();
    await chat.setModelRef("ollama-cloud/glm-5.3");
    chat.setThinking("low");
    assert.equal(saved(), null);
  });

  test("a composer pick in a session that already has a message stays that session's", async () => {
    rmSync(defaultsFile, { force: true });
    const said = { type: "message", id: "u1", parentId: null, timestamp: "2026-09-20T00:00:01.000Z", message: { role: "user", content: "hi", timestamp: 0 } };
    const chat = await chatOn([said]);
    await chat.setModelRef("ollama-cloud/glm-5.3", { save: true });
    chat.setThinking("low", { save: true });
    assert.equal(saved(), null);
  });
});
