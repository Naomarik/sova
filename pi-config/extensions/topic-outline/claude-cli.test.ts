import assert from "node:assert/strict";
import test from "node:test";
import { claudeCliArgs } from "./summarizers/claude-cli.ts";
import { SOVA_FIXED_SETTINGS } from "../claude-code/fixed-settings.ts";

test("the summarizer's claude one-shot: no user settings, the fixed ones (auto-memory off) in its one --settings", () => {
	const args = claudeCliArgs("claude-haiku-4-5", 0.05);
	assert.equal(args[args.indexOf("--setting-sources") + 1], "");
	assert.equal(args.filter((a) => a === "--settings").length, 1);
	const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
	assert.deepEqual(settings, SOVA_FIXED_SETTINGS);
	assert.equal(settings.autoMemoryEnabled, false);
	assert.equal(args[args.indexOf("--tools") + 1], "");
	assert.equal(args[args.indexOf("--max-budget-usd") + 1], "0.05");
});
