// The homed conversation files from the homes index (server/chat-homes/session-files.ts): the same files a read of
// every home's folder finds (the old walk, kept here as the reference), through every way a file comes and goes, each
// told as Sova tells it (a line of the change log, or the session feed's watch); a folder nothing says changed is not
// read again, and the backstop sweep finds what nothing told.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "sova-home-files-"));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.SOVA_CHAT_HOMES = join(scratch, "homes");
const HOMES = process.env.SOVA_CHAT_HOMES;
after(() => rmSync(scratch, { recursive: true, force: true }));

const { ensureChatHome, forgetHome } = await import("./root");
const { crashHomeSessionFilesForTest, expireHomeSessionFilesSweepForTest, homeSessionFiles, noteHomeSessionPath, resetHomeSessionFiles, sessionFilesIo } = await import("./session-files");
const { appendChange, INDEX_NAME, readIndex, resetChangeTails } = await import("./changes");
const { listSessionFiles, listSessions } = await import("../sessions-index");
const { stateRoot } = await import("../state-root");

/** The walk the listing did before the index: every folder of the root, its manifest, its sessions/ read. */
function reference(): string[] {
  const out: string[] = [];
  for (const d of readdirSync(HOMES, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    let m: { v?: unknown; id?: unknown; stateRoot?: unknown };
    try {
      m = JSON.parse(readFileSync(join(HOMES, d.name, "home.json"), "utf8"));
    } catch {
      continue;
    }
    if (m.v !== 1 || m.id !== d.name || m.stateRoot !== stateRoot()) continue;
    try {
      for (const f of readdirSync(join(HOMES, d.name, "sessions"), { withFileTypes: true })) if (f.isFile() && f.name.endsWith(".jsonl") && !f.name.startsWith(".")) out.push(join(HOMES, d.name, "sessions", f.name));
    } catch {
      // none
    }
  }
  return out.sort();
}
const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const header = (sid: string) => `${JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-11-01T00:00:00.000Z", cwd: scratch })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-11-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } })}\n`;
const conv = (home: string, name = `2026-11-01T00-00-00-000Z_${home}.jsonl`) => {
  writeFileSync(join(HOMES, home, "sessions", name), header(home));
  return join(HOMES, home, "sessions", name);
};
const sorted = async () => (await homeSessionFiles()).sort();

test("the index lists exactly what the walk of every home lists, through every way a file comes and goes", async () => {
  for (let i = 1; i <= 30; i++) {
    ensureChatHome(id(i));
    if (i % 3) conv(id(i));
  }
  // Not homes of this state root: a stray folder, another state root's home, a loose file, a dot-file conversation.
  mkdirSync(join(HOMES, "stray", "sessions"), { recursive: true });
  writeFileSync(join(HOMES, "stray", "sessions", "x.jsonl"), "");
  mkdirSync(join(HOMES, id(99), "sessions"), { recursive: true });
  writeFileSync(join(HOMES, id(99), "home.json"), JSON.stringify({ v: 1, id: id(99), stateRoot: "/elsewhere", layout: 1, device: { id: "d", name: "d" }, createdAt: "" }));
  writeFileSync(join(HOMES, id(99), "sessions", "y.jsonl"), "");
  writeFileSync(join(HOMES, `${id(40)}.tar.gz`), "");
  writeFileSync(join(HOMES, id(1), "sessions", ".fork-source.jsonl"), "");
  assert.deepEqual(await sorted(), reference(), "the first listing (no index yet: one walk)");

  const steps: [string, () => void][] = [
    ["a new chat, with its line", () => (ensureChatHome(id(31)), conv(id(31)), appendChange(HOMES, id(31), "sessions"))],
    ["a helper's conversation, with its line", () => (conv(id(3), "2026-11-02T00-00-00-000Z_h.jsonl"), appendChange(HOMES, id(3), "sessions"))],
    ["a second conversation written by a chat, seen by the watch", () => noteHomeSessionPath(conv(id(2), "2026-11-02T00-00-00-000Z_b.jsonl"))],
    ["a file renamed into a home, seen by the watch", () => (writeFileSync(join(scratch, "r.jsonl"), header(id(4))), renameSync(join(scratch, "r.jsonl"), join(HOMES, id(4), "sessions", "r.jsonl")), noteHomeSessionPath(join(HOMES, id(4), "sessions", "r.jsonl")))],
    ["a conversation removed, seen by the watch", () => (rmSync(join(HOMES, id(5), "sessions", `2026-11-01T00-00-00-000Z_${id(5)}.jsonl`)), noteHomeSessionPath(join(HOMES, id(5), "sessions", `2026-11-01T00-00-00-000Z_${id(5)}.jsonl`)))],
    ["a home deleted (its line)", () => (rmSync(join(HOMES, id(7)), { recursive: true }), forgetHome(id(7)))],
    ["a folder that isn't a file, seen by the watch", () => (mkdirSync(join(HOMES, id(8), "sessions", "dir.jsonl")), noteHomeSessionPath(join(HOMES, id(8), "sessions", "dir.jsonl")))],
  ];
  for (const [what, act] of steps) {
    act();
    assert.deepEqual(await sorted(), reference(), what);
  }

  // A restart: the index read back from disk lists the same.
  await new Promise((r) => setTimeout(r, 10));
  resetHomeSessionFiles();
  expireHomeSessionFilesSweepForTest();
  assert.ok(readIndex(HOMES), "the index was written");
  assert.deepEqual(await sorted(), reference(), "after a restart, from the index");

  // A crash before the pending index write: the lines since the index on disk say which homes to read again.
  noteHomeSessionPath(conv(id(12), "2026-11-04T00-00-00-000Z_c.jsonl"));
  assert.deepEqual(await sorted(), reference(), "seen by the watch (the index written at once)");
  noteHomeSessionPath(conv(id(13), "2026-11-04T00-00-00-000Z_d.jsonl"));
  assert.deepEqual(await sorted(), reference(), "seen by the watch (the index write waits)");
  assert.equal(readIndex(HOMES)!.homes[id(13)]!.files.includes("2026-11-04T00-00-00-000Z_d.jsonl"), false, "the index on disk is older");
  crashHomeSessionFilesForTest();
  resetChangeTails(); // a new process: its reader starts where the index on disk left off
  assert.deepEqual(await sorted(), reference(), "after a crash, from the older index and the log");

  // A torn index: rebuilt by one walk.
  writeFileSync(join(HOMES, INDEX_NAME), "{");
  resetHomeSessionFiles();
  assert.deepEqual(await sorted(), reference(), "after a torn index");

  // An index edited by hand into a shape no writer makes: rebuilt by one walk, never a list that fails.
  for (const bad of [{ files: [1], st: "" }, { files: ["../x.jsonl"], st: "" }])
    for (const cursor of [{ seg: 1, off: 0 }, { seg: 1, off: -5 }]) {
      writeFileSync(join(HOMES, INDEX_NAME), JSON.stringify({ v: 1, cursor, homes: { [id(2)]: bad } }));
      resetHomeSessionFiles();
      resetChangeTails();
      assert.deepEqual(await sorted(), reference(), `after a hand-edited index (${JSON.stringify(bad)}, ${JSON.stringify(cursor)})`);
    }

  // And the session list itself lists one row per homed conversation the walk finds (its own files are pi's, none here).
  const rows = (await listSessions()).map((r) => r.path).sort();
  assert.deepEqual(rows, reference().filter((p) => statSync(p).size > 0));
  assert.deepEqual((await listSessionFiles()).sort(), reference());
});

test("a home nothing says changed is not read again; the backstop sweep reads every one", async () => {
  await sorted();
  const before = sessionFilesIo.readdirs;
  const stats = sessionFilesIo.stats;
  await sorted();
  assert.equal(sessionFilesIo.readdirs, before, "no folder read when nothing changed");
  assert.equal(sessionFilesIo.stats, stats, "no folder stat'ed either");
  // A file written behind Sova's back (no line, no watch): only the sweep finds it.
  const sneaked = conv(id(10), "2026-11-03T00-00-00-000Z_s.jsonl");
  assert.equal((await sorted()).includes(sneaked), false, "nothing told: the index stands");
  expireHomeSessionFilesSweepForTest();
  assert.equal((await sorted()).includes(sneaked), true, "the sweep reads every home");
  assert.deepEqual(await sorted(), reference());
});
