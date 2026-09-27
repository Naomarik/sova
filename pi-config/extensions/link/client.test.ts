import assert from "node:assert/strict";
import test from "node:test";
import {
	formatBytes,
	LinkClient,
	LinkHostError,
	type LinkOffer,
	type MeshLinkView,
	nameFrom,
	NOT_LINKED,
	promptSection,
	renderAnswer,
	renderInbox,
	renderMembers,
	renderOfferCreate,
	renderOffers,
	renderSend,
	sectionKey,
} from "./client.ts";

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

const B = { nodeId: "n-b", sessionId: "s-b" };
const C = { nodeId: "n-c", sessionId: "s-c" };
const ME = { nodeId: "n-self", sessionId: "s-me" };
const offer = (over: Partial<LinkOffer> = {}): LinkOffer => ({
	id: "of_0123456789abcdef",
	linkId: "lk_a",
	at: 0,
	expiresAt: 86_400_000,
	from: ME,
	roots: [
		{ name: "proj", kind: "dir", files: 1203, bytes: 43_000_000 },
		{ name: "notes.md", kind: "file", files: 1, bytes: 512 },
	],
	files: 1204,
	bytes: 43_000_512,
	recipients: [],
	...over,
});

test("file offer requests go to the host's local acts, with the offer id in the path", async () => {
	const { f, calls } = fakeFetch({ body: { offer: offer(), deliveries: [] } }, { body: offer() }, { body: offer() }, { body: { offers: [offer()] } });
	const c = new LinkClient(ORIGIN, f);
	await c.offer({ session: "s1", paths: ["a"], dest: { box: "/in" } });
	await c.accept("of_1", { session: "s1", dest: "in" });
	await c.decline("of_1", { session: "s1" });
	assert.equal((await c.offers("s 1")).length, 1);
	assert.deepEqual(calls, [
		{ url: `${ORIGIN}/api/mesh/links/offers`, method: "POST", body: { session: "s1", paths: ["a"], dest: { box: "/in" } } },
		{ url: `${ORIGIN}/api/mesh/links/offers/of_1/accept`, method: "POST", body: { session: "s1", dest: "in" } },
		{ url: `${ORIGIN}/api/mesh/links/offers/of_1/decline`, method: "POST", body: { session: "s1" } },
		{ url: `${ORIGIN}/api/mesh/links/offers?session=s+1`, method: "GET" },
	]);
});

test("sizes read as binary units", () => {
	assert.deepEqual([0, 1023, 1024, 43_000_000, 5 * 1024 ** 3].map(formatBytes), ["0 B", "1023 B", "1.0 KiB", "41 MiB", "5.0 GiB"]);
});

test("link_offer's result: what went, warnings, and every partner's answer", () => {
	const name = nameFrom([view("lk_a")]);
	const out = renderOfferCreate(
		{
			offer: offer({ exclude: ["node_modules"], warnings: [{ kind: "gitlink", root: "proj", path: "proj/.git", gitdir: "/src/.git/worktrees/proj" }] }),
			deliveries: [
				{ to: B, state: "offered", delivery: "started" },
				{ to: C, state: "refused", reason: "tui-live", message: "It is open in a TUI." },
				{ to: { nodeId: "n-d", sessionId: "s-d" }, state: "outbox" },
			],
		},
		name,
	);
	assert.match(out, /^Offered of_0123456789abcdef on lk_a: proj\/, notes\.md \(1204 files, 41 MiB\)\. Excluded: node_modules\./);
	assert.match(out, /Warning: proj\/\.git is a git worktree's pointer file \(gitdir: \/src\/\.git\/worktrees\/proj\)/);
	assert.match(out, /- box\/s-b: its agent was idle and started a turn with the offer; it answers with link_accept or link_decline/);
	assert.match(out, /- s-c: refused \(tui-live\): It is open in a TUI\./);
	assert.match(out, /- s-d: its host is offline; held here/);
	assert.match(out, /one message when every recipient is done or declined, or at the first failure.*expires in 24h/);
	const none = renderOfferCreate({ offer: offer(), deliveries: [{ to: C, state: "refused", reason: "old-build", message: "Its host has no file offers." }] }, name);
	assert.match(none, /No recipient took it: nothing will be sent\.$/);
});

test("link_offers: a sent offer's table and a received offer's answer line", () => {
	const name = nameFrom([view("lk_a")]);
	const sent = offer({
		snapshot: { sha256: "x", size: 20 * 1024 * 1024 },
		note: "the repo",
		recipients: [
			{ to: B, state: "pulling", received: 5 * 1024 * 1024, dest: "~/in", resolvedDest: "/root/in", implicit: true, retries: 1 },
			{ to: C, state: "done", received: 20 * 1024 * 1024, resolvedDest: "/c/in", startedAt: 1000, doneAt: 39_000 },
			{ to: { nodeId: "n-d", sessionId: "s-d" }, state: "failed", reason: "not-writable", message: "/etc is outside its writable roots." },
		],
	});
	const got = offer({ id: "of_fedcba9876543210", from: B, at: 60_000, packing: { state: "packing" }, recipients: [{ to: ME, state: "offered" }] });
	const out = renderOffers([got, sent], name, "s-me", 120_000);
	assert.match(out, /^of_fedcba9876543210 on lk_a, from box\/s-b \(1m ago\): proj\/, notes\.md/);
	assert.match(out, /- this session: offered; expires in 24h/);
	assert.match(out, /Answer with link_accept \{offer:"of_fedcba9876543210", dest:"<a directory>"\} or link_decline/);
	assert.doesNotMatch(out.split("\n\n")[0]!, /Packing/, "a received offer shows no packing state");
	assert.match(out, /of_0123456789abcdef on lk_a, you → box\/s-b, s-c, s-d \(2m ago\)/);
	assert.match(out, /Note: the repo/);
	assert.match(out, /- box\/s-b: pulling; 5\.0 MiB \/ 20 MiB; into \/root\/in \(dest given with the offer\); 1 retry; expires in/);
	assert.match(out, /- s-c: done; 20 MiB \/ 20 MiB; into \/c\/in; took 38s$/m);
	assert.match(out, /- s-d: failed \(not-writable: \/etc is outside its writable roots\.\)/);
	assert.equal(renderOffers([], name, "s-me"), "No file offers, either way.");
});

test("link_accept / link_decline read the recipient's own row", () => {
	const name = nameFrom([view("lk_a")]);
	const acc = renderAnswer(offer({ from: B, recipients: [{ to: ME, state: "accepted", dest: "in", resolvedDest: "/w/in" }] }), "s-me", name);
	assert.match(acc, /^Accepted of_0123456789abcdef from box\/s-b: proj\/, notes\.md \(1204 files, 41 MiB\)\. Your host is pulling it into \/w\/in; each path lands there under its own name\./);
	assert.match(renderAnswer(offer({ from: B, recipients: [{ to: ME, state: "declined" }] }), "s-me", name), /^Declined of_0123456789abcdef from box\/s-b\./);
});

test("the prompt section mentions the file tools once, and stays stable", () => {
	const a = promptSection([view("lk_a")])!;
	assert.match(a, /link_offer/);
	assert.match(a, /link_accept/);
	assert.equal(promptSection([view("lk_a", {}, { state: "working" })]), a);
});
