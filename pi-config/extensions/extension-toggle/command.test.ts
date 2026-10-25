/**
 * The `/extensions` command through the extension's own handler, on a hermetic agent dir: it lists
 * PI_CODING_AGENT_DIR's extensions, never ~/.pi/agent's. Node only (`node --test command.test.ts`):
 * pi-tui is nested under pi-coding-agent's node_modules, so a resolve hook retries @earendil-works/*
 * from there before index.ts loads; index.test.ts stays pi-free.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// Before index.ts loads: a throwaway HOME (its ~/.pi/agent holds a decoy) and agent dir.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ext-toggle-command-"));
const HOME = path.join(ROOT, "home");
const AGENT = path.join(ROOT, "agent");
process.env.HOME = HOME;
process.env.PI_CODING_AGENT_DIR = AGENT;
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));
assert.equal(os.homedir(), HOME, "this runtime ignores an in-process HOME: run it under node");

const piAgentUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (!specifier.startsWith("@earendil-works/")) throw error;
			return nextResolve(specifier, { ...context, parentURL: piAgentUrl });
		}
	},
});

const { default: extensionToggle } = await import("./index.ts");

test("/extensions lists the active agent dir's extensions (PI_CODING_AGENT_DIR), never ~/.pi/agent's", async () => {
	fs.mkdirSync(path.join(AGENT, "extensions", "alpha"), { recursive: true });
	fs.writeFileSync(path.join(AGENT, "extensions", "alpha", "index.ts"), "export default () => {};");
	fs.mkdirSync(path.join(HOME, ".pi", "agent", "extensions"), { recursive: true });
	fs.writeFileSync(path.join(HOME, ".pi", "agent", "extensions", "home-only.ts"), "export default () => {};");
	const cwd = path.join(ROOT, "proj");
	fs.mkdirSync(cwd, { recursive: true });

	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	extensionToggle({ registerCommand: (_name: string, spec: { handler: typeof handler }) => { handler = spec.handler; } } as never);
	const notes: string[] = [];
	await handler!("", { cwd, mode: "rpc", isProjectTrusted: () => false, ui: { notify: (text: string) => notes.push(text) } });
	assert.equal(notes.length, 1);
	assert.match(notes[0], /alpha/, "the agent dir's own extension");
	assert.doesNotMatch(notes[0], /home-only/, "nothing from ~/.pi/agent");
});
