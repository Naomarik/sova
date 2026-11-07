// Run: pnpm test -- server/cleanup-dry-run.test.ts
// A dryRun that isn't a boolean is refused before anything is deleted, never read as a real run:
// POST /api/sessions/cleanup and POST /api/worktrees/cleanup, in-process, in a throwaway agent dir.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-cleanup-dry-run-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-cleanup--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const { addWebSession } = await import("./web-sessions");
const { canonicalPath } = await import("./paths");

after(() => rmSync(agentDir, { recursive: true, force: true }));

let n = 0;
/** A session file last written an hour ago (past the just-written guard): its path. */
function sessionFile(): string {
  const id = `cleanup-${++n}`;
  const path = join(sessionsDir, `2026-10-17T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-17T00:00:00.000Z", cwd: "/tmp" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-17T00:00:01.000Z", message: { role: "user", content: "hi" } }),
  ].join("\n")}\n`);
  addWebSession(id);
  const then = new Date(Date.now() - 3_600_000);
  utimesSync(path, then, then);
  return canonicalPath(path);
}
async function post(url: string, body: unknown): Promise<[number, { error?: string } & Record<string, unknown>]> {
  const res = await app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return [res.status, (await res.json()) as { error?: string } & Record<string, unknown>];
}
async function archived(): Promise<string> {
  const path = sessionFile();
  const [s] = await post("/api/sessions/archive", { path, archived: true });
  assert.equal(s, 200);
  utimesSync(path, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  return path;
}

describe("POST /api/sessions/cleanup", () => {
  test('dryRun "true" is refused with a sentence, and the archived file stays', async () => {
    const path = await archived();
    assert.deepEqual(await post("/api/sessions/cleanup", { mode: "paths", paths: [path], dryRun: "true" }), [400, { error: "dryRun must be true or false" }]);
    assert.ok(existsSync(path), "the file is still on disk");
  });

  test("the same file, with a real dryRun, is listed and kept; with dryRun false it goes (the check above can see a deletion)", async () => {
    const path = await archived();
    const [s1, dry] = await post("/api/sessions/cleanup", { mode: "paths", paths: [path], dryRun: true });
    assert.equal(s1, 200, JSON.stringify(dry));
    assert.equal((dry.deletedIds as string[]).length, 1);
    assert.ok(existsSync(path));
    const [s2] = await post("/api/sessions/cleanup", { mode: "paths", paths: [path], dryRun: false });
    assert.equal(s2, 200);
    assert.equal(existsSync(path), false);
  });

  test("age mode with minAgeDays other than 7 or 30 is refused, before anything runs", async () => {
    for (const minAgeDays of [1, "7", null, 7.5]) assert.equal((await post("/api/sessions/cleanup", { mode: "age", minAgeDays, dryRun: true }))[0], 400, String(minAgeDays));
    assert.deepEqual(await post("/api/sessions/cleanup", { mode: "age", dryRun: true }), [400, { error: 'mode must be "husks", "paths", or "age" with minAgeDays 7 or 30' }]);
  });
});

describe("POST /api/worktrees/cleanup", () => {
  test('dryRun "true" is refused with a sentence before any removal, and the session file stays', async () => {
    const path = sessionFile();
    assert.deepEqual(await post("/api/worktrees/cleanup", { path, dryRun: "true", expect: ["/nowhere/worktree"] }), [400, { error: "dryRun must be true or false" }]);
    assert.deepEqual(await post("/api/worktrees/cleanup", { path, dryRun: "true" }), [400, { error: "dryRun must be true or false" }]);
    assert.ok(existsSync(path));
    // A real dryRun reaches the plan: this session's folder is no repository here.
    assert.equal((await post("/api/worktrees/cleanup", { path, dryRun: true }))[0], 409);
  });

  test("Remove Anyway: a malformed force is a 400, and a request that isn't the user's page is refused with where to click", async () => {
    const path = sessionFile();
    const bad = [400, { error: "force must be {path: absolute path, digest}, sent alone" }];
    assert.deepEqual(await post("/api/worktrees/cleanup", { path, force: { path: "rel", digest: "abcdef0123" } }), bad);
    assert.deepEqual(await post("/api/worktrees/cleanup", { path, force: { path: "/w", digest: "not hex!" } }), bad);
    assert.deepEqual(await post("/api/worktrees/cleanup", { path, force: { path: "/w", digest: "abcdef0123" }, expect: ["/w"] }), bad);
    // No socket and no page cookie: a script, refused before anything is read or deleted.
    const [status, body] = await post("/api/worktrees/cleanup", { path, force: { path: "/w", digest: "abcdef0123" } });
    assert.equal(status, 403);
    assert.equal(body.yourClick, true);
    assert.match(body.error!, /Ask them to press Remove Anyway in Clean Up Merged\. Nothing was deleted\./);
  });
});
