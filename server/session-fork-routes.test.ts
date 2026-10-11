// Route pins for POST /api/sessions/fork: isolated agent dir, ephemeral listener, no prompts or
// model calls. The source files are hand-written JSONL, aged past the foreign-write window so an
// idle session reads as idle; the live-record cases drop a presence file with an alive foreign
// pid (1) into the temp live dir and remove it after.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { piSession } from "./harness/pi/testing/handle";

const dir = mkdtempSync(join(tmpdir(), "sova-fork-routes-"));
process.env.PI_CODING_AGENT_DIR = dir;
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { canonicalPath } = await import("./paths");
const { FORK_CACHE_ENTRY } = await import("../pi-config/extensions/subagents/fork/cache.ts");
const { acquireChat, disposeAllChats } = await import("./chat-manager");

const sessionsDir = join(dir, "sessions", "--tmp-fork-routes--");
mkdirSync(sessionsDir, { recursive: true });
const liveDir = join(dir, "sessions", "live");
mkdirSync(liveDir, { recursive: true });

after(async () => {
  await disposeAllChats();
  rmSync(dir, { recursive: true, force: true });
});

const request = (method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const post = (body: unknown) => request("POST", "/api/sessions/fork", body);

const ts = (n: number) => new Date(Date.UTC(2026, 8, 20, 0, 0, n)).toISOString();
const line = (e: Record<string, unknown>) => JSON.stringify(e);
let n = 0;
function source(lines: string[], ageSec = 300): string {
  const path = join(sessionsDir, `src-${n++}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  const t = Date.now() / 1000 - ageSec;
  utimesSync(path, t, t); // idle: last touched before the foreign-write window
  return canonicalPath(path);
}
function conversation(id: string, extra: string[] = []): string[] {
  return [
    line({ type: "session", version: 3, id, timestamp: ts(0), cwd: dir }),
    line({ type: "message", id: "u1", parentId: null, timestamp: ts(1), message: { role: "user", content: [{ type: "text", text: "first question" }], timestamp: 0 } }),
    line({ type: "message", id: "a1", parentId: "u1", timestamp: ts(2), message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "zai", model: "glm-5.3", api: "openai-completions", stopReason: "stop", timestamp: 0 } }),
    ...extra,
  ];
}
const later = [
  line({ type: "message", id: "u2", parentId: "a1", timestamp: ts(3), message: { role: "user", content: [{ type: "text", text: "second" }], timestamp: 0 } }),
  line({ type: "message", id: "a2", parentId: "u2", timestamp: ts(4), message: { role: "assistant", content: [{ type: "text", text: "second answer" }], stopReason: "stop", timestamp: 0 } }),
];
function liveRecord(path: string, name: string, presence: unknown = {}): void {
  writeFileSync(
    join(liveDir, `${name}.json`),
    JSON.stringify({ v: 2, session: { pid: 1, sessionFile: path, startedAt: Date.now() - 1000 }, presence }),
  );
}

test("fork route: body and path validation", async () => {
  const path = source(conversation("src-validation"));
  for (const body of [null, [], "text", 1]) assert.equal((await post(body)).status, 400);
  assert.equal((await post({ entryId: "a1" })).status, 400, "no path");
  assert.equal((await post({ path })).status, 400, "no entryId");
  assert.equal((await post({ path: 7, entryId: "a1" })).status, 400);
  assert.equal((await post({ path: join(dir, "not-a-session.txt"), entryId: "a1" })).status, 400);
  assert.equal((await post({ path: "/etc/passwd.jsonl", entryId: "a1" })).status, 400, "outside the sessions dir");
  assert.equal((await app.request("/api/sessions/fork", { method: "POST", body: "not json" })).status, 400);
  assert.equal((await post({ path: join(sessionsDir, "missing.jsonl"), entryId: "a1" })).status, 404);
});

test("fork route: a happy fork is a web-owned session with a parent reference", async () => {
  const path = source(conversation("src-happy", later));
  const before = readFileSync(path, "utf8");
  const res = await post({ path, entryId: "a1" });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  const summary = JSON.parse(text) as Record<string, any>;
  assert.equal(summary.parent, path, "the summary's parent is the canonical source path");
  assert.equal(summary.cwd, dir);
  assert.equal(summary.origin, "web");
  assert.equal(summary.title, "first question");
  assert.notEqual(summary.id, "src-happy");
  assert.equal(dirname(summary.path), sessionsDir, "the fork is filed beside its source");
  assert.ok(typeof summary.seenAt === "number", "marked seen at birth");
  const [header, ...entries] = readFileSync(summary.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(header.parentSession, path);
  assert.equal(header.cwd, dir);
  assert.deepEqual(
    entries.filter(e => e.customType !== FORK_CACHE_ENTRY).map((e: any) => e.id),
    ["u1", "a1"],
    "through the selected reply, nothing later",
  );
  assert.equal(readFileSync(path, "utf8"), before, "the source bytes never change");
});

test("fork route: the fork's memory starts as a copy of its source's (§chat.memory/log)", async () => {
  const path = source(conversation("src-memory", later));
  const { memoryDir } = await import("./memory/store");
  mkdirSync(memoryDir("src-memory"), { recursive: true });
  writeFileSync(join(memoryDir("src-memory"), "tree.jsonl"), '{"marker":1}\n');
  const res = await post({ path, entryId: "a1" });
  assert.equal(res.status, 201);
  const fork = (await res.json()) as { id: string };
  assert.equal(readFileSync(join(memoryDir(fork.id), "tree.jsonl"), "utf8"), '{"marker":1}\n');
  const bare = await post({ path: source(conversation("src-no-memory", later)), entryId: "a1" });
  assert.equal(bare.status, 201);
  assert.equal(existsSync(memoryDir(((await bare.json()) as { id: string }).id)), false, "a source without memory gives none");
});

test("fork route: held runtime checks streaming, compaction and queued sends without modifying the source", async (t) => {
  const path = source(conversation("src-held"));
  const before = readFileSync(path, "utf8");
  const chat = await acquireChat(path, true);
  try {
    Object.defineProperty(piSession(chat), "isStreaming", { get: () => true, configurable: true });
    const streaming = await post({ path, entryId: "a1" });
    assert.equal(streaming.status, 409);
    assert.match((await streaming.json() as { error: string }).error, /Stop the current turn/);
    Reflect.deleteProperty(piSession(chat), "isStreaming");

    t.mock.method(chat, "isCompacting", () => true);
    const compacting = await post({ path, entryId: "a1" });
    assert.equal(compacting.status, 409);
    assert.match((await compacting.json() as { error: string }).error, /compaction/);
    t.mock.restoreAll();

    t.mock.method(chat, "hasPendingSends", () => true);
    const queued = await post({ path, entryId: "a1" });
    assert.equal(queued.status, 409);
    assert.match((await queued.json() as { error: string }).error, /still on its way out/);
    t.mock.restoreAll();

    const idle = await post({ path, entryId: "a1" });
    assert.equal(idle.status, 201, await idle.text());
    assert.equal(readFileSync(path, "utf8"), before, "opening and forking the held source never writes to it");
  } finally {
    Reflect.deleteProperty(piSession(chat), "isStreaming");
    t.mock.restoreAll();
    await disposeAllChats();
  }
});

test("fork route: a worker-marked source cannot produce an invisible worker fork", async () => {
  const path = source(conversation("src-worker", [
    line({ type: "custom", id: "worker", parentId: "a1", timestamp: ts(3), customType: "subagents-worker-session", data: { v: 1 } }),
  ]));
  const before = readFileSync(path, "utf8");
  const response = await post({ path, entryId: "a1" });
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /Subagent sessions/);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("fork route: a session changed within the foreign-write window refuses", async () => {
  const path = source(conversation("src-recent"), 2); // 2s old: an unidentified writer may own it
  const res = await post({ path, entryId: "a1" });
  assert.equal(res.status, 409);
  assert.match((await res.json() as { error: string }).error, /changed 2?s ago/);
});

test("fork route: a TUI-live source refuses", async () => {
  const path = source(conversation("src-live"));
  liveRecord(path, `p1-live-${n}`);
  try {
    const res = await post({ path, entryId: "a1" });
    assert.equal(res.status, 409);
    assert.match((await res.json() as { error: string }).error, /open in another pi process/);
  } finally {
    rmSync(join(liveDir, `p1-live-${n}.json`), { force: true });
  }
});

test("fork route: working subagents refuse even before the TUI check", async () => {
  const path = source(conversation("src-workers"));
  const name = `p1-workers-${n}`;
  liveRecord(path, name, { workerCounts: { working: 2, total: 2 }, activity: { state: "working", since: 1 } });
  try {
    const res = await post({ path, entryId: "a1" });
    assert.equal(res.status, 409);
    assert.match((await res.json() as { error: string }).error, /Subagents are working/);
  } finally {
    rmSync(join(liveDir, `${name}.json`), { force: true });
  }
});

test("fork route: boundary refusals answer 400 with the server's sentence", async () => {
  const path = source(conversation("src-boundary", [
    line({ type: "message", id: "u2b", parentId: "a1", timestamp: ts(3), message: { role: "user", content: [{ type: "text", text: "abandoned" }], timestamp: 0 } }),
    line({ type: "message", id: "a2b", parentId: "u2b", timestamp: ts(4), message: { role: "assistant", content: [{ type: "text", text: "abandoned answer" }], stopReason: "stop", timestamp: 0 } }),
    ...later,
  ]));
  const abandoned = await post({ path, entryId: "a2b" });
  assert.equal(abandoned.status, 400);
  assert.match((await abandoned.json() as { error: string }).error, /current branch/);
  const user = await post({ path, entryId: "u1" });
  assert.equal(user.status, 400);
  assert.match((await user.json() as { error: string }).error, /assistant reply/);
  const midTurn = source([
    line({ type: "session", version: 3, id: "src-midturn", timestamp: ts(0), cwd: dir }),
    line({ type: "message", id: "u1", parentId: null, timestamp: ts(1), message: { role: "user", content: [{ type: "text", text: "go read" }], timestamp: 0 } }),
    line({ type: "message", id: "a1t", parentId: "u1", timestamp: ts(2), message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], stopReason: "toolUse", timestamp: 0 } }),
  ]);
  const mid = await post({ path: midTurn, entryId: "a1t" });
  assert.equal(mid.status, 400);
  assert.match((await mid.json() as { error: string }).error, /tool result/);
});

test("fork route: a torn tail line refuses instead of forking a partial file", async () => {
  const path = join(sessionsDir, `src-torn-${n++}.jsonl`);
  writeFileSync(path, `${conversation("src-torn").join("\n")}\n{"type":"mess`);
  const t = Date.now() / 1000 - 300;
  utimesSync(path, t, t);
  const res = await post({ path: canonicalPath(path), entryId: "a1" });
  assert.equal(res.status, 400);
  assert.match((await res.json() as { error: string }).error, /not a readable session/);
});
