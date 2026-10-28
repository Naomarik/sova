import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cardToolkitTypes } from "./card-toolkit-types";
import { COMMANDS } from "./commands-catalog";

test("the card toolkit's command types are the catalogue's (run node scripts/card-toolkit-types.mjs)", () => {
  const have = readFileSync(new URL("../src/card-toolkit/commands.gen.ts", import.meta.url), "utf8");
  assert.equal(have, cardToolkitTypes(COMMANDS));
});

test("every entry is there, with its params as declared", () => {
  const text = cardToolkitTypes(COMMANDS);
  for (const c of COMMANDS) assert.ok(text.includes(`| ${JSON.stringify(c.id)}`), c.id);
  const send = COMMANDS.find((c) => c.id === "session.send")!;
  assert.ok(send.params.text?.required);
  assert.match(text, /"session\.send": \{[^}]*"text": string;/s, "a required param is required");
  assert.match(text, /"session\.send": \{[^}]*"session"\?: string;/s, "a session param defaults to the card's own");
});
