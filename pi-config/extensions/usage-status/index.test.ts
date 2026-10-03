/**
 * The `/usage` command's arguments, through the extension's own handler: `reset-day ollama
 * <1-31|clear>` writes usage-windows.json in any session, before the TUI check, and plain `/usage`
 * outside the TUI keeps its old answer. pi-tui is stubbed (it isn't installed beside pi-config).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { register } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// Before index.ts loads: the agent dir it writes to, and resolution for pi-tui and the
// extensionless "./fetch" that pi's own loader accepts.
const AGENT = fs.mkdtempSync(path.join(os.tmpdir(), "usage-status-index-"));
process.env.HOME = AGENT;
process.env.PI_CODING_AGENT_DIR = AGENT;
process.on("exit", () => fs.rmSync(AGENT, { recursive: true, force: true }));
const tui = "export const matchesKey = () => false; export const truncateToWidth = (s) => s; export const visibleWidth = (s) => s.length;";
const hooks = `
export async function resolve(specifier, context, next) {
	if (specifier === "@earendil-works/pi-tui") return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(tui)}), shortCircuit: true };
	if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context);
	return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

const { default: usageStatus } = await import("./index.ts");

function harness(mode: string) {
	const commands = new Map<string, any>();
	usageStatus({ registerCommand: (name: string, c: unknown) => commands.set(name, c), on: () => {} } as any);
	const notes: [string, string][] = [];
	const ctx = { mode, ui: { notify: (m: string, l: string) => notes.push([m, l]), custom: async () => assert.fail("opened the screen") } };
	return { usage: commands.get("usage"), ctx, notes };
}

const file = path.join(AGENT, "usage-windows.json");

test("/usage reset-day ollama <n|clear> writes the file in a session without the TUI", async () => {
	const { usage, ctx, notes } = harness("rpc");
	await usage.handler("reset-day ollama 14", ctx);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, ollama: { resetDay: 14 } });
	await usage.handler("reset-day ollama 0", ctx);
	await usage.handler("reset-day ollama clear", ctx);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1 });
	await usage.handler("nonsense", ctx);
	assert.deepEqual(notes, [
		["Ollama Cloud resets on day 14 of each month.", "info"],
		["Usage: /usage reset-day ollama <1-31|clear>", "warning"],
		["Ollama Cloud's reset day is cleared.", "info"],
		["Usage: /usage [reset-day ollama <1-31|clear>]", "warning"],
	]);
});

test("plain /usage outside the TUI still says it needs the TUI", async () => {
	const { usage, ctx, notes } = harness("rpc");
	await usage.handler("", ctx);
	assert.deepEqual(notes, [["The /usage screen requires Pi's interactive TUI.", "warning"]]);
});

test("/usage completes its arguments", () => {
	const { usage } = harness("tui");
	assert.deepEqual(usage.getArgumentCompletions("re")?.map((i: { value: string }) => i.value), ["reset-day ollama ", "reset-day ollama clear"]);
	assert.deepEqual(usage.getArgumentCompletions("reset-day ollama c")?.map((i: { value: string }) => i.value), ["reset-day ollama clear"]);
	assert.equal(usage.getArgumentCompletions("x"), null);
});
