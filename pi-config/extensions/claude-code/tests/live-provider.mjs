// Opt-in live test: one real Claude Code turn driven through pi as a provider.
//
// This is the end-to-end claim the unit tests cannot make. It runs a headless
// pi session against a fresh temp agent dir and cwd, selects claude-code-cli/sonnet,
// and asks the model to use PI'S OWN `read` tool. Everything the model can
// reach is served by the in-process MCP facade, so a successful tool call
// proves the whole path: initialize.sdkMcpServers -> tools/list -> a held
// tools/call -> pi executing the tool -> the result resuming the same CLI turn.
//
// It also proves the CLI child is one process per pi session and that
// session_shutdown takes it away, by looking for the derived --session-id in
// /proc rather than trusting the bridge's own bookkeeping.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jiti } from "../../subagents/tests/runtime.mjs";

if (!process.argv.includes("--live")) throw Error("Pass --live to authorize real Claude requests.");

const EXTENSION_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));
const AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-claude-live-agent-"));
const CWD = mkdtempSync(path.join(tmpdir(), "pi-claude-live-"));
const PI_SESSION_TOOL = "read";
// The test writes its own fixture and holds the expected line itself, so the
// assertion never depends on reading back the file the model is asked to read.
const EXPECTED = "Red baseline: 4d7a1c";
mkdirSync(path.join(CWD, "notes"));
const TARGET = path.join(CWD, "notes/baseline-red.md");
writeFileSync(TARGET, `${EXPECTED}\nsecond line, not the answer\n`);

const pi = await jiti.import("@earendil-works/pi-coding-agent");
const { claudeSessionId, getSessionBridge } = await jiti.import(new URL("../provider/session-bridge.ts", import.meta.url).pathname);
const { CLAUDE_PROVIDER_FLAG, CLAUDE_PROVIDER_ID } = await jiti.import(new URL("../provider/index.ts", import.meta.url).pathname);

/** Claude CLI processes whose argv carries this exact --session-id. */
function claudeProcesses(sessionId) {
	const found = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		let argv;
		try {
			argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
		} catch {
			continue; // The process went away between readdir and read.
		}
		if (argv.includes(sessionId)) found.push({ pid: Number(entry), argv: argv.filter(Boolean) });
	}
	return found;
}

const started = Date.now();
const timings = {};
const mark = (name) => { timings[name] = Date.now() - started; };

// Only the extension under test is loaded. Auto-discovery would also start the
// other extensions in the agent dir, and some of them (sessions) keep
// background timers that touch a stale ctx after dispose and crash the harness
// for reasons that have nothing to do with the provider.
const resourceLoaderOptions = {
	noExtensions: true,
	additionalExtensionPaths: [EXTENSION_ENTRY],
};

// The real host path, and the one Sova uses: AgentSessionRuntime is what
// emits session_shutdown. Plain session.dispose() does NOT emit it (verified
// against 0.86.1; chat-manager.ts says the same), so a test built on dispose()
// alone would "prove" a cleanup that never ran.
const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await pi.createAgentSessionServices({
		cwd,
		agentDir: AGENT_DIR,
		extensionFlagValues: new Map([[CLAUDE_PROVIDER_FLAG, true]]),
		resourceLoaderOptions,
	});
	return {
		...(await pi.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: ["read", "bash"] })),
		services,
		diagnostics: services.diagnostics,
	};
};

const runtime = await pi.createAgentSessionRuntime(createRuntime, {
	cwd: CWD,
	agentDir: AGENT_DIR,
	sessionManager: pi.SessionManager.inMemory(),
});
mark("services");
for (const diagnostic of runtime.diagnostics ?? []) {
	if (diagnostic.type === "error") console.error(`[diagnostic:error] ${diagnostic.message}`);
}

const session = runtime.session;
// The provider registers from session_start, and session_start is emitted by
// AgentSession.bindExtensions -- NOT by creating the session. Without the bind
// the extension factory runs and registers nothing at all.
await session.bindExtensions({
	mode: "rpc",
	onError: (err) => console.error(`[extension:${err.extensionPath}] ${err.error}`),
});
mark("session");

const model = runtime.services.modelRuntime.getModel(CLAUDE_PROVIDER_ID, "sonnet");
assert.ok(model, `claude-code-cli/sonnet was not registered; is the ${CLAUDE_PROVIDER_FLAG} flag reaching the extension?`);
await session.setModel(model);
console.log(`model: ${model.provider}/${model.id} (${model.name})`);

const sessionId = session.sessionManager?.getSessionId?.() ?? undefined;
assert.ok(sessionId, "the headless session has no id, so the bridge cannot key its child");
const cliSessionId = claudeSessionId(sessionId);
console.log(`pi session ${sessionId} -> CLI --session-id ${cliSessionId}`);
assert.equal(claudeProcesses(cliSessionId).length, 0, "a CLI child existed before the turn started");

const events = [];
const toolCalls = [];
let assistantText = "";
const unsubscribe = session.subscribe((event) => {
	events.push(event.type);
	if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
		assistantText += event.assistantMessageEvent.delta;
	}
	if (event.type === "tool_execution_start") toolCalls.push({ phase: "start", name: event.toolName });
	if (event.type === "tool_execution_end") toolCalls.push({ phase: "end", name: event.toolName, isError: event.isError });
	if (event.type === "message_end" && event.message?.role === "assistant") {
		for (const block of event.message.content ?? []) {
			if (block.type === "toolCall") toolCalls.push({ phase: "requested", name: block.name, id: block.id });
			if (block.type === "text" && !assistantText) assistantText += block.text;
		}
	}
});

let childrenDuringTurn = 0;
const watch = setInterval(() => {
	childrenDuringTurn = Math.max(childrenDuringTurn, claudeProcesses(cliSessionId).length);
}, 100);

try {
	await session.prompt(`Use the ${PI_SESSION_TOOL} tool to read ${TARGET} and reply with its first line verbatim. Do not use any other tool.`);
	mark("prompt");
} finally {
	clearInterval(watch);
	unsubscribe?.();
}

console.log(`\n--- event summary (${events.length} events) ---`);
const counts = events.reduce((acc, type) => ({ ...acc, [type]: (acc[type] ?? 0) + 1 }), {});
for (const [type, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${type}`);
console.log("--- tool calls ---");
for (const call of toolCalls) console.log(`  ${call.phase.padEnd(10)} ${call.name}${call.isError ? " (error)" : ""}`);
console.log(`--- assistant text ---\n${assistantText.trim()}`);
console.log(`--- timings (ms from start) ---\n  ${JSON.stringify(timings)}`);
console.log(`--- CLI children ---\n  peak during turn: ${childrenDuringTurn}`);

// 1. pi — not the CLI — executed the tool.
const executed = toolCalls.filter((c) => c.phase === "end");
assert.ok(executed.length > 0, "pi never executed a tool; the MCP facade did not reach it");
assert.ok(
	executed.some((c) => c.name === PI_SESSION_TOOL),
	`expected pi to execute "${PI_SESSION_TOOL}", saw ${JSON.stringify(executed.map((c) => c.name))}`,
);
// The model must see pi's tool through the facade, never a CLI built-in.
assert.ok(
	toolCalls.every((c) => !/^(Read|Bash|Edit|Write|Glob|Grep)$/.test(c.name)),
	`a Claude built-in tool ran: ${JSON.stringify(toolCalls.map((c) => c.name))}`,
);

// 2. One CLI child, and the bridge agrees it owns exactly this session.
assert.equal(childrenDuringTurn, 1, `expected exactly one CLI child during the turn, saw ${childrenDuringTurn}`);
const bridge = getSessionBridge();
assert.deepEqual(bridge.activeSessionIds(), [sessionId], "the bridge registry does not hold exactly this pi session");

// 3. The answer came back through the resumed CLI turn.
// Derived from EXPECTED, never re-spelled: a hand-written fragment here would keep
// passing after the fixture line changes, and would test a different string than the one
// the test wrote.
assert.ok(assistantText.includes(EXPECTED), `assistant text did not contain the fixture's first line (${JSON.stringify(EXPECTED)})`);

// 4. session_shutdown takes the child away. runtime.dispose() emits the hook
// and then disposes the session, exactly as Sova's chat manager does.
await runtime.dispose();
const deadline = Date.now() + 15000;
while (claudeProcesses(cliSessionId).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
mark("shutdown");
const leftover = claudeProcesses(cliSessionId);
assert.equal(leftover.length, 0, `a CLI child outlived session_shutdown: ${JSON.stringify(leftover)}`);
assert.deepEqual(getSessionBridge().activeSessionIds(), [], "the bridge registry still holds the session after shutdown");

console.log(`\nPASS: pi executed its own "${PI_SESSION_TOOL}" tool through the Claude Code provider; one CLI child, gone after shutdown.`);
console.log(`timings: ${JSON.stringify(timings)}`);
