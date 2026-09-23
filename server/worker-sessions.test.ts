// Run: npx tsx --test server/worker-sessions.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// Worker-session detection (SessionSummary.workerSession): the self marker, the owner's durable
// refs (registry + completion header), the live registry, and the incremental read-only scan.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-worker-sessions-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-worker-sessions--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { WorkerSessions, WORKER_SESSION_MARKER, completionHeaderRef } = await import("./worker-sessions");
const { canonicalPath } = await import("./paths");

const idOf = (p: string) => basename(p, ".jsonl").split("_").pop() ?? "";
const noLive = () => [];

let n = 0;
function newId(): string {
  n++;
  return `01a0ccb9-3b00-7000-8000-${String(n).padStart(12, "0")}`;
}
const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-23T00:00:00.000Z", cwd: "/tmp" });
const user = (text: string) =>
  JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-09-23T00:00:01.000Z", message: { role: "user", content: text } });
const marker = () => JSON.stringify({ type: "custom", customType: "subagents-worker-session", data: { v: 1 } });
const registry = (data: Record<string, unknown>) =>
  JSON.stringify({ type: "custom", customType: "subagents-worker-registry", data: { v: 1, kind: "worker-registry", workerId: "ag_01", backend: "pi", at: 1, ...data } });
const complete = (content: unknown) => JSON.stringify({ type: "custom_message", customType: "subagent-complete", display: true, content });
const header3 = (ref: string, body = "the answer") => `### ag_01 (worker) — done\nSession: ${ref}\nModel: glm-5.3 · thinking: low\n${body}`;

/** A session file with the given entry lines (complete, newline-terminated); returns its canonical path. */
function session(lines: string[] = [], id = newId()): { path: string; id: string } {
  const path = join(sessionsDir, `2026-09-23T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, [header(id), user("hi"), ...lines].map((l) => `${l}\n`).join(""));
  return { path: canonicalPath(path), id };
}

const scanner = (live: () => any[] = noLive) => new WorkerSessions({ idOf, live });

test("the marker literal is the one pi-config's worker-mark.ts writes (rename protection)", () => {
  assert.equal(WORKER_SESSION_MARKER, "subagents-worker-session");
});

test("a marker entry marks the file it is in, and nothing else", async () => {
  const worker = session([marker()]);
  const other = session();
  const flagged = await scanner().refresh([worker.path, other.path]);
  assert.deepEqual([...flagged], [worker.path]);
});

test("registry refs by path and by bare id", async () => {
  const byPath = session();
  const byId = session();
  const bystander = session();
  const owner = session([registry({ backendSessionFile: byPath.path }), registry({ backendSessionId: byId.id })]);
  const flagged = await scanner().refresh([owner.path, byPath.path, byId.path, bystander.path]);
  assert.deepEqual(new Set(flagged), new Set([byPath.path, byId.path]));
});

test("completion header refs by path and by bare id; content as a string or text parts", async () => {
  const byPath = session();
  const byId = session();
  const owner = session([complete(header3(byPath.path)), complete([{ type: "text", text: header3(byId.id) }])]);
  const flagged = await scanner().refresh([owner.path, byPath.path, byId.path]);
  assert.deepEqual(new Set(flagged), new Set([byPath.path, byId.path]));
});

test("an Error line in the header still leaves the Session line a ref", () => {
  assert.equal(completionHeaderRef("### ag_02 (w) — error\nError: boom\nSession: abc\nModel: m\nbody"), "abc");
});

test("negatives: no Session line outside a completion header block ever becomes a ref", async () => {
  const target = session();
  const lines = [
    // a user message quoting a Session line
    JSON.stringify({ type: "message", id: "u2", parentId: null, message: { role: "user", content: `### x\nSession: ${target.path}\nModel: m` } }),
    user(`Session: ${target.path}`),
    // a completion whose BODY (after Model:) quotes a session path
    complete(`### ag_01 (w) — done\nModel: m\nSession: ${target.path}`),
    complete(header3("", `see\nSession: ${target.path}\nModel: m`)),
    // a Session line but no ### heading
    complete(`Session: ${target.path}\nModel: m`),
    complete(`intro\n### ag_01 (w) — done\nSession: ${target.path}\nModel: m`),
    // the right shape in the wrong entry kinds
    JSON.stringify({ type: "custom", customType: "subagent-complete", data: header3(target.path) }),
    JSON.stringify({ type: "custom_message", customType: "something-else", content: header3(target.path) }),
    // a marker text inside a user message does not mark this file
    user(`{"type":"custom","customType":"subagents-worker-session"}`),
  ];
  const owner = session(lines);
  const flagged = await scanner().refresh([owner.path, target.path]);
  assert.deepEqual([...flagged], []);
  assert.equal(completionHeaderRef(`Session: ${target.path}\nModel: m`), null);
  assert.equal(completionHeaderRef(`### a\nModel: m\nSession: ${target.path}`), null);
});

test("unresolvable refs yield nothing: outside the sessions dir, deleted, unlisted id, relative, live/", async () => {
  const gone = session();
  unlinkSync(gone.path);
  const listed = session(); // listed, but named only by a relative path
  const outside = join(agentDir, "elsewhere.jsonl");
  writeFileSync(outside, `${header(newId())}\n`);
  const owner = session([
    registry({ backendSessionFile: outside }),
    registry({ backendSessionFile: gone.path }),
    registry({ backendSessionId: gone.id }),
    registry({ backendSessionId: "01a0ccb9-ffff-7fff-8fff-ffffffffffff" }),
    complete(header3(join("--tmp-worker-sessions--", basename(listed.path)))),
    registry({ backendSessionFile: join(liveDir, "p1-x.jsonl") }),
  ]);
  const flagged = await scanner().refresh([owner.path, listed.path]);
  assert.deepEqual([...flagged], []);
});

test("live refs: this server's own record counts; sessionFile first, sessionId only as fallback", async () => {
  const byFile = session();
  const byId = session();
  const idIgnored = session();
  const rec = {
    sessionFile: null,
    pid: process.pid,
    rec: {
      presence: {
        workers: [
          { id: "ag_01", sessionFile: byFile.path, sessionId: idIgnored.id },
          { id: "ag_02", sessionId: byId.id },
          { id: "ag_03", sessionFile: "/etc/passwd.jsonl" },
          { id: "ag_04", sessionId: "8253ec8b-1ded-4c7f-bf1b-39d41a3b14cd" },
        ],
      },
    },
  };
  const flagged = await scanner(() => [rec]).refresh([byFile.path, byId.path, idIgnored.path]);
  assert.deepEqual(new Set(flagged), new Set([byFile.path, byId.path]));
});

test("live refs through the real registry reader include this process's own pid", async () => {
  const w = session();
  const liveFile = join(liveDir, `p${process.pid}-test.json`);
  writeFileSync(liveFile, JSON.stringify({ v: 1, session: { id: "x", pid: process.pid }, presence: { workers: [{ id: "ag_01", sessionFile: w.path }] } }));
  try {
    const flagged = await new WorkerSessions({ idOf }).refresh([w.path]);
    assert.deepEqual([...flagged], [w.path]);
  } finally {
    unlinkSync(liveFile);
  }
});

test("incremental: whole file, then only the appended bytes; shrink rescans from 0", async () => {
  const w1 = session();
  const w2 = session();
  const owner = session([registry({ backendSessionFile: w1.path })]);
  const s = scanner();
  const files = [owner.path, w1.path, w2.path];
  let flagged = await s.refresh(files);
  assert.deepEqual([...flagged], [w1.path]);
  const size0 = statSync(owner.path).size;
  assert.equal(s.entries.get(owner.path)?.scanned, size0);

  // Unchanged files are not read again.
  let before = s.bytesRead;
  await s.refresh(files);
  assert.equal(s.bytesRead, before);

  // Append: exactly the new bytes are read.
  const added = `${complete(header3(w2.id))}\n`;
  appendFileSync(owner.path, added);
  before = s.bytesRead;
  flagged = await s.refresh(files);
  assert.equal(s.bytesRead - before, Buffer.byteLength(added));
  assert.equal(s.entries.get(owner.path)?.scanned, size0 + Buffer.byteLength(added));
  assert.deepEqual(new Set(flagged), new Set([w1.path, w2.path]));

  // Shrink (rewrite): the old refs go, the file is read again from 0.
  writeFileSync(owner.path, `${header(owner.id)}\n${registry({ backendSessionFile: w2.path })}\n`);
  before = s.bytesRead;
  flagged = await s.refresh(files);
  assert.equal(s.bytesRead - before, statSync(owner.path).size);
  assert.deepEqual([...flagged], [w2.path]);
});

test("a trailing partial line is ignored until it is completed, and scanned never passes it", async () => {
  const w = session();
  const owner = session();
  const s = scanner();
  const files = [owner.path, w.path];
  await s.refresh(files);
  const complete0 = statSync(owner.path).size;
  const line = registry({ backendSessionFile: w.path });
  const cut = Math.floor(line.length / 2);
  appendFileSync(owner.path, line.slice(0, cut));
  assert.deepEqual([...(await s.refresh(files))], []);
  assert.equal(s.entries.get(owner.path)?.scanned, complete0);
  // Even a partial line that happens to be valid JSON is not parsed before its newline.
  appendFileSync(owner.path, line.slice(cut));
  assert.deepEqual([...(await s.refresh(files))], []);
  assert.equal(s.entries.get(owner.path)?.scanned, complete0);
  appendFileSync(owner.path, "\n");
  assert.deepEqual([...(await s.refresh(files))], [w.path]);
  assert.equal(s.entries.get(owner.path)?.scanned, statSync(owner.path).size);
});

test("lines longer than one 16 KB chunk parse across chunk boundaries", async () => {
  const w = session();
  const owner = session([user("x".repeat(40_000)), registry({ backendSessionFile: w.path, pad: "y".repeat(40_000) })]);
  assert.deepEqual([...(await scanner().refresh([owner.path, w.path]))], [w.path]);
});

test("a deleted owner takes its refs with it; a deleted file's entry is dropped", async () => {
  const w = session();
  const owner = session([registry({ backendSessionFile: w.path })]);
  const s = scanner();
  assert.deepEqual([...(await s.refresh([owner.path, w.path]))], [w.path]);
  unlinkSync(owner.path);
  // Both the listing no longer naming it and a stat failure drop it.
  assert.deepEqual([...(await s.refresh([w.path]))], []);
  assert.equal(s.entries.has(owner.path), false);
  assert.deepEqual([...(await s.refresh([owner.path, w.path]))], []);
  assert.equal(s.entries.has(owner.path), false);
});

test("isWorker: the single-summary path agrees with refresh", async () => {
  const w = session();
  const self = session([marker()]);
  const owner = session([registry({ backendSessionId: w.id })]);
  const s = scanner();
  assert.equal(await s.isWorker(self.path), true); // cold: its own marker is enough
  await s.refresh([owner.path, w.path, self.path]);
  assert.equal(await s.isWorker(w.path), true);
  assert.equal(await s.isWorker(owner.path), false);
});

test("read-only: scanning leaves every file's bytes and mtime untouched", async () => {
  const w = session([marker()]);
  const owner = session([registry({ backendSessionFile: w.path }), complete(header3(w.id))]);
  const snap = (p: string) => ({ bytes: readFileSync(p, "utf8"), mtimeMs: statSync(p).mtimeMs, size: statSync(p).size });
  const before = [snap(w.path), snap(owner.path)];
  await scanner().refresh([owner.path, w.path]);
  assert.deepEqual([snap(w.path), snap(owner.path)], before);
});
