// Run: npx tsx --test server/session-setup.test.ts
// A throwaway PI_CODING_AGENT_DIR and a throwaway folder tree in the OS temp dir: ~/.pi is never
// read or written, and no chat is opened — the runtime seam is the test's own. The target case
// builds its placeholder with targets.targetDir, so the shape under test is the one Sova writes,
// not a string that happens to look like it.
//
// The assertions name the sentence or the behaviour, never a substring that a wrong state would
// also produce: "the loader was never asked" is a call count, "an unreadable file is dropped" is
// the row list, and the byte count is checked against a file whose characters and bytes differ.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { Loadout, SetupDeps } from "./session-setup";

const agentDir = mkdtempSync(join(tmpdir(), "sova-setup-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const scratch = mkdtempSync(join(tmpdir(), "sova-setup-test-"));
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const S = await import("./session-setup");
const T = await import("./targets");

beforeEach(() => S.clearSetupCache());

let n = 0;
/** A fresh folder under scratch, with the given files written into it. */
const fresh = (files: Record<string, string> = {}): string => {
  const dir = join(scratch, `d${++n}`);
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return dir;
};

/** A session file whose header carries `cwd` — the real reader is what reads it in most tests. */
const sessionFile = (cwd: string): string => {
  const p = join(scratch, `s${++n}.jsonl`);
  writeFileSync(p, `${JSON.stringify({ type: "session", version: 3, id: `id${n}`, timestamp: new Date().toISOString(), cwd })}\n`);
  return p;
};

const loadout = (over: Partial<Loadout> = {}): Loadout => ({ context: [], skills: [], appendSystemPrompt: [], ...over });

// ---------------------------------------------------------------------------
// the size rules (pure)

test("countLines counts the way wc -l does", () => {
  assert.equal(S.countLines(Buffer.from("")), 0);
  assert.equal(S.countLines(Buffer.from("a")), 1);
  assert.equal(S.countLines(Buffer.from("a\n")), 1);
  assert.equal(S.countLines(Buffer.from("a\nb")), 2);
  assert.equal(S.countLines(Buffer.from("a\nb\n")), 2);
  assert.equal(S.countLines(Buffer.from("\n\n")), 2);
});

test("bytes are bytes on disk, not characters — and tokens are the characters, not the bytes", () => {
  // 4 × (0xc3 0xa9) + 0x0a: five characters, nine bytes. The estimate counts the DECODED text
  // (5 characters → 2 tokens); an estimate taken from the byte count would say 3 here.
  const dir = fresh({ "A.md": "éééé\n" });
  assert.deepEqual(S.measureFile(join(dir, "A.md")), { bytes: 9, lines: 1, tokens: 2 });
  const five = fresh({ "B.md": "abcd\n" }); // 5 bytes, 5 characters, 2 tokens: rounded up, never down
  assert.deepEqual(S.measureFile(join(five, "B.md")), { bytes: 5, lines: 1, tokens: 2 });
  const empty = fresh({ "C.md": "" });
  assert.deepEqual(S.measureFile(join(empty, "C.md")), { bytes: 0, lines: 0, tokens: 0 });
});

test("a file that cannot be read has no size at all", () => {
  const dir = fresh();
  assert.equal(S.measureFile(join(dir, "gone.md")), null);
  assert.equal(S.measureFile(dir), null); // a directory is not a file with 0 lines
});

// ---------------------------------------------------------------------------
// the loadout

test("an open chat's own loader is the answer, and the fallback is never asked", async () => {
  const dir = fresh({ "AGENTS.md": "ctx\n", "a/SKILL.md": "one\ntwo\n" });
  const cwd = join(dir, "a");
  let loaderCalls = 0;
  const runtime: Loadout = loadout({ context: [{ path: join(dir, "AGENTS.md") }], skills: [{ name: "a", filePath: join(cwd, "SKILL.md"), description: "does a" }] });
  const setup = await S.getSessionSetup(sessionFile(cwd), {}, {
    runtime: () => runtime,
    loader: () => {
      loaderCalls++;
      return Promise.resolve(loadout());
    },
  });
  assert.equal(setup.state, "ok");
  if (setup.state !== "ok") return;
  assert.equal(setup.fromRuntime, true);
  assert.equal(loaderCalls, 0);
  assert.deepEqual(setup.context, [{ path: join(dir, "AGENTS.md"), bytes: 4, lines: 1, tokens: 1 }]);
  assert.deepEqual(setup.skills, [{ name: "a", path: join(cwd, "SKILL.md"), description: "does a", bytes: 8, lines: 2, tokens: 2 }]);
  assert.equal(setup.cwd, cwd);
});

test("with nothing open, pi's loader answers — and says it is the lower bound", async () => {
  const dir = fresh();
  const setup = await S.getSessionSetup(sessionFile(dir), {}, { runtime: () => null, loader: () => Promise.resolve(loadout({ context: [{ path: join(dir, "X.md") }] })), exists: () => true });
  assert.equal(setup.state, "ok");
  if (setup.state !== "ok") return;
  assert.equal(setup.fromRuntime, false);
  assert.deepEqual(setup.context, []); // listed but not on disk: the row is dropped, not shown as 0 lines
});

test("a listed file is sized from disk, a project prompt source is reported when there is one", async () => {
  const dir = fresh({ "AGENTS.md": "one\ntwo\n", "SYSTEM.md": "sys\n", "APPEND.md": "app\n" });
  const setup = await S.getSessionSetup(sessionFile(dir), {}, {
    runtime: () => null,
    loader: () => Promise.resolve(loadout({ context: [{ path: join(dir, "AGENTS.md") }], systemPrompt: join(dir, "SYSTEM.md"), appendSystemPrompt: [join(dir, "APPEND.md")] })),
    exists: () => true,
  });
  assert.equal(setup.state, "ok");
  if (setup.state !== "ok") return;
  assert.deepEqual(setup.context, [{ path: join(dir, "AGENTS.md"), bytes: 8, lines: 2, tokens: 2 }]);
  assert.deepEqual(setup.systemPrompt, { path: join(dir, "SYSTEM.md"), bytes: 4, lines: 1, tokens: 1 });
  assert.deepEqual(setup.appendSystemPrompt, [{ path: join(dir, "APPEND.md"), bytes: 4, lines: 1, tokens: 1 }]);
});

test("no prompt sources: the fields are absent, not empty", async () => {
  const dir = fresh();
  const setup = await S.getSessionSetup(sessionFile(dir), {}, { runtime: () => null, loader: () => Promise.resolve(loadout()) });
  assert.equal(setup.state, "ok");
  if (setup.state !== "ok") return;
  assert.equal("systemPrompt" in setup, false);
  assert.equal("appendSystemPrompt" in setup, false);
});

test("a skill's description is trimmed, and a blank one is absent rather than empty", async () => {
  const dir = fresh({ "a/SKILL.md": "x\n", "b/SKILL.md": "y\n" });
  const setup = await S.getSessionSetup(sessionFile(dir), {}, {
    runtime: () => null,
    loader: () =>
      Promise.resolve(
        loadout({
          skills: [
            { name: "a", filePath: join(dir, "a/SKILL.md"), description: "does a\n" },
            { name: "b", filePath: join(dir, "b/SKILL.md"), description: "  " },
          ],
        }),
      ),
  });
  assert.equal(setup.state, "ok");
  if (setup.state !== "ok") return;
  assert.deepEqual(setup.skills.map((s) => s.description), ["does a", undefined]);
  assert.equal("description" in setup.skills[1]!, false);
});

test("a loader that threw is a sentence, not a throw", async () => {
  const dir = fresh();
  const setup = await S.getSessionSetup(sessionFile(dir), {}, {
    runtime: () => null,
    loader: () => Promise.reject(new Error("settings.json is not readable")),
  });
  assert.equal(setup.state, "unavailable");
  if (setup.state !== "unavailable") return;
  assert.match(setup.reason, /settings\.json is not readable/);
  assert.match(setup.reason, /setup/);
});

// ---------------------------------------------------------------------------
// which folder

test("a target session is remote, and nothing local is read for it", async () => {
  const placeholder = T.targetDir("box", "/srv/app");
  let loaderCalls = 0;
  const setup = await S.getSessionSetup(sessionFile(placeholder), {}, {
    runtime: () => {
      throw new Error("a remote session's runtime must not be asked for a local loadout");
    },
    loader: () => {
      loaderCalls++;
      return Promise.resolve(loadout());
    },
  });
  assert.deepEqual(setup, { state: "remote", where: { kind: "remote", target: "box" }, cwd: "/srv/app", checkedAt: setup.checkedAt });
  assert.equal(loaderCalls, 0);
});

test("a relative stored cwd is never resolved against the server's own folder", async () => {
  const setup = await S.getSessionSetup(sessionFile("webapps/sova"), {});
  assert.equal(setup.state, "unavailable");
  if (setup.state !== "unavailable") return;
  assert.match(setup.reason, /isn't an absolute path/);
});

test("a session file with no readable header says so", async () => {
  const p = join(scratch, "notjson.jsonl");
  writeFileSync(p, "not a session header\n");
  const setup = await S.getSessionSetup(p, {});
  assert.equal(setup.state, "unavailable");
  if (setup.state !== "unavailable") return;
  assert.equal(setup.reason, "This session file has no header to read its folder from.");
});

test("a folder that is gone says which one", async () => {
  const gone = await S.getSessionSetup(sessionFile(join(scratch, "never-existed")), {});
  assert.equal(gone.state, "unavailable");
  if (gone.state !== "unavailable") return;
  assert.match(gone.reason, /no longer exists/);
});

// ---------------------------------------------------------------------------
// the cache

test("one folder is one read, and fresh=1 is the way past it", async () => {
  const dir = fresh({ "A.md": "a\n" });
  let loaderCalls = 0;
  const deps: SetupDeps = {
    runtime: () => null,
    loader: () => {
      loaderCalls++;
      return Promise.resolve(loadout({ context: [{ path: join(dir, "A.md") }] }));
    },
  };
  const first = await S.getSessionSetup(sessionFile(dir), {}, deps);
  const second = await S.getSessionSetup(sessionFile(dir), {}, deps);
  assert.equal(loaderCalls, 1);
  assert.deepEqual(second, first);
  await S.getSessionSetup(sessionFile(dir), { fresh: true }, deps);
  assert.equal(loaderCalls, 2);
});

test("a failure is never served from the cache", async () => {
  const dir = fresh({ "A.md": "a\n" });
  let exists = false;
  let loaderCalls = 0;
  const deps: SetupDeps = {
    runtime: () => null,
    exists: () => exists,
    loader: () => {
      loaderCalls++;
      return Promise.resolve(loadout({ context: [{ path: join(dir, "A.md") }] }));
    },
  };
  const missing = await S.getSessionSetup(sessionFile(dir), {}, deps);
  assert.equal(missing.state, "unavailable");
  exists = true;
  const found = await S.getSessionSetup(sessionFile(dir), {}, deps);
  assert.equal(found.state, "ok");
  assert.equal(loaderCalls, 1);
});
