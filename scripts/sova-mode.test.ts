// Run: pnpm test -- scripts/sova-mode.test.ts
// A project mode's command from the command line (§chat.mode-menu/project-mode-commands): `mode.<id>.<name>` is
// the catalogue's chat.mode-command row with its mode and name fixed, and Sova's record of who ran what names it
// by that id. In-process; the real server and process run in server/mode-commands.integration.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: a plain .mjs script, no declarations
import { entryFor, MODE_COMMAND_RE, parseRunArgs } from "./sova.mjs";
import { buildRequest } from "../shared/commands-catalog";
import { commandName } from "../server/command-audit";

const env = { SOVA_EXTENSIONS_FILE: "/nonexistent/extensions.json" };

test("mode.<id>.<name> is chat.mode-command with that mode and name, needing --session", () => {
  const entry = entryFor("mode.release.release_check", env);
  assert.equal(entry.id, "mode.release.release_check");
  assert.equal(entry.meshNeed, "full");
  assert.equal(entry.effect, "changes");
  assert.deepEqual(Object.keys(entry.params).sort(), ["args", "session"]);
  const parsed = parseRunArgs(entry, ["--session", "/s/a.jsonl", "--args", '{"filter":"x"}']);
  const req = buildRequest(entry, { ...parsed.values, session: "/s/a.jsonl" });
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/api/mode/command?path=%2Fs%2Fa.jsonl");
  assert.deepEqual(req.body, { args: { filter: "x" }, mode: "release", name: "release_check" });
});

test("anything else is not a mode command: core ids stay theirs, bad shapes are none", () => {
  assert.equal(entryFor("chat.stop", env).id, "chat.stop");
  for (const id of ["mode.Release.check", "mode.release.Check", "mode.release", "mode.release.check.more", "mode..check", "mode.release.check__x", `mode.${"a".repeat(31)}.x`])
    assert.equal(entryFor(id, env), undefined, id);
  assert.equal(MODE_COMMAND_RE.test("mode.release-check.status"), true);
});

test("Sova's record names a mode command by its id, and nothing that only looks like one", () => {
  assert.equal(commandName("mode.release.release_check"), "mode.release.release_check");
  assert.equal(commandName("mode.Release.x"), undefined);
  assert.equal(commandName("mode.release"), undefined);
  assert.equal(commandName("chat.stop"), "chat.stop");
});
