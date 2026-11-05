// Run: pnpm test -- server/overseer-abilities.test.ts
// One reading of the Overseer's extension commands (§app.overseer/extension-commands, §app.overseer/about):
// grouped by extension with each one's health, what sova_ext can run, and the About panel's answer.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OverseerExtCommand } from "./extensions";
import { abilitiesInfo, BUILT_IN_ABILITIES, extAbilities, type ExtHealth, runnableCommands } from "./overseer-abilities";
import { DEFAULT_CAPS } from "./overseer-store";

const cmd = (ext: string, title: string, name: string, extra: Partial<OverseerExtCommand> = {}): OverseerExtCommand => ({
  extension: { id: ext, title },
  command: {
    id: `ext.${ext}.${name}`,
    extension: ext,
    label: `${name} label`,
    summary: `${name} summary`,
    effect: "changes",
    params: {},
    route: { method: "POST", path: `/ext/${ext}/api/commands/${name}` },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "full",
  },
  job: false,
  ...extra,
});

const offered = [cmd("a", "Alpha", "one", { description: "Does one." }), cmd("b", "Beta", "two", { job: true }), cmd("a", "Alpha", "three"), cmd("gone", "Gone", "x")];
const HEALTH: Record<string, ExtHealth> = { a: { status: "ok" }, b: { status: "down", error: "connection refused" }, gone: null };

describe("extAbilities", () => {
  test("groups by extension in manifest order, asks each one's health once, leaves out one no longer installed", async () => {
    const asked: string[] = [];
    const got = await extAbilities(offered, async (id) => (asked.push(id), HEALTH[id] ?? null));
    assert.deepEqual(asked, ["a", "b", "gone"], "once per extension");
    assert.deepEqual(got.map((g) => [g.extension.id, g.running, g.error, g.commands.map((c) => c.command.id)]), [
      ["a", true, undefined, ["ext.a.one", "ext.a.three"]],
      ["b", false, "connection refused", ["ext.b.two"]],
    ]);
  });

  test("a health probe that throws reads as not installed, never as running", async () => {
    const got = await extAbilities([cmd("x", "X", "y")], async () => {
      throw new Error("boom");
    });
    assert.deepEqual(got, []);
  });

  test("a down extension without a reason still says why", async () => {
    const [g] = await extAbilities([cmd("x", "X", "y")], async () => ({ status: "down" }));
    assert.equal(g!.error, "its backend didn't answer its health check");
  });

  test("runnableCommands: only those of running extensions; no switch filters them", async () => {
    const got = await extAbilities(offered, async (id) => HEALTH[id] ?? null);
    assert.deepEqual(runnableCommands(got).map((c) => c.command.id), ["ext.a.one", "ext.a.three"]);
  });
});

describe("abilitiesInfo (GET /api/overseer/abilities)", () => {
  test("built-in lines, the caps as given, and each extension with its commands as the panel draws them", async () => {
    const caps = { ...DEFAULT_CAPS, extRunsPerTurn: 2 };
    const info = abilitiesInfo(await extAbilities(offered, async (id) => HEALTH[id] ?? null), caps);
    assert.equal(info.builtIn, BUILT_IN_ABILITIES);
    assert.ok(info.builtIn.length >= 5 && info.builtIn.every((b) => b.name && b.text.endsWith(".")), "short lines, each a sentence");
    assert.equal(info.caps, caps);
    assert.deepEqual(info.extensions, [
      {
        id: "a",
        title: "Alpha",
        running: true,
        commands: [
          { id: "ext.a.one", label: "one label", summary: "one summary", description: "Does one.", job: false },
          { id: "ext.a.three", label: "three label", summary: "three summary", job: false },
        ],
      },
      { id: "b", title: "Beta", running: false, error: "connection refused", commands: [{ id: "ext.b.two", label: "two label", summary: "two summary", job: true }] },
    ]);
  });
});
