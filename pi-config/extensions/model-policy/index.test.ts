import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import modelPolicy from "./index.ts";

type Handler = (event: any, ctx: any) => Promise<any>;
interface Rig {
	fire(event: string, payload?: Record<string, unknown>): Promise<any>;
	ctx: any;
	notes: { text: string; level: string }[];
	status: (string | undefined)[];
	setModelCalls: string[];
	setModelResult: boolean;
	aborts: () => number;
	file: string;
	write(policy: Record<string, unknown>): void;
	cleanup(): void;
}

/** A fake pi + ExtensionContext: only the surface this extension touches. */
function rig(model: string | null = "zai/glm-5.3"): Rig {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-policy-ext-"));
	const file = path.join(dir, "model-policy.json");
	const handlers = new Map<string, Handler>();
	let writes = 0;
	const notes: { text: string; level: string }[] = [];
	const status: (string | undefined)[] = [];
	const setModelCalls: string[] = [];
	let aborts = 0;
	const asModel = (ref: string | null) =>
		ref ? { provider: ref.slice(0, ref.indexOf("/")), id: ref.slice(ref.indexOf("/") + 1) } : undefined;
	const state = { model: asModel(model) };
	const self: Rig = {
		file,
		notes,
		status,
		setModelCalls,
		setModelResult: true,
		aborts: () => aborts,
		ctx: {
			get model() {
				return state.model;
			},
			ui: {
				notify: (text: string, level: string) => notes.push({ text, level }),
				setStatus: (_key: string, text: string | undefined) => status.push(text),
			},
			abort: () => { aborts++; },
		},
		fire: async (event, payload = {}) => handlers.get(event)?.({ type: event, ...payload }, self.ctx),
		write: (policy) => {
			fs.writeFileSync(file, JSON.stringify(policy));
			const future = new Date(Date.now() + 5000 * ++writes); // beat the mtime cache within one test
			fs.utimesSync(file, future, future);
		},
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		setModel: async (m: { provider: string; id: string }) => {
			setModelCalls.push(`${m.provider}/${m.id}`);
			if (self.setModelResult) state.model = m;
			return self.setModelResult;
		},
	};
	modelPolicy(pi as never, { policyFile: file });
	return self;
}

test("an allowed model is never in the way: no refusal, no notice, no status", async (t) => {
	const r = rig("zai/glm-5.3");
	t.after(r.cleanup);
	r.write({ version: 1, disabledProviders: ["anthropic"], subagentDisabledProviders: [] });
	await r.fire("session_start");
	assert.deepEqual(r.notes, []);
	assert.equal(await r.fire("input", { text: "hello" }), undefined);
});

test("picking a disabled model puts the previous one back and says why", async (t) => {
	const r = rig("zai/glm-5.3");
	t.after(r.cleanup);
	r.write({ version: 1, disabledProviders: ["anthropic"], subagentDisabledProviders: [] });
	await r.fire("model_select", {
		model: { provider: "anthropic", id: "claude-sonnet-5" },
		previousModel: { provider: "zai", id: "glm-5.3" },
		source: "set",
	});
	assert.deepEqual(r.setModelCalls, ["zai/glm-5.3"]);
	assert.match(r.notes.at(-1)!.text, /Provider anthropic is turned off.*Staying on zai\/glm-5\.3/s);
	assert.equal(r.notes.at(-1)!.level, "error");
	// Back on an allowed model, the session runs.
	assert.equal(await r.fire("input", { text: "hello" }), undefined);
});

test("no allowed model to fall back to: nothing is chosen for you, and the turn is refused", async (t) => {
	const r = rig("anthropic/claude-sonnet-5");
	t.after(r.cleanup);
	r.write({ version: 1, disabledProviders: ["anthropic"], subagentDisabledProviders: [] });
	await r.fire("model_select", {
		model: { provider: "anthropic", id: "claude-sonnet-5" },
		previousModel: { provider: "anthropic", id: "claude-opus-5" },
		source: "set",
	});
	assert.deepEqual(r.setModelCalls, []); // the previous model is disabled too
	assert.match(r.notes.at(-1)!.text, /won't send until you switch/);
	const refused = await r.fire("input", { text: "hello" });
	assert.deepEqual(refused, { action: "handled" });
	assert.match(r.notes.at(-1)!.text, /wasn't sent/);
	assert.equal(r.status.at(-1), "model off");
});

test("a resumed session keeps its model and refuses the next turn", async (t) => {
	const r = rig("zai/glm-5.3");
	t.after(r.cleanup);
	r.write({ version: 1, disabledProviders: ["zai"], subagentDisabledProviders: [] });
	await r.fire("model_select", {
		model: { provider: "zai", id: "glm-5.3" },
		previousModel: undefined,
		source: "restore",
	});
	assert.deepEqual(r.setModelCalls, []); // a restore is history replaying, not a choice
	assert.deepEqual(await r.fire("input", { text: "write the code" }), { action: "handled" });
	assert.match(r.notes.at(-1)!.text, /Switch with \/model/);
});

test("slash input that expands into a prompt is refused too, however it is spelled", async (t) => {
	const r = rig("zai/glm-5.3");
	t.after(r.cleanup);
	r.write({ version: 1, disabledModels: ["zai/glm-5.3"], subagentDisabledProviders: [] });
	// Pi's own commands (/model, /new, /compact) return inside interactive-mode's onSubmit, and
	// extension commands are dispatched in prompt() before this hook — so everything that reaches
	// it is on its way to the model, and a skill or template would run on the disabled model.
	for (const text of ["/skill:review the diff", "/plan ship it", "/model-ish", "write the code", "  "]) {
		assert.deepEqual(await r.fire("input", { text }), { action: "handled" }, text);
	}
	// Including messages an extension sent as user input (sendUserMessage → prompt → input).
	assert.deepEqual(await r.fire("input", { text: "go on", source: "extension" }), { action: "handled" });
	assert.deepEqual(await r.fire("input", { text: "go on", source: "rpc" }), { action: "handled" });
});

test("a turn that never passed through input is stopped at the last boundary before the request", async (t) => {
	const r = rig("zai/glm-5.3");
	t.after(r.cleanup);
	r.write({ version: 1, disabledProviders: ["zai"], subagentDisabledProviders: [] });
	// What pi.sendMessage({triggerTurn:true}), a turn_end continuation and a retry all look like:
	// no input event, straight into the run. `context` runs immediately before the request is
	// admitted, and ctx.abort() closes the gate the request would have to pass.
	await r.fire("agent_start");
	assert.equal(await r.fire("context", { messages: [] }), undefined); // messages untouched
	assert.equal(r.aborts(), 1);
	assert.match(r.notes.at(-1)!.text, /turn was stopped before anything was sent/);
	// Per provider request, but said once per run: a stopped turn shouldn't repeat itself.
	await r.fire("context", { messages: [] });
	assert.equal(r.aborts(), 2);
	assert.equal(r.notes.filter((n) => /stopped before anything was sent/.test(n.text)).length, 1);
	// A new run says it again, because it is news again.
	await r.fire("agent_start");
	await r.fire("context", { messages: [] });
	assert.equal(r.notes.filter((n) => /stopped before anything was sent/.test(n.text)).length, 2);
});

test("an allowed model's turns are never touched at the request boundary", async (t) => {
	const r = rig("zai/glm-5.3");
	t.after(r.cleanup);
	r.write({ version: 1, disabledProviders: ["anthropic"], subagentDisabledProviders: [] });
	await r.fire("agent_start");
	assert.equal(await r.fire("context", { messages: [] }), undefined);
	assert.equal(r.aborts(), 0);
	assert.deepEqual(r.notes, []);
	assert.equal(await r.fire("cache_warming_decision", { action: "warm" }), undefined);
});

test("tree navigation keeps working, with no request: we hand pi the summary instead", async (t) => {
	const r = rig("zai/glm-5.3");
	t.after(r.cleanup);
	r.write({ version: 1, disabledProviders: ["zai"], subagentDisabledProviders: [] });
	const result = await r.fire("session_before_tree", { preparation: {} });
	assert.equal(result.cancel, undefined, "moving between branches is not a model call: never blocked");
	assert.match(result.summary.summary, /Branch summary skipped/);
	assert.match(r.notes.at(-1)!.text, /wasn't summarized/);
	// An allowed model gets pi's own summarizer, untouched.
	r.write({ version: 1, disabledProviders: [], subagentDisabledProviders: [] });
	assert.equal(await r.fire("session_before_tree", { preparation: {} }), undefined);
});

test("compaction and cache warming are calls to the same model, and stop with it", async (t) => {
	const r = rig("zai/glm-5.3");
	t.after(r.cleanup);
	r.write({ version: 1, disabledProviders: ["zai"], subagentDisabledProviders: [] });
	// Compaction runs before before_agent_start on the prompt path: the one request that could
	// still reach a disabled model.
	assert.deepEqual(await r.fire("session_before_compact", { reason: "threshold" }), { cancel: true });
	assert.match(r.notes.at(-1)!.text, /Compaction was cancelled/);
	// Warming re-sends a prefix captured while the model was still allowed.
	assert.deepEqual(await r.fire("cache_warming_decision", { action: "warm" }), { action: "stop" });
});

test("the policy is re-read per check: a model disabled mid-session blocks the next turn", async (t) => {
	const r = rig("zai/glm-5.3");
	t.after(r.cleanup);
	r.write({ version: 1, disabledProviders: [], subagentDisabledProviders: [] });
	assert.equal(await r.fire("input", { text: "hello" }), undefined);
	r.write({ version: 1, disabledModels: ["zai/glm-5.3"], subagentDisabledProviders: [] });
	assert.deepEqual(await r.fire("input", { text: "hello" }), { action: "handled" });
	assert.match(r.notes.at(-1)!.text, /^zai\/glm-5\.3 is turned off/);
});

test("a session with no model yet is not refused: pi will ask for one", async (t) => {
	const r = rig(null);
	t.after(r.cleanup);
	r.write({ version: 1, disabledProviders: ["zai"], subagentDisabledProviders: [] });
	await r.fire("session_start");
	assert.deepEqual(r.notes, []);
	assert.equal(await r.fire("input", { text: "hello" }), undefined);
});
