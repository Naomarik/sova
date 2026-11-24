// Run: pnpm test -- shared/project-overseer-coding-line.test.ts.
//
// The Overseer's project view names the profile a coding session started now is on (§app.project-overseer/coding-mode):
// never the word "Off", which is no profile any more.
import assert from "node:assert/strict";
import { test } from "node:test";
import { codingNowLine } from "./project-overseer";

const modes = { mode: "normal" as const, minorModes: ["spec", "vis"] };

test("the default profile by name, else the helpers in effect, else the words for the default; never Off", () => {
  assert.equal(codingNowLine({ ...modes, subagents: { id: "claude", name: "Claude" }, profile: { id: "house", name: "House" } }), "A coding session started now is on House, in normal · spec · visuals (this computer's default profile)");
  assert.equal(codingNowLine({ ...modes, subagents: { id: "claude", name: "Claude" } }), "A coding session started now is on Claude, in normal · spec · visuals (this computer's default profile)");
  for (const now of [{ ...modes, subagents: null }, { ...modes, subagents: null, profile: { id: "off", name: "Off" } }]) {
    const line = codingNowLine(now);
    assert.equal(line, "A coding session started now is on this computer's default profile, in normal · spec · visuals");
    assert.doesNotMatch(line, /\bOff\b/);
  }
});
