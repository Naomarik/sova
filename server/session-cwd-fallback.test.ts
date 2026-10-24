// A local session whose stored working directory is gone opens in this host's home folder
// (§app.shell/missing-folder-home); every other open failure is still refused with why.
// Uses a throwaway PI_CODING_AGENT_DIR and the runner's throwaway home; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { piSession } from "./harness/pi/testing/handle";

const agentDir = mkdtempSync(join(tmpdir(), "sova-cwdfallback-test-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-cwdfallback--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { acquireChat, activeConfigFailure, assertOpenConfig, ConfigError, resolveOpenCwd } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { markOwned } = await import("./write-guard");
const { targetDir } = await import("./targets");
const { probeFolder, cwdFallbackNote } = await import("./session-cwd");
const { extensionFlagValues, withPromptNotes } = await import("./harness/pi/open");

after(() => {
  for (const p of locked) try { chmodSync(p, 0o755); } catch {}
  rmSync(agentDir, { recursive: true, force: true });
});

const home = homedir();
const locked: string[] = [];
let n = 0;
/** A session file whose header names `cwd`, which may or may not exist on disk; marked as ours. */
function session(cwd: string): { path: string; bytes: string } {
  const id = `fb${++n}-0000-0000-0000-000000000000`;
  const path = canonicalPath(join(sessionsDir, `2026-10-22T00-00-00-000Z_${id}.jsonl`));
  const header = { type: "session", version: 3, id, timestamp: "2026-10-22T00:00:00.000Z", cwd };
  const user = { type: "message", id: "u1", parentId: null, timestamp: "2026-10-22T00:00:01.000Z", message: { role: "user", content: "fix the repo", timestamp: 0 } };
  const bytes = [header, user].map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, bytes);
  markOwned(path);
  return { path, bytes };
}
const folder = (name: string) => join(agentDir, "work", `${name}-${++n}`);

async function failure(path: string): Promise<unknown> {
  try {
    await acquireChat(path);
    return null;
  } catch (err) {
    return err;
  }
}

describe("probeFolder: only a genuinely missing folder is missing", () => {
  test("present, missing (gone, or a parent that is a file), unreachable (permission)", () => {
    const here = folder("here");
    mkdirSync(here, { recursive: true });
    assert.deepEqual(probeFolder(here), { state: "present" });
    assert.deepEqual(probeFolder(join(here, "gone")), { state: "missing" });
    writeFileSync(join(here, "file"), "x");
    assert.deepEqual(probeFolder(join(here, "file", "below")), { state: "missing" });
    if (process.getuid?.() === 0) return; // root reads through any mode
    const shut = join(here, "shut");
    mkdirSync(join(shut, "repo"), { recursive: true });
    chmodSync(shut, 0o000);
    locked.push(shut);
    assert.deepEqual(probeFolder(join(shut, "repo")), { state: "unreachable", code: "EACCES" });
  });
});

describe("resolveOpenCwd", () => {
  test("an existing cwd is used unchanged, with no fallback", () => {
    const here = folder("kept");
    mkdirSync(here, { recursive: true });
    assert.deepEqual(resolveOpenCwd("/s.jsonl", here), { cwd: here, fallback: null });
  });

  test("a missing local cwd opens in this host's home folder", () => {
    const gone = folder("gone");
    assert.deepEqual(resolveOpenCwd("/s.jsonl", gone), { cwd: home, fallback: { original: gone, cwd: home } });
    // The home folder is the one the call is told, else this host's: never assumed from elsewhere.
    const other = folder("other-home");
    mkdirSync(other, { recursive: true });
    assert.deepEqual(resolveOpenCwd("/s.jsonl", gone, { home: other }), { cwd: other, fallback: { original: gone, cwd: other } });
  });

  test("refused, naming the stored cwd: a remote placeholder, a folder Sova chose, a home that is gone too", () => {
    const placeholder = targetDir("acme", "/srv/site");
    for (const [cwd, opts] of [
      [placeholder, {}],
      [folder("chosen"), { overridden: true }],
      [folder("gone"), { home: folder("no-home") }],
    ] as const) {
      assert.throws(
        () => resolveOpenCwd("/s.jsonl", cwd, opts),
        (err: unknown) => err instanceof ConfigError && err.cwd === cwd && err.message.startsWith(`Stored session working directory does not exist: ${cwd}`),
      );
    }
  });
});

describe("opening a session whose folder is gone", () => {
  test("missing at open: it opens in the home folder, says so, and the agent is told; the file is untouched", async () => {
    const gone = folder("motorsaif.incoming");
    const { path, bytes } = session(gone);
    assert.doesNotThrow(() => assertOpenConfig(path));
    const chat = await acquireChat(path);
    try {
      assert.equal(chat.harness.cwd, home);
      assert.deepEqual(chat.cwdFallback, { original: gone, cwd: home });
      assert.deepEqual(chat.hello().cwdFallback, { original: gone, cwd: home });
      // The transcript and identity are the file's own.
      assert.ok(chat.hello().items.some((it) => it.kind === "user"));
      const prompt = piSession(chat).systemPrompt;
      assert.ok(prompt.includes(cwdFallbackNote({ original: gone, cwd: home })), "the note is in the system prompt");
      assert.ok(prompt.includes(home), "pi's prompt names the home folder");
      // Opening wrote nothing: the header still names the stored folder, nothing was recreated.
      assert.equal(readFileSync(path, "utf8"), bytes);
      assert.equal(probeFolder(gone).state, "missing");
      assert.equal(activeConfigFailure(path), undefined);
    } finally {
      await chat.dispose();
    }
  });

  test("deleted between the server's check and the chat's open: it still opens in the home folder", async () => {
    const dir = folder("deleted-later");
    mkdirSync(dir, { recursive: true });
    const { path } = session(dir);
    assertOpenConfig(path); // the server's look, before it starts the chat's process: the folder is there
    rmSync(dir, { recursive: true, force: true });
    const chat = await acquireChat(path);
    try {
      assert.equal(chat.harness.cwd, home);
      assert.deepEqual(chat.cwdFallback, { original: dir, cwd: home });
    } finally {
      await chat.dispose();
    }
  });

  test("reconnect: every open looks again: the home folder while the folder is gone, its own once it is back", async () => {
    const dir = folder("comes-back");
    const { path, bytes } = session(dir);
    const first = await acquireChat(path);
    assert.equal(await acquireChat(path), first, "a reconnect to the open chat is the same chat");
    assert.deepEqual(first.hello().cwdFallback, { original: dir, cwd: home });
    await first.dispose();
    const again = await acquireChat(path);
    assert.equal(again.harness.cwd, home);
    await again.dispose();
    mkdirSync(dir, { recursive: true });
    const back = await acquireChat(path);
    try {
      assert.equal(back.harness.cwd, dir);
      assert.equal(back.cwdFallback, null);
      assert.equal(back.hello().cwdFallback, undefined);
      assert.ok(!piSession(back).systemPrompt.includes("Working directory notice"));
      assert.equal(readFileSync(path, "utf8"), bytes);
    } finally {
      await back.dispose();
    }
  });

  test("an existing cwd opens there, unchanged, with no note and no flag", async () => {
    const dir = folder("present");
    mkdirSync(dir, { recursive: true });
    const { path } = session(dir);
    const chat = await acquireChat(path);
    try {
      assert.equal(chat.harness.cwd, dir);
      assert.equal(chat.cwdFallback, null);
      assert.equal(chat.hello().cwdFallback, undefined);
      assert.ok(!piSession(chat).systemPrompt.includes("Working directory notice"));
    } finally {
      await chat.dispose();
    }
  });

  test("a folder that exists but can't be reached (permission) is refused with that reason, never the home folder", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root reads through any mode");
    const shut = folder("shut");
    const repo = join(shut, "repo");
    mkdirSync(repo, { recursive: true });
    const { path } = session(repo);
    chmodSync(shut, 0o000);
    locked.push(shut);
    try {
      const err = await failure(path);
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err}`);
      assert.match(err.message, /^Stored session working directory can't be reached \(EACCES\): /);
      assert.ok(!err.message.includes("does not exist"));
      assert.equal(activeConfigFailure(path), err, "remembered while it applies");
      chmodSync(shut, 0o755);
      assert.equal(activeConfigFailure(path), undefined, "dropped once the folder is reachable");
      const chat = await acquireChat(path);
      assert.equal(chat.harness.cwd, repo);
      await chat.dispose();
    } finally {
      chmodSync(shut, 0o755);
    }
  });

  test("a remote session whose placeholder is gone is still refused: this host's home never stands in for a target", async () => {
    const placeholder = targetDir("acme", "/srv/gone-site");
    const { path } = session(placeholder);
    const err = await failure(path);
    assert.ok(err instanceof ConfigError);
    assert.equal(err.cwd, placeholder);
    assert.match(err.message, /^Stored session working directory does not exist: /);
  });
});

describe("the pi adapter's part", () => {
  test("the sandbox flag is set only when asked", () => {
    assert.equal(extensionFlagValues({ cwdNotWritable: true }).get("sandbox-cwd-not-writable"), true);
    assert.equal(extensionFlagValues({}).has("sandbox-cwd-not-writable"), false);
  });

  test("prompt notes go after the loader's own appends, which it still discovers", () => {
    const plain = withPromptNotes({}, ["NOTE"]);
    assert.deepEqual(plain.appendSystemPromptOverride!(["user append"]), ["user append", "NOTE"]);
    assert.equal((plain as { appendSystemPrompt?: unknown }).appendSystemPrompt, undefined);
    const own = withPromptNotes({ appendSystemPromptOverride: (b: string[]) => [...b, "ours"] }, ["NOTE"]);
    assert.deepEqual(own.appendSystemPromptOverride!(["user append"]), ["user append", "ours", "NOTE"]);
  });
});
