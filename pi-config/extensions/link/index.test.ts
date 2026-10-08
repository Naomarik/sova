// Run through tests/run.mjs (pi imports resolve from the installed package).
import assert from "node:assert/strict";
import test from "node:test";
import link, { declaresLinkTools, FLAG, SECTION, TOKEN_FLAG, TOOL_NAMES, TOOLS_FLAG } from "./index.ts";
import { NOT_LINKED } from "./client.ts";

const ORIGIN = "http://127.0.0.1:4810";

type Answer = { status?: number; body?: unknown } | Error;
type Sys = { role: "system"; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };

/** Just enough of ExtensionAPI: flags (read only after load, as pi applies them), tools (a
    re-registration replaces, as pi's does), handlers. The host is a queue of answers. `transcript`
    is the session's projected messages, which a legacy session's start reads. */
function rig(flag: string | undefined, ...answers: Answer[]) {
	return rigWith({ origin: flag, tools: flag ? "member" : undefined }, ...answers);
}
function rigWith(opts: { origin?: string; tools?: string; transcript?: Sys[]; start?: boolean }, ...answers: Answer[]) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, (e: any, ctx: any) => unknown>();
	const calls: { url: string; method: string; body?: any }[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ url, method: init.method ?? "GET", ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
		const a = answers.shift() ?? { body: {} };
		if (a instanceof Error) throw a;
		return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
	}) as unknown as typeof fetch;
	let loaded = false;
	const flags: Record<string, string | undefined> = { [FLAG]: opts.origin, [TOOLS_FLAG]: opts.tools };
	const pi = {
		registerFlag: () => {},
		getFlag: (name: string) => {
			assert.ok(loaded, "a flag is read only after every extension has loaded (pi applies the values then)");
			return flags[name];
		},
		registerTool: (t: any) => tools.set(t.name, t),
		on: (event: string, h: any) => handlers.set(event, h),
	};
	link(pi as any, { fetch: fetchImpl });
	loaded = true;
	const atLoad = tools.size;
	const ctx = { sessionManager: { getSessionId: () => "s-me", buildSessionProjection: () => ({ messages: opts.transcript ?? [] }) } };
	const r = {
		tools,
		calls,
		answers,
		atLoad,
		/** The tools the model is declared: registered and not hidden. */
		declared: () => [...tools.values()].filter((t) => t.exposure !== "hidden").map((t) => t.name),
		sessionStart: async () => handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx),
		compact: async () => handlers.get("session_compact")!({ type: "session_compact", reason: "threshold", willRetry: false, fromExtension: false }, ctx),
		run: async (name: string, params: Record<string, unknown> = {}) => {
			const res = await tools.get(name).execute("c1", params, undefined, undefined, ctx);
			return res.content[0].text as string;
		},
		start: async () => {
			const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
			await handlers.get("before_agent_start")!(event, ctx);
			return event.systemPromptOptions.sections[SECTION];
		},
	};
	if (opts.start !== false) void r.sessionStart();
	return r;
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

const TOOLS = [...TOOL_NAMES];
const OF = "of_0123456789abcdef";
const declaring = (...names: string[]): Sys => ({ role: "system", toolsAdded: names.map((name) => ({ name })) });

test("a link member gets the seven tools at session start, none at load, with a fixed schema", () => {
	const member = rigWith({ origin: ORIGIN, tools: "member", start: false });
	assert.equal(member.atLoad, 0, "nothing at load: the flag isn't known yet");
	assert.equal(member.tools.size, 0);
	void member.sessionStart();
	assert.deepEqual([...member.tools.keys()], TOOLS);
	assert.deepEqual(member.declared(), TOOLS);
	const again = rig(ORIGIN);
	assert.deepEqual(shape(member.tools), shape(again.tools));
	void member.sessionStart();
	assert.equal(member.tools.size, 7, "a second start registers nothing more");
});

test("no flag at all (a TUI, a worker): no link tool, no section, nothing fetched", async () => {
	const r = rigWith({});
	assert.equal(r.tools.size, 0);
	assert.equal(await r.start(), undefined);
	assert.equal(r.calls.length, 0);
	const noTools = rigWith({ origin: ORIGIN }, linked());
	assert.equal(noTools.tools.size, 0, "an origin without sova-link-tools registers nothing either");
	assert.equal(await noTools.start(), undefined);
	assert.equal(noTools.calls.length, 0);
});

test("an ordinary session (legacy) whose transcript declares no link tool gets none, ever", async () => {
	const fresh = rigWith({ origin: ORIGIN, tools: "legacy" });
	assert.equal(fresh.tools.size, 0);
	const other = rigWith({ origin: ORIGIN, tools: "legacy", transcript: [declaring("read", "bash")] });
	assert.equal(other.tools.size, 0);
	const dropped = rigWith({ origin: ORIGIN, tools: "legacy", transcript: [declaring("read", ...TOOLS), { role: "system", toolsRemoved: TOOLS.map((name) => ({ name })) }] });
	assert.equal(dropped.tools.size, 0, "dropped once: never back");
	assert.equal(await fresh.start(), undefined);
	assert.equal(fresh.calls.length, 0);
});

test("a session from before keeps its declared tools, unchanged, until a compaction finds it in no live link", async () => {
	const r = rigWith({ origin: ORIGIN, tools: "legacy", transcript: [declaring("read", ...TOOLS)] }, linked(), new TypeError("fetch failed"), { body: { links: [] } });
	assert.deepEqual(r.declared(), TOOLS, "the same seven it declared");
	assert.deepEqual(shape(r.tools), shape(rig(ORIGIN).tools), "the same schema as a member's: no changed definition");
	await r.compact();
	assert.deepEqual(r.declared(), TOOLS, "still in a live link: kept");
	await r.compact();
	assert.deepEqual(r.declared(), TOOLS, "the host didn't answer: kept");
	await r.compact();
	assert.deepEqual(r.declared(), [], "in no live link: withdrawn at this compaction");
	assert.equal(r.tools.size, 7, "withdrawn as pi takes a tool back: re-registered hidden");
	await r.compact();
	assert.equal(r.calls.length, 3, "once withdrawn, a later compaction asks nothing");
	assert.equal(await r.start(), undefined, "and no run asks the host either");
	assert.equal(r.calls.length, 3);
});

test("a host with no link routes (4xx) at a compaction is no live link: withdrawn", async () => {
	const r = rigWith({ origin: ORIGIN, tools: "legacy", transcript: [declaring(...TOOLS)] }, { status: 404, body: {} });
	await r.compact();
	assert.deepEqual(r.declared(), []);
});

test("a link member never loses its tools at a compaction, and asks nothing for it", async () => {
	const r = rig(ORIGIN);
	await r.compact();
	assert.deepEqual(r.declared(), TOOLS);
	assert.equal(r.calls.length, 0);
});

test("declaresLinkTools replays the system messages as pi restores tools", () => {
	assert.equal(declaresLinkTools([]), false);
	assert.equal(declaresLinkTools([declaring("read"), { role: "user" } as any, declaring("link_inbox")]), true);
	assert.equal(declaresLinkTools([declaring("link_inbox"), { role: "system", toolsRemoved: [{ name: "link_inbox" }] }]), false);
});

test("the sova-link-token flag is sent back to the host on every call", async () => {
	const headers: Headers[] = [];
	const fetchImpl = (async (_u: string, init: RequestInit) => {
		headers.push(new Headers(init.headers));
		return new Response(JSON.stringify({ links: [] }));
	}) as unknown as typeof fetch;
	const tools = new Map<string, any>();
	const handlers = new Map<string, any>();
	const flags: Record<string, string> = { [FLAG]: ORIGIN, [TOKEN_FLAG]: "tok-abc", [TOOLS_FLAG]: "member" };
	const pi = { registerFlag: () => {}, getFlag: (n: string) => flags[n], registerTool: (t: any) => tools.set(t.name, t), on: (e: string, h: any) => handlers.set(e, h) };
	link(pi as any, { fetch: fetchImpl });
	const ctx = { sessionManager: { getSessionId: () => "s-me", buildSessionProjection: () => ({ messages: [] }) } };
	await handlers.get("session_start")({ type: "session_start" }, ctx);
	await tools.get("link_members").execute("c1", {}, undefined, undefined, ctx);
	assert.equal(headers.length, 1);
	assert.equal(headers[0]!.get("x-sova-token"), "tok-abc");
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
	// The host names an unknown offer with reason not-member: shown as is, not as "in no link".
	r.answers.push({ status: 404, body: { error: "No file offer of_0123456789abcdef for this session.", reason: "not-member" } });
	assert.equal(await r.run("link_accept", { offer: OF, dest: "in" }), "No file offer of_0123456789abcdef for this session.");
});
