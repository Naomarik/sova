// Run: pnpm test -- shared/commands-retired.test.ts
// Retired command ids (§app.commands/catalogue): an id whose action was removed leaves
// shared/commands-ids.json's `ids` for its `retired` list and is never used again, so no live
// entry, now or later, can take an id a script or a log once meant something else by.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMMANDS } from "./commands-catalog";

const file = JSON.parse(readFileSync(new URL("./commands-ids.json", import.meta.url), "utf8")) as { ids: string[]; retired?: string[] };
const retired = file.retired ?? [];

test("no live entry uses a retired id", () => {
  const live = new Set(COMMANDS.map((c) => c.id));
  assert.deepEqual(retired.filter((id) => live.has(id)), [], "a retired id is an entry again: retired ids are never reused (shared/commands-ids.json)");
});

test("a retired id is listed once, and never also as a live id", () => {
  assert.equal(new Set(retired).size, retired.length, "a retired id listed twice");
  assert.deepEqual(retired.filter((id) => file.ids.includes(id)), [], "an id is both live and retired");
});

test("the retired ids stay listed", () => {
  // Each removal appends here; deleting one is deleting an id ever shipped.
  for (const id of ["settings.agents.get"]) assert.ok(retired.includes(id), `${id} was retired and must stay listed`);
});
