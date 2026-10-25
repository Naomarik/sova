import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forbiddenAddress, hostAllowed, PROXY_DENY_TEXT, proxySocketPath, startProxy, type ProxyDecision } from "../../proxy.ts";

// These tests' Unix sockets live outside the host's /tmp: the linux-bwrap write-only-worker test
// (hostTmp), running beside them, masks every socket it finds there, and one removed between its scan
// and bwrap's start fails that one command by design. Production is unchanged.
const SOCKET_ROOT = process.platform === "linux" && existsSync("/dev/shm") ? "/dev/shm" : tmpdir();

test("hostAllowed: exact names, *.suffix wildcards, IP literals only exactly", () => {
	const allow = ["github.com", "*.githubusercontent.com", "10.0.0.5"];
	assert.ok(hostAllowed("github.com", allow));
	assert.ok(hostAllowed("GitHub.com.", allow));
	assert.ok(!hostAllowed("evilgithub.com", allow));
	assert.ok(!hostAllowed("api.github.com", allow));
	assert.ok(hostAllowed("objects.githubusercontent.com", allow));
	assert.ok(!hostAllowed("githubusercontent.com", allow));
	assert.ok(!hostAllowed("githubusercontent.com.evil.org", allow));
	assert.ok(hostAllowed("10.0.0.5", allow));
	assert.ok(!hostAllowed("127.0.0.1", allow));
	assert.ok(!hostAllowed("", allow));
});

test("forbiddenAddress covers loopback, unspecified, link-local and mapped forms", () => {
	for (const a of ["127.0.0.1", "127.1.2.3", "0.0.0.0", "169.254.169.254", "::1", "::", "fe80::1", "::ffff:127.0.0.1"]) assert.ok(forbiddenAddress(a), a);
	for (const a of ["140.82.112.3", "10.0.0.1", "2606:4700::1"]) assert.ok(!forbiddenAddress(a), a);
});

test("proxySocketPath is short, stable and per session", () => {
	const a = proxySocketPath("0198a0b1-aaaa-bbbb-cccc-0123456789ab", "/run/user/1000");
	assert.equal(a, proxySocketPath("0198a0b1-aaaa-bbbb-cccc-0123456789ab", "/run/user/1000"));
	assert.notEqual(a, proxySocketPath("other", "/run/user/1000"));
	assert.ok(Buffer.byteLength(a) <= 107);
	assert.throws(() => proxySocketPath("s", "/" + "x".repeat(120)));
});

/** Send raw bytes to the proxy's Unix socket and collect the reply until close or `until` matches. */
function exchange(socket: string, payload: string, until?: RegExp): Promise<string> {
	return new Promise((resolve, reject) => {
		const c = connect({ path: socket });
		let out = "";
		const timer = setTimeout(() => (c.destroy(), resolve(out)), 5000);
		c.on("data", (d) => {
			out += d;
			if (until?.test(out)) (clearTimeout(timer), c.destroy(), resolve(out));
		});
		c.on("close", () => (clearTimeout(timer), resolve(out)));
		c.on("error", reject);
		c.write(payload);
	});
}

test("startProxy refuses non-allowlisted hosts, other ports, local addresses and non-proxy requests", async (t) => {
	const dir = mkdtempSync(join(SOCKET_ROOT, "sbx-proxy-"));
	const socket = join(dir, "p.sock");
	// A live loopback listener: an allowlisted name resolving to it must still be refused.
	const upstream = createServer((s) => s.end("hello-from-upstream"));
	await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
	const port = (upstream.address() as { port: number }).port;
	const decisions: ProxyDecision[] = [];
	const px = await startProxy({
		socket,
		allow: ["allowed.test", "loop.test"],
		ports: [443, port],
		onDecision: (d) => decisions.push(d),
		resolve: async (h) => (h === "loop.test" ? "127.0.0.1" : "192.0.2.1"),
	});
	t.after(async () => {
		await px.close();
		upstream.close();
		rmSync(dir, { recursive: true, force: true });
	});
	assert.equal(statSync(socket).mode & 0o777, 0o600);

	const denied = await exchange(socket, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
	assert.match(denied, /^HTTP\/1\.1 403/);
	assert.ok(denied.includes(PROXY_DENY_TEXT));

	const badPort = await exchange(socket, "CONNECT allowed.test:22 HTTP/1.1\r\n\r\n");
	assert.match(badPort, /^HTTP\/1\.1 403/);

	const loop = await exchange(socket, `CONNECT loop.test:${port} HTTP/1.1\r\n\r\n`);
	assert.match(loop, /^HTTP\/1\.1 403/);
	assert.match(loop, /local address/);

	const plain = await exchange(socket, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
	assert.match(plain, /^HTTP\/1\.1 403/);
	assert.ok(plain.includes(PROXY_DENY_TEXT));

	const direct = await exchange(socket, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
	assert.match(direct, /^HTTP\/1\.1 400/);

	// setAllow applies to the next request.
	px.setAllow(["loop.test"]);
	assert.match(await exchange(socket, "CONNECT allowed.test:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);

	assert.ok(decisions.some((d) => d.host === "example.com" && !d.allowed));
	await px.close();
	assert.equal(existsSync(socket), false);
});

test("startProxy lets an allowlisted name past the allowlist: it fails only at the dial (no live host involved)", async (t) => {
	const dir = mkdtempSync(join(SOCKET_ROOT, "sbx-proxy-"));
	const socket = join(dir, "p.sock");
	const px = await startProxy({ socket, allow: ["sbx-allowed.invalid", "api.github.com"] });
	t.after(async () => {
		await px.close();
		rmSync(dir, { recursive: true, force: true });
	});
	// ".invalid" never resolves (RFC 6761), online or offline.
	const allowed = await exchange(socket, "CONNECT sbx-allowed.invalid:443 HTTP/1.1\r\n\r\n");
	assert.match(allowed, /^HTTP\/1\.1 502/);
	assert.match(allowed, /cannot resolve sbx-allowed\.invalid/);
	assert.ok(!allowed.includes(PROXY_DENY_TEXT));
	const denied = await exchange(socket, "CONNECT sbx-denied.invalid:443 HTTP/1.1\r\n\r\n");
	assert.match(denied, /^HTTP\/1\.1 403/);
	assert.ok(denied.includes(PROXY_DENY_TEXT));
	// Optional live check, never failing.
	const live = await exchange(socket, "CONNECT api.github.com:443 HTTP/1.1\r\n\r\n", /\r\n\r\n/);
	t.diagnostic(`live CONNECT api.github.com: ${live.split("\r\n")[0] || "(no reply)"}`);
});

test("forbid (off by default): an allowlisted name resolving to a refused address gets no dial; a denied name is never resolved", async (t) => {
	const dir = mkdtempSync(join(SOCKET_ROOT, "sbx-proxy-"));
	const socket = join(dir, "p.sock");
	const answers: Record<string, string> = { "rfc1918.test": "10.0.0.5", "cgnat.test": "100.64.1.1", "ula.test": "fd00::1", "mapped.test": "::ffff:10.0.0.5", "loop.test": "127.0.0.1", "public.test": "192.0.2.1" };
	const resolved: string[] = [];
	const decisions: ProxyDecision[] = [];
	// Stands in for a recording attempt's rule: only 192.0.2.1 counts as public in this fixture.
	const px = await startProxy({ socket, allow: Object.keys(answers), forbid: (a) => a !== "192.0.2.1", onDecision: (d) => decisions.push(d), resolve: async (h) => { resolved.push(h); return answers[h]!; } });
	t.after(async () => { await px.close(); rmSync(dir, { recursive: true, force: true }); });
	for (const host of ["rfc1918.test", "cgnat.test", "ula.test", "mapped.test"]) {
		const reply = await exchange(socket, `CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
		assert.match(reply, /^HTTP\/1\.1 403/, host);
		assert.match(reply, /private address/, host);
	}
	// The default rule still applies first, with its own words.
	assert.match(await exchange(socket, "CONNECT loop.test:443 HTTP/1.1\r\n\r\n"), /local address/);
	assert.match(await exchange(socket, "CONNECT denied.test:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
	assert.ok(!resolved.includes("denied.test"), "a name the allowlist denies is never resolved");
	// Positive control: the predicate is what refused; an address it accepts passes to the dial.
	void exchange(socket, "CONNECT public.test:443 HTTP/1.1\r\n\r\n", /./);
	for (let i = 0; i < 100 && !decisions.some((d) => d.host === "public.test"); i++) await new Promise((r) => setTimeout(r, 10));
	assert.equal(decisions.find((d) => d.host === "public.test")?.allowed, true);
	// Without the option nothing changes: the default rule doesn't refuse a private address (no dial here).
	assert.equal(forbiddenAddress("10.0.0.5"), false);
});

test("local (off by default): exactly one loopback host:port, re-admitted on every contact; other ports and the default proxy still refuse loopback", async (t) => {
	const dir = mkdtempSync(join(SOCKET_ROOT, "sbx-proxy-"));
	const socket = join(dir, "p.sock"), plainSocket = join(dir, "q.sock");
	const { createServer: createHttp } = await import("node:http");
	const counts = { own: 0, other: 0 };
	const own = createHttp((_q, s) => { counts.own++; s.end("own-copy"); });
	const other = createHttp((_q, s) => { counts.other++; s.end("other-copy"); });
	await new Promise<void>((r) => own.listen(0, "127.0.0.1", r));
	await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
	const ownPort = (own.address() as { port: number }).port, otherPort = (other.address() as { port: number }).port;
	let identity: "ok" | "changed" | "throws" = "ok";
	let admits = 0;
	const px = await startProxy({ socket, allow: [], local: { host: "127.0.0.1", port: ownPort, admit: async () => { admits++; if (identity === "throws") throw new Error("registry unreadable"); return identity === "ok"; } } });
	const unchanged = await startProxy({ socket: plainSocket, allow: [] });
	t.after(async () => { await px.close(); await unchanged.close(); own.close(); other.close(); rmSync(dir, { recursive: true, force: true }); });
	const get = (sock: string, port: number, host = "127.0.0.1") => exchange(sock, `GET http://${host}:${port}/ HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
	const reached = await get(socket, ownPort);
	assert.match(reached, /^HTTP\/1\.1 200/);
	assert.ok(reached.includes("own-copy"));
	assert.equal(counts.own, 1, "the attempt's own running copy is reachable");
	assert.match(await exchange(socket, `CONNECT 127.0.0.1:${ownPort} HTTP/1.1\r\n\r\n`, /\r\n\r\n/), /^HTTP\/1\.1 200/);
	assert.equal(admits, 2, "each contact is re-admitted");
	// Another port, another spelling of this machine (localhost, [::1], 127.0.0.2): all refused.
	for (const reply of [await get(socket, otherPort), await get(socket, ownPort, "localhost"), await get(socket, ownPort, "[::1]"), await get(socket, ownPort, "127.0.0.2"), await exchange(socket, `CONNECT 127.0.0.1:${otherPort} HTTP/1.1\r\n\r\n`), await exchange(socket, `CONNECT [::1]:${ownPort} HTTP/1.1\r\n\r\n`)]) assert.match(reply, /^HTTP\/1\.1 403/);
	assert.equal(counts.own, 1, "no other spelling reached the own copy");
	assert.equal(counts.other, 0, "another loopback port gets no request");
	// The port now belongs to another copy (B reused it), or the identity can't be read: refused, no request.
	for (const state of ["changed", "throws"] as const) {
		identity = state;
		const before = counts.own;
		assert.match(await get(socket, ownPort), /^HTTP\/1\.1 403/, state);
		assert.equal(counts.own, before, `${state}: no request reaches the port`);
	}
	// The chat's own proxy (no option) still refuses every loopback contact.
	identity = "ok";
	const before = counts.own;
	assert.match(await get(plainSocket, ownPort), /^HTTP\/1\.1 403/);
	assert.equal(counts.own, before);
});

test("admit: absent leaves every decision and answer as before; false, a throw or a rejection refuses before any lookup or dial", async (t) => {
	const upstream = createServer((s) => s.end("hello-from-upstream"));
	let dials = 0;
	upstream.on("connection", () => dials++);
	await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
	const port = (upstream.address() as { port: number }).port;
	t.after(() => upstream.close());
	const script = [
		"CONNECT example.com:443 HTTP/1.1\r\n\r\n",
		"CONNECT allowed.test:22 HTTP/1.1\r\n\r\n",
		`CONNECT loop.test:${port} HTTP/1.1\r\n\r\n`,
		"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n",
		// The one admitted contact: the attempt's own loopback copy, dialled.
		`CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`,
	];
	const run = async (admit?: (host: string, port: number) => boolean | Promise<boolean>) => {
		const dir = mkdtempSync(join(SOCKET_ROOT, "sbx-proxy-"));
		const socket = join(dir, "p.sock");
		const decisions: ProxyDecision[] = [];
		let lookups = 0;
		const px = await startProxy({
			socket, allow: ["allowed.test", "loop.test"], ports: [443, port], onDecision: (d) => decisions.push(d),
			resolve: async (h) => { lookups++; return h === "loop.test" ? "127.0.0.1" : "192.0.2.1"; },
			local: { host: "127.0.0.1", port, admit: async () => true },
			...(admit ? { admit } : {}),
		});
		const answers: string[] = [];
		try {
			for (const payload of script) answers.push((await exchange(socket, payload, /\r\n\r\n/)).split("\r\n")[0]!);
		} finally {
			await px.close();
			rmSync(dir, { recursive: true, force: true });
		}
		return { decisions, answers, lookups };
	};
	// Absent, and an admit that always says yes: the same decisions and answers.
	const absent = await run();
	assert.match(absent.answers.at(-1)!, /^HTTP\/1\.1 200/, "positive control: the own copy is reached");
	assert.deepEqual(await run(() => true), absent);
	// Refusing in each way: every contact refused with no lookup and no dial.
	const before = dials;
	for (const admit of [() => false, () => { throw new Error("no"); }, () => Promise.reject(new Error("no")), async () => false]) {
		const r = await run(admit);
		assert.ok(r.answers.every((a) => /^HTTP\/1\.1 403/.test(a)), JSON.stringify(r.answers));
		assert.equal(r.lookups, 0, "nothing looked up");
		assert.ok(r.decisions.every((d) => !d.allowed && /not admitted for this recording/.test(d.reason ?? "")));
	}
	assert.equal(dials, before, "nothing dialled");
});
