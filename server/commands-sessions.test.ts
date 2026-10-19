// Run: pnpm test -- server/commands-sessions.test.ts
// The sessions sweep (§app.session-commands/sessions-sweep) against the real app, in-process: each
// entry's request gets exactly the answer the web app's own request to that route gets, on the same
// fixture, refusals word for word, and an entry that changes something changes it as the route does.
// A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written. Nothing here starts a chat.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { buildRequest, COMMANDS, findCommand, type CommandEntry } from "../shared/commands-catalog";
import { SESSION_ENTRIES } from "../shared/commands/sessions";
import { PROJECT_ENTRIES, VERB_ENTRIES } from "../shared/commands/projects";
import { OVERSEER_ENTRIES } from "../shared/commands/overseer";
import { OTHER_ENTRIES } from "../shared/commands/other";

const agentDir = mkdtempSync(join(tmpdir(), "sova-commands-sessions-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-commands-sessions--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const { canonicalPath } = await import("./paths");
after(() => rmSync(agentDir, { recursive: true, force: true }));

let n = 0;
/** A session with a user message and an assistant reply, last written an hour ago: [path, id]. */
function session(): [string, string] {
  const id = `sweep-${++n}`;
  const path = join(sessionsDir, `2026-10-17T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[
    { type: "session", version: 3, id, timestamp: "2026-10-17T00:00:00.000Z", cwd: "/tmp" },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-10-17T00:00:01.000Z", message: { role: "user", content: "hi" } },
  ].map((l) => JSON.stringify(l)).join("\n")}\n`);
  appendFileSync(path, `${JSON.stringify({ type: "message", id: "a1", parentId: "m1", timestamp: "2026-10-17T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }], provider: "t", model: "t", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } })}\n`);
  const then = new Date(Date.now() - 3_600_000);
  utimesSync(path, then, then);
  return [canonicalPath(path), id];
}
const missing = () => canonicalPath(join(sessionsDir, "missing.jsonl"));
function live(): string {
  const [path, id] = session();
  writeFileSync(join(liveDir, `p-${id}.json`), JSON.stringify({ session: { pid: process.ppid, sessionFile: path, mode: "tui" }, presence: { status: "idle" } }));
  return path;
}

async function send(method: string, url: string, body?: unknown): Promise<[number, unknown]> {
  const res = await app.request(url, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  return [res.status, await res.json()];
}
const via = (entry: CommandEntry, values: Record<string, unknown>) => {
  const r = buildRequest(entry, values);
  return send(r.method, r.url, r.body);
};
const viaId = (id: string, values: Record<string, unknown>) => via(findCommand(id)!, values);
const q = (p: string) => encodeURIComponent(p);
const groups = async () => (await send("GET", "/api/session-groups"))[1] as { groups: { id: string; name: string; members?: unknown }[] } | { id: string; name: string }[];
const groupList = async () => { const g = await groups(); return Array.isArray(g) ? g : g.groups; };
const newGroup = async (name: string) => ((await send("POST", "/api/session-groups", { name }))[1] as { id: string }).id;

describe("the catalogue by area", () => {
  test("COMMANDS is the area files in order, and each area holds only its own ids", () => {
    assert.deepEqual(COMMANDS, [...SESSION_ENTRIES, ...VERB_ENTRIES, ...PROJECT_ENTRIES, ...OVERSEER_ENTRIES, ...OTHER_ENTRIES]);
    for (const c of SESSION_ENTRIES) assert.match(c.id, /^(session|worker)\./, c.id);
    for (const c of [...VERB_ENTRIES, ...PROJECT_ENTRIES]) assert.match(c.id, /^project\./, c.id);
    for (const c of OVERSEER_ENTRIES) assert.match(c.id, /^overseer\./, c.id);
    for (const c of OTHER_ENTRIES) assert.doesNotMatch(c.id, /^(session|worker|project|overseer)\./, c.id);
  });
});

describe("answers: the route's own, on the same fixture", () => {
  test("looks entries answer as their route does, and a missing session is the route's own 404", async () => {
    const reads: [string, string][] = [
      ["session.draft.get", "/api/sessions/draft"],
      ["session.tools.get", "/api/sessions/tools"],
      ["session.context", "/api/sessions/context"],
      ["session.insights", "/api/insights/session"],
    ];
    for (const [id, route] of reads) {
      const [path] = session();
      const [s, body] = await viaId(id, { session: path });
      assert.equal(s, 200, `${id}: ${JSON.stringify(body).slice(0, 200)}`);
      // A read's clock (`checkedAt`) is the moment it answered; everything else is the same answer.
      const timeless = ([st, b]: [number, unknown]) => [st, { ...(b as object), checkedAt: undefined }];
      assert.deepEqual(timeless([s, body]), timeless(await send("GET", `${route}?path=${q(path)}`)), id);
      assert.deepEqual(await viaId(id, { session: missing() }), [404, { error: "Session file not found" }], id);
    }
    assert.deepEqual(await viaId("session.group.list", {}), await send("GET", "/api/session-groups"));
  });

  test("session.draft.set: the draft the route keeps, read back", async () => {
    const [path] = session();
    assert.deepEqual(await viaId("session.draft.set", { session: path, text: "Typed by a script" }), [200, { ok: true }]);
    const [, draft] = await send("GET", `/api/sessions/draft?path=${q(path)}`);
    assert.equal((draft as { text: string }).text, "Typed by a script");
    assert.deepEqual(await viaId("session.draft.set", { session: path, text: "x", attachments: 7 }), [400, { error: "attachments must be an array" }]);
  });

  test("session.fork: a new session, the source untouched; a terminal-held one gets the route's 409", async () => {
    const [path] = session();
    const [s, made] = await viaId("session.fork", { session: path, entry: "a1" });
    assert.equal(s, 201, JSON.stringify(made));
    const fork = (made as { path: string }).path;
    assert.ok(fork !== path && existsSync(fork));
    const held = live();
    assert.deepEqual(await viaId("session.fork", { session: held, entry: "a1" }), await send("POST", "/api/sessions/fork", { path: held, entryId: "a1" }));
    assert.equal((await viaId("session.fork", { session: held, entry: "a1" }))[0], 409);
  });

  test("session groups: create, rename, assign, take out and delete, each as the route does", async () => {
    const [s1, made] = await viaId("session.group.create", { name: "Made by a script" });
    assert.equal(s1, 201);
    const gid = (made as { id: string }).id;
    assert.equal((await groupList()).find((g) => g.id === gid)?.name, "Made by a script");
    assert.equal((await viaId("session.group.rename", { group: gid, name: "Renamed" }))[0], 200);
    assert.equal((await groupList()).find((g) => g.id === gid)?.name, "Renamed");
    const [path, id] = session();
    assert.deepEqual(await viaId("session.group.assign", { session: path, group: gid }), [200, { ok: true }]);
    assert.ok(JSON.stringify(await groups()).includes(id));
    assert.deepEqual(await viaId("session.group.assign", { session: path, group: null }), [200, { ok: true }]);
    assert.ok(!JSON.stringify(await groups()).includes(id));
    assert.deepEqual(await viaId("session.group.delete", { group: gid }), [200, { ok: true }]);
    assert.equal((await groupList()).some((g) => g.id === gid), false);
    assert.deepEqual(await viaId("session.group.delete", { group: gid }), [404, { error: "Group not found" }]);
    const other = await newGroup("Twin");
    assert.deepEqual(await viaId("session.group.rename", { group: other, name: "" }), await send("PATCH", `/api/session-groups/${other}`, { name: "" }));
  });

  test("entries that would start a chat or a model: the route's own refusal, before anything starts", async () => {
    const held = live();
    assert.deepEqual(await viaId("session.sandbox.set", { session: held, state: "on" }), await send("POST", `/api/sandbox?path=${q(held)}`, { state: "on" }));
    assert.deepEqual(await viaId("session.sandbox.set", { session: missing(), state: "on" }), [404, { error: "Session file not found" }]);
    const resumed = await viaId("worker.resume", { session: held, worker: "ag_99" });
    assert.equal(resumed[0], 409, JSON.stringify(resumed));
    assert.deepEqual(resumed, await send("POST", `/api/workers/resume?path=${q(held)}&id=ag_99`));
    assert.deepEqual(await viaId("session.group.send", { group: "no-such-group", text: "hi" }), await send("POST", "/api/session-groups/no-such-group/prompt", { text: "hi" }));
  });
});
