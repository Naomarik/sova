// cache-invariant.mjs — §chat.sandbox/states: changing a session's sandbox state, between any two of
// Off, Subagents only and On, never busts the main thread's prompt cache. A real pi runtime (the
// repo-pinned one Sova embeds) with the extension loaded and a scripted provider that records every
// request it is asked for; the state changes the way Sova changes it, through the /sandbox handler
// itself, never through prompt(). Every transition is checked against the request before it:
//   (a) the earlier request's messages are a byte-equal prefix of the next one's;
//   (b) no system message (a tool loadout or prompt section change) is appended between them;
//   (c) the tool declarations are equal, in the same order; (d) the system prompt is equal;
//   (e) the `sandbox` entries never reach the context.
// The same recorded contexts then go through the Claude Code provider's own request builder
// (streamClaudeCode) to a recording bridge, and the bridge's restart inputs are compared: its
// turn identity (turnMeta: model, effort, system prompt, tools, cwd) and the transcript prefix
// (transcriptFingerprint / isPrefix). Equal identity and a prefix is a turn the CLI carries on.
// A state change in the middle of a run (between two requests of one prompt) is checked too.
import "../../claude-code/tests/hermetic-env.mjs";
import { existsSync } from "node:fs";
import path from "node:path";
import { makeSuite, ok, eq } from "./kit.mjs";
import { EXT_ENTRY, EXT_DIR, cleanupAll, jiti, makeFixture, pi, stubUi } from "./harness.mjs";

const t = makeSuite("cache-invariant");

if (!existsSync(EXT_ENTRY)) {
	t.pending("CI1-CI4", "pi-config/extensions/sandbox/index.ts does not exist yet");
	t.done();
	process.exitCode = 0;
} else {
	const P = await pi();
	const { createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt, toToolDeclaration } = await jiti.import("@earendil-works/pi-ai");
	const CC = path.resolve(EXT_DIR, "../claude-code/provider");
	const { streamClaudeCode } = await jiti.import(path.join(CC, "stream.ts"));
	const { turnMeta, transcriptFingerprint, isPrefix } = await jiti.import(path.join(CC, "session-bridge.ts"));

	const fx = makeFixture({ agentInsideCwd: false });
	/** Every request the scripted provider was asked for: the model, and the context as sent. */
	const requests = [];
	/** What the provider answers next; `during` runs while that request is in flight (a mid-run change). */
	const steps = [];
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const streamSimple = (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		requests.push({ model, context: JSON.parse(JSON.stringify(context)) });
		const step = steps.shift() ?? { text: "ok" };
		const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage, stopReason: step.command ? "toolUse" : "stop", timestamp: Date.now() };
		(async () => {
			if (step.during) await step.during();
			options?.onPayload?.({});
			stream.push({ type: "start", partial: message });
			if (step.command) {
				message.content.push({ type: "toolCall", id: `c${requests.length}`, name: "bash", arguments: { command: step.command } });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
			} else {
				message.content.push({ type: "text", text: step.text });
				stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: message });
			}
			stream.push({ type: "done", reason: message.stopReason, message });
		})();
		return stream;
	};
	const provider = (p) =>
		p.registerProvider("scripted", {
			baseUrl: "http://localhost",
			apiKey: "unused",
			api: "openai-completions",
			models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
			streamSimple,
		});
	process.env.PI_CODING_AGENT_DIR = fx.agentDir;
	const loader = new P.DefaultResourceLoader({ cwd: fx.cwd, agentDir: fx.agentDir, noExtensions: true, additionalExtensionPaths: [EXT_ENTRY], extensionFactories: [provider] });
	await loader.reload();
	const manager = P.SessionManager.inMemory(fx.cwd);
	const { session } = await P.createAgentSession({ cwd: fx.cwd, agentDir: fx.agentDir, resourceLoader: loader, settingsManager: P.SettingsManager.inMemory(), sessionManager: manager });
	const errors = [];
	await session.bindExtensions({ uiContext: stubUi([]), mode: "rpc", onError: (e) => errors.push(`${e.extensionPath}: ${e.error}`) });
	await session.setModel(session.modelRuntime.getModel("scripted", "fixture"));
	/** As Sova's POST /api/sandbox does: the extension's own handler, never a prompt. */
	const setState = async (state) => {
		const runner = session._extensionRunner;
		await runner.getCommand("sandbox").handler(state, runner.createCommandContext());
	};
	const sandboxEntries = () => manager.getBranch().filter((e) => e.type === "custom" && e.customType === "sandbox");
	const stateNow = () => {
		const d = sandboxEntries().at(-1)?.data;
		return !d ? "subagents" : d.on ? "on" : d.workers === "off" ? "off" : "subagents";
	};

	/** One turn: a bash call (which runs under the state of the moment), then a reply. */
	const turn = async (label) => {
		const before = requests.length;
		steps.push({ command: `echo ${label}` }, { text: `done ${label}` });
		await session.prompt(`turn ${label}`);
		eq(requests.length, before + 2, `turn ${label}: two requests, no corrective continuation`);
		return { first: before, last: before + 1 };
	};

	// pi 0.87 sends the loadout as system messages in the transcript, so the tools and the prompt a
	// provider sends are the replay of those (pi-ai's own helpers), not `context.tools`.
	const toolList = (r) => [...(r.context.tools ?? []), ...getCurrentTools(r.context.messages)];
	const tools = (r) => JSON.stringify(toolList(r).map(toToolDeclaration));
	const prompt = (r) => `${r.context.systemPrompt ?? ""}\u0000${getCurrentSystemPrompt(r.context.messages)}`;
	const systemMessages = (msgs) => msgs.filter((m) => m.role === "system");
	/** (a)-(d) between request i (before a change) and request j (after it). */
	function samePrefix(i, j, what) {
		const a = requests[i].context;
		const b = requests[j].context;
		ok(b.messages.length > a.messages.length, `${what}: the later request has more messages`);
		eq(JSON.stringify(b.messages.slice(0, a.messages.length)), JSON.stringify(a.messages), `${what}: (a) earlier messages are a byte-equal prefix`);
		const added = b.messages.slice(a.messages.length);
		eq(systemMessages(added).length, 0, `${what}: (b) no system message appended (${JSON.stringify(systemMessages(added).map((m) => m.toolsAdded ?? m.toolsRemoved ?? m.sections ?? "?"))})`);
		eq(tools(requests[j]), tools(requests[i]), `${what}: (c) tool declarations equal, same order`);
		eq(prompt(requests[j]), prompt(requests[i]), `${what}: (d) system prompt equal`);
	}

	/** The Claude Code provider's request for a recorded context: what the bridge plans from. */
	async function claudeRequest(r) {
		let got;
		const bridge = {
			async *runTurn(request) {
				got = request;
				yield { type: "result", outcome: "success" };
			},
		};
		const model = { ...r.model, id: "opus", provider: "claude-code-cli" };
		const stream = streamClaudeCode(bridge, model, r.context, undefined);
		for await (const _ of stream) { /* drain */ }
		ok(got, "the provider handed the bridge a request");
		return got;
	}
	async function claudeCarriesOn(i, j, what) {
		const a = await claudeRequest(requests[i]);
		const b = await claudeRequest(requests[j]);
		eq(turnMeta(b, fx.cwd), turnMeta(a, fx.cwd), `${what}: Claude Code turn identity unchanged (no CLI restart)`);
		eq(isPrefix(transcriptFingerprint(a.messages), transcriptFingerprint(b.messages)), true, `${what}: Claude Code transcript is a prefix (no fold)`);
	}

	const turns = [];
	await t.test("CI0 the runtime is up, Subagents only by default, and the provider sees requests", async () => {
		eq(errors.length, 0, errors.join(" | "));
		ok(session._extensionRunner.getCommand("sandbox"), "the sandbox command is loaded");
		turns.push({ state: stateNow(), ...(await turn("0")) });
		eq(turns[0].state, "subagents");
		// What the equalities below compare is really there, so they cannot pass on two empty sides.
		const first = requests[turns[0].first];
		const names = toolList(first).map((x) => x.name);
		for (const n of ["read", "bash", "edit", "write"]) ok(names.includes(n), `the request declares ${n} (${names.join(",")})`);
		ok(prompt(first).length > 100, "the request carries a system prompt");
		const cc = await claudeRequest(requests[turns[0].first]);
		ok(cc.tools.length >= 4 && (cc.systemPrompt ?? "").length > 0, `the Claude request carries tools (${cc.tools.length}) and a system prompt`);
	});

	// Every transition between the three states: Sub→On→Off→Sub→Off→On→Sub.
	const path6 = ["on", "off", "subagents", "off", "on", "subagents"];
	await t.test("CI1 each of the six transitions keeps the cache prefix, the tools and the prompt", async () => {
		for (const state of path6) {
			const from = turns.at(-1);
			await setState(state);
			eq(stateNow(), state, `the session reports ${state}`);
			const now = await turn(state);
			turns.push({ state, ...now });
			samePrefix(from.last, now.first, `${from.state} → ${state}`);
		}
	});

	await t.test("CI2 the same transitions, through the Claude Code provider: the CLI carries on", async () => {
		for (let k = 1; k < turns.length; k++) await claudeCarriesOn(turns[k - 1].last, turns[k].first, `${turns[k - 1].state} → ${turns[k].state}`);
	});

	await t.test("CI3 a change in the middle of a run reaches the next request of that run without a system message", async () => {
		for (const state of ["on", "off", "subagents"]) {
			const before = requests.length;
			steps.push({ command: "echo mid", during: () => setState(state) }, { text: "mid done" });
			await session.prompt(`mid ${state}`);
			eq(requests.length, before + 2);
			eq(stateNow(), state, `changed to ${state} mid-run`);
			samePrefix(before, before + 1, `mid-run → ${state}`);
			await claudeCarriesOn(before, before + 1, `mid-run → ${state}`);
		}
	});

	await t.test("CI4 the sandbox entries were written and never reached a request", async () => {
		ok(sandboxEntries().length >= path6.length, `one entry per change (${sandboxEntries().length})`);
		for (const [i, r] of requests.entries()) {
			const text = JSON.stringify(r.context);
			ok(!/"customType":"sandbox"/.test(text), `request ${i}: no sandbox entry in the context`);
			ok(!/Sandbox (on|off|subagents only)/.test(text), `request ${i}: no sandbox status line in the context`);
		}
	});

	session.dispose();
	cleanupAll();
	t.done();
	if (process.exitCode !== 1) process.exitCode = 0;
}
