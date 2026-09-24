import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forbiddenAddress, hostAllowed, PROXY_DENY_TEXT, proxySocketPath, startProxy, type ProxyDecision } from "../../proxy.ts";

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
	const dir = mkdtempSync(join(tmpdir(), "sbx-proxy-"));
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

test("startProxy tunnels an allowlisted host (real network; skipped offline)", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "sbx-proxy-"));
	const socket = join(dir, "p.sock");
	const px = await startProxy({ socket, allow: ["api.github.com"] });
	t.after(async () => {
		await px.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const reply = await exchange(socket, "CONNECT api.github.com:443 HTTP/1.1\r\n\r\n", /\r\n\r\n/);
	if (/^HTTP\/1\.1 502/.test(reply)) return t.skip("no network");
	assert.match(reply, /^HTTP\/1\.1 200/);
});
