// Run: npx tsx --test src/lib/todos.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import { moveId, splitTodos, todoName, todosCount, todosMeta } from "./todos";

const t = (id: string, done = false) => ({ id, done, text: id, createdAt: "", updatedAt: "" });

test("splitTodos: open then done, each in list order", () => {
  const { open, done } = splitTodos({ todos: [t("a"), t("b", true), t("c"), t("d", true)] });
  assert.deepEqual(open.map((x) => x.id), ["a", "c"]);
  assert.deepEqual(done.map((x) => x.id), ["b", "d"]);
  assert.deepEqual(splitTodos(undefined), { open: [], done: [] });
});

test("counts in words", () => {
  assert.equal(todosCount(1), "1 todo");
  assert.equal(todosCount(0), "0 todos");
  assert.equal(todosCount(3), "3 todos");
  assert.equal(todosMeta({ open: 3, done: 1 }), "3 open · 1 done");
  assert.equal(todosMeta({ open: 2, done: 0 }), "2 open");
  assert.equal(todosMeta({ open: 0, done: 2 }), "0 open · 2 done");
  assert.equal(todosMeta({ open: 0, done: 0 }), "No todos");
  assert.equal(todosMeta(undefined), "");
});

test("moveId swaps with the nearest row of the same state, and is null at an end", () => {
  const list = [t("a"), t("x", true), t("b"), t("c")];
  assert.deepEqual(moveId(list, "b", -1), ["b", "x", "a", "c"], "skips the done row between them");
  assert.deepEqual(moveId(list, "b", 1), ["a", "x", "c", "b"]);
  assert.equal(moveId(list, "a", -1), null);
  assert.equal(moveId(list, "c", 1), null);
  assert.equal(moveId(list, "x", 1), null, "the only done row has nowhere to go");
  assert.equal(moveId(list, "nope", 1), null);
});

test("moveId always returns a permutation of the ids (what PUT order requires)", () => {
  const list = [t("a", true), t("b"), t("c", true), t("d"), t("e"), t("f", true)];
  for (const row of list)
    for (const dir of [-1, 1] as const) {
      const ids = moveId(list, row.id, dir);
      if (ids) assert.deepEqual([...ids].sort(), list.map((x) => x.id).sort(), `${row.id} ${dir}`);
    }
});

test("todoName collapses whitespace and cuts a long text", () => {
  assert.equal(todoName("  revoke\n the  token "), "revoke the token");
  const long = todoName("x".repeat(100));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
});
