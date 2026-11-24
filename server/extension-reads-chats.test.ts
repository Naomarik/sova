// Run: pnpm test -- server/extension-reads-chats.test.ts
// An extension that reads chats (§app.extensions/reads-chats): the `reads` key, what the review states, the
// program's SOVA_CHATS_DIR, its own folder in each home going with Remove's data, and the unsent draft
// kept out of every answer a key reads. In-process, no server.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-ext-reads-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.SOVA_CHAT_HOMES = join(root, "homes");
delete process.env.SOVA_EXTENSIONS_FILE;
mkdirSync(join(root, "agent", "sova"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { readDescription } = await import("./extension-description");
const { programEnv } = await import("./extension-program");
const { removeExtensionFolders } = await import("./extension-chats");
const { withoutDrafts, answerWithoutDrafts, isDraftRead } = await import("./extension-doors");

let n = 0;
function folder(desc: object): string {
  const dir = join(root, `f${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sova-extension.json"), JSON.stringify({ version: 1, id: `sync${n}`, title: "Company sync", needsContract: "1.20", ...desc }));
  return dir;
}

describe("the reads key", () => {
  test('reads: ["chats"] goes into the entry and the review says so; absent, neither', () => {
    const on = readDescription(folder({ reads: ["chats"] }));
    assert.ok(on.ok);
    assert.deepEqual(on.described.entry.reads, ["chats"]);
    assert.equal(on.described.asks.readsChats, true);
    const off = readDescription(folder({}));
    assert.ok(off.ok);
    assert.equal(off.described.entry.reads, undefined);
    assert.equal(off.described.asks.readsChats, undefined);
  });
  test("any other value is refused, naming the key", () => {
    for (const reads of [["chats", "files"], ["files"], "chats", [], true]) {
      const r = readDescription(folder({ reads }));
      assert.ok(!r.ok);
      assert.match(r.reason, /reads may only be \["chats"\]/);
    }
  });
});

describe("what the program gets", () => {
  test("SOVA_CHATS_DIR only for one that reads chats", () => {
    const spec = { id: "s", run: ["x"], folder: "/f", api: "http://127.0.0.1:7" };
    assert.equal(programEnv(spec, "7", "/k", "/d", { PATH: "/bin" }).SOVA_CHATS_DIR, undefined);
    assert.equal(programEnv({ ...spec, chatsDir: "/homes" }, "7", "/k", "/d", { PATH: "/bin" }).SOVA_CHATS_DIR, "/homes");
  });
  test("Remove with its data takes its own folder out of every home, and nothing else", () => {
    const homes = join(root, "rm-homes");
    for (const chat of ["c1", "c2"]) {
      mkdirSync(join(homes, chat, "ext", "sync"), { recursive: true });
      mkdirSync(join(homes, chat, "ext", "other"), { recursive: true });
      writeFileSync(join(homes, chat, "ext", "sync", "cursor.json"), "{}");
    }
    assert.equal(removeExtensionFolders("sync", homes), 2);
    assert.ok(!existsSync(join(homes, "c1", "ext", "sync")));
    assert.ok(existsSync(join(homes, "c1", "ext", "other")));
    assert.equal(removeExtensionFolders("..", homes), 0, "an id that is no valid id names no folder");
  });
});

describe("the unsent draft never reaches a key", () => {
  test("the draft route is refused; a row's preview and the Needs you line that quotes it are taken out", async () => {
    assert.ok(isDraftRead("GET", "/api/sessions/draft"));
    assert.ok(!isDraftRead("PUT", "/api/sessions/draft"));
    const rows = JSON.stringify([{ id: "a", hasDraft: true, draftPreview: "my secret plan" }, { id: "b", why: "Unsent draft: my secret plan" }]);
    assert.deepEqual(JSON.parse(withoutDrafts(rows)), [{ id: "a", hasDraft: true }, { id: "b", why: "Unsent draft." }]);
    const res = await answerWithoutDrafts(new Response(rows, { headers: { "content-type": "application/json" } }));
    assert.ok(!(await res.text()).includes("secret"));
    const plain = new Response("{\"id\":\"a\"}", { headers: { "content-type": "application/json" } });
    assert.equal(await answerWithoutDrafts(plain), plain, "an answer with no draft in it is passed on as it is");
  });
});
