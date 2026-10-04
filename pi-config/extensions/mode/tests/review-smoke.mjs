// Adversarial review behind the `adversarial-review` flag (§chat.alignment-review), driven through
// the real index.ts with a fake ExtensionAPI. No model requests.
// - Flag off is today, exactly: the align tool's declaration and the mode prompt equal master's
//   (tests/fixtures/flag-off-master.json, generated from master 043816d4 before this feature), no
//   /review command, no review op.
// - Flag on: the review form of the tool and /review register at session_start, the reviewer comes
//   from the chat's subagent profile, and the ops run end to end.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { jiti } from "../../subagents/tests/runtime.mjs";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "mode-review-smoke-"));
const here = (p) => pathToFileURL(path.resolve(new URL(p, import.meta.url).pathname)).href;
const modeExtension = (await jiti.import(here("../index.ts"))).default;
const { composePrompt, DEFAULT_ROUTES } = await jiti.import(here("../prompt.ts"));
const { REVIEW_FLAG } = await jiti.import(here("../index.ts"));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/flag-off-master.json", import.meta.url), "utf8"));

const declaration = (t) =>
	JSON.parse(JSON.stringify({ name: t.name, label: t.label, description: t.description, promptSnippet: t.promptSnippet, promptGuidelines: t.promptGuidelines, parameters: t.parameters, executionMode: t.executionMode }));

function makeHost(flags) {
	const hooks = new Map();
	const commands = new Map();
	const tools = new Map();
	const registrations = [];
	const userMessages = [];
	let active = ["read", "bash", "edit", "write", "grep"];
	const api = {
		events: { on: () => () => {}, emit() {} },
		on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
		registerFlag: (name, options) => api.flags.set(name, options),
		getFlag: (name) => flags[name] ?? api.flags.get(name)?.default,
		registerCommand: (name, options) => commands.set(name, options),
		registerShortcut() {},
		appendEntry() {},
		registerEntryRenderer() {},
		registerMessageRenderer() {},
		registerTool: (tool) => {
			tools.set(tool.name, tool);
			registrations.push(tool.name);
		},
		sendMessage() {},
		sendUserMessage: (text, options) => userMessages.push({ text, options }),
		getActiveTools: () => [...active],
		setActiveTools: (next) => (active = [...next]),
		getAllTools: () => [...tools.keys()].map((name) => ({ name })),
		flags: new Map(),
	};
	const store = { notices: [], branch: [] };
	const theme = { fg: (_t, s) => s, bold: (s) => s, bg: (_t, s) => s };
	const ctx = {
		hasUI: true,
		mode: "rpc",
		cwd: process.env.PI_CODING_AGENT_DIR,
		isIdle: () => true,
		sessionManager: { getBranch: () => store.branch, getEntries: () => store.branch, getSessionFile: () => "/tmp/review-smoke.jsonl", getSessionId: () => "s1" },
		ui: { setStatus() {}, notify: (message, level) => store.notices.push({ message, level }), setWidget() {}, custom: async () => undefined, theme },
	};
	modeExtension(api);
	const fire = async (name, event = {}) => {
		for (const h of hooks.get(name) ?? []) await h(event, ctx);
	};
	return { api, commands, tools, registrations, userMessages, store, ctx, fire };
}

// ── The fixture is master's own output: the flag-off prompt equals it ──────────────────────────
for (const [key, text] of Object.entries(fixture.prompt)) {
	const [mode, minors] = key.split("+");
	assert.equal(composePrompt({ mode, strict: false, minorModes: minors ? minors.split(",") : [] }, DEFAULT_ROUTES, null) ?? null, text, `mode prompt ${key} unchanged`);
}

// ── Flag off: today, exactly ────────────────────────────────────────────────────────────────────
{
	const off = makeHost({});
	assert.equal(off.api.flags.get(REVIEW_FLAG)?.type, "boolean");
	assert.equal(off.api.flags.get(REVIEW_FLAG)?.default, false);
	await off.fire("session_start", { reason: "startup" });
	assert.deepEqual(off.registrations.filter((n) => n === "align"), ["align"], "registered once, never re-registered");
	assert.deepEqual(declaration(off.tools.get("align")), fixture.tool, "align tool declaration byte-identical to master");
	assert.ok(!off.commands.has("review"), "/review not registered");
	await off.commands.get("mode").handler("align on", off.ctx);
	const created = await off.tools.get("align").execute("c1", { ops: [{ op: "create", title: "T", summary: "S." }] }, undefined, undefined, off.ctx);
	assert.equal(created.details.doc.review, undefined);
	await assert.rejects(
		off.tools.get("align").execute("c2", { ops: [{ op: "review", phase: "plan", state: "running", reason: "r" }] }, undefined, undefined, off.ctx),
		/ops\[0\]\.op must be one of create, import, add, edit, edit_question, edit_rejected, edit_doc, remove, decide, accept, accept_all, reopen, drop_question, drop_alignment, status, exempt, get\. Nothing was changed\./,
	);
}

// ── Flag on ─────────────────────────────────────────────────────────────────────────────────────
// The chat's profile names a reviewer; the seeding (phase 2) is not this test's business.
const agentDir = process.env.PI_CODING_AGENT_DIR;
const route = (model) => ({ primary: { backend: "pi", model: "fake/sol", effort: "high" }, fallback: { backend: "claude-code", model, effort: "high" } });
const profile = (id, reviewer) => ({
	id,
	name: id,
	delegate: Object.fromEntries(["planning", "investigation", "routine", "complex"].map((k) => [k, { primary: { backend: "claude-code", model: "opus[1m]", effort: "high" }, fallback: null }])),
	teams: null,
	members: null,
	specWriter: null,
	...(reviewer === undefined ? {} : { reviewer }),
});
writeFileSync(path.join(agentDir, "subagent-profiles.json"), JSON.stringify({ version: 1, profiles: [profile("with-reviewer", route("opus[1m]")), profile("none", null), profile("old", undefined)] }));
writeFileSync(path.join(agentDir, "subagent-profiles-default.json"), JSON.stringify({ version: 1, default: "with-reviewer" }));
{
	const on = makeHost({ [REVIEW_FLAG]: true });
	assert.deepEqual(declaration(on.tools.get("align")), fixture.tool, "before session_start the flag is not visible: the flag-off tool");
	await on.fire("session_start", { reason: "startup" });
	assert.deepEqual(on.registrations.filter((n) => n === "align"), ["align", "align"], "re-registered once with the review form");
	await on.fire("session_start", { reason: "new" });
	assert.equal(on.registrations.filter((n) => n === "align").length, 2, "and only once per process");
	const tool = on.tools.get("align");
	const ops = tool.parameters.properties.ops.items.anyOf.map((b) => b.properties.op.const);
	assert.deepEqual(ops.slice(-2), ["review", "close_blocker"]);
	assert.match(tool.description, /Adversarial review \(op review, at most once per phase per alignment\)/);
	assert.equal(tool.description.startsWith(fixture.tool.description), true, "the flag-off text is kept, the rules appended");
	assert.match(tool.promptGuidelines.at(-1), /^Adversarial review \(align review op\)/);
	assert.ok(on.commands.has("review"), "/review registered");

	// /review needs align on, then sends the card's message.
	await on.commands.get("review").handler("plan", on.ctx);
	assert.match(on.store.notices.at(-1).message, /needs the align minor mode on/);
	await on.commands.get("mode").handler("align on", on.ctx);
	await on.commands.get("review").handler("plan", on.ctx);
	assert.match(on.store.notices.at(-1).message, /No open alignment to review/);

	const exec = (params) => tool.execute("x", params, undefined, undefined, on.ctx);
	await exec({ ops: [{ op: "create", title: "Queue", summary: "Persist the queue.", approach: ["Write it to disk"] }] });
	await on.commands.get("review").handler("diff", on.ctx);
	assert.deepEqual(on.userMessages.at(-1), { text: "al_1: run the adversarial diff review now (align review, phase diff), whatever the rule says.", options: undefined });
	await on.commands.get("review").handler("bogus", on.ctx);
	assert.match(on.store.notices.at(-1).message, /^Usage: \/review plan\|diff \[al_N\]$/);

	// The reviewer is the profile's: primary unverified (never probed) is used, its fallback offered for a retry.
	const started = await exec({ ops: [{ op: "review", phase: "plan", state: "running", reason: "persistence format" }] });
	assert.equal(started.details.doc.review.plan.model, "pi · fake/sol · high");
	assert.match(started.content[0].text, /backend "pi", model "fake\/sol", effort "high", tools \["read","grep","find","ls"\]/);
	assert.match(started.content[0].text, /retry once with backend "claude-code", model "opus\[1m\]"/);
	await assert.rejects(exec({ ops: [{ op: "status", to: "implementing" }] }), /plan review is running/);
	await exec({ ops: [{ op: "add", findings: ["Review (plan, fake/sol): the reload path loses the tail"] }, { op: "review", phase: "plan", state: "clear", reason: "1 constraint added" }] });
	await assert.rejects(exec({ ops: [{ op: "review", phase: "plan", state: "running", reason: "again" }] }), /no second round/);
	await exec({ ops: [{ op: "status", to: "implementing" }] });
	await exec({ ops: [{ op: "review", phase: "diff", state: "running", reason: "persistence" }] });
	await exec({ ops: [{ op: "review", phase: "diff", state: "blocking", reason: "1 blocking", blockers: [{ title: "reload drops the tail", check: "node --test q.test.ts" }] }] });
	await assert.rejects(exec({ ops: [{ op: "status", to: "done" }] }), /1 open blocker \(diff b1\)/);
	const done = await exec({ ops: [{ op: "close_blocker", phase: "diff", id: "b1", by: "check", evidence: "node --test q.test.ts passes" }, { op: "status", to: "done" }] });
	assert.equal(done.details.doc.phase, "done");

	// A profile with Reviewer None, and an older profile without the key: no reviewer, the start is refused.
	for (const pick of ["none", "old"]) {
		writeFileSync(path.join(agentDir, "subagent-profiles-default.json"), JSON.stringify({ version: 1, default: pick }));
		await exec({ ops: [{ op: "create", title: `Other ${pick}`, summary: "S." }] });
		await assert.rejects(exec({ ops: [{ op: "review", phase: "plan", state: "running", reason: "r" }] }), /names no reviewer \(Reviewer: None\)/);
		await exec({ ops: [{ op: "drop_alignment", reason: "test" }] });
	}
	// Nothing was written to the profiles by any of this.
	assert.equal(JSON.parse(readFileSync(path.join(agentDir, "subagent-profiles.json"), "utf8")).profiles[2].reviewer, undefined);
}

console.log("mode review smoke tests passed");
