// Run through tests/run.mjs (pi imports resolve from the installed package).
import assert from "node:assert/strict";
import test from "node:test";
import link, { FLAG, SECTION } from "./index.ts";
import { NOT_HOSTED, NOT_LINKED } from "./client.ts";

const ORIGIN = "http://127.0.0.1:4810";

type Answer = { status?: number; body?: unknown } | Error;

/** Just enough of ExtensionAPI: flags, tools, handlers. The host is a queue of answers. */
function rig(flag: string | undefined, ...answers: Answer[]) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, (e: any, ctx: any) => unknown>();
	const calls: { url: string; method: string; body?: any }[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ url, method: init.method ?? "GET", ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
		const a = answers.shift() ?? { body: {} };
		if (a instanceof Error) throw a;
		return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
	}) as unknown as typeof fetch;
	const pi = {
		registerFlag: () => {},
		getFlag: (name: string) => (name === FLAG ? flag : undefined),
		registerTool: (t: any) => tools.set(t.name, t),
		on: (event: string, h: any) => handlers.set(event, h),
	};
	link(pi as any, { fetch: fetchImpl });
	const ctx = { sessionManager: { getSessionId: () => "s-me" } };
	return {
		tools,
		calls,
		answers,
		run: async (name: string, params: Record<string, unknown> = {}) => {
			const r = await tools.get(name).execute("c1", params, undefined, undefined, ctx);
			return r.content[0].text as string;
		},
		start: async () => {
			const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
			await handlers.get("before_agent_start")!(event, ctx);
			return event.systemPromptOptions.sections[SECTION];
		},
	};
}

const linked = (id = "lk_a", endedAt?: number, title = "Fix it") => ({
	body: {
		links: [
			{
				link: { id, createdAt: 0, createdBy: "n-self", ...(endedAt ? { endedAt } : {}) },
				members: [
					{ nodeId: "n-self", sessionId: "s-me", path: "/m", self: true, hostLabel: "here", reach: "self", state: "working" },
					{ nodeId: "n-b", sessionId: "s-b", path: "/b", self: false, hostLabel: "box", reach: "up", state: "idle", title },
				],
			},
		],
	},
});

const shape = (tools: Map<string, any>) => [...tools.values()].map((t) => [t.name, JSON.stringify(t.parameters)]);

test("the same three tools, with the same schema, with or without the flag", () => {
	const hosted = rig(ORIGIN);
	const tui = rig(undefined);
	assert.deepEqual([...hosted.tools.keys()], ["link_members", "link_send", "link_inbox"]);
	assert.deepEqual(shape(hosted.tools), shape(tui.tools));
});

test("without the flag (a TUI, a worker) everything is inert", async () => {
	const r = rig(undefined);
	for (const name of ["link_members", "link_inbox"]) assert.equal(await r.run(name), NOT_HOSTED);
	assert.equal(await r.run("link_send", { text: "hi" }), NOT_HOSTED);
	assert.equal(await r.start(), undefined);
	assert.equal(r.calls.length, 0);
});

test("an unlinked session: no section, and every tool refuses with a sentence", async () => {
	const r = rig(ORIGIN, { body: { links: [] } }, { body: { links: [] } }, { body: { records: [] } }, { body: { links: [] } });
	assert.equal(await r.start(), undefined);
	assert.equal(await r.run("link_members"), NOT_LINKED);
	assert.equal(await r.run("link_inbox"), NOT_LINKED);
	r.answers.push({ status: 409, body: { error: "s-me is in no live link.", reason: "not-member" } });
	assert.equal(await r.run("link_send", { text: "hi" }), `${NOT_LINKED} (s-me is in no live link.)`);
	assert.equal(r.calls.at(-1)!.url, `${ORIGIN}/api/mesh/links/send`);
});

test("the section follows membership, and survives a run start the host can't answer", async () => {
	const r = rig(ORIGIN, linked(), new TypeError("fetch failed"), linked("lk_a", undefined, "Renamed"), linked("lk_a", 9), { status: 404, body: {} });
	const first = await r.start();
	assert.ok(first && first.includes("lk_a") && first.includes('"Fix it" (box/s-b)'));
	assert.equal(await r.start(), first, "no answer keeps the section: no CLI restart");
	assert.equal(await r.start(), first, "a partner's retitle keeps it too: same live links");
	assert.equal(await r.start(), undefined, "the link ended");
	assert.equal(await r.start(), undefined, "a host with no link routes");
	assert.ok(r.calls.every((c) => c.url === `${ORIGIN}/api/mesh/links?session=s-me&brief=1`));
});

test("link_send passes to, link and text, and names recipients from the last view", async () => {
	const r = rig(ORIGIN, linked(), {
		body: { linkId: "lk_a", messageId: "lm_1", deliveries: [{ to: { nodeId: "n-b", sessionId: "s-b" }, state: "delivered" }] },
	});
	await r.start();
	const out = await r.run("link_send", { text: "done?", to: ["box"], link: "lk_a" });
	assert.deepEqual(r.calls[1]!.body, { session: "s-me", text: "done?", to: ["box"], link: "lk_a" });
	assert.match(out, /- box\/s-b: will see it at its next step/);
	assert.equal(await r.run("link_send", { text: "  " }), "Nothing to send: the text is empty.");
	assert.equal(r.calls.length, 2);
});

test("a delivery refusal from the host is shown as is", async () => {
	const r = rig(ORIGIN, { status: 400, body: { error: "No partner matches \"x\".", reason: "not-member-name" } });
	assert.equal(await r.run("link_send", { text: "t", to: "x" }), 'No partner matches "x".');
});
