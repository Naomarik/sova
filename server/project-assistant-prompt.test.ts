// Run: pnpm test server/project-assistant-prompt.test.ts. The Project Assistant's prompt
// (§app.project-assistant/chat): Sova's own words never reach the owner, so the prompt names them
// and the plain words to say instead; and every placeholder is one the loadout fills.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ASSISTANT_VIS_GUIDE, gatheringVisGuide, SHARE_VIS_KINDS } from "./baton-vis-guide";
import { ASSISTANT_PHOTOS_OFF, ASSISTANT_PHOTOS_ON } from "./project-assistant-loadout";
import { parseVis } from "../src/vis/parse";

const template = readFileSync(join(import.meta.dirname, "project-assistant-prompt.md"), "utf8");

test("it forbids Sova's internal words to the owner and gives the plain ones", () => {
  const line = template.split("\n").find((l) => l.startsWith("- Never say spec"));
  assert.ok(line, "the internal-words line");
  for (const w of ["spec", "draft", "claim", "branch", "session", "model"]) assert.match(line!, new RegExp(`\\b${w}\\b`), w);
  for (const plain of ["what's been agreed", "the project's plan", "the team"]) assert.ok(line!.includes(plain), plain);
});

test("its placeholders are the ones the loadout fills", () => {
  const used = new Set([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), ["DRAWING", "FIX", "LOOKUP_RULES", "OPERATOR", "OWNER", "PHOTOS", "PLANNING", "PROJECTS", "RELEASE", "REQUIREMENTS", "VERSIONS"]);
});

// §app.project-assistant/drawings: the hand-off guide's grammar, interactive drawings included, with an opening for the owner.
test("its drawing guide teaches every kind the owner page draws, interactive ones too, and its examples parse", () => {
  const g = ASSISTANT_VIS_GUIDE();
  const taught = [...g.matchAll(/^## (.*)$/gm)].map((m) => m[1]!.trim());
  assert.deepEqual(taught.slice(-2), ["svg", "html"]);
  for (const k of SHARE_VIS_KINDS) assert.ok(g.includes(`\`\`\`vis ${k}\n`), `an example of ${k}`);
  assert.match(g, /^The owner's page draws `vis` fences/m);
  assert.match(g, /Never draw people, roles, who decides what, the team's own work, or how this conversation is run/);
  assert.match(g, /A drawing couldn't be shown here\./);
  assert.doesNotMatch(g, /the roster|hand the conversation|<!--|vis_check|## code/);
  // The grammar is the hand-off guide's: only the opening differs.
  const body = (s: string) => s.slice(s.indexOf("Rules for every kind:"));
  assert.equal(body(g), body(gatheringVisGuide(undefined, { html: true })));
  for (const [, info, src] of g.matchAll(/^```(vis [a-z]+)\n([\s\S]*?)^```$/gm)) {
    const r = parseVis(info!.slice(4), src!);
    assert.ok(r.ok && r.warnings.length === 0, `${info}: ${r.ok ? r.warnings.join("; ") : `line ${r.line}: ${r.message}`}`);
  }
});

// §app.project-assistant/photos: the prompt says photos can be sent only when they can.
test("its photo lines follow whether the owner can send photos", () => {
  assert.match(ASSISTANT_PHOTOS_ON, /can attach photos and screenshots/);
  assert.match(ASSISTANT_PHOTOS_ON, /ask for a screenshot/);
  assert.match(ASSISTANT_PHOTOS_ON, /Say in words what a photo shows/);
  assert.match(ASSISTANT_PHOTOS_ON, /Never describe a person's face/);
  assert.match(ASSISTANT_PHOTOS_ON, /never read personal numbers/);
  assert.match(ASSISTANT_PHOTOS_OFF, /can't send photos here/);
});

test("it offers to close a request made moot, and closes or reopens only after the owner's clear yes", () => {
  const line = template.split("\n").find((l) => l.includes("close_request"));
  assert.ok(line, "the closing line");
  assert.match(line!, /made it moot/);
  assert.match(line!, /only after their clear yes in their next message/);
  assert.match(line!, /reopen_request/);
  assert.match(line!, /the team's call/);
});

test("it looks at what's new and the versions' summaries before it says it can't tell", () => {
  const line = template.split("\n").find((l) => l.includes("project_news"));
  assert.ok(line, "the what's-new line");
  assert.match(line!, /owner_versions/);
  assert.match(line!, /Never say you can't tell until you have looked at both/);
});
