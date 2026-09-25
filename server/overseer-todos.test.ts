// Run: npx tsx --test server/overseer-todos.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-overseer-todos-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const todos = await import("./overseer-todos");
const { addIdea } = await import("./overseer-ideas");
const { TODO_TEXT_MAX, TODOS_MAX } = await import("../shared/protocol");

after(() => rmSync(agentDir, { recursive: true, force: true }));

let n = 0;
/** A fresh todos file per test. */
const fresh = () => join(agentDir, `todos-${n++}.json`);
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, text: `task ${id}`, done: false, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...extra });

describe("reading todos.json", () => {
  test("the default file is <stateRoot>/todos.json", () => {
    assert.equal(todos.todosFile(), join(agentDir, "sova", "todos.json"));
  });

  test("missing or corrupt is an empty list, never a throw", () => {
    const f = fresh();
    assert.deepEqual(todos.readTodos(f), { formatVersion: 1, todos: [] });
    writeFileSync(f, "{ not json");
    assert.deepEqual(todos.readTodos(f), { formatVersion: 1, todos: [] });
    writeFileSync(f, JSON.stringify({ formatVersion: 1, todos: "nope" }));
    assert.deepEqual(todos.readTodos(f).todos, []);
  });

  test("bad rows and duplicate ids are dropped, an unparseable idea link is dropped from its row, order is kept", () => {
    const f = fresh();
    writeFileSync(
      f,
      JSON.stringify({
        formatVersion: 1,
        todos: [
          row("td_bbbbbbbb"),
          row("TD_BAD"),
          { id: "td_cccccccc", text: "   " },
          "a string",
          row("td_aaaaaaaa", { ideaId: "Not An Id", sessionId: "  s-1 ", done: true, doneAt: "2026-09-02T00:00:00.000Z" }),
          row("td_bbbbbbbb", { text: "the duplicate" }),
          row("td_dddddddd", { ideaId: "mesh/retry", text: "  two\n lines  ", done: "yes", doneAt: "2026-09-02T00:00:00.000Z" }),
        ],
      }),
    );
    const got = todos.readTodos(f).todos;
    assert.deepEqual(got.map((t) => t.id), ["td_bbbbbbbb", "td_aaaaaaaa", "td_dddddddd"]);
    assert.equal(got[0]!.text, "task td_bbbbbbbb");
    assert.equal(got[1]!.ideaId, undefined);
    assert.equal(got[1]!.sessionId, "s-1");
    assert.equal(got[1]!.doneAt, "2026-09-02T00:00:00.000Z");
    assert.equal(got[2]!.ideaId, "§mesh/retry", "a parseable link is kept, canonical");
    assert.equal(got[2]!.text, "two lines");
    assert.equal(got[2]!.done, false, "only true is done");
    assert.equal(got[2]!.doneAt, undefined, "an open todo has no doneAt");
  });
});

describe("writing todos", () => {
  test("add appends at the end with a td_ id, one line, and writes atomically (no temp file left)", () => {
    const f = fresh();
    const a = todos.addTodo({ text: "Revoke GitLab token" }, f);
    const b = todos.addTodo({ text: "  reply\tto   Dana " }, f);
    assert.match(a.id, /^td_[a-z0-9]{8}$/);
    assert.notEqual(a.id, b.id);
    assert.equal(b.text, "reply to Dana");
    assert.equal(a.done, false);
    assert.equal(a.createdAt, a.updatedAt);
    const stored = JSON.parse(readFileSync(f, "utf8"));
    assert.equal(stored.formatVersion, 1);
    assert.deepEqual(stored.todos.map((t: { id: string }) => t.id), [a.id, b.id]);
    assert.deepEqual(readdirSync(dirname(f)).filter((x) => x.includes(".tmp")), []);
  });

  test("check sets doneAt, uncheck clears it; updatedAt strictly increases on every write", () => {
    const f = fresh();
    const a = todos.addTodo({ text: "one" }, f);
    const checked = todos.updateTodo(a.id, { done: true }, f, new Date("2026-09-26T10:00:00.000Z"));
    assert.equal(checked.done, true);
    assert.equal(checked.doneAt, "2026-09-26T10:00:00.000Z");
    assert.ok(checked.updatedAt > a.updatedAt);
    const again = todos.updateTodo(a.id, { done: true }, f, new Date("2026-09-26T11:00:00.000Z"));
    assert.equal(again.doneAt, "2026-09-26T10:00:00.000Z", "re-checking keeps when it was done");
    const open = todos.updateTodo(a.id, { done: false }, f);
    assert.equal(open.done, false);
    assert.equal(open.doneAt, undefined);
    let prev = open.updatedAt;
    for (let i = 0; i < 5; i++) {
      const t = todos.updateTodo(a.id, { text: `edit ${i}` }, f);
      assert.ok(t.updatedAt > prev, "strictly increasing even within one ms");
      prev = t.updatedAt;
    }
  });

  test("a stale base is a conflict carrying the current list; no base is last-write-wins", () => {
    const f = fresh();
    const a = todos.addTodo({ text: "one" }, f);
    todos.updateTodo(a.id, { text: "the Overseer's edit" }, f);
    assert.throws(
      () => todos.updateTodo(a.id, { text: "mine", base: a.updatedAt }, f),
      (err: unknown) => err instanceof todos.TodoConflictError && err.current.todos[0]!.text === "the Overseer's edit" && err.current.open === 1,
    );
    assert.equal(todos.readTodos(f).todos[0]!.text, "the Overseer's edit", "nothing was written");
    assert.equal(todos.updateTodo(a.id, { done: true }, f).done, true);
  });

  test("remove deletes one, clear_done deletes every done one, unknown ids are TodoNotFoundError", () => {
    const f = fresh();
    const [a, b, c] = ["a", "b", "c"].map((text) => todos.addTodo({ text }, f));
    todos.updateTodo(a!.id, { done: true }, f);
    todos.updateTodo(c!.id, { done: true }, f);
    assert.equal(todos.removeTodo(b!.id, f).text, "b");
    assert.throws(() => todos.removeTodo(b!.id, f), todos.TodoNotFoundError);
    assert.throws(() => todos.updateTodo("td_zzzzzzzz", { done: true }, f), todos.TodoNotFoundError);
    assert.equal(todos.clearDone(f), 2);
    assert.deepEqual(todos.readTodos(f).todos, []);
    assert.equal(todos.clearDone(f), 0);
  });

  test("reorder takes a permutation of the current ids, nothing else", () => {
    const f = fresh();
    const ids = ["a", "b", "c"].map((text) => todos.addTodo({ text }, f).id);
    todos.reorderTodos([ids[2], ids[0], ids[1]], f);
    assert.deepEqual(todos.readTodos(f).todos.map((t) => t.text), ["c", "a", "b"]);
    for (const bad of [[ids[0], ids[1]], [...ids, ids[0]], [ids[0], ids[0], ids[1]], [ids[0], ids[1], "td_zzzzzzzz"], "nope", null]) {
      assert.throws(() => todos.reorderTodos(bad, f), todos.TodoError, JSON.stringify(bad));
    }
    assert.deepEqual(todos.readTodos(f).todos.map((t) => t.text), ["c", "a", "b"], "a refused order changes nothing");
  });

  test("limits: text at most TODO_TEXT_MAX, not blank; at most TODOS_MAX todos", () => {
    const f = fresh();
    assert.equal(todos.addTodo({ text: "x".repeat(TODO_TEXT_MAX) }, f).text.length, TODO_TEXT_MAX);
    assert.throws(() => todos.addTodo({ text: "x".repeat(TODO_TEXT_MAX + 1) }, f), /at most 200 characters/);
    assert.throws(() => todos.addTodo({ text: "  \n " }, f), /text is required/);
    assert.throws(() => todos.addTodo({ text: 7 }, f), /text is required/);
    const g = fresh();
    writeFileSync(g, JSON.stringify({ formatVersion: 1, todos: Array.from({ length: TODOS_MAX }, (_, i) => row(`td_${String(i).padStart(8, "0")}`)) }));
    assert.equal(todos.readTodos(g).todos.length, TODOS_MAX);
    assert.throws(() => todos.addTodo({ text: "one too many" }, g), /at most 200 todos/);
  });

  test("an idea link must name an idea that exists; null or empty unlinks", () => {
    const f = fresh();
    addIdea({ id: "sova/multi-login", title: "Multi login" });
    assert.throws(() => todos.addTodo({ text: "x", ideaId: "sova/nope" }, f), /No idea §sova\/nope/);
    assert.throws(() => todos.addTodo({ text: "x", ideaId: "Bad Id" }, f), todos.TodoError);
    const t = todos.addTodo({ text: "x", ideaId: "sova/multi-login", sessionId: "sova://s/abc" }, f);
    assert.equal(t.ideaId, "§sova/multi-login");
    assert.equal(t.sessionId, "abc");
    const u = todos.updateTodo(t.id, { ideaId: null, sessionId: "" }, f);
    assert.equal(u.ideaId, undefined);
    assert.equal(u.sessionId, undefined);
  });
});

describe("the prompt's line", () => {
  test("counts only, byte-identical for an unchanged file, and a todo's text never appears", () => {
    const f = fresh();
    assert.equal(todos.promptTodos(todos.readTodos(f)), "(no todos)");
    const a = todos.addTodo({ text: "TEXT-NOT-IN-PROMPT" }, f);
    todos.addTodo({ text: "second" }, f);
    todos.updateTodo(a.id, { done: true }, f);
    const one = todos.promptTodos(todos.readTodos(f));
    const two = todos.promptTodos(todos.readTodos(f));
    assert.equal(one, "1 open, 1 done (sova_todos lists them)");
    assert.equal(one, two);
    assert.doesNotMatch(one, /TEXT-NOT-IN-PROMPT|second/);
    assert.equal(todos.openCount(f), 1);
    assert.deepEqual({ ...todos.todosInfo(f), todos: [] }, { todos: [], open: 1, done: 1, file: f });
  });
});
