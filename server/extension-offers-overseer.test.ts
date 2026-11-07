// Run: pnpm test -- server/extension-offers-overseer.test.ts
// A command's ext-contract-v1.18 keys (§app.commands/extension-commands, §app.overseer/extension-commands):
// `overseer: true`, `description` and `job: true`. Each is read on its own: a bad value leaves out
// only that key, never the command. The offers carry `overseer` and `job` as `true` only; the
// description is read from the manifest (overseerExtCommands), never in the offers. A command without them reads exactly as
// before, for the offers and for the command line.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { offersOf } from "../shared/extension-offers";
import { DESCRIPTION_MAX, extCommandsFrom, extOverseerKeys } from "../shared/commands-ext";

const tmp = mkdtempSync(join(tmpdir(), "sova-ext-overseer-keys-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.SOVA_EXTENSIONS_FILE = join(tmp, "extensions.json");
mkdirSync(join(tmp, "agent", "sova"), { recursive: true });

const { validateExtension, overseerExtCommands } = await import("./extensions");

after(() => rmSync(tmp, { recursive: true, force: true }));

const cmd = (name: string, extra: Record<string, unknown> = {}) => ({ name, label: `Do ${name}`, ...extra });
const entry = (id: string, commands: unknown[], title = id) => ({ id, title, dist: "/abs/dist", api: "http://127.0.0.1:47916", commands });

describe("extOverseerKeys", () => {
  test("valid keys read as declared; false and absent are none", () => {
    assert.deepEqual(extOverseerKeys(cmd("a", { overseer: true, job: true, description: "  Launch a session.\nThen report.  " })), {
      overseer: true,
      job: true,
      description: "Launch a session.\nThen report.",
      dropped: [],
    });
    assert.deepEqual(extOverseerKeys(cmd("a", { overseer: false, job: false })), { dropped: [] });
    assert.deepEqual(extOverseerKeys(cmd("a")), { dropped: [] });
    assert.deepEqual(extOverseerKeys(null), { dropped: [] });
  });

  test("a bad value leaves out only its key", () => {
    assert.deepEqual(extOverseerKeys(cmd("a", { overseer: "yes", job: 1, description: "fine" })), { description: "fine", dropped: ["overseer", "job"] });
    for (const bad of ["", "   ", "x".repeat(DESCRIPTION_MAX + 1), "tab\there", "nul\u0000", 42, ["a"]])
      assert.deepEqual(extOverseerKeys(cmd("a", { overseer: true, description: bad })), { overseer: true, dropped: ["description"] }, JSON.stringify(bad));
    assert.equal(extOverseerKeys(cmd("a", { description: "x".repeat(DESCRIPTION_MAX) })).description?.length, DESCRIPTION_MAX);
  });
});

describe("the offers", () => {
  test("overseer and job ride on the command as true; the description never does", () => {
    const got = offersOf("acme", { commands: [cmd("launch", { overseer: true, job: true, description: "For a model", summary: "Starts one" }), cmd("plain")] });
    assert.deepEqual(got, {
      offers: { commands: [{ name: "launch", label: "Do launch", summary: "Starts one", overseer: true, job: true }, { name: "plain", label: "Do plain" }] },
      dropped: [],
    });
    assert.doesNotMatch(JSON.stringify(got), /For a model/);
  });

  test("a bad key drops that key alone, logged; the command stays", () => {
    const got = offersOf("t", { commands: [cmd("a", { overseer: "yes", job: true }), cmd("b", { overseer: true, description: "" })] });
    assert.deepEqual(got.offers, { commands: [{ name: "a", label: "Do a", job: true }, { name: "b", label: "Do b", overseer: true }] });
    assert.deepEqual(got.dropped, ["1 of its commands' overseer keys", "1 of its commands' description keys"]);
  });

  test("an extension without the keys gets exactly the offers it got before", () => {
    const v = validateExtension(entry("tickets", [cmd("a", { summary: "A" }), cmd("b", { menu: "session" })]));
    assert.ok("entry" in v);
    assert.deepEqual(v.offers, { commands: [{ name: "a", label: "Do a", summary: "A" }, { name: "b", label: "Do b", menu: "session" }] });
    assert.doesNotMatch(JSON.stringify(v), /overseer|job|description/);
  });

  test("the command line reads the same commands with or without the keys", () => {
    const plain = [cmd("a"), cmd("b", { summary: "B", params: { n: { type: "integer", required: true } } })];
    const keyed = [cmd("a", { overseer: true, job: "bad" }), cmd("b", { summary: "B", params: { n: { type: "integer", required: true } }, description: "D", job: true })];
    assert.deepEqual(extCommandsFrom("t", keyed), extCommandsFrom("t", plain));
  });
});

describe("overseerExtCommands", () => {
  test("only the commands an installed extension marks overseer, whole, in manifest order, with their description", () => {
    writeFileSync(
      process.env.SOVA_EXTENSIONS_FILE!,
      JSON.stringify({
        version: 1,
        extensions: [
          entry("tickets", [cmd("file")]),
          entry("acme", [cmd("status", { overseer: true }), cmd("launch", { overseer: true, job: true, description: "Opens a session.", params: { prompt: { type: "string", required: true } } }), cmd("hidden")], "Acme"),
          { id: "broken", dist: "relative/dist", commands: [cmd("x", { overseer: true })] },
        ],
      }),
    );
    const got = overseerExtCommands();
    assert.deepEqual(got.map((c) => [c.extension.id, c.extension.title, c.command.id, c.job, c.description ?? null]), [
      ["acme", "Acme", "ext.acme.status", false, null],
      ["acme", "Acme", "ext.acme.launch", true, "Opens a session."],
    ]);
    assert.deepEqual(got[1]!.command.params, { prompt: { type: "string", description: "", in: "body", required: true } });
    assert.deepEqual(got[1]!.command.route, { method: "POST", path: "/ext/acme/api/commands/launch" });
  });
});
