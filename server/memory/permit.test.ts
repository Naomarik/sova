// The server's web-minor hook (§chat.memory/where): installed when the module loads, so a chat this server hosts
// keeps the saved default's memory, while turning memory on stays refused outside a switch for that session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptableMinorModes, webMinorRefusal } from "../../pi-config/extensions/mode/minor.ts";
import { withWebMinors } from "./permit";

test("loading the module installs the hook: the default's memory is adoptable here", () => {
  assert.equal(typeof (globalThis as Record<symbol, unknown>)[Symbol.for("sova:web-minor")], "function");
  assert.deepEqual(adoptableMinorModes(["align", "memory"]), ["align", "memory"]);
});

test("turning memory on is still permitted only inside a switch for that very session", async () => {
  assert.match(webMinorRefusal("memory", "s1") ?? "", /mode menu/);
  await withWebMinors("s1", ["memory"], async () => {
    assert.equal(webMinorRefusal("memory", "s1"), undefined);
    assert.match(webMinorRefusal("memory", "s2") ?? "", /mode menu/);
  });
  assert.match(webMinorRefusal("memory", "s1") ?? "", /mode menu/);
});
