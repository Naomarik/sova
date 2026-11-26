// The Chats folder move (§app.chat-homes/chats-folder): the whole homes folder copied, each file checked, the paths in it
// rewritten, the marker written last, the server switched; refused, cancelled and interrupted moves leave the old folder
// in force. A scratch agent dir and homes folders, stand-in deps for the chat processes; no server.
import { scratchAgentDir, dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { CHAT_HOMES_ROOT_ENV, HOMES_ENV, homesRoot, homesRootInfo, MARKER_FILE, onHomesRootSwitch, rebaseHomePath, resetHomesMemoForTests } from "./root";
import { cancelMove, chatsFolderInfo, currentMove, JOURNAL_FILE, repositoryOf, syncIo, liveSyncOf, MOVE_STATE_FILE, moveHold, moveSettled, type MoveDeps, previewMove, recoverMove, resetMoveForTests, startMove, SUBFOLDER, targetOf } from "./move-root";
import { sessionPathShape } from "../paths";
import { acquireChatHandle, setChatRouter, type ChatHandle } from "../chat-handle";

const state = join(scratchAgentDir, "sova");
const ID = "019a0000-0000-7000-8000-00000000aaaa";
const ARCHIVED = "019a0000-0000-7000-8000-00000000bbbb";
const WORKER = "019a0000-0000-7000-8000-00000000cccc";
let n = 0;
let from = "";
/** Folders for the chats beside the agent dir, never in it (a move into it is refused). */
const outside = join(scratchAgentDir, "..", "chats-folders");
let to = "";
after(dropScratchAgentDir);
after(() => rmSync(outside, { recursive: true, force: true }));

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

/** Every file under a folder, by relative path → sha256 (dot names at the top left out, as the move does). */
function tree(dir: string, rel = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(join(dir, rel))) {
    if (!rel && name.startsWith(".")) continue;
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, r)).isDirectory()) for (const [k, v] of tree(dir, r)) out.set(k, v);
    else out.set(r, sha(join(dir, r)));
  }
  return out;
}

/** A homes folder shaped like a real one: a chat with a helper, and a compressed chat beside it. */
function seed(root: string): void {
  const home = join(root, ID);
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(join(home, "workers"), { recursive: true });
  mkdirSync(join(home, "chat", "attachments"), { recursive: true });
  writeFileSync(join(home, "home.json"), JSON.stringify({ v: 1, id: ID, stateRoot: state, layout: 1, device: { id: "d", name: "d" }, createdAt: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n");
  const conv = join(home, "sessions", `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
  writeFileSync(conv, `${JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: `see ${join(home, "chat", "attachments", "a.png")}` }] } })}\n`);
  utimesSync(conv, new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
  const helper = join(home, "sessions", `2026-01-01T00-00-01-000Z_${WORKER}.jsonl`);
  writeFileSync(helper, `${JSON.stringify({ type: "session", version: 3, id: WORKER, timestamp: "2026-01-01T00:00:01.000Z", cwd: "/tmp", parentSession: conv })}\n`);
  writeFileSync(join(home, "workers", `${WORKER}.json`), JSON.stringify({ v: 1, chatId: WORKER, path: helper, parent: { path: conv, sessionId: ID, workerId: "ag_01" }, spec: { env: { SOVA_SHARED_DIR: join(home, "shared") } } }) + "\n");
  writeFileSync(join(home, "chat", "attachments", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(join(home, "chat", "draft.json"), "{}\n");
  chmodSync(join(home, "chat", "draft.json"), 0o600);
  // A compressed chat: its archive and its record beside it.
  writeFileSync(join(root, `${ARCHIVED}.tar.gz`), Buffer.alloc(3000, 7));
  writeFileSync(join(root, `${ARCHIVED}.compressed.json`), JSON.stringify({ id: ARCHIVED, kind: "home", archive: join(root, `${ARCHIVED}.tar.gz`), home: join(root, ARCHIVED) }) + "\n");
  // Device-local files: never copied.
  writeFileSync(join(root, ".changes.0.log"), "x\n");
  writeFileSync(join(root, ".index.json"), "{}\n");
}

function deps(over: Partial<MoveDeps> = {}): MoveDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    working: () => [],
    stopChats: async () => (calls.push("stopChats"), 0),
    holdReaders: async () => (calls.push("holdReaders"), ["reader"]),
    releaseReaders: async () => void calls.push("releaseReaders"),
    afterSwitch: async (a, b) => void calls.push(`afterSwitch ${a === from} ${b === to} marker=${JSON.parse(readFileSync(join(state, MARKER_FILE), "utf8")).homes === to}`),
    log: () => {},
    ...over,
  };
}

beforeEach(() => {
  n++;
  delete process.env[HOMES_ENV];
  delete process.env[CHAT_HOMES_ROOT_ENV];
  process.env.PI_CODING_AGENT_DIR = scratchAgentDir;
  from = join(outside, `old-${n}`);
  to = join(outside, `new-${n}`);
  mkdirSync(state, { recursive: true });
  rmSync(join(state, MOVE_STATE_FILE), { force: true });
  seed(from);
  writeFileSync(join(state, MARKER_FILE), JSON.stringify({ v: 1, homes: from }));
  resetHomesMemoForTests();
  resetMoveForTests();
});

describe("a move", () => {
  test("copies every chat and compressed chat, checked, the paths in it moved, the marker last; the old folder stays as it was", async () => {
    const before = tree(from);
    const switched: string[] = [];
    const off = onHomesRootSwitch(() => switched.push(homesRoot()));
    const d = deps();
    const preview = await previewMove(to, d);
    assert.equal(preview.target, to);
    assert.equal(preview.chats, 2, "the chat and the compressed chat");
    assert.equal(preview.refusal, undefined);
    const r = await startMove(to, d);
    assert.ok(r.ok);
    assert.match(moveHold() ?? "", /moving to/, "new chats and opens wait while it runs");
    await moveSettled();
    off();
    const m = currentMove()!;
    assert.equal(m.phase, "done", m.error);
    assert.equal(moveHold(), null);
    assert.deepEqual(d.calls, ["holdReaders", "stopChats", "afterSwitch true true marker=true", "releaseReaders"], "chats stopped before the copy; the server switched after the marker");
    assert.deepEqual(switched, [to], "the root memos are cleared and listeners told, once");
    assert.equal(homesRoot(), to);
    assert.equal(homesRootInfo().source, "marker");
    const marker = JSON.parse(readFileSync(join(state, MARKER_FILE), "utf8"));
    assert.deepEqual(marker.movedFrom, [from]);
    // The old folder: untouched.
    assert.deepEqual(tree(from), before);
    // The new one: every file, the device-local ones and the journal left out.
    const now = tree(to);
    assert.deepEqual([...now.keys()].sort(), [...before.keys()].sort());
    assert.equal(existsSync(join(to, ".index.json")), false);
    assert.equal(existsSync(join(to, JOURNAL_FILE)), false);
    // Files no path is rewritten in are byte for byte the same; mode and times kept.
    for (const rel of [`${ARCHIVED}.tar.gz`, `${ID}/chat/attachments/a.png`, `${ID}/home.json`]) assert.equal(now.get(rel), before.get(rel), rel);
    assert.equal(statSync(join(to, ID, "chat", "draft.json")).mode & 0o777, 0o600);
    const conv = join(to, ID, "sessions", `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
    assert.equal(statSync(conv).mtime.toISOString(), "2026-02-01T00:00:00.000Z", "the list's order is kept");
    // The paths in it: the helper's record, the fork's header and the compressed chat's record name the new folder.
    const rec = JSON.parse(readFileSync(join(to, ID, "workers", `${WORKER}.json`), "utf8"));
    assert.equal(rec.path, join(to, ID, "sessions", `2026-01-01T00-00-01-000Z_${WORKER}.jsonl`));
    assert.equal(rec.parent.path, conv);
    assert.equal(rec.spec.env.SOVA_SHARED_DIR, join(to, ID, "shared"));
    assert.equal(JSON.parse(readFileSync(join(to, ID, "sessions", `2026-01-01T00-00-01-000Z_${WORKER}.jsonl`), "utf8").split("\n")[0]!).parentSession, conv);
    assert.equal(JSON.parse(readFileSync(join(to, `${ARCHIVED}.compressed.json`), "utf8")).archive, join(to, `${ARCHIVED}.tar.gz`));
    // What was said is kept verbatim (an attachment's old path), and read as the same file now.
    const said = readFileSync(conv, "utf8");
    assert.ok(said.includes(join(from, ID, "chat", "attachments", "a.png")));
    assert.equal(rebaseHomePath(join(from, ID, "chat", "attachments", "a.png")), join(to, ID, "chat", "attachments", "a.png"));
    // A browser's tab still naming the old place opens the chat in the new one.
    assert.equal(sessionPathShape(join(from, ID, "sessions", `2026-01-01T00-00-00-000Z_${ID}.jsonl`)), conv);
    assert.deepEqual(chatsFolderInfo().movedFrom, [from]);
  });

  test("a folder that holds files gets a sova-chats folder of its own; one already in it, or inside the chats folder, is refused", async () => {
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "notes.txt"), "mine");
    assert.equal(targetOf(to), join(to, SUBFOLDER));
    mkdirSync(join(to, SUBFOLDER));
    writeFileSync(join(to, SUBFOLDER, "x"), "x");
    assert.match((await previewMove(to, deps())).refusal ?? "", /already holds files/);
    assert.match((await previewMove(join(from, "inside"), deps())).refusal ?? "", /inside your chats folder/);
    assert.match((await previewMove(from, deps())).refusal ?? "", /already/);
    assert.match((await previewMove(join(scratchAgentDir, "sessions", "x"), deps())).refusal ?? "", /pi's own sessions folder/);
    // Outside everything a tool writes: not in the agent dir or the state root, nor around them, nor in a repository.
    for (const inside of [join(scratchAgentDir, `chats-${n}`), join(state, `chats-${n}`)]) {
      assert.match((await previewMove(inside, deps())).refusal ?? "", /inside Sova's own settings folder/, inside);
      const r = await startMove(inside, deps());
      assert.ok(!r.ok && /Sova's own settings folder/.test(r.error));
      assert.equal(existsSync(inside), false, "nothing made there");
    }
    // Picking the agent dir itself (it holds files): its sova-chats would be inside it.
    assert.match((await previewMove(scratchAgentDir, deps())).refusal ?? "", /inside Sova's own settings folder/);
    const repo = join(outside, `repo-${n}`);
    mkdirSync(join(repo, ".git"), { recursive: true });
    assert.match((await previewMove(join(repo, "chats"), deps())).refusal ?? "", /inside a repository/);
    rmSync(repo, { recursive: true, force: true });
    // A home kept as a dotfiles repository (~/.git) never counts, or every folder under home would be refused.
    const home = join(outside, `home-${n}`);
    mkdirSync(join(home, ".git"), { recursive: true });
    mkdirSync(join(home, "code", "app", ".git"), { recursive: true });
    assert.equal(repositoryOf(join(home, "data", "chats"), home), null);
    assert.equal(repositoryOf(join(home, "code", "app", "chats"), home), join(home, "code", "app"));
  });

  test("refused while a chat works, and while a variable sets the folder: nothing stops, nothing is copied", async () => {
    const d = deps({ working: () => ["Fix the build"] });
    const r = await startMove(to, d);
    assert.ok(!r.ok);
    assert.match(r.error, /1 chat is working: Fix the build/);
    assert.deepEqual(d.calls, []);
    assert.equal(existsSync(to), false);
    process.env[HOMES_ENV] = from;
    resetHomesMemoForTests();
    const e = await startMove(to, deps());
    assert.ok(!e.ok);
    assert.match(e.error, /SOVA_CHAT_HOMES sets your chats folder/);
    assert.match(chatsFolderInfo().locked ?? "", /SOVA_CHAT_HOMES/);
    assert.equal(chatsFolderInfo().source, "env");
  });

  test("a live-sync folder is named, and still allowed", async () => {
    const box = join(outside, `Dropbox-${n}`, "chats");
    assert.equal(liveSyncOf(box), "Dropbox");
    const st = join(outside, `synced-${n}`);
    mkdirSync(st, { recursive: true });
    writeFileSync(join(st, ".stfolder"), "");
    assert.equal(liveSyncOf(join(st, "chats")), "Syncthing");
    assert.equal(liveSyncOf(join(scratchAgentDir, "plain")), undefined);
    const p = await previewMove(box, deps());
    assert.equal(p.liveSync, "Dropbox");
    assert.equal(p.refusal, undefined);
  });

  test("Cancel before the switch: the partial copy goes, the marker and the old folder stay", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = deps({ stopChats: async () => (await gate, 0) });
    assert.ok((await startMove(to, d)).ok);
    assert.equal(cancelMove(), true);
    release();
    await moveSettled();
    assert.equal(currentMove()!.phase, "cancelled");
    assert.equal(JSON.parse(readFileSync(join(state, MARKER_FILE), "utf8")).homes, from);
    resetHomesMemoForTests();
    assert.equal(homesRoot(), from);
    assert.equal(existsSync(to), false);
    assert.equal(moveHold(), null);
  });

  test("a copy that fails leaves the old folder in force, the marker unwritten, and the programs started again", async () => {
    chmodSync(join(from, ID, "chat", "attachments", "a.png"), 0o000);
    const d = deps();
    assert.ok((await startMove(to, d)).ok);
    await moveSettled();
    chmodSync(join(from, ID, "chat", "attachments", "a.png"), 0o600);
    const m = currentMove()!;
    // Root can read a 000 file: then the move simply succeeds, and this test says nothing.
    if (m.phase === "done") return;
    assert.equal(m.phase, "failed");
    assert.match(m.error ?? "", /Your chats stay in/);
    assert.equal(JSON.parse(readFileSync(join(state, MARKER_FILE), "utf8")).homes, from);
    assert.ok(d.calls.includes("releaseReaders"));
    assert.ok(!d.calls.some((c) => c.startsWith("afterSwitch")));
    // Its partial copy goes, as a cancel's does: a retry to the same folder starts there clean.
    assert.equal(existsSync(to), false, "the folder the move made is gone");
    assert.equal((await previewMove(to, deps())).target, to, "the same folder again, not a sova-chats beside a half copy");
  });

  test("a move the server's stop interrupted is resumed from the files its journal checked", async () => {
    // As a stop partway would leave it: the state file mid-copy, one file copied and journaled.
    const rel = `${ARCHIVED}.tar.gz`;
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, rel), readFileSync(join(from, rel)));
    const st = statSync(join(from, rel));
    writeFileSync(join(to, JOURNAL_FILE), `${JSON.stringify({ rel, size: st.size, mtimeMs: st.mtimeMs, sha256: sha(join(from, rel)), out: st.size })}\n{"rel":"torn`);
    // A marker on the copied file: a resume that copied it again would overwrite it.
    utimesSync(join(to, rel), new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    writeFileSync(join(state, MOVE_STATE_FILE), JSON.stringify({ id: "m1", from, to, phase: "copying", startedAt: "2026-01-01T00:00:00Z", chats: 2, files: 9, bytes: 1, copiedFiles: 1, copiedBytes: 1, made: true }));
    recoverMove(() => {});
    assert.equal(currentMove()!.phase, "interrupted");
    assert.equal(homesRoot(), from, "the old folder is still in force");
    const p = await previewMove(to, deps());
    assert.equal(p.target, to, "the same folder, not a sova-chats inside it");
    assert.equal(p.refusal, undefined);
    assert.ok((await startMove(to, deps())).ok);
    await moveSettled();
    assert.equal(currentMove()!.phase, "done", currentMove()!.error);
    assert.equal(statSync(join(to, rel)).mtime.toISOString(), "2020-01-01T00:00:00.000Z", "the journaled file wasn't copied again");
    assert.equal(homesRoot(), to);
  });

  test("a start that finds the marker already naming the new folder finishes the move", () => {
    mkdirSync(to, { recursive: true });
    writeFileSync(join(state, MARKER_FILE), JSON.stringify({ v: 1, homes: to, movedFrom: [from] }));
    writeFileSync(join(state, "compressed-sessions.json"), JSON.stringify({ v: 1, chats: { [ARCHIVED]: { archive: join(from, `${ARCHIVED}.tar.gz`) } } }));
    writeFileSync(join(state, MOVE_STATE_FILE), JSON.stringify({ id: "m2", from, to, phase: "switching", startedAt: "2026-01-01T00:00:00Z", chats: 2, files: 9, bytes: 1, copiedFiles: 9, copiedBytes: 1 }));
    resetHomesMemoForTests();
    recoverMove(() => {});
    assert.equal(currentMove()!.phase, "done");
    assert.equal(JSON.parse(readFileSync(join(state, "compressed-sessions.json"), "utf8")).chats[ARCHIVED].archive, join(to, `${ARCHIVED}.tar.gz`));
  });

  test("refused while a background job a chat started still runs in the chats folder; one that ended or is gone doesn't hold it", async () => {
    const jobs = join(state, "background-jobs", encodeURIComponent(ID));
    mkdirSync(jobs, { recursive: true });
    const conv = join(from, ID, "sessions", `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
    const job = { v: 1, id: "j1", sessionId: ID, path: conv, kind: "kept", command: "pnpm run dev", cwd: "/tmp", unit: "sova-job-x-j1.scope", driver: "systemd", startedAt: Date.now(), bootId: "b" };
    writeFileSync(join(jobs, "j1.json"), JSON.stringify(job));
    try {
      const d = deps();
      const r = await startMove(to, d);
      assert.ok(!r.ok);
      assert.match(r.error, /1 background job that chats started is still running: pnpm run dev\. It writes in your chats folder/);
      assert.deepEqual(d.calls, [], "nothing stopped");
      assert.equal(existsSync(to), false);
      assert.match((await previewMove(to, d)).refusal ?? "", /pnpm run dev/);
      // Its unit gone (the keeper hasn't swept it yet): not a reason to wait.
      assert.equal((await previewMove(to, deps({ jobAlive: async () => false }))).refusal, undefined);
      writeFileSync(join(jobs, "j1.json"), JSON.stringify({ ...job, ended: { at: Date.now(), how: "exited", card: "wake" } }));
      assert.equal((await previewMove(to, d)).refusal, undefined);
    } finally {
      rmSync(join(state, "background-jobs"), { recursive: true, force: true });
    }
  });

  test("the state root's records naming a chat's file (shares, jobs, wakes, a crash marker) name it in the new folder; an old path opens it there", async () => {
    const conv = (root: string) => join(root, ID, "sessions", `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
    const put = (file: string, v: unknown) => (mkdirSync(join(file, ".."), { recursive: true }), writeFileSync(file, JSON.stringify(v)));
    const files = {
      shares: join(state, "session-shares.json"),
      job: join(state, "background-jobs", encodeURIComponent(ID), "j2.json"),
      wake: join(state, "wake-nudges", `${ID}.jobs.json`),
      inflight: join(state, "chats", "inflight", `${ID}.json`),
    };
    put(files.shares, { version: 1, shares: [{ id: "s1", sessionId: ID, sessionPath: conv(from) }] });
    put(files.job, { v: 1, id: "j2", sessionId: ID, path: conv(from), kind: "kept", command: "x", cwd: "/tmp", unit: "u", driver: "systemd", startedAt: 1, bootId: "b", ended: { at: 2, how: "exited", card: "wake" } });
    put(files.wake, { v: 1, source: "jobs", sessionId: ID, path: conv(from), items: [{ id: "j2", at: 2 }], syncedAt: 2 });
    put(files.inflight, { v: 1, path: conv(from), since: 1 });
    try {
      assert.ok((await startMove(to, deps())).ok);
      await moveSettled();
      assert.equal(currentMove()!.phase, "done", currentMove()!.error);
      for (const [name, f] of Object.entries(files)) {
        const text = readFileSync(f, "utf8");
        assert.ok(text.includes(conv(to)) && !text.includes(from), `${name}: ${text}`);
      }
      // The net under every chat open (a wake keeper's, a crash resume's): an old path opens the chat where it is now.
      const opened: string[] = [];
      setChatRouter({ ready: async () => {}, get: () => undefined, all: () => [], acquire: async (p: string) => (opened.push(p), {} as ChatHandle), close: async () => false });
      await acquireChatHandle(conv(from));
      assert.deepEqual(opened, [conv(to)]);
    } finally {
      setChatRouter(null);
      for (const f of Object.values(files)) rmSync(f, { force: true });
    }
  });

  test("the copy is on the disk before the marker: each rewritten file flushed, then every folder of the copy and its parent", async () => {
    const seen: string[] = [];
    const was = { ...syncIo };
    syncIo.file = (f) => (seen.push(`file ${f}`), was.file(f));
    syncIo.dir = (d) => (seen.push(`dir ${d}`), was.dir(d));
    const off = onHomesRootSwitch(() => seen.push("marker"));
    try {
      assert.ok((await startMove(to, deps())).ok);
      await moveSettled();
    } finally {
      off();
      Object.assign(syncIo, was);
    }
    assert.equal(currentMove()!.phase, "done", currentMove()!.error);
    const marker = seen.indexOf("marker");
    assert.ok(marker > 0, "the switch came after flushes");
    // The helper's record had its paths rewritten after its checked copy: flushed again.
    assert.ok(seen.slice(0, marker).includes(`file ${join(to, ID, "workers", `${WORKER}.json`)}.sova-part`), seen.join("\n"));
    for (const d of [to, join(to, ID), join(to, ID, "sessions"), join(to, ID, "workers"), join(to, ID, "chat", "attachments"), join(to, "..")].map((p) => join(p)))
      assert.ok(seen.slice(0, marker).includes(`dir ${d}`), `${d} flushed before the marker`);
  });
});
