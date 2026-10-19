// Run: pnpm test -- server/commands-overseer.test.ts
// The Overseer sweep (§app.overseer-commands/overseer-sweep) against the real app, in-process: each
// entry's request gets exactly the answer the web app's own request to that route gets, on the same
// fixture, refusals word for word; each entry's mesh need is the classifier's for its route; and an
// entry that changes something changes it as the route does, read back through the route.
// A throwaway state root (scratchRoot); ~/.pi is never read or written. Nothing here starts a chat.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { buildRequest, findCommand } from "../shared/commands-catalog";
import { OVERSEER_ENTRIES, PROJECT_OVERSEER_ENTRIES } from "../shared/commands/overseer";
import { PROJECT_ENTRIES } from "../shared/commands/projects";
import { scratchRoot } from "./test-scratch";

const root = scratchRoot("sova-commands-overseer-");
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const { classifyRequest } = await import("./mesh/access");
after(() => rmSync(root, { recursive: true, force: true }));

type Answer = [number, unknown];
async function send(method: string, url: string, body?: unknown): Promise<Answer> {
  const res = await app.request(url, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  return [res.status, await res.json()];
}
const viaId = (id: string, values: Record<string, unknown>): Promise<Answer> => {
  const entry = findCommand(id);
  assert.ok(entry, `no entry ${id}`);
  const r = buildRequest(entry, values);
  return send(r.method, r.url, r.body);
};
const q = encodeURIComponent;

/** Every id this sweep adds, with the route the web app's own control calls (method, path as registered). */
const SWEEP: Record<string, [string, string]> = {
  "overseer.todo.reorder": ["PUT", "/api/overseer/todos/order"],
  "overseer.todo.clear-done": ["DELETE", "/api/overseer/todos/done"],
  "overseer.idea.list": ["GET", "/api/overseer/ideas"],
  "overseer.idea.get": ["GET", "/api/overseer/idea"],
  "overseer.idea.update": ["PATCH", "/api/overseer/idea"],
  "overseer.notes.get": ["GET", "/api/overseer/notes"],
  "overseer.notes.set": ["PUT", "/api/overseer/notes"],
  "project.overseer.idea.list": ["GET", "/api/projects/:pid/overseer/ideas"],
  "project.overseer.idea.get": ["GET", "/api/projects/:pid/overseer/idea"],
  "project.overseer.idea.add": ["POST", "/api/projects/:pid/overseer/ideas"],
  "project.overseer.idea.update": ["PATCH", "/api/projects/:pid/overseer/idea"],
  "project.overseer.todo.list": ["GET", "/api/projects/:pid/overseer/todos"],
  "project.overseer.todo.add": ["POST", "/api/projects/:pid/overseer/todos"],
  "project.overseer.todo.update": ["PATCH", "/api/projects/:pid/overseer/todo"],
  "project.overseer.todo.remove": ["DELETE", "/api/projects/:pid/overseer/todo"],
  "project.overseer.todo.reorder": ["PUT", "/api/projects/:pid/overseer/todos/order"],
  "project.overseer.todo.clear-done": ["DELETE", "/api/projects/:pid/overseer/todos/done"],
};

let pn = 0;
/** A registered project on a plain folder: its id. */
async function project(): Promise<string> {
  const dir = join(root, `proj-${++pn}`);
  mkdirSync(dir, { recursive: true });
  const [s, body] = await send("POST", "/api/projects", { root: dir, name: `Sweep ${pn}` });
  assert.equal(s, 201, JSON.stringify(body));
  return (body as { project: { id: string } }).project.id;
}
type Todo = { id: string; text: string; done?: boolean };
const todosOf = (b: unknown) => (b as { todos: Todo[] }).todos;

describe("routes and mesh needs", () => {
  test("each sweep entry names its route, and its mesh need is the classifier's for that route", () => {
    for (const [id, [method, path]] of Object.entries(SWEEP)) {
      const e = findCommand(id);
      assert.ok(e, `missing ${id}`);
      assert.deepEqual([e.route.method, e.route.path], [method, path], id);
      assert.equal(e.sessionKey, null, id);
      assert.equal(e.sessionFile, "never", id);
      assert.equal(e.meshNeed, classifyRequest(method, path.replace(":pid", "p-1")).need, id);
      assert.equal(e.effect, method === "GET" ? "looks" : "changes", id);
    }
  });

  test("the project overseer's entries are listed among the project entries, once", () => {
    for (const e of PROJECT_OVERSEER_ENTRIES) assert.equal(PROJECT_ENTRIES.filter((p) => p === e).length, 1, e.id);
  });

  test("trust acts stay out: no entry reaches autonomy, the Overseer's settings or a project overseer's message", () => {
    for (const e of [...OVERSEER_ENTRIES, ...PROJECT_OVERSEER_ENTRIES]) assert.doesNotMatch(e.route.path, /autonomy|\/settings\/|\/message$|\/clear$|\/run$/, e.id);
  });
});

describe("the global Overseer: the route's own answers, and the effect read back", () => {
  test("notes: set, read back, and a stale base is the route's 409", async () => {
    const [, before] = await send("GET", "/api/overseer/notes");
    assert.deepEqual(await viaId("overseer.notes.get", {}), [200, before]);
    assert.deepEqual(await viaId("overseer.notes.set", { text: "Set by a script" }), [200, { text: "Set by a script" }]);
    assert.deepEqual(await send("GET", "/api/overseer/notes"), [200, { text: "Set by a script" }]);
    assert.deepEqual(await viaId("overseer.notes.set", { text: "x", base: "stale" }), await send("PUT", "/api/overseer/notes", { text: "x", base: "stale" }));
    assert.equal((await viaId("overseer.notes.set", { text: "x", base: "stale" }))[0], 409);
    assert.deepEqual((await send("GET", "/api/overseer/notes"))[1], { text: "Set by a script" });
  });

  test("to-dos: reorder and clear-done, read back", async () => {
    for (const text of ["First", "Second", "Third"]) await send("POST", "/api/overseer/todos", { text });
    const ids = todosOf((await send("GET", "/api/overseer/todos"))[1]).map((t) => t.id);
    const reversed = [...ids].reverse();
    const [s, out] = await viaId("overseer.todo.reorder", { ids: reversed });
    assert.equal(s, 200, JSON.stringify(out));
    assert.deepEqual(todosOf((await send("GET", "/api/overseer/todos"))[1]).map((t) => t.id), reversed);
    assert.deepEqual(await viaId("overseer.todo.reorder", { ids: ["nope"] }), await send("PUT", "/api/overseer/todos/order", { ids: ["nope"] }));
    await send("PATCH", `/api/overseer/todo?id=${q(ids[0]!)}`, { done: true });
    assert.equal((await viaId("overseer.todo.clear-done", {}))[0], 200);
    const left = todosOf((await send("GET", "/api/overseer/todos"))[1]);
    assert.deepEqual(left.map((t) => t.id).sort(), ids.slice(1).sort());
  });

  test("ideas: list, get and update as the routes do; a bad id is the route's 400, a missing one its 404", async () => {
    const id = "§sweep/an-idea";
    // The global backlog has no POST route: the Overseer's sova_idea files ideas. The store is what it writes.
    const { addIdea } = await import("./overseer-ideas");
    addIdea({ id, title: "An idea", text: "Filed." });
    assert.deepEqual(await viaId("overseer.idea.list", {}), await send("GET", "/api/overseer/ideas"));
    assert.deepEqual(await viaId("overseer.idea.get", { id }), await send("GET", `/api/overseer/idea?id=${q(id)}`));
    assert.equal((await viaId("overseer.idea.get", { id }))[0], 200);
    assert.deepEqual(await viaId("overseer.idea.get", { id: "bad" }), await send("GET", "/api/overseer/idea?id=bad"));
    assert.deepEqual(await viaId("overseer.idea.get", { id: "§sweep/none" }), [404, { error: "No idea §sweep/none" }]);
    const [s, out] = await viaId("overseer.idea.update", { id, title: "Retitled by a script", tags: ["scripted"] });
    assert.equal(s, 200, JSON.stringify(out));
    const read = JSON.stringify((await send("GET", `/api/overseer/idea?id=${q(id)}`))[1]);
    assert.ok(read.includes("Retitled by a script") && read.includes("scripted"), read.slice(0, 300));
    assert.deepEqual(await viaId("overseer.idea.update", { id, tags: "x" }), await send("PATCH", `/api/overseer/idea?id=${q(id)}`, { tags: "x" }));
    const [rs] = await viaId("overseer.idea.update", { id, "new-id": "§sweep/renamed" });
    assert.equal(rs, 200);
    assert.equal((await send("GET", `/api/overseer/idea?id=${q("§sweep/renamed")}`))[0], 200);
  });
});

describe("a project overseer: the route's own answers, and the effect read back", () => {
  test("an unknown project is the route's own 404 for every entry", async () => {
    for (const e of PROJECT_OVERSEER_ENTRIES) {
      const values = { pid: "no-such-project", id: "§x/y", title: "t", text: "t", ids: ["a"] };
      const r = buildRequest(e, values);
      const mine = await send(r.method, r.url, r.body);
      assert.equal(mine[0], 404, `${e.id}: ${JSON.stringify(mine)}`);
      const [method, path] = SWEEP[e.id]!;
      const url = path.replace(":pid", "no-such-project") + (r.url.includes("?") ? r.url.slice(r.url.indexOf("?")) : "");
      assert.deepEqual(mine, await send(method, url, r.body), e.id);
    }
  });

  test("ideas: add, list, get and update, read back", async () => {
    const pid = await project();
    const base = `/api/projects/${pid}/overseer`;
    const id = "§gap/scripted";
    const [s, added] = await viaId("project.overseer.idea.add", { pid, id, title: "Scripted", text: "From a script", tags: ["a"] });
    assert.equal(s, 201, JSON.stringify(added));
    assert.ok(JSON.stringify((await send("GET", `${base}/ideas`))[1]).includes("Scripted"));
    assert.deepEqual(await viaId("project.overseer.idea.list", { pid }), await send("GET", `${base}/ideas`));
    assert.deepEqual(await viaId("project.overseer.idea.get", { pid, id }), await send("GET", `${base}/idea?id=${q(id)}`));
    assert.deepEqual(await viaId("project.overseer.idea.add", { pid, id, title: "Again" }), await send("POST", `${base}/ideas`, { id, title: "Again" }));
    assert.equal((await viaId("project.overseer.idea.add", { pid, id, title: "Again" }))[0], 400);
    assert.equal((await viaId("project.overseer.idea.update", { pid, id, title: "Renamed title" }))[0], 200);
    assert.ok(JSON.stringify((await send("GET", `${base}/idea?id=${q(id)}`))[1]).includes("Renamed title"));
    assert.deepEqual(await viaId("project.overseer.idea.update", { pid, id, links: 3 }), await send("PATCH", `${base}/idea?id=${q(id)}`, { links: 3 }));
  });

  test("to-dos: add, update, reorder, clear-done and remove, read back", async () => {
    const pid = await project();
    const base = `/api/projects/${pid}/overseer`;
    const list = async () => todosOf((await send("GET", `${base}/todos`))[1]);
    for (const text of ["One", "Two", "Three"]) assert.equal((await viaId("project.overseer.todo.add", { pid, text }))[0], 201);
    assert.deepEqual((await list()).map((t) => t.text), ["One", "Two", "Three"]);
    assert.deepEqual(await viaId("project.overseer.todo.list", { pid }), await send("GET", `${base}/todos`));
    const ids = (await list()).map((t) => t.id);
    assert.equal((await viaId("project.overseer.todo.update", { pid, id: ids[0], text: "One, edited", done: true }))[0], 200);
    const first = (await list()).find((t) => t.id === ids[0])!;
    assert.deepEqual([first.text, first.done], ["One, edited", true]);
    assert.equal((await viaId("project.overseer.todo.reorder", { pid, ids: [...ids].reverse() }))[0], 200);
    assert.deepEqual((await list()).map((t) => t.id), [...ids].reverse());
    assert.equal((await viaId("project.overseer.todo.clear-done", { pid }))[0], 200);
    assert.deepEqual((await list()).map((t) => t.id).sort(), ids.slice(1).sort());
    assert.equal((await viaId("project.overseer.todo.remove", { pid, id: ids[1] }))[0], 200);
    assert.deepEqual((await list()).map((t) => t.id), [ids[2]]);
    assert.deepEqual(await viaId("project.overseer.todo.remove", { pid, id: "nope" }), await send("DELETE", `${base}/todo?id=nope`));
    assert.deepEqual(await viaId("project.overseer.todo.update", { pid, id: ids[2], done: "yes" }), await send("PATCH", `${base}/todo?id=${q(ids[2]!)}`, { done: "yes" }));
    // The global list never saw any of it.
    assert.ok(!JSON.stringify((await send("GET", "/api/overseer/todos"))[1]).includes("One, edited"));
  });
});
