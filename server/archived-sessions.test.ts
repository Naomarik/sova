// Run: npx tsx --test server/archived-sessions.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-archive-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-archive-test--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });
const archiveFile = join(agentDir, "pi-web", "archived-sessions.json");

const { isArchived, setArchived } = await import("./archived-sessions");
const { archiveSession } = await import("./sessions-index");
const { addWebSession } = await import("./web-sessions");
const { canonicalPath } = await import("./paths");

const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
after(() => {
  sleeper.kill();
  rmSync(agentDir, { recursive: true, force: true });
});

function session(id: string): string {
  const path = join(sessionsDir, `2026-09-19T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-19T00:00:00.000Z", cwd: "/tmp" })}\n`);
  return canonicalPath(path);
}
const onDisk = () => JSON.parse(readFileSync(archiveFile, "utf8")) as string[];

test("store: set and clear an id, atomically and merged with other writers", () => {
  assert.equal(isArchived("a"), false);
  setArchived("a", true);
  assert.equal(isArchived("a"), true);
  assert.deepEqual(onDisk(), ["a"]);
  // Another server instance adds an id; our next write keeps it and refreshes our copy.
  writeFileSync(archiveFile, JSON.stringify(["a", "other"]));
  setArchived("b", true);
  assert.deepEqual(onDisk().sort(), ["a", "b", "other"]);
  assert.equal(isArchived("other"), true);
  setArchived("a", false);
  setArchived("b", false);
  setArchived("other", false);
  assert.deepEqual(onDisk(), []);
});

test("store: a corrupt file counts as empty and is replaced on the next write", () => {
  writeFileSync(archiveFile, "{not json");
  setArchived("c", true);
  assert.deepEqual(onDisk(), ["c"]);
  setArchived("c", false);
});

test("archiveSession: archive and unarchive a web session without touching its file", async () => {
  const path = session("web-1");
  addWebSession("web-1");
  const before = readFileSync(path, "utf8");
  const on = await archiveSession(path, true);
  assert.ok(on.ok);
  assert.equal(on.summary.archived, true);
  assert.equal(on.summary.origin, "web");
  assert.equal(isArchived("web-1"), true);
  const off = await archiveSession(path, false);
  assert.ok(off.ok);
  assert.equal(off.summary.archived, false);
  assert.equal(isArchived("web-1"), false);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("archiveSession: refuses archiving a live session, still allows unarchiving it", async () => {
  const path = session("web-live");
  addWebSession("web-live");
  setArchived("web-live", true); // archived before a TUI opened it
  writeFileSync(
    join(liveDir, "p-test.json"),
    JSON.stringify({ session: { pid: sleeper.pid, sessionFile: path, mode: "tui" }, presence: { status: "idle" } }),
  );
  try {
    const off = await archiveSession(path, false);
    assert.ok(off.ok);
    assert.equal(off.summary.live?.pid, sleeper.pid);
    const on = await archiveSession(path, true);
    assert.equal(on.ok, false);
    assert.ok(!on.ok && on.status === 409 && /open in a TUI/.test(on.error));
    assert.equal(isArchived("web-live"), false);
  } finally {
    rmSync(join(liveDir, "p-test.json"));
  }
});

test("archiveSession: refuses archiving an external session", async () => {
  const r = await archiveSession(session("ext-1"), true);
  assert.ok(!r.ok && r.status === 409);
  assert.equal(isArchived("ext-1"), false);
});

test("archiveSession: unknown session is 404", async () => {
  const r = await archiveSession(join(sessionsDir, "missing.jsonl"), true);
  assert.deepEqual(r, { ok: false, status: 404, error: "Session file not found" });
});
