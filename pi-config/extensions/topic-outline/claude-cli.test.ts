import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { claudeCliArgs, claudeCliEnv, createClaudeCliSummarizer } from "./summarizers/claude-cli.ts";
import { loadConfig } from "./config.ts";
import { resetClaudeExecutable } from "../claude-code/claude-executable.ts";
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

test("a hermetic agent dir: the config is that dir's, never ~/.pi/agent's, and the Claude summarizer runs Sova's Claude program, never ~/.local/bin/claude", async () => {
	const root = mkdtempSync(join(tmpdir(), "outline-hermetic-"));
	const home = join(root, "home");
	const agent = join(root, "agent");
	const bin = join(root, "bin");
	for (const dir of [join(home, ".pi", "agent"), join(home, ".local", "bin"), agent, bin]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "topic-outline.json"), JSON.stringify({ shareWithSessions: "off" }));
	writeFileSync(join(agent, "topic-outline.json"), JSON.stringify({ shareWithSessions: "summary" }));
	const fake = (file: string, mark: string) => {
		writeFileSync(file, `#!/bin/sh\ntouch ${join(root, mark)}\nexit 1\n`);
		chmodSync(file, 0o755);
	};
	fake(join(home, ".local", "bin", "claude"), "ran-home");
	fake(join(bin, "claude"), "ran-path");
	const saved = { HOME: process.env.HOME, PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agent;
	process.env.PATH = [bin, saved.PATH ?? ""].join(delimiter);
	resetClaudeExecutable();
	try {
		const config = loadConfig(root, false);
		assert.equal(config.shareWithSessions, "summary", "the agent dir's config, not the home one");
		assert.equal(config.claudeBin, undefined, "no hard-coded ~/.local/bin/claude");
		const input = { existingOutline: "[]", newLines: ["[m1] USER: hi"], validRefs: new Set(["m1"]), signal: new AbortController().signal };
		await createClaudeCliSummarizer({ backend: "claude-code", model: "sonnet", timeoutMs: 10_000 }, config.claudeBin).summarize(input).catch(() => {});
		assert.equal(existsSync(join(root, "ran-path")), true, "the resolver's program ran");
		assert.equal(existsSync(join(root, "ran-home")), false, "never ~/.local/bin/claude");
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		resetClaudeExecutable();
		rmSync(root, { recursive: true, force: true });
	}
});
