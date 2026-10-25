// Run: node scripts/run-tests.mjs server/extension-offers.test.ts
// What an extension offers (§app.extensions/offers): a manifest entry's `commands` and `screens`,
// validated and bounded on the server (shared/extension-offers.ts through server/extensions.ts
// validateExtension), kept apart from the entry the mesh publishes, and the mesh need of the routes
// the page uses to read and ask them. The list itself against a real health probe is
// extension-offers.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { offersOf, offersPlace, SCREEN_PLACES, screenPath } from "../shared/extension-offers";

const tmp = mkdtempSync(join(tmpdir(), "sova-ext-offers-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.SOVA_EXTENSIONS_FILE = join(tmp, "extensions.json");
mkdirSync(join(tmp, "agent", "sova"), { recursive: true });

const { validateExtension } = await import("./extensions");
const { classifyRequest } = await import("./mesh/access");

after(() => rmSync(tmp, { recursive: true, force: true }));

const base = () => ({ id: "tickets", title: "Tickets", dist: "/abs/dist", api: "http://127.0.0.1:47916" });
const cmd = (name: string, extra: Record<string, unknown> = {}) => ({ name, label: `Do ${name}`, ...extra });

describe("offersOf", () => {
  test("nothing declared is no offers, and no complaint", () => {
    assert.deepEqual(offersOf("x", {}), { offers: null, dropped: [] });
  });

  test("valid commands keep only name, label and summary; valid screens keep their place", () => {
    const got = offersOf("tickets", {
      commands: [cmd("create", { summary: "Files an issue", params: { title: { type: "string" } }, confirm: true }), cmd("open")],
      screens: ["reply"],
    });
    assert.deepEqual(got, {
      offers: { commands: [{ name: "create", label: "Do create", summary: "Files an issue" }, { name: "open", label: "Do open" }], screens: ["reply"] },
      dropped: [],
    });
  });

  test("a malformed command or screen is left out alone; a malformed key is none", () => {
    const got = offersOf("t", { commands: [cmd("ok"), { name: "Bad Name", label: "x" }, cmd("ok"), "nope", { name: "nolabel" }], screens: ["reply", "sidebar", 7, "reply"] });
    assert.deepEqual(got.offers, { commands: [{ name: "ok", label: "Do ok" }], screens: ["reply"] });
    assert.deepEqual(got.dropped, ["4 of its commands", "3 of its screens"]);
    assert.deepEqual(offersOf("t", { commands: { name: "x" }, screens: "reply" }), { offers: null, dropped: ["commands is not an array", "screens is not an array"] });
  });

  test("bounded: at most 32 commands read, labels and summaries capped", () => {
    const many = Array.from({ length: 40 }, (_, i) => cmd(`c${i}`));
    assert.equal(offersOf("t", { commands: many }).offers!.commands!.length, 32);
    assert.equal(offersOf("t", { commands: [{ name: "a", label: "x".repeat(49) }] }).offers, null);
    assert.equal(offersOf("t", { commands: [{ name: "a", label: "ok", summary: "x".repeat(201) }] }).offers, null);
    assert.equal(offersOf("t", { screens: Array.from({ length: 1000 }, () => "nope").concat(["reply"]) }).offers, null, "names past the first 16 are never read");
  });

  test("never copies anything but the validated strings", () => {
    const planted = "fake-key-0000-test";
    const got = offersOf("t", { commands: [{ ...cmd("a"), token: planted, headers: { authorization: planted }, env: { SOVA_TOKEN: planted } }], screens: ["reply"] });
    assert.ok(!JSON.stringify(got).includes(planted));
  });

  test("the places and the path a place asks", () => {
    assert.deepEqual([...SCREEN_PLACES], ["reply", "row", "card"]);
    assert.equal(screenPath("reply"), "/api/screens/reply");
    assert.equal(offersPlace({ screens: ["reply"] }, "reply"), true);
    assert.equal(offersPlace({ commands: [{ name: "a", label: "A" }] }, "reply"), false);
    assert.equal(offersPlace(undefined, "reply"), false);
  });
});

describe("validateExtension", () => {
  test("an entry that declares nothing is exactly today's: no offers key", () => {
    const v = validateExtension(base());
    assert.deepEqual(v, { entry: base() });
  });

  test("offers ride beside the entry, never in it (the entry is what the mesh publishes)", () => {
    const v = validateExtension({ ...base(), commands: [cmd("create")], screens: ["reply"] });
    assert.ok("entry" in v);
    assert.deepEqual(v.entry, base());
    assert.deepEqual(v.offers, { commands: [{ name: "create", label: "Do create" }], screens: ["reply"] });
  });

  test("bad offers never drop the entry", () => {
    const v = validateExtension({ ...base(), commands: 5, screens: [{}] });
    assert.deepEqual(v, { entry: base() });
  });
});

describe("mesh", () => {
  test("GET /api/extensions keeps its need; the screen and command requests stay behind the proxy's", () => {
    assert.equal(classifyRequest("GET", "/api/extensions").need, "sessions");
    assert.equal(classifyRequest("GET", `/ext/tickets${screenPath("reply")}`).need, "full");
    assert.equal(classifyRequest("POST", "/ext/tickets/api/commands/create").need, "full");
  });
});
