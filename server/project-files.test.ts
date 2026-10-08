// Run: pnpm test -- server/project-files.test.ts. The project's file store (§app/file-intake):
// names, kinds, the ledger's fold, staging (the cap stops a stream and leaves nothing), receiving,
// confirming, deleting, the per-person room, the host budget and the sweep. A throwaway
// PI_CODING_AGENT_DIR and ledger in the OS temp dir.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-project-files-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
after(() => rmSync(root, { recursive: true, force: true }));
const f = await import("./project-files");
f.setLedgerPathForTests((pid) => join(root, "ws", pid, "files.jsonl"));
const PID = "prj_aaaaaaaa";
const body = (b: Buffer | string, chunk = 64 * 1024): AsyncIterable<Uint8Array> => Readable.from((function* () {
  const buf = Buffer.from(b);
  for (let i = 0; i < buf.length; i += chunk) yield buf.subarray(i, i + chunk);
})());
const stage = (name: string, data: Buffer | string, extra: Partial<Parameters<typeof f.stageFile>[0]> = {}) =>
  f.stageFile({ projectId: PID, sessionId: "s-one", personId: "p_kim", name, type: "application/json", body: body(data), maxBytes: 25 * 1024 * 1024, ...extra });

describe("names and kinds", () => {
  test("a name keeps only its last segment, no control characters or leading dots, cut keeping its extension", () => {
    assert.equal(f.sanitizeName("../../etc/passwd"), "passwd");
    assert.equal(f.sanitizeName("C:\\Users\\kim\\dump.json"), "dump.json");
    assert.equal(f.sanitizeName(".bashrc"), "bashrc");
    assert.equal(f.sanitizeName("..."), "file");
    assert.equal(f.sanitizeName(""), "file");
    assert.equal(f.sanitizeName("a\u0000b\nc\u202Egnp.exe"), "abcgnp.exe");
    const long = f.sanitizeName(`${"x".repeat(300)}.json`);
    assert.equal(long.length, 120);
    assert.ok(long.endsWith(".json"));
    assert.equal(f.sanitizeName("Alex's dump (final).json"), "Alex's dump (final).json");
  });
  test("a taken name gets (2), (3), …", () => {
    assert.equal(f.dedupeName("a.json", new Set()), "a.json");
    assert.equal(f.dedupeName("a.json", new Set(["a.json"])), "a (2).json");
    assert.equal(f.dedupeName("a.json", new Set(["a.json", "a (2).json"])), "a (3).json");
    assert.equal(f.dedupeName("README", new Set(["README"])), "README (2)");
  });
  test("the first bytes label the kind, never refuse it", () => {
    const k = (s: string | Buffer, name = "x", whole?: Buffer) => f.sniffKind(Buffer.from(s), name, whole);
    assert.equal(k("PK\x03\x04rest"), "zip archive");
    assert.equal(k(Buffer.from([0x1f, 0x8b, 8])), "gzip archive");
    assert.equal(k("%PDF-1.7"), "PDF document");
    assert.equal(k(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "PNG image");
    const j = Buffer.from('  {"a": [1, 2]}\n');
    assert.equal(k(j, "x", j), "JSON");
    assert.equal(k('{"a": 1', "x", Buffer.from('{"a": 1')), "text");
    assert.equal(k("a,b\n1,2\n", "data.csv"), "CSV text");
    assert.equal(k("hello"), "text");
    assert.equal(k(Buffer.from([0, 1, 2, 3])), "binary file");
    const tar = Buffer.alloc(512);
    tar.write("ustar", 257, "latin1");
    assert.equal(k(tar), "tar archive");
  });
  test("sizes in words", () => {
    assert.deepEqual([f.sizeWords(1), f.sizeWords(900), f.sizeWords(340 * 1024), f.sizeWords(1.1 * 1024 * 1024)], ["1 byte", "900 bytes", "340 KB", "1.1 MB"]);
  });
});

describe("staging, receiving, confirming, deleting", () => {
  test("an upload is kept 0600 in its own 0700 folder with a sidecar, hashed; no ledger line until a message sends it", async () => {
    const s = await stage("dump.json", '{"records": []}');
    const dir = join(f.filesRoot(), PID, s.id);
    assert.deepEqual(readdirSync(dir).sort(), [".meta.json", "dump.json"]);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "dump.json")).mode & 0o777, 0o600);
    assert.equal(s.kind, "JSON");
    assert.deepEqual(f.readLedger(PID), []);
    const taken = f.takeStagedFiles(PID, "s-one", "p_kim", [s.id]);
    assert.match(taken[0]!.sha256, /^[0-9a-f]{64}$/);
    assert.throws(() => f.takeStagedFiles(PID, "s-one", "p_other", [s.id]), /uploaded again/, "another person's");
    assert.throws(() => f.takeStagedFiles(PID, "s-two", "p_kim", [s.id]), /uploaded again/, "another session's");
    f.receiveFiles(PID, taken);
    assert.deepEqual(f.readLedger(PID).map((r) => [r.id, r.status]), [[s.id, "received"]]);
    assert.ok(existsSync(join(f.sessionView(PID, "s-one"), "dump.json")), "linked into the session's view");
    assert.equal(statSync(join(f.sessionView(PID, "s-one"), "dump.json")).ino, statSync(join(dir, "dump.json")).ino, "a hard link, not a copy or a symlink");
    assert.throws(() => f.takeStagedFiles(PID, "s-one", "p_kim", [s.id]), /uploaded again/, "single use");
    // confirm: only this session's
    assert.throws(() => f.confirmFile(PID, "s-two", s.id), /No file/);
    assert.equal(f.confirmFile(PID, "s-one", s.id, "fine").status, "confirmed");
    assert.equal(f.fileOf(PID, s.id)?.status, "confirmed");
    // delete: the line, the bytes and the view's link go; the ledger keeps every line
    f.deleteFile(PID, s.id, "operator");
    assert.equal(f.fileOf(PID, s.id), null);
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(join(f.sessionView(PID, "s-one"), "dump.json")), false);
    assert.deepEqual(readFileSync(f.ledgerPath(PID), "utf8").trim().split("\n").map((l) => JSON.parse(l).status), ["received", "confirmed", "deleted"]);
  });

  test("a body past the cap stops while it streams and leaves nothing behind", async () => {
    const before = readdirSync(join(f.filesRoot(), PID)).length;
    await assert.rejects(stage("big.bin", Buffer.alloc(3 * 1024 * 1024, 1), { maxBytes: 1024 * 1024 }), (e: unknown) => e instanceof f.FileRefusal && e.status === 413);
    assert.equal(readdirSync(join(f.filesRoot(), PID)).length, before);
  });

  test("an upload's reservation counts while it streams and is released when it ends: success, a refusal or an abort", async () => {
    const pid = "prj_flight";
    const flying = () => f.inflightFor(pid, "s", "p");
    const total = f.inflightBytes();
    // Held while in flight: the room check sees it before any sidecar exists.
    const r1 = f.reserveUpload(pid, "s", "p", 150 * 1024 * 1024);
    assert.deepEqual(flying(), { files: 1, bytes: 150 * 1024 * 1024 });
    assert.equal(f.inflightBytes(), total + 150 * 1024 * 1024);
    assert.throws(() => f.reserveUpload(pid, "s", "p", 60 * 1024 * 1024), (e: unknown) => e instanceof f.FileRefusal && e.code === "file-limit");
    assert.throws(() => f.assertFilesBudget(10, { maxBytes: total + 150 * 1024 * 1024 + 5, freeFloor: 0 }, 1e15, 0), (e: unknown) => e instanceof f.FileRefusal && e.status === 507, "host-wide in-flight bytes count");
    r1();
    r1();
    assert.deepEqual(flying(), { files: 0, bytes: 0 }, "released once, idempotent");
    assert.equal(f.inflightBytes(), total);
    // Refused while streaming (past the cap): released.
    const big = f.reserveUpload(pid, "s", "p", 2048);
    await assert.rejects(f.stageFile({ projectId: pid, sessionId: "s", personId: "p", name: "a.bin", type: "", body: body(Buffer.alloc(4096, 1), 512), maxBytes: 1024, release: big }), /Over/);
    assert.deepEqual(flying(), { files: 0, bytes: 0 });
    // Aborted mid-stream (the connection dropped): released, nothing left on disk.
    const cut = f.reserveUpload(pid, "s", "p", 4096);
    const aborted: AsyncIterable<Uint8Array> = (async function* () {
      yield Buffer.alloc(100, 1);
      throw new Error("aborted");
    })();
    await assert.rejects(f.stageFile({ projectId: pid, sessionId: "s", personId: "p", name: "b.bin", type: "", body: aborted, maxBytes: 1 << 20, release: cut }), /aborted/);
    assert.deepEqual(flying(), { files: 0, bytes: 0 });
    assert.equal(f.inflightBytes(), total);
    assert.deepEqual(readdirSync(join(f.filesRoot(), pid)).filter((n) => n.startsWith("f_")), []);
    // And on success.
    const ok = f.reserveUpload(pid, "s", "p", 1);
    await f.stageFile({ projectId: pid, sessionId: "s", personId: "p", name: "c.txt", type: "", body: body("c"), maxBytes: 10, release: ok });
    assert.deepEqual(flying(), { files: 0, bytes: 0 });
  });

  test("two uploads at once never take one name", async () => {
    const [a, b] = await Promise.all([stage("same.txt", "a"), stage("same.txt", "b")]);
    assert.deepEqual([a.name, b.name].sort(), ["same (2).txt", "same.txt"]);
  });

  test("the ledger fold: newest status wins, malformed lines are skipped, nothing comes back from deleted", () => {
    const p = f.ledgerPath("prj_fold");
    mkdirSync(join(p, ".."), { recursive: true });
    const id = "f_AAAAAAAAAAAAAAAA";
    writeFileSync(p, "");
    for (const l of [
      { v: 1, id, name: "a.json", size: 1, personId: "p", sessionId: "s", at: "2026-10-01T00:00:00Z", status: "received" },
      "not json",
      { v: 1, id: "f_bad", name: "x", size: 1, personId: "p", sessionId: "s", at: "x", status: "received" },
      { v: 1, id, status: "confirmed", at: "2026-10-01T00:01:00Z" },
      { v: 1, id, status: "deleted", at: "2026-10-01T00:02:00Z" },
      { v: 1, id, status: "confirmed", at: "2026-10-01T00:03:00Z" },
    ])
      appendFileSync(p, `${typeof l === "string" ? l : JSON.stringify(l)}\n`);
    assert.deepEqual(f.readLedger("prj_fold").map((r) => [r.id, r.status]), [[id, "deleted"]]);
    assert.deepEqual(f.liveFiles("prj_fold"), []);
  });

  test("the person's room: 20 files or 200 MB in a session, staged and received together", async () => {
    const pid = "prj_room";
    for (let i = 0; i < 20; i++) await f.stageFile({ projectId: pid, sessionId: "s", personId: "p", name: `${i}.txt`, type: "", body: body("x"), maxBytes: 100 });
    assert.throws(() => f.assertPersonRoom(pid, "s", "p", 1), /most files/);
    f.assertPersonRoom(pid, "s", "q", 1);
    f.assertPersonRoom(pid, "t", "p", 1);
    assert.throws(() => f.assertPersonRoom(pid, "s2", "p", 200 * 1024 * 1024 + 1), /most files/, "bytes too");
  });

  test("the host budget and the free-disk floor refuse with 507", () => {
    assert.throws(() => f.assertFilesBudget(10, { maxBytes: 100, freeFloor: 0 }, 1e12, 95), (e: unknown) => e instanceof f.FileRefusal && e.status === 507);
    assert.throws(() => f.assertFilesBudget(10, { maxBytes: 1e12, freeFloor: 100 }, 105, 0), (e: unknown) => e instanceof f.FileRefusal && e.status === 507);
    f.assertFilesBudget(10, { maxBytes: 1e12, freeFloor: 100 }, 1000, 0);
    assert.deepEqual(f.filesBudget(), { maxBytes: 10 * 1024 * 1024 * 1024, freeFloor: 2048 * 1024 * 1024 });
  });

  test("the sweep removes old staged files and those of a session no longer open; received ones stay", async () => {
    const pid = "prj_sweep";
    const kept = await f.stageFile({ projectId: pid, sessionId: "open-one", personId: "p", name: "kept.txt", type: "", body: body("k"), maxBytes: 100 });
    const old = await f.stageFile({ projectId: pid, sessionId: "open-one", personId: "p", name: "old.txt", type: "", body: body("o"), maxBytes: 100, now: Date.now() - f.STAGED_TTL_MS - 1000 });
    const closed = await f.stageFile({ projectId: pid, sessionId: "closed-one", personId: "p", name: "c.txt", type: "", body: body("c"), maxBytes: 100 });
    const recv = await f.stageFile({ projectId: pid, sessionId: "closed-one", personId: "p", name: "r.txt", type: "", body: body("r"), maxBytes: 100 });
    f.receiveFiles(pid, f.takeStagedFiles(pid, "closed-one", "p", [recv.id]));
    // A crash mid-upload: a folder with no sidecar and no ledger line, an hour old.
    const crash = join(f.filesRoot(), pid, "f_CCCCCCCCCCCCCCCC");
    mkdirSync(crash);
    utimesSync(crash, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    const removed = f.sweepFiles(Date.now(), (sid) => sid === "open-one");
    assert.ok(removed >= 3, "old, closed and the crash (other projects' staged files too)");
    const left = readdirSync(join(f.filesRoot(), pid)).filter((n) => n.startsWith("f_")).sort();
    assert.deepEqual(left, [kept.id, recv.id].sort());
    void old;
    void closed;
  });
});
