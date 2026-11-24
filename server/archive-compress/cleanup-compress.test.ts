// Clean Up's Compress (§app.session-list/archive-compress) and a compressed chat in the list and in
// Delete (§app.session-list/archive-compression): POST /api/sessions/cleanup in-process, in a throwaway
// agent dir and homes root.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "sova-cleanup-compress-"));
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.SOVA_CHAT_HOMES = join(scratch, "homes");
const sessionsDir = join(agentDir, "sessions", "--tmp-compress--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { testApp } = await import("../mesh/app-test-fixtures");
const app = await testApp();
const { addWebSession } = await import("../web-sessions");
const { canonicalPath } = await import("../paths");
const { listSessionsAfresh } = await import("../sessions-index");
const { ensureChatHome } = await import("../chat-homes/root");

after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function sessionFile(): string {
  const id = `019a0000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-10-17T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-17T00:00:00.000Z", cwd: "/tmp" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-17T00:00:01.000Z", message: { role: "user", content: `chat ${n}` } }),
  ].join("\n")}\n`);
  addWebSession(id);
  const then = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(path, then, then);
  return canonicalPath(path);
}
async function post(url: string, body: unknown): Promise<[number, Record<string, any>]> {
  const res = await app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return [res.status, (await res.json()) as Record<string, any>];
}
async function archive(path: string): Promise<void> {
  const [s] = await post("/api/sessions/archive", { path, archived: true });
  assert.equal(s, 200);
  const then = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(path, then, then);
}

describe("POST /api/sessions/cleanup with action compress", () => {
  test("a bad action is a 400 before anything runs", async () => {
    const path = sessionFile();
    await archive(path);
    assert.deepEqual(await post("/api/sessions/cleanup", { mode: "paths", paths: [path], action: "zip" }), [400, { error: "action must be delete or compress" }]);
    assert.ok(existsSync(path));
  });

  test("only archived chats of the range are compressed; the row stays, marked; Delete removes the compressed file", async () => {
    const kept = sessionFile(); // not archived: left out silently
    const path = sessionFile();
    await archive(path);
    const [s, r] = await post("/api/sessions/cleanup", { mode: "age", minAgeDays: 30, action: "compress" });
    assert.equal(s, 200, JSON.stringify(r));
    assert.ok(r.compressedIds.includes(path.split("_").pop()!.replace(".jsonl", "")));
    assert.equal(r.deletedCount, 0);
    assert.ok(existsSync(kept), "the unarchived chat is untouched");
    assert.ok(!existsSync(path) && existsSync(`${path}.gz`), "compressed where it was");
    const row = (await listSessionsAfresh()).find((x) => x.path === path);
    assert.equal(row?.compressed, true);
    assert.equal(row?.archived, true);
    assert.equal(row?.title, `chat ${n}`, "its title as it was");
    const [, again] = await post("/api/sessions/cleanup", { mode: "paths", paths: [path], action: "compress" });
    assert.equal(again.compressedCount, 0, "already compressed: left out");
    const [, del] = await post("/api/sessions/cleanup", { mode: "paths", paths: [path] });
    assert.equal(del.deletedCount, 1, JSON.stringify(del));
    assert.ok(!existsSync(`${path}.gz`));
    assert.equal((await listSessionsAfresh()).some((x) => x.path === path), false);
  });

  test("a homed chat whose helper wrote just now, or has an unended worker record, is left as it is", async () => {
    const id = "019a0000-0000-7000-8000-0000000000aa";
    const home = ensureChatHome(id);
    mkdirSync(join(home, "sessions"), { recursive: true });
    const path = canonicalPath(join(home, "sessions", `2026-10-17T00-00-00-000Z_${id}.jsonl`));
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-17T00:00:00.000Z", cwd: "/tmp" })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-17T00:00:01.000Z", message: { role: "user", content: "homed" } })}\n`);
    addWebSession(id);
    await archive(path);
    const helper = join(home, "sessions", "2026-10-17T00-00-01-000Z_019a0000-0000-7000-8000-0000000000ab.jsonl");
    writeFileSync(helper, "{}\n"); // written just now
    const [, r] = await post("/api/sessions/cleanup", { mode: "paths", paths: [path], action: "compress" });
    assert.deepEqual(r.compressedIds, [], JSON.stringify(r));
    assert.equal(r.skipped.busy, 1);
    assert.ok(existsSync(home), "the home is intact");
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(helper, old, old);
    mkdirSync(join(home, "workers"), { recursive: true });
    writeFileSync(join(home, "workers", "ag_01.json"), JSON.stringify({ state: "idle", path: helper }));
    const [, r2] = await post("/api/sessions/cleanup", { mode: "paths", paths: [path], action: "compress" });
    assert.deepEqual(r2.compressedIds, [], "an unended worker record keeps it too");
    writeFileSync(join(home, "workers", "ag_01.json"), JSON.stringify({ state: "ended", path: helper }));
    const [, r3] = await post("/api/sessions/cleanup", { mode: "paths", paths: [path], action: "compress" });
    assert.deepEqual(r3.compressedIds, [id], JSON.stringify(r3));
    assert.equal(existsSync(home), false);
  });
});
