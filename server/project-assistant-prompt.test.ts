// Run: pnpm test server/project-assistant-prompt.test.ts. The Project Assistant's prompt
// (§app.project-assistant/chat): Sova's own words never reach the owner, so the prompt names them
// and the plain words to say instead; and every placeholder is one the loadout fills.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const template = readFileSync(join(import.meta.dirname, "project-assistant-prompt.md"), "utf8");

test("it forbids Sova's internal words to the owner and gives the plain ones", () => {
  const line = template.split("\n").find((l) => l.startsWith("- Never say spec"));
  assert.ok(line, "the internal-words line");
  for (const w of ["spec", "draft", "claim", "branch", "session", "model"]) assert.match(line!, new RegExp(`\\b${w}\\b`), w);
  for (const plain of ["what's been agreed", "the project's plan", "the team"]) assert.ok(line!.includes(plain), plain);
});

test("its placeholders are the four the loadout fills", () => {
  const used = new Set([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), ["LOOKUP_RULES", "OPERATOR", "OWNER", "PROJECTS"]);
});
