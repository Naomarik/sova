import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ENV_ALLOW, proxyEnv, scrubEnv } from "../../env.ts";

test("scrubEnv keeps the allowlist and drops everything else", () => {
	const out = scrubEnv({
		PATH: "/usr/bin", HOME: "/home/u", LC_ALL: "C", MISE_SHELL: "zsh", PI_SESSION_ID: "abc",
		DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", XDG_RUNTIME_DIR: "/run/user/1000",
		SSH_AUTH_SOCK: "/tmp/ssh", DOCKER_HOST: "unix:///run/docker.sock", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1",
		TMUX: "/tmp/tmux", ANTHROPIC_API_KEY: "k", GH_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", NODE_OPTIONS: "--require x",
		UNDEF: undefined,
	});
	assert.deepEqual(Object.keys(out).sort(), ["HOME", "LC_ALL", "MISE_SHELL", "PATH", "PI_SESSION_ID"]);
});

test("extra allow widens, but never past the NEVER list", () => {
	const src = { FOO: "1", FOO_BAR: "2", SSH_AUTH_SOCK: "/s", LD_PRELOAD: "/x.so", HTTPS_PROXY: "http://evil", TMPDIR: "/tmp/x" };
	const out = scrubEnv(src, ["FOO", "SSH_AUTH_SOCK", "LD_*", "HTTPS_PROXY", "TMPDIR"]);
	assert.deepEqual(out, { FOO: "1" });
	assert.deepEqual(scrubEnv(src, ["FOO*"]), { FOO: "1", FOO_BAR: "2" });
	// A bare "*" is not a wildcard for everything.
	assert.deepEqual(scrubEnv({ SECRET: "x" }, ["*"]), {});
});

test("defaults name no bus, agent or credential variable", () => {
	for (const bad of ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK", "DISPLAY", "GH_TOKEN"]) {
		assert.ok(!DEFAULT_ENV_ALLOW.includes(bad));
	}
});

test("proxyEnv sets both spellings and exempts loopback", () => {
	const e = proxyEnv(3128);
	assert.equal(e.HTTPS_PROXY, "http://127.0.0.1:3128");
	assert.equal(e.https_proxy, "http://127.0.0.1:3128");
	assert.match(e.NO_PROXY!, /127\.0\.0\.1/);
});
