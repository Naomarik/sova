import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addGitCleanupEnv, DEFAULT_ENV_ALLOW, GIT_CLEANUP_FILE, GIT_CLEANUP_MARKER, gitCleanupConfig, machineGitSystemConfig, proxyEnv, scrubEnv, writeGitCleanupConfig } from "../../env.ts";

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

function scratch(t: { after(fn: () => void): void }): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "sbx-gitenv-")));
	t.after(() => rmSync(d, { recursive: true, force: true }));
	return d;
}

test("git cleanup config: the machine's config copied in, then the two keys last; no include of its own", (t) => {
	const d = scratch(t);
	const machine = join(d, "gitconfig");
	writeFileSync(machine, "[core]\n\tautocrlf = input\n[maintenance]\n\tauto = true");
	const text = gitCleanupConfig(machine);
	assert.equal(text.split("\n", 1)[0], GIT_CLEANUP_MARKER);
	assert.ok(text.includes("autocrlf = input"));
	assert.ok(text.endsWith("[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n"), "ours come last, so they win over the copied auto = true");
	assert.doesNotMatch(text, /\[\s*include/i);
	assert.equal(gitCleanupConfig(null), `${GIT_CLEANUP_MARKER}\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n`);
	assert.equal(gitCleanupConfig(join(d, "missing")), gitCleanupConfig(null));
});

test("git cleanup config: a machine config with includes of its own is included by its absolute path, never copied", (t) => {
	const d = scratch(t);
	const machine = join(d, "with \"q\"");
	writeFileSync(machine, "[include]\n\tpath = relative.inc\n");
	const text = gitCleanupConfig(machine);
	assert.ok(text.includes(`[include]\n\tpath = "${d}/with \\"q\\""\n`), text);
	assert.ok(!text.includes("relative.inc"));
});

test("machine config: an inherited GIT_CONFIG_SYSTEM unless it is one of ours; none under GIT_CONFIG_NOSYSTEM", (t) => {
	const d = scratch(t);
	const theirs = join(d, "theirs");
	writeFileSync(theirs, "[user]\n\tname = x\n");
	assert.equal(machineGitSystemConfig({ GIT_CONFIG_SYSTEM: theirs }), theirs);
	assert.equal(machineGitSystemConfig({ GIT_CONFIG_SYSTEM: theirs, GIT_CONFIG_NOSYSTEM: "1" }), null);
	const ours = join(d, "ours");
	assert.ok(writeGitCleanupConfig(ours, { GIT_CONFIG_SYSTEM: theirs }));
	const fallback = machineGitSystemConfig({});
	assert.ok(fallback && fallback !== ours);
	assert.equal(machineGitSystemConfig({ GIT_CONFIG_SYSTEM: ours }), fallback, "one of ours is never copied into another");
});

test("writeGitCleanupConfig rewrites only when the content changes", (t) => {
	const d = scratch(t);
	const file = join(d, "sub", GIT_CLEANUP_FILE);
	assert.ok(writeGitCleanupConfig(file, { GIT_CONFIG_NOSYSTEM: "1" }));
	const before = statSync(file);
	assert.ok(writeGitCleanupConfig(file, { GIT_CONFIG_NOSYSTEM: "1" }));
	assert.equal(statSync(file).ino, before.ino, "same content: the file is left alone");
	assert.equal(readFileSync(file, "utf8"), gitCleanupConfig(null));
});

test("addGitCleanupEnv: GIT_CONFIG_SYSTEM as the command sees it, GIT_CONFIG_NOSYSTEM dropped; an unwritable tmp changes nothing", (t) => {
	const d = scratch(t);
	const env: Record<string, string> = { PATH: "/bin", GIT_CONFIG_NOSYSTEM: "1" };
	addGitCleanupEnv(env, d, "/tmp", { ...env });
	assert.deepEqual(env, { PATH: "/bin", GIT_CONFIG_SYSTEM: `/tmp/${GIT_CLEANUP_FILE}` });
	assert.equal(readFileSync(join(d, GIT_CLEANUP_FILE), "utf8"), gitCleanupConfig(null));
	const blocked = join(d, "file");
	writeFileSync(blocked, "");
	const env2: Record<string, string> = { PATH: "/bin" };
	addGitCleanupEnv(env2, join(blocked, "under-a-file"), "/tmp", env2);
	assert.deepEqual(env2, { PATH: "/bin" });
});
