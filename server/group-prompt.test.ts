// Run: npx tsx --test server/group-prompt.test.ts
// The batch prompt's rules, with every probe injected: no agent dir, no SDK runtime, no fs.
//
// The one behaviour worth more than the rest: a refusal sends NOTHING. Each test asserts what
// went out, not just what came back.
import assert from "node:assert/strict";
import { test } from "node:test";

const { promptGroup } = await import("./group-prompt");
const { BusyError, ConfigError } = await import("./chat-manager");
import type { BatchDeps } from "./group-prompt";

const PATHS: Record<string, string> = { a: "/s/a.jsonl", b: "/s/b.jsonl", c: "/s/c.jsonl" };

/** Deps where everything is allowed and every send succeeds; each test says what is different. */
function deps(over: Partial<BatchDeps> = {}): BatchDeps & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    members: () => ["a", "b", "c"],
    paths: async () => new Map(Object.entries(PATHS)),
    live: () => false,
    archived: () => false,
    misconfigured: () => false,
    streaming: () => false,
    foreignWriter: () => false,
    async send(path) {
      sent.push(path);
    },
    ...over,
  };
}

test("the happy path prompts every member once, in member order", async () => {
  const d = deps();
  const r = await promptGroup("g1", "ship it", undefined, d);
  assert.ok(r.ok);
  assert.deepEqual(r.result, { sent: ["a", "b", "c"], failed: [] });
  assert.deepEqual(d.sent, ["/s/a.jsonl", "/s/b.jsonl", "/s/c.jsonl"]);
});

test("one blocked member refuses the WHOLE batch and sends nothing", async () => {
  const d = deps({ streaming: (p) => p === PATHS.b });
  const r = await promptGroup("g1", "ship it", undefined, d);
  assert.ok(!r.ok && r.status === 409);
  assert.deepEqual(
    r.refused.map((x) => [x.id, x.code]),
    [["b", "mid-turn"]],
  );
  assert.deepEqual(d.sent, [], "not one member was prompted");
});

test("every blocked member is named at once, each with its own reason", async () => {
  const d = deps({
    live: (p) => p === PATHS.a,
    archived: (id) => id === "b",
    paths: async () => new Map([["a", PATHS.a!], ["b", PATHS.b!]]), // c's file is gone
  });
  const r = await promptGroup("g1", "ship it", undefined, d);
  assert.ok(!r.ok && r.status === 409);
  assert.deepEqual(
    r.refused.map((x) => [x.id, x.code, x.path]),
    [
      ["a", "tui-live", PATHS.a],
      ["b", "archived", PATHS.b],
      ["c", "missing", ""],
    ],
  );
  assert.ok(r.refused.every((x) => x.message.length > 0), "every refusal carries a sentence");
  assert.deepEqual(d.sent, []);
});

test("each remaining reason has its own code", async () => {
  for (const [over, code] of [
    [{ misconfigured: () => true }, "config"],
    [{ foreignWriter: () => true }, "busy"],
  ] as const) {
    const d = deps({ members: () => ["a"], ...over });
    const r = await promptGroup("g1", "hi", undefined, d);
    assert.ok(!r.ok && r.status === 409);
    assert.equal(r.refused[0]!.code, code);
    assert.deepEqual(d.sent, []);
  }
});

test("a send that fails AFTER the pre-check is a partial send, not a rollback", async () => {
  const d = deps({
    async send(path) {
      if (path === PATHS.b) throw new BusyError("a TUI grabbed it", "busy");
      d.sent.push(path);
    },
  });
  const r = await promptGroup("g1", "ship it", undefined, d);
  assert.ok(r.ok, "not a 409: the pre-check passed");
  assert.deepEqual(r.result.sent, ["a", "c"], "the members behind the failure still got it");
  assert.deepEqual(
    r.result.failed.map((x) => [x.id, x.code, x.message]),
    [["b", "tui-live", "a TUI grabbed it"]],
  );
  assert.deepEqual(d.sent, ["/s/a.jsonl", "/s/c.jsonl"]);
});

test("a post-check failure keeps the WS error vocabulary out of the wire codes", async () => {
  for (const [err, code] of [
    [new BusyError("unknown writer", "recent"), "busy"],
    [new BusyError("reloaded", "reloaded"), "internal"],
    [new ConfigError("cwd is gone", "/gone"), "config"],
    [new Error("something else"), "internal"],
  ] as const) {
    const d = deps({
      members: () => ["a"],
      send: async () => {
        throw err;
      },
    });
    const r = await promptGroup("g1", "hi", undefined, d);
    assert.ok(r.ok);
    assert.deepEqual(r.result.sent, []);
    assert.equal(r.result.failed[0]!.code, code);
    assert.equal(r.result.failed[0]!.message, err.message, "the real error text survives");
  }
});

test("members subset: only those are checked and prompted, in group order", async () => {
  const d = deps({ streaming: (p) => p === PATHS.b }); // b would refuse the whole batch
  const r = await promptGroup("g1", "ship it", ["c", "a"], d);
  assert.ok(r.ok, "the blocked member is not in the subset, so nothing is refused");
  assert.deepEqual(r.result.sent, ["a", "c"], "group order, not the client's order");
  assert.deepEqual(d.sent, ["/s/a.jsonl", "/s/c.jsonl"]);
});

test("a subset naming a session that is not a member is a 400, and sends nothing", async () => {
  const d = deps();
  const r = await promptGroup("g1", "hi", ["a", "stranger"], d);
  assert.ok(!r.ok && r.status === 400);
  assert.match(r.error, /stranger/);
  assert.deepEqual(d.sent, []);
});

test("400s: blank text, an empty subset, an empty group — and 404 for an unknown group", async () => {
  const one = (): BatchDeps & { sent: string[] } => deps({ members: (id) => (id === "g1" ? ["a"] : null) });
  for (const [groupId, text, subset, status] of [
    ["g1", "   ", undefined, 400],
    ["g1", "hi", [], 400],
    ["nope", "hi", undefined, 404],
  ] as const) {
    const d = one();
    const r = await promptGroup(groupId, text, subset as string[] | undefined, d);
    assert.ok(!r.ok && r.status === status, `${groupId}/${JSON.stringify(text)}/${JSON.stringify(subset)} → ${status}`);
    assert.deepEqual(d.sent, []);
  }
  const emptyGroup = deps({ members: () => [] });
  const empty = await promptGroup("g1", "hi", undefined, emptyGroup);
  assert.ok(!empty.ok && empty.status === 400);
  assert.deepEqual(emptyGroup.sent, []);
});

test("blank text is refused before the group is even looked up", async () => {
  let looked = false;
  const r = await promptGroup(
    "g1",
    "\n  \t ",
    undefined,
    deps({
      members: () => {
        looked = true;
        return ["a"];
      },
    }),
  );
  assert.ok(!r.ok && r.status === 400);
  assert.equal(looked, false);
});

test("a failure with no message still carries a sentence", async () => {
  // spec §14: a client that doesn't recognise a newer `code` shows `message` verbatim, so a blank
  // one would drop the reason on the floor.
  const d = deps({
    members: () => ["a"],
    send: async () => {
      throw new Error("   ");
    },
  });
  const r = await promptGroup("g1", "hi", undefined, d);
  assert.ok(r.ok);
  assert.equal(r.result.failed[0]!.code, "internal");
  assert.ok(r.result.failed[0]!.message.trim().length > 0);
});
