// Run: pnpm test -- src/lib/overseer-about.test.ts
// The Overseer's About panel's words and rows (§app.overseer/about).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OverseerCaps } from "../../shared/protocol";
import { commandText, EXT_NONE, EXT_NOT_RUNNING, extIntro, limitRows } from "./overseer-about";
import { CAP_KEYS } from "./overseer-draft";

const DEFAULT_CAPS: OverseerCaps = { createPerTurn: 5, promptsPerTurn: 10, archivesPerTurn: 50, concurrentSessions: 10, explorePerTurn: 2, linksPerTurn: 3, orgWritesPerTurn: 20, gatherPerTurn: 3, extRunsPerTurn: 5 };

test("limits: running at once first, then every per-message one in Settings' order, with Settings' labels", () => {
  const rows = limitRows({ ...DEFAULT_CAPS, extRunsPerTurn: 7 });
  assert.equal(rows.length, CAP_KEYS.length, "all nine");
  assert.deepEqual(rows[0], { key: "concurrentSessions", label: "Running at once", value: 10 });
  assert.deepEqual(rows.at(-1), { key: "extRunsPerTurn", label: "Extension commands run", value: 7 });
  assert.deepEqual(rows.slice(1).map((r) => r.key), CAP_KEYS.filter((k) => k !== "concurrentSessions"));
});

test("the extensions group's words: the ask-first rule with the per-message limit, the empty and not-running lines", () => {
  assert.equal(extIntro({ ...DEFAULT_CAPS, extRunsPerTurn: 3 }), "It runs one only when you ask in your own message, at most 3 per message.");
  assert.equal(EXT_NONE, "No extension gives the Overseer abilities. An extension does by marking its commands for the Overseer.");
  assert.equal(EXT_NOT_RUNNING, "Not running: the Overseer can't run these until it is.");
});

test("a command's text: its description, else its summary, else nothing", () => {
  assert.equal(commandText({ id: "ext.a.b", label: "B", summary: "S", description: "D", job: false }), "D");
  assert.equal(commandText({ id: "ext.a.b", label: "B", summary: "S", job: false }), "S");
  assert.equal(commandText({ id: "ext.a.b", label: "B", job: true }), "");
});
