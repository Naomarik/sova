// Run: pnpm test -- server/extension-offers-menu.test.ts
// A command's `menu` key (the session ⋯ menu place, src/lib/menu-place.ts): validated with the rest
// of what an extension offers (shared/extension-offers.ts through server/extensions.ts
// validateExtension). A bad value leaves the command out of every menu, never out of `commands`, and
// never changes what the command line reads (shared/commands-ext.ts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { MENU_PLACES, offersOf } from "../shared/extension-offers";
import { extCommandsFrom } from "../shared/commands-ext";

const tmp = mkdtempSync(join(tmpdir(), "sova-ext-menu-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.SOVA_EXTENSIONS_FILE = join(tmp, "extensions.json");
mkdirSync(join(tmp, "agent", "sova"), { recursive: true });

const { validateExtension } = await import("./extensions");

after(() => rmSync(tmp, { recursive: true, force: true }));

const cmd = (name: string, extra: Record<string, unknown> = {}) => ({ name, label: `Do ${name}`, ...extra });

describe("the menu key", () => {
  test("the one menu place", () => {
    assert.deepEqual([...MENU_PLACES], ["session"]);
  });

  test('"session" rides on the command; a command without it has no menu key', () => {
    const got = offersOf("t", { commands: [cmd("file", { menu: "session", summary: "Files it" }), cmd("plain")] });
    assert.deepEqual(got, {
      offers: { commands: [{ name: "file", label: "Do file", summary: "Files it", menu: "session" }, { name: "plain", label: "Do plain" }] },
      dropped: [],
    });
    assert.ok(!("menu" in got.offers!.commands![1]!));
  });

  test("a bad menu value drops the menu entry alone: the command stays, and the drop is logged", () => {
    const bad = [cmd("a", { menu: "sidebar" }), cmd("b", { menu: 7 }), cmd("c", { menu: ["session"] }), cmd("d", { menu: null }), cmd("e", { menu: "Session" }), cmd("f", { menu: "session" })];
    const got = offersOf("t", { commands: bad });
    assert.deepEqual(
      got.offers!.commands!.map((c) => [c.name, c.menu]),
      [["a", undefined], ["b", undefined], ["c", undefined], ["d", undefined], ["e", undefined], ["f", "session"]],
    );
    assert.deepEqual(got.dropped, ["5 of its menu entries"]);
  });

  test("a command that isn't valid adds no menu entry, whatever its menu says", () => {
    const got = offersOf("t", { commands: [{ name: "Bad Name", label: "x", menu: "session" }, { name: "nolabel", menu: "session" }] });
    assert.equal(got.offers, null);
    assert.deepEqual(got.dropped, ["2 of its commands"]);
  });

  test("the first valid command of a name is the one whose menu counts", () => {
    const got = offersOf("t", { commands: [{ name: "a", menu: "session" }, cmd("a"), cmd("a", { menu: "session" })] });
    assert.deepEqual(got.offers!.commands, [{ name: "a", label: "Do a" }], "the invalid first one and the later duplicate are ignored");
    const got2 = offersOf("t", { commands: [cmd("a", { menu: "session" }), cmd("a")] });
    assert.deepEqual(got2.offers!.commands, [{ name: "a", label: "Do a", menu: "session" }]);
  });

  test("commands past the 32 read never add an entry", () => {
    const many = Array.from({ length: 40 }, (_, i) => cmd(`c${i}`, { menu: "session" }));
    const got = offersOf("t", { commands: many });
    assert.equal(got.offers!.commands!.filter((c) => c.menu === "session").length, 32);
  });

  test("the command line reads the same commands with or without menu keys", () => {
    const plain = [cmd("a"), cmd("b", { summary: "B" })];
    const menued = [cmd("a", { menu: "session" }), cmd("b", { summary: "B", menu: "nope" })];
    assert.deepEqual(extCommandsFrom("t", menued), extCommandsFrom("t", plain));
  });

  test("an extension without the key gets exactly the offers it got before: no menu key anywhere", () => {
    const entry = { id: "tickets", title: "Tickets", dist: "/abs/dist", api: "http://127.0.0.1:47916", commands: [cmd("a", { summary: "A" }), cmd("b")], screens: ["reply"] };
    const v = validateExtension(entry);
    assert.ok("entry" in v);
    assert.deepEqual(v.offers, { commands: [{ name: "a", label: "Do a", summary: "A" }, { name: "b", label: "Do b" }], screens: ["reply"] });
    assert.doesNotMatch(JSON.stringify(v), /menu/);
    assert.deepEqual(offersOf("tickets", entry).dropped, []);
  });

  test("validateExtension carries it into the list's offers", () => {
    const v = validateExtension({ id: "tickets", title: "Tickets", dist: "/abs/dist", api: "http://127.0.0.1:47916", commands: [cmd("file", { menu: "session" })] });
    assert.ok("entry" in v);
    assert.deepEqual(v.offers, { commands: [{ name: "file", label: "Do file", menu: "session" }] });
  });
});
