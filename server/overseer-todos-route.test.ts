// Run: npx tsx --test server/overseer-todos-route.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written. The server is imported
// with PORT=0 so it binds an ephemeral port instead of the dev port.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { OverseerTodosInfo, TodoConflict } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-todos-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";

const { app, server } = await import("./index");
const { disposeAllChats } = await import("./chat-manager");
const todos = await import("./overseer-todos");

after(async () => {
  server.close();
  await disposeAllChats();
  rmSync(agentDir, { recursive: true, force: true });
});

const json = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
const read = async (res: Response) => (await res.json()) as OverseerTodosInfo;
const texts = (info: OverseerTodosInfo) => info.todos.map((t) => t.text);

describe("the todos routes", () => {
  test("GET: the list, its counts and the file, never cached", async () => {
    const res = await app.request("/api/overseer/todos");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await read(res), { todos: [], open: 0, done: 0, file: join(agentDir, "sova", "todos.json") });
  });

  test("POST adds (201, the whole list); a bad body or text is a 400 that adds nothing", async () => {
    const res = await json("POST", "/api/overseer/todos", { text: "Revoke GitLab token" });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const info = await read(res);
    assert.deepEqual(texts(info), ["Revoke GitLab token"]);
    assert.equal(info.open, 1);
    for (const bad of [{}, { text: "  " }, { text: 3 }, { text: "x".repeat(201) }, { text: "ok", ideaId: "§no/such-idea" }, { text: "ok", sessionId: 5 }, "[1]", "not json"]) {
      const r = await json("POST", "/api/overseer/todos", bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(typeof ((await r.json()) as { error: unknown }).error, "string");
    }
    assert.equal(todos.readTodos().todos.length, 1);
  });

  test("PATCH ticks and edits; 404 unknown, 400 bad types, 409 on a stale base with the current list", async () => {
    const id = todos.readTodos().todos[0]!.id;
    const url = `/api/overseer/todo?id=${id}`;
    let info = await read(await json("PATCH", url, { done: true }));
    assert.equal(info.todos[0]!.done, true);
    assert.deepEqual([info.open, info.done], [0, 1]);
    const base = info.todos[0]!.updatedAt;
    info = await read(await json("PATCH", url, { done: false, text: "Revoke the GitLab token", base }));
    assert.equal(info.todos[0]!.text, "Revoke the GitLab token");
    const stale = await json("PATCH", url, { text: "mine", base });
    assert.equal(stale.status, 409);
    const conflict = (await stale.json()) as TodoConflict;
    assert.match(conflict.error, /changed since/);
    assert.equal(conflict.current.todos[0]!.text, "Revoke the GitLab token");
    assert.equal((await json("PATCH", "/api/overseer/todo?id=td_zzzzzzzz", { done: true })).status, 404);
    assert.equal((await json("PATCH", "/api/overseer/todo", { done: true })).status, 404);
    for (const bad of [{ done: "yes" }, { text: 1 }, { base: 1 }, { ideaId: 3 }, { text: "" }]) assert.equal((await json("PATCH", url, bad)).status, 400, JSON.stringify(bad));
    assert.equal(todos.readTodos().todos[0]!.text, "Revoke the GitLab token");
  });

  test("PUT order takes a permutation of the ids only", async () => {
    await json("POST", "/api/overseer/todos", { text: "two" });
    await json("POST", "/api/overseer/todos", { text: "three" });
    const ids = todos.readTodos().todos.map((t) => t.id);
    const res = await json("PUT", "/api/overseer/todos/order", { ids: [ids[2], ids[1], ids[0]] });
    assert.equal(res.status, 200);
    assert.deepEqual(texts(await read(res)), ["three", "two", "Revoke the GitLab token"]);
    for (const bad of [{ ids: [ids[0]] }, { ids: [ids[0], ids[0], ids[1]] }, { ids: "x" }, {}]) assert.equal((await json("PUT", "/api/overseer/todos/order", bad)).status, 400, JSON.stringify(bad));
    assert.deepEqual(texts(todos.todosInfo()), ["three", "two", "Revoke the GitLab token"]);
  });

  test("DELETE one (404 unknown) and DELETE done clear what is ticked", async () => {
    const [a, b] = todos.readTodos().todos;
    const one = await json("DELETE", `/api/overseer/todo?id=${a!.id}`);
    assert.equal(one.status, 200);
    assert.deepEqual(texts(await read(one)), ["two", "Revoke the GitLab token"]);
    assert.equal((await json("DELETE", `/api/overseer/todo?id=${a!.id}`)).status, 404);
    await json("PATCH", `/api/overseer/todo?id=${b!.id}`, { done: true });
    const cleared = await json("DELETE", "/api/overseer/todos/done");
    assert.equal(cleared.status, 200);
    const info = await read(cleared);
    assert.deepEqual(texts(info), ["Revoke the GitLab token"]);
    assert.deepEqual([info.open, info.done], [1, 0]);
  });
});
