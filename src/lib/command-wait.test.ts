// Run: pnpm test -- src/lib/command-wait.test.ts. A "/word" sent before a new chat has listed its
// commands (§chat.transcript/send-while-starting): it waits for the list, then shows as a "Ran" row
// when the chat knows it and as an ordinary message otherwise; one handed back meanwhile never shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandOf, UnlistedSends } from "./command-wait";

test("commandOf: only a listed name is a command; anything else is a message", () => {
  const list = [{ name: "foo" }, { name: "compact" }];
  assert.equal(commandOf("/foo", list), "foo");
  assert.equal(commandOf("/foo bar baz", list), "foo");
  assert.equal(commandOf("/zzz hi", list), null);
  assert.equal(commandOf("foo", list), null);
  assert.equal(commandOf("/foo", []), null, "before the list, nothing is known");
});

test("a /word before the list waits, then shows once as what it is; plain text never waits", () => {
  const u = new UnlistedSends<{ text: string; clientId: string }>();
  assert.equal(u.hold({ text: "hello", clientId: "m" }), false, "a message shows at once");
  assert.equal(u.hold({ text: "/foo", clientId: "a" }), true);
  assert.equal(u.hold({ text: "/zzz hi", clientId: "b" }), true);
  const list = [{ name: "foo" }];
  const shown = u.listedNow(() => false);
  assert.deepEqual(
    shown.map((s) => [s.clientId, commandOf(s.text, list) ? "ran" : "message"]),
    [
      ["a", "ran"],
      ["b", "message"],
    ],
  );
  assert.deepEqual(u.listedNow(() => false), [], "each once");
  assert.equal(u.hold({ text: "/foo", clientId: "c" }), false, "once listed, a /word is decided at once");
});

test("a /word handed back before the list (the chat never started) never shows later", () => {
  const u = new UnlistedSends<{ text: string; clientId: string }>();
  u.hold({ text: "/foo", clientId: "a" });
  u.hold({ text: "/bar", clientId: "b" });
  u.hold({ text: "/baz", clientId: "c" });
  u.drop(new Set(["a"]));
  assert.deepEqual(
    u.listedNow((id) => id === "b").map((s) => s.clientId),
    ["c"],
  );
});
