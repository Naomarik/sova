import assert from "node:assert/strict";
import test from "node:test";
import { LinkClient, LinkHostError, type MeshLinkView, nameFrom, NOT_LINKED, promptSection, renderInbox, sectionKey, renderMembers, renderSend } from "./client.ts";

const ORIGIN = "http://127.0.0.1:4810";

function view(id: string, over: Partial<MeshLinkView["link"]> = {}, partner: Record<string, unknown> = {}): MeshLinkView {
	return {
		link: { id, createdAt: 1_000, createdBy: "n-self", ...over },
		members: [
			{ nodeId: "n-self", sessionId: "s-me", path: "/p/me.jsonl", self: true, hostLabel: "here", reach: "self", state: "working" },
			{ nodeId: "n-b", sessionId: "s-b", path: "/p/b.jsonl", self: false, hostId: "b", hostLabel: "box", reach: "up", state: "idle", title: "Fix it", model: "claude-code-cli/opus", cwd: "/w", lastActivity: 1_000, ...partner },
		] as MeshLinkView["members"],
	};
}

/** A fetch that records requests and answers from a queue. */
function fakeFetch(...answers: Array<{ status?: number; body?: unknown; raw?: string } | Error>) {
	const calls: { url: string; method: string; body?: unknown }[] = [];
	const f = (async (url: string, init: RequestInit) => {
		calls.push({ url, method: init.method ?? "GET", ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
		const a = answers.shift() ?? { body: {} };
		if (a instanceof Error) throw a;
		return new Response(a.raw ?? JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
	}) as unknown as typeof fetch;
	return { f, calls };
}

test("the prompt section names partners and no live state", () => {
	const a = promptSection([view("lk_b"), view("lk_a")]);
	assert.ok(a);
	assert.ok(a.indexOf("lk_a") < a.indexOf("lk_b"), "links sorted by id");
	assert.match(a, /- lk_a: "Fix it" \(box\/s-b\)/);
	assert.doesNotMatch(a, /s-me/, "the session itself is not a partner");
	// Live state, models and reach change every run; the section must not.
	const b = promptSection([view("lk_a", {}, { state: "working", reach: "down", model: "x/y", lastActivity: 9 }), view("lk_b")]);
	assert.equal(b, a);
	assert.equal(sectionKey([view("lk_b"), view("lk_a"), view("lk_c", { endedAt: 1 })]), "lk_a lk_b");
});

test("no live link, no section", () => {
	assert.equal(promptSection([]), null);
	assert.equal(promptSection([view("lk_a", { endedAt: 5 })]), null);
	assert.equal(renderMembers([view("lk_a", { endedAt: 5 })]), NOT_LINKED);
});

test("link_members names each partner with its state and backend", () => {
	const out = renderMembers([view("lk_a"), view("lk_z", { endedAt: 2 })], 61_000);
	assert.match(out, /Link lk_a \(made 1m ago\)/);
	assert.match(out, /- this session \(s-me\)/);
	assert.match(out, /- box\/s-b: "Fix it"; model claude-code-cli\/opus \(claude-code\); cwd \/w; host up; idle, last active 1m ago/);
	assert.match(out, /1 ended link not shown/);
	assert.match(renderMembers([view("lk_a", {}, { reach: "unknown-host", state: "offline", lastActivity: undefined })]), /host not known to this host \(unreachable\); offline/);
});

test("results name recipients from the last view", () => {
	const name = nameFrom([view("lk_a")]);
	const out = renderSend(
		{
			linkId: "lk_a",
			messageId: "lm_1",
			deliveries: [
				{ to: { nodeId: "n-b", sessionId: "s-b" }, state: "started" },
				{ to: { nodeId: "n-c", sessionId: "s-c" }, state: "refused", reason: "tui-live", message: "It is open in a TUI." },
			],
		},
		name,
	);
	assert.match(out, /Acceptance is not proof/);
	assert.match(out, /- box\/s-b: started a turn/);
	assert.match(out, /- s-c: refused \(tui-live\): It is open in a TUI\./);
	const inbox = renderInbox(
		[
			{ id: "lm_1", linkId: "lk_a", at: 0, from: { nodeId: "n-b", sessionId: "s-b" }, to: [{ nodeId: "n-self", sessionId: "s-me" }], text: "hi", dir: "in" },
			{ id: "lm_2", linkId: "lk_a", at: 0, from: { nodeId: "n-self", sessionId: "s-me" }, to: [{ nodeId: "n-b", sessionId: "s-b" }], text: "yo", dir: "out", deliveries: [{ to: { nodeId: "n-b", sessionId: "s-b" }, state: "outbox" }] },
		],
		name,
		0,
	);
	assert.equal(inbox, "[0s ago] lk_a from box/s-b\nhi\n\n[0s ago] lk_a you → box/s-b (box/s-b outbox)\nyo");
});

test("requests go to the session's own host with the session named", async () => {
	const { f, calls } = fakeFetch({ body: { links: [view("lk_a")] } }, { body: { linkId: "lk_a", messageId: "lm_1", deliveries: [] } }, { body: { records: [] } });
	const c = new LinkClient(`${ORIGIN}/`, f);
	assert.equal((await c.members("s 1", { brief: true })).length, 1);
	await c.send({ session: "s1", to: "all", text: "t" });
	await c.inbox("s1", 5);
	assert.deepEqual(calls, [
		{ url: `${ORIGIN}/api/mesh/links?session=s+1&brief=1`, method: "GET" },
		{ url: `${ORIGIN}/api/mesh/links/send`, method: "POST", body: { session: "s1", to: "all", text: "t" } },
		{ url: `${ORIGIN}/api/mesh/links/inbox?session=s1&limit=5`, method: "GET" },
	]);
});

test("the host's refusals reach the model as sentences", async () => {
	const { f } = fakeFetch(
		{ status: 409, body: { error: "This session is not a member of lk_a.", reason: "not-member" } },
		{ status: 404, body: { error: "Not found" } },
		new TypeError("fetch failed"),
		{ raw: "<html>" },
	);
	const c = new LinkClient(ORIGIN, f);
	const err = async () => {
		try {
			await c.members("s1");
		} catch (e) {
			assert.ok(e instanceof LinkHostError);
			return e;
		}
		assert.fail("expected a refusal");
	};
	const a = await err();
	assert.deepEqual([a.message, a.status, a.reason], ["This session is not a member of lk_a.", 409, "not-member"]);
	assert.match((await err()).message, /no link routes: the mesh is off/);
	const c3 = await err();
	assert.equal(c3.status, 0);
	assert.match(c3.message, /did not answer \(fetch failed\)/);
	assert.match((await err()).message, /unreadable/);
});

test("the tool's own abort is not reworded as a host failure", async () => {
	const ac = new AbortController();
	ac.abort();
	const f = (async (_u: string, init: RequestInit) => {
		init.signal?.throwIfAborted();
		return new Response("{}");
	}) as unknown as typeof fetch;
	await assert.rejects(new LinkClient(ORIGIN, f).members("s1", { signal: ac.signal }), (e: Error) => !(e instanceof LinkHostError));
});
