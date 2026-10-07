// Run: npx tsx --test server/claude-models.integration.test.ts. Model discovery's spawn of a real
// executable path that does not exist (the OS's ENOENT, not a fake's); everything else about
// discovery runs on fake children in claude-models.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverClaudeModels } from "./claude-models";

test("a CLI that isn't there rejects with a sentence, not the OS error", async () => {
  await assert.rejects(discoverClaudeModels({ executable: "/nonexistent/claude-for-sova-test" }), (err: Error) => /^Could not run the Claude Code CLI/.test(err.message) && !/ENOENT/.test(err.message));
});
