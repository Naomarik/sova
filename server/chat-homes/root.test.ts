// Chat homes' location and path rules (§app.chat-homes/location, /new-chats, /sole-writer): a scratch agent dir and
// homes folder, no server.
import { scratchAgentDir, dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { defaultHomesRoot, ensureChatHome, hasHome, HOMES_ENV, homeOfSessionFile, homeSessionsDirs, homesRoot, isHomeOwnState, isHomeSessionFile, isHomeSessionsDir, listHomeIds, MARKER_FILE, resetHomesMemoForTests } from "./root";
import { placedByParent } from "./place";
import { sessionPathShape } from "../paths";
import { listSessionFiles } from "../sessions-index";
import { watchFeedInputs } from "../session-feed-watch";

const homes = process.env[HOMES_ENV]!;
const state = join(scratchAgentDir, "sova");
const ID = "019a0000-0000-7000-8000-000000000001";
after(dropScratchAgentDir);
beforeEach(() => {
  process.env[HOMES_ENV] = homes;
  process.env.PI_CODING_AGENT_DIR = scratchAgentDir;
  resetHomesMemoForTests();
});

describe("where homes live", () => {
  test("the override wins and writes no marker; without it the state root's hash names the folder, then its marker does", () => {
    assert.equal(homesRoot(), homes);
    ensureChatHome(ID);
    assert.equal(existsSync(join(state, MARKER_FILE)), false, "a harness never points real state at scratch");
    assert.equal(JSON.parse(readFileSync(join(homes, ID, "index.json"), "utf8")).files.find((f: { pattern: string }) => f.pattern === "sessions/*.jsonl").kind, "log");
    const m = JSON.parse(readFileSync(join(homes, ID, "home.json"), "utf8"));
    assert.equal(m.stateRoot, state);
    assert.equal(m.id, ID);

    delete process.env[HOMES_ENV];
    resetHomesMemoForTests();
    const fakeHome = join(scratchAgentDir, "home");
    assert.notEqual(defaultHomesRoot(state, fakeHome), defaultHomesRoot(join(scratchAgentDir, "other", "sova"), fakeHome), "two state roots never share homes");
    // The marker, once written, names the folder however the hash would come out.
    const moved = join(scratchAgentDir, "moved-homes");
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(state, MARKER_FILE), JSON.stringify({ v: 1, homes: moved }));
    resetHomesMemoForTests();
    assert.equal(homesRoot(), moved);
  });

  test("a home whose manifest names another state root is not this server's", () => {
    ensureChatHome(ID);
    const other = "019a0000-0000-7000-8000-000000000002";
    mkdirSync(join(homes, other, "sessions"), { recursive: true });
    writeFileSync(join(homes, other, "home.json"), JSON.stringify({ v: 1, id: other, stateRoot: "/elsewhere/sova", layout: 1 }));
    writeFileSync(join(homes, other, "sessions", `2026-01-01T00-00-00-000Z_${other}.jsonl`), "{}\n");
    assert.equal(hasHome(ID), true);
    assert.equal(hasHome(other), false);
    assert.deepEqual(listHomeIds(), [ID]);
  });
});

describe("the shape rules", () => {
  const file = () => join(homes, ID, "sessions", `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
  test("a conversation is exactly <homes>/<id>/sessions/<file>.jsonl", () => {
    assert.equal(isHomeSessionFile(file()), true);
    assert.equal(isHomeSessionFile(join(homes, ID, "chat", "x.jsonl")), false);
    assert.equal(isHomeSessionFile(join(homes, ID, "sessions", "deeper", "x.jsonl")), false);
    assert.equal(isHomeSessionFile(join(homes, ID, "sessions", ".fork-source-1.jsonl")), false);
    assert.equal(isHomeSessionFile(join(homes, "..", "x", "sessions", "a.jsonl")), false);
    assert.equal(isHomeSessionsDir(join(homes, ID, "sessions")), true);
    assert.equal(homeOfSessionFile(file()), join(homes, ID));
    assert.equal(sessionPathShape(file()), file(), "every route that checks a session path takes it");
    assert.equal(sessionPathShape(join(homes, ID, "usage", "x.jsonl")), null);
  });

  test("the own-state guards' rule: all of a home but its shared folder", () => {
    assert.equal(isHomeOwnState(homes), true);
    assert.equal(isHomeOwnState(file()), true);
    assert.equal(isHomeOwnState(join(homes, ID, "chat", "meta.json")), true);
    assert.equal(isHomeOwnState(join(homes, ID, "shared")), false);
    assert.equal(isHomeOwnState(join(homes, ID, "shared", "brief.md")), false);
    assert.equal(isHomeOwnState(join(homes, ID, "sessions", "..", "shared", "x")), false, "resolved first");
    assert.equal(isHomeOwnState(join(scratchAgentDir, "elsewhere")), false);
  });

  test("a helper of a homed chat goes into its parent's home; of an older chat, where it asked", () => {
    const parent = file();
    const dir = join(homes, ID, "sessions");
    assert.deepEqual(placedByParent({ new: { dir: "/x/--cwd--" } }, parent), { new: { dir } });
    assert.deepEqual(placedByParent({ fork: { from: parent, dir: "/x" } }, parent), { fork: { from: parent, dir } });
    assert.deepEqual(placedByParent({ seed: { dir: "/x", messages: [] } }, parent), { seed: { dir, messages: [] } });
    assert.deepEqual(placedByParent({ resume: { file: "/x/a.jsonl" } }, parent), { resume: { file: "/x/a.jsonl" } });
    assert.deepEqual(placedByParent({ new: { dir: "/x/--cwd--" } }, join(scratchAgentDir, "sessions", "--w--", "a.jsonl")), { new: { dir: "/x/--cwd--" } });
  });
});

describe("listing and watching", () => {
  test("the list's second walk takes each home's conversations, nothing else in it", async () => {
    ensureChatHome(ID);
    writeFileSync(join(homes, ID, "sessions", `2026-01-01T00-00-00-000Z_${ID}.jsonl`), "{}\n");
    writeFileSync(join(homes, ID, "sessions", ".fork-source-ab.jsonl"), "{}\n");
    mkdirSync(join(homes, ID, "usage", ID), { recursive: true });
    writeFileSync(join(homes, ID, "usage", ID, "labels.jsonl"), "{}\n");
    writeFileSync(join(homes, `${ID}.compressed.json`), "{}");
    const listed = (await listSessionFiles()).filter((p) => p.startsWith(homes));
    assert.deepEqual(listed, [join(homes, ID, "sessions", `2026-01-01T00-00-00-000Z_${ID}.jsonl`)]);
  });

  test("an open homed chat's folder is watched", async () => {
    ensureChatHome(ID);
    const dir = join(homes, ID, "sessions");
    const watched: string[] = [];
    const fakeWatch = ((p: string) => {
      watched.push(p);
      return { close() {}, on() { return this; } };
    }) as never;
    const sessionsDir = join(scratchAgentDir, "sessions");
    mkdirSync(join(sessionsDir, "live"), { recursive: true });
    const stop = watchFeedInputs(() => {}, {
      sessionsDir,
      liveDir: join(sessionsDir, "live"),
      liveSignature: () => "same",
      watch: fakeWatch,
      scope: { hot: () => new Set<string>(), active: () => new Set([dir]), folders: homeSessionsDirs, accepts: isHomeSessionsDir },
    });
    try {
      assert.ok(watched.includes(dir), `watched: ${watched.join(", ")}`);
    } finally {
      stop();
    }
  });
});

describe("making a home", () => {
  test("no new home while the marker names a missing homes folder: the chat is made as before homes", async () => {
    const { newChatPlace } = await import("./place");
    delete process.env[HOMES_ENV];
    const missing = join(scratchAgentDir, "unmounted", "homes");
    writeFileSync(join(state, MARKER_FILE), JSON.stringify({ v: 1, homes: missing }));
    resetHomesMemoForTests();
    try {
      assert.equal(newChatPlace(scratchAgentDir, undefined, true), null);
      assert.equal(existsSync(missing), false, "the missing folder is never made anew");
    } finally {
      rmSync(join(state, MARKER_FILE), { force: true });
    }
  });

  test("a home made for a file that then fails is undone", async () => {
    const { createNewChatFile } = await import("./place");
    const before = listHomeIds().length;
    // A seed of no registered kind throws once the home is made (SOVA_STATE_ASSERT), before any file is written.
    process.env.SOVA_STATE_ASSERT = "1";
    try {
      assert.throws(() => createNewChatFile({ cwd: scratchAgentDir, seed: [[{ type: "not-a-kind", parse: () => null } as never, 1]] }, true));
    } finally {
      delete process.env.SOVA_STATE_ASSERT;
    }
    assert.equal(listHomeIds().length, before);
  });
});
