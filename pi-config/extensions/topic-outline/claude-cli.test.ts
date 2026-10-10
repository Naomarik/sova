import assert from "node:assert/strict";
import test from "node:test";
import { claudeCliArgs, claudeCliEnv } from "./summarizers/claude-cli.ts";
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

test("the summarizer's env pins CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 over an inherited 0 and a login's env", () => {
	const env = claudeCliEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0", CLAUDECODE: "1" }, { CLAUDE_CONFIG_DIR: "/l", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "false" });
	assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
	assert.equal(env.CLAUDE_CONFIG_DIR, "/l");
	assert.equal(env.CLAUDECODE, undefined);
});
