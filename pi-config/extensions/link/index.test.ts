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

const TOOLS = ["link_members", "link_send", "link_inbox", "link_offer", "link_accept", "link_decline", "link_offers"];
const OF = "of_0123456789abcdef";

test("the same seven tools, with the same schema, with or without the flag", () => {
	const hosted = rig(ORIGIN);
	const tui = rig(undefined);
	assert.deepEqual([...hosted.tools.keys()], TOOLS);
	assert.deepEqual(shape(hosted.tools), shape(tui.tools));
});

test("without the flag (a TUI, a worker) everything is inert", async () => {
	const r = rig(undefined);
	for (const name of ["link_members", "link_inbox", "link_offers"]) assert.equal(await r.run(name), NOT_HOSTED);
	assert.equal(await r.run("link_send", { text: "hi" }), NOT_HOSTED);
	assert.equal(await r.run("link_offer", { paths: ["a"], dest: "/in" }), NOT_HOSTED);
	assert.equal(await r.run("link_accept", { offer: OF, dest: "/in" }), NOT_HOSTED);
	assert.equal(await r.run("link_decline", { offer: OF }), NOT_HOSTED);
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

const offerBody = (state: string, over: Record<string, unknown> = {}) => ({
	id: OF,
	linkId: "lk_a",
	at: 0,
	expiresAt: 86_400_000,
	from: { nodeId: "n-b", sessionId: "s-b" },
	roots: [{ name: "proj", kind: "dir", files: 3, bytes: 2048 }],
	files: 3,
	bytes: 2048,
	recipients: [{ to: { nodeId: "n-self", sessionId: "s-me" }, state, dest: "in", resolvedDest: "/w/in" }],
	...over,
});

test("the file tools refuse in an unlinked session, like the others", async () => {
	const r = rig(ORIGIN, { status: 409, body: { error: "s-me is in no live link.", reason: "not-member" } }, { body: { offers: [] } }, { body: { links: [] } });
	assert.equal(await r.run("link_offer", { paths: ["a"] }), `${NOT_LINKED} (s-me is in no live link.)`);
	assert.equal(await r.run("link_offers"), NOT_LINKED);
	assert.deepEqual(
		r.calls.map((c) => c.url),
		[`${ORIGIN}/api/mesh/links/offers`, `${ORIGIN}/api/mesh/links/offers?session=s-me`, `${ORIGIN}/api/mesh/links?session=s-me&brief=1`],
	);
});

test("link_offer sends paths, to, dest, exclude, note and link, and reports each partner's answer", async () => {
	const r = rig(ORIGIN, linked(), {
		body: {
			offer: { ...offerBody("accepted"), from: { nodeId: "n-self", sessionId: "s-me" }, recipients: [{ to: { nodeId: "n-b", sessionId: "s-b" }, state: "accepted" }] },
			deliveries: [{ to: { nodeId: "n-b", sessionId: "s-b" }, state: "accepted", resolvedDest: "/root/in" }],
		},
	});
	await r.start();
	const out = await r.run("link_offer", { paths: ["proj", " "], to: "box", dest: "~/in", exclude: ["node_modules"], note: " the repo ", link: "lk_a" });
	assert.deepEqual(r.calls[1]!.body, { session: "s-me", paths: ["proj"], to: "box", dest: "~/in", exclude: ["node_modules"], note: "the repo", link: "lk_a" });
	assert.match(out, /^Offered of_0123456789abcdef on lk_a: proj\/ \(3 files, 2\.0 KiB\)\./);
	assert.match(out, /- box\/s-b: accepted; its host pulls it into \/root\/in/);
	assert.equal(await r.run("link_offer", { paths: [""] }), "Nothing to offer: name at least one path.");
	assert.equal(r.calls.length, 2);
});

test("link_accept and link_decline name the offer and the session, and check the id first", async () => {
	const r = rig(ORIGIN, linked(), { body: offerBody("accepted") }, { body: offerBody("declined") });
	await r.start();
	assert.match(await r.run("link_accept", { offer: "of_x", dest: "in" }), /not an offer id/);
	assert.equal(await r.run("link_accept", { offer: OF, dest: " " }), "Name a destination directory (dest).");
	assert.match(await r.run("link_accept", { offer: OF, dest: "in" }), /^Accepted of_0123456789abcdef from box\/s-b: proj\/ .*pulling it into \/w\/in/);
	assert.deepEqual(r.calls[1], { url: `${ORIGIN}/api/mesh/links/offers/${OF}/accept`, method: "POST", body: { session: "s-me", dest: "in" } });
	assert.match(await r.run("link_decline", { offer: OF, reason: "not needed" }), /^Declined of_0123456789abcdef from box\/s-b/);
	assert.deepEqual(r.calls[2], { url: `${ORIGIN}/api/mesh/links/offers/${OF}/decline`, method: "POST", body: { session: "s-me", reason: "not needed" } });
});

test("link_offers lists both directions; an unknown offer is the host's sentence", async () => {
	const r = rig(ORIGIN, linked(), { body: { offers: [offerBody("offered", { recipients: [{ to: { nodeId: "n-self", sessionId: "s-me" }, state: "offered" }] })] } }, {
		status: 404,
		body: { error: "No offer of_0123456789abcdef for this session.", reason: "no-offer" },
	});
	await r.start();
	const out = await r.run("link_offers");
	assert.match(out, /of_0123456789abcdef on lk_a, from box\/s-b/);
	assert.match(out, /Answer with link_accept/);
	assert.equal(await r.run("link_decline", { offer: OF }), "No offer of_0123456789abcdef for this session.");
});
