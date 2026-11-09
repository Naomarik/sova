// Route pins for POST /api/sessions/fork: isolated agent dir, ephemeral listener, no prompts or
// model calls. The source files are hand-written JSONL, aged past the foreign-write window so an
// idle session reads as idle; the live-record cases drop a presence file with an alive foreign
// pid (1) into the temp live dir and remove it after.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { piSession } from "./harness/pi/testing/handle";

const dir = mkdtempSync(join(tmpdir(), "sova-fork-routes-"));
process.env.PI_CODING_AGENT_DIR = dir;
// The mode extension owns the helper pick and the pinned modes; two providers, so a default can name a model a fresh chat isn't on.
writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [resolve(dirname(fileURLToPath(import.meta.url)), "../pi-config/extensions/mode")] }));
writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test" }, openai: { type: "api_key", key: "test" } }));
await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
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

test("create route: a session made with a subagent profile opens at once, its pick not read as a foreign write", async () => {
  const { recentForeignWriteAgeSec } = await import("./write-guard");
  const res = await request("POST", "/api/sessions", { cwd: dir, subagent_profile: "off" });
  assert.equal(res.status, 201);
  const { path } = (await res.json()) as { path: string };
  assert.match(readFileSync(path, "utf8"), /"profile":"off"/, "the pick is on file");
  assert.equal(recentForeignWriteAgeSec(path), null);
});

test("create route: an Overseer's start naming only helpers follows the default, with the named helpers and only the grants it may have", async () => {
  const sp = await import("../pi-config/extensions/subagents/subagent-profiles.ts");
  const { OVERSEER_SENDER_HEADER, senderSecret } = await import("./overseer-sender");
  const { PROFILE_ENTRY } = await import("../shared/profiles");
  const { acquireChatHandle } = await import("./chat-handle");
  (await import("./overseer-store")).writeOverseerState({ version: 1, current: "overseer-chat", history: [] }); // the sender mark counts only while an Overseer exists
  sp.writeSubagentProfiles(dir, { version: 1, profiles: [sp.legacyProfile(dir, "theirs", "Default's helpers"), sp.legacyProfile(dir, "named", "Named helpers")] });
  const state = join(dir, "sova");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "default-profile.json"), JSON.stringify({ version: 1, profile: "reader" }));
  const reader = { id: "reader", label: "Reader", model: "openai/gpt-5.5", thinking: "high", mode: "delegate", minorModes: ["spec"], grant: ["sessions.read"], subagents: "theirs" };
  const overseer = { [OVERSEER_SENDER_HEADER]: senderSecret() };
  const start = async (headers: Record<string, string>) => {
    const res = await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ cwd: dir, subagent_profile: "named" }) });
    assert.equal(res.status, 201);
    const { path } = (await res.json()) as { path: string };
    const grants = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.customType === PROFILE_ENTRY).map((e) => e.data.profile.grant);
    const { mirror } = await acquireChatHandle(path);
    return { path, grants, on: [mirror.model?.ref, mirror.thinking, mirror.mode.mode, mirror.mode.minorModes, mirror.subagentPick] };
  };
  const defaultsAndNamed = ["openai/gpt-5.5", "high", "delegate", ["spec"], "named"];
  for (const [marks, grants] of [[{}, []], [{ overseerMayStart: true }, [["sessions.read"]]]] as const) {
    writeFileSync(join(state, "session-profiles.json"), JSON.stringify({ version: 1, profiles: [{ ...reader, ...marks }] }));
    const made = await start(overseer);
    assert.deepEqual(made.on, defaultsAndNamed, `marks ${JSON.stringify(marks)}`);
    assert.deepEqual(made.grants, grants, "powers only when the profile is marked for an Overseer");
  }
  // A person's call naming helpers stays off the default, as it was.
  const person = await start({});
  assert.equal(person.grants.length, 0);
  assert.notDeepEqual(person.on.slice(0, 4), defaultsAndNamed.slice(0, 4));
  assert.equal(person.on[4], "named");
});
