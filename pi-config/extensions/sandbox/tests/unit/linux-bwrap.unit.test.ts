/**
 * Real runs of the bwrap backend on this host. Every escape is attempted for real and judged from
 * the HOST side (file existence, a listener's accept count, a hash), never from the sandbox's own
 * output. Skipped as a whole where bwrap is not installed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { classifyRun, type Policy } from "../../backend.ts";
import { findExecutable, LinuxBwrapBackend, mountPlan, runCapture } from "../../backends/linux-bwrap.ts";
import { scrubEnv } from "../../env.ts";
import { startProxy } from "../../proxy.ts";

const HAVE_BWRAP = process.platform === "linux" && !!findExecutable("bwrap");
const HAVE_SOCAT = !!findExecutable("socat");
const skip = HAVE_BWRAP ? false : "bwrap not installed";

function scratch(t: { after(fn: () => void): void }, prefix: string): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	t.after(() => rmSync(d, { recursive: true, force: true }));
	return d;
}

function makePolicy(ws: string, tmp: string, over: Partial<Policy> = {}): Policy {
	return {
		level: "workspace-write",
		workspaceRoot: ws,
		writable: [ws],
		readOnlyWithinWritable: [],
		hidden: [],
		tmpDir: tmp,
		network: { mode: "none" },
		env: scrubEnv(process.env),
		sessionId: "unit",
		...over,
	};
}

async function run(backend: LinuxBwrapBackend, policy: Policy, command: string, spawnEnv?: Record<string, string>) {
	const res = await backend.confine({ argv: ["/bin/bash", "-c", command], cwd: policy.workspaceRoot, policy });
	assert.ok(res.ok, !res.ok ? res.reason : "");
	const c = res.confined;
	const out = await runCapture(c.argv, spawnEnv ?? c.env, 30_000);
	return { ...out, confined: c, cls: classifyRun(c, { exitCode: out.code, output: out.output }) };
}

const rand = () => randomBytes(6).toString("hex");

test("probe passes on this host with full enforcement", { skip }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const tmp = scratch(t, "sbx-tmp-");
	const r = await new LinuxBwrapBackend().probe(makePolicy(ws, tmp));
	assert.deepEqual(r, { ok: true, enforcement: "full", network: "none" });
});

test("a write outside the writable roots does not reach the host; inside does", { skip }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const tmp = scratch(t, "sbx-tmp-");
	const outside = scratch(t, "sbx-out-");
	const name = `sbx-${rand()}`;
	const home = join(homedir(), `.${name}`);
	t.after(() => rmSync(home, { force: true }));
	const b = new LinuxBwrapBackend();
	const r = await run(b, makePolicy(ws, tmp), `touch ${outside}/${name}; echo x > ${home}; echo ok > ${ws}/${name}; exit 1`);
	assert.equal(existsSync(join(outside, name)), false);
	assert.equal(existsSync(home), false);
	assert.equal(readFileSync(join(ws, name), "utf8"), "ok\n");
	assert.equal(r.cls.kind, "denied");
});

test("private /tmp is the session tmp dir; host /tmp and /run/user are invisible", { skip }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const tmp = scratch(t, "sbx-tmp-");
	const marker = join(tmpdir(), `sbx-host-${rand()}`);
	writeFileSync(marker, "host");
	t.after(() => rmSync(marker, { force: true }));
	const name = `f-${rand()}`;
	const r = await run(new LinuxBwrapBackend(), makePolicy(ws, tmp), `test -e ${marker} && echo SEEN-HOST-TMP; test -e /run/user && echo SEEN-RUN-USER; echo in > /tmp/${name}; echo "tmpdir=$TMPDIR"`);
	assert.equal(r.code, 0, r.output);
	assert.ok(!r.output.includes("SEEN-"), r.output);
	assert.match(r.output, /tmpdir=\/tmp/);
	assert.equal(readFileSync(join(tmp, name), "utf8"), "in\n");
	assert.equal(existsSync(join("/tmp", name)), false);
});

test("the mount namespace differs from the host's", { skip }, async (t) => {
	const r = await run(new LinuxBwrapBackend(), makePolicy(scratch(t, "sbx-ws-"), scratch(t, "sbx-tmp-")), "readlink /proc/self/ns/mnt");
	assert.notEqual(r.output.trim(), readlinkSync("/proc/self/ns/mnt"));
});

test("systemd-run --user cannot reach the user bus, even with the address forced", { skip: skip || (!findExecutable("systemd-run") && "no systemd-run") }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const target = join(homedir(), `.sbx-systemd-${rand()}`);
	t.after(() => rmSync(target, { force: true }));
	const uid = process.getuid!();
	const r = await run(
		new LinuxBwrapBackend(),
		makePolicy(ws, scratch(t, "sbx-tmp-")),
		`systemd-run --user --wait touch ${target}; echo rc=$?; DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus XDG_RUNTIME_DIR=/run/user/${uid} systemd-run --user --wait touch ${target}; echo rc=$?; busctl --user list >/dev/null; echo rc=$?`,
	);
	assert.equal(existsSync(target), false);
	assert.doesNotMatch(r.output, /rc=0/);
});

test("the caller's env never leaks: --clearenv holds even if spawned with the full host env", { skip }, async (t) => {
	const b = new LinuxBwrapBackend();
	const policy = makePolicy(scratch(t, "sbx-ws-"), scratch(t, "sbx-tmp-"));
	const dirty = { ...(process.env as Record<string, string>), DBUS_SESSION_BUS_ADDRESS: "unix:path=/x", SSH_AUTH_SOCK: "/x", SANDBOX_CANARY: "leak", GH_TOKEN: "t" };
	const r = await run(b, policy, "env", dirty);
	for (const k of ["DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "SANDBOX_CANARY", "GH_TOKEN", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "TMUX", "DOCKER_HOST"]) {
		assert.ok(!new RegExp(`^${k}=`, "m").test(r.output), `${k} leaked`);
	}
	assert.match(r.output, /^PATH=/m);
});

async function listen(server: Server, arg: object): Promise<void> {
	await new Promise<void>((r) => server.listen(arg, r));
}

test("host loopback TCP and abstract Unix sockets are unreachable", { skip }, async (t) => {
	let accepted = 0;
	const tcp = createServer((s) => (accepted++, s.end("hi")));
	await listen(tcp, { port: 0, host: "127.0.0.1" });
	const abstract = `sbx-${rand()}`;
	const abs = createServer((s) => (accepted++, s.end("hi")));
	await listen(abs, { path: `\0${abstract}` });
	t.after(() => (tcp.close(), abs.close()));
	const port = (tcp.address() as { port: number }).port;
	const cmd = [
		`(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo TCP-OPEN`,
		`(exec 3<>/dev/tcp/127.0.0.1/4800) 2>/dev/null && echo SOVA-OPEN`,
		HAVE_SOCAT ? `socat -u ABSTRACT-CONNECT:${abstract} - 2>/dev/null && echo ABSTRACT-OPEN` : "true",
	].join("; ");
	const r = await run(new LinuxBwrapBackend(), makePolicy(scratch(t, "sbx-ws-"), scratch(t, "sbx-tmp-")), cmd);
	assert.equal(accepted, 0);
	assert.doesNotMatch(r.output, /OPEN/);
});

test("the policy file inside the writable workspace: masked, and its ancestors cannot be renamed", { skip }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const policyFile = join(ws, ".agent", "sandbox-policy", "linux", "policy.json");
	mkdirSync(join(ws, ".agent", "sandbox-policy", "linux"), { recursive: true });
	writeFileSync(policyFile, '{"level":"workspace-write"}\n');
	const before = readFileSync(policyFile, "utf8");
	const cmd = [
		`cat .agent/sandbox-policy/linux/policy.json`,
		`echo '{"level":"full"}' > .agent/sandbox-policy/linux/policy.json`,
		`rm -f .agent/sandbox-policy/linux/policy.json`,
		`mv .agent .agent-moved`,
		`mv .agent/sandbox-policy .agent/sp-moved`,
		`mv .agent/sandbox-policy/linux .agent/sandbox-policy/l2`,
		`mkdir -p .agent/sandbox-policy/linux && echo '{"level":"full"}' > .agent/sandbox-policy/linux/policy.json`,
		`echo still-writable > .agent/other`,
		`true`,
	].join("; ");
	const r = await run(new LinuxBwrapBackend(), makePolicy(ws, scratch(t, "sbx-tmp-"), { hidden: [policyFile] }), cmd);
	assert.equal(readFileSync(policyFile, "utf8"), before);
	for (const moved of [".agent-moved", ".agent/sp-moved", ".agent/sandbox-policy/l2"]) assert.equal(existsSync(join(ws, moved)), false, moved);
	assert.ok(!r.output.includes("workspace-write"), "masked file must read empty");
	// Pins keep the ancestors writable for everything else.
	assert.equal(readFileSync(join(ws, ".agent", "other"), "utf8"), "still-writable\n");
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
}

test("git: hooks and config are read-only, .git cannot be swapped, commits still work", { skip: skip || (!findExecutable("git") && "no git") }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	git(ws, "init", "-q");
	rmSync(join(ws, ".git", "hooks"), { recursive: true, force: true }); // the backend recreates it
	const cfgBefore = readFileSync(join(ws, ".git", "config"), "utf8");
	const cmd = [
		`printf '#!/bin/sh\\ntouch /tmp/pwned\\n' > .git/hooks/pre-commit`,
		`git config core.hooksPath /tmp/hooks`,
		`mv .git .git-moved`,
		`mv .git/hooks .git/h2`,
		`echo a > a && git add a && git -c user.name=t -c user.email=t@t commit -qm one && echo COMMITTED`,
	].join("; ");
	const r = await run(new LinuxBwrapBackend(), makePolicy(ws, scratch(t, "sbx-tmp-")), cmd);
	assert.equal(existsSync(join(ws, ".git", "hooks", "pre-commit")), false);
	assert.equal(readFileSync(join(ws, ".git", "config"), "utf8"), cfgBefore);
	assert.equal(existsSync(join(ws, ".git-moved")), false);
	assert.match(r.output, /COMMITTED/);
	assert.match(git(ws, "log", "--oneline"), /one/);
});

test("git worktree: the common dir is writable for commits, its hooks/config and the gitfile are not", { skip: skip || (!findExecutable("git") && "no git") }, async (t) => {
	const base = scratch(t, "sbx-wt-");
	const main = join(base, "main");
	mkdirSync(main);
	git(main, "init", "-q");
	git(main, "commit", "-q", "--allow-empty", "-m", "root");
	const wt = join(base, "wt");
	git(main, "worktree", "add", "-q", "-b", "side", wt);
	const common = join(main, ".git");
	const gitfileBefore = readFileSync(join(wt, ".git"), "utf8");
	const cfgBefore = readFileSync(join(common, "config"), "utf8");
	const cmd = [
		`printf '#!/bin/sh\\n' > ${common}/hooks/post-commit`,
		`echo "gitdir: /tmp/evil" > .git`,
		`echo /tmp/evil > ${common}/worktrees/wt/commondir`,
		`echo "gitdir: /tmp/evil/.git" > ${common}/worktrees/wt/gitdir`,
		`git switch -q -c side2 && git switch -q side && echo SWITCHED`,
		`git config core.fsmonitor 'touch /tmp/pwned'`,
		`echo b > b && git add b && git -c user.name=t -c user.email=t@t commit -qm two && echo COMMITTED`,
		`touch ${main}/in-main-checkout`,
	].join("; ");
	const r = await run(new LinuxBwrapBackend(), makePolicy(wt, scratch(t, "sbx-tmp-")), cmd);
	assert.equal(existsSync(join(common, "hooks", "post-commit")), false);
	assert.equal(readFileSync(join(wt, ".git"), "utf8"), gitfileBefore);
	assert.equal(readFileSync(join(common, "config"), "utf8"), cfgBefore);
	assert.equal(readFileSync(join(common, "worktrees", "wt", "commondir"), "utf8").trim(), "../..");
	assert.equal(readFileSync(join(common, "worktrees", "wt", "gitdir"), "utf8").trim(), join(wt, ".git"));
	assert.match(r.output, /SWITCHED/, "the worktree's own HEAD stays writable");
	assert.equal(existsSync(join(main, "in-main-checkout")), false, "the main checkout stays read-only");
	assert.match(r.output, /COMMITTED/);
	assert.match(git(main, "log", "--oneline", "side"), /two/);
});

test("hidden: a directory reads empty and a file reads empty, both unwritable", { skip }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const secrets = scratch(t, "sbx-secrets-");
	writeFileSync(join(secrets, "id_key"), "SECRET");
	const tokenFile = join(ws, "token.json");
	writeFileSync(tokenFile, "TOKEN");
	const r = await run(
		new LinuxBwrapBackend(),
		makePolicy(ws, scratch(t, "sbx-tmp-"), { hidden: [secrets, tokenFile] }),
		`ls -A ${secrets}; cat ${tokenFile}; echo x > ${tokenFile}; touch ${secrets}/new; true`,
	);
	assert.doesNotMatch(r.output, /SECRET|TOKEN|id_key/);
	assert.equal(readFileSync(tokenFile, "utf8"), "TOKEN");
	assert.equal(existsSync(join(secrets, "new")), false);
});

test("read-only level: the workspace is not writable, /tmp is", { skip }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const tmp = scratch(t, "sbx-tmp-");
	const r = await run(new LinuxBwrapBackend(), makePolicy(ws, tmp, { level: "read-only" }), `touch ${ws}/x; echo t > /tmp/y; true`);
	assert.equal(existsSync(join(ws, "x")), false);
	assert.equal(existsSync(join(tmp, "y")), true);
	assert.equal(r.code, 0);
	const probe = await new LinuxBwrapBackend().probe(makePolicy(ws, tmp, { level: "read-only" }));
	assert.equal(probe.ok, true);
});

test("fail closed: no bwrap refuses; a broken bwrap fails the probe and classifies as runner failure", { skip }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const tmp = scratch(t, "sbx-tmp-");
	const shimDir = scratch(t, "sbx-shim-");
	const shim = join(shimDir, "bwrap");
	writeFileSync(shim, "#!/bin/sh\necho 'bwrap: No permissions to create new namespace' >&2\nexit 1\n");
	chmodSync(shim, 0o755);

	const savedPath = process.env.PATH;
	process.env.PATH = "/nonexistent";
	try {
		const c = await new LinuxBwrapBackend().confine({ argv: ["/bin/true"], cwd: ws, policy: makePolicy(ws, tmp) });
		assert.equal(c.ok, false);
		assert.match(!c.ok ? c.reason : "", /bwrap not found/);
		assert.equal((await new LinuxBwrapBackend().probe(makePolicy(ws, tmp))).ok, false);
		// A shim earlier on PATH is what the backend uses (PATH is read per call).
		process.env.PATH = `${shimDir}:${savedPath}`;
		assert.equal((await new LinuxBwrapBackend().probe(makePolicy(ws, tmp))).ok, false);
	} finally {
		process.env.PATH = savedPath;
	}

	const broken = new LinuxBwrapBackend({ bwrapPath: shim });
	const probe = await broken.probe(makePolicy(ws, tmp));
	assert.equal(probe.ok, false);
	const r = await run(broken, makePolicy(ws, tmp), `touch ${ws}/should-not-exist`);
	assert.equal(existsSync(join(ws, "should-not-exist")), false);
	assert.equal(r.cls.kind, "runner-failure");
});

test("a real bwrap failure (missing cwd) is a runner failure, not command output", { skip }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const policy = makePolicy(ws, scratch(t, "sbx-tmp-"));
	const res = await new LinuxBwrapBackend().confine({ argv: ["/bin/true"], cwd: join(ws, "gone"), policy });
	assert.ok(res.ok);
	const out = await runCapture(res.confined.argv, res.confined.env, 10_000);
	assert.equal(classifyRun(res.confined, { exitCode: out.code, output: out.output }).kind, "runner-failure", out.output);
});

test("mountPlan: deeper paths land later; pins only between the nearest writable root and the protected path", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "sbx-plan-")));
	try {
		mkdirSync(join(base, "ws", "a", "b"), { recursive: true });
		writeFileSync(join(base, "ws", "a", "b", "secret"), "s");
		const { ops } = mountPlan(makePolicy(join(base, "ws"), base, { hidden: [join(base, "ws", "a", "b", "secret")] }));
		const paths = ops.map((o) => `${o.op}:${o.path.slice(base.length)}`);
		assert.deepEqual(paths, ["bind:/ws", "bind:/ws/a", "bind:/ws/a/b", "hide-file:/ws/a/b/secret"]);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("network proxy: the allowlist decides, direct egress is impossible (no live host can fail this)", { skip: skip || (!HAVE_SOCAT && "no socat") }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const sockDir = scratch(t, "sbx-sock-");
	const socket = join(sockDir, "p.sock");
	// ".invalid" never resolves (RFC 6761): an allowlisted name passes the allowlist and then
	// fails at the dial with 502, whatever the network is doing.
	const allow = ["sbx-allowed.invalid", "api.github.com"];
	const decisions: { host: string; allowed: boolean; reason?: string }[] = [];
	const px = await startProxy({ socket, allow, onDecision: (d) => decisions.push(d) });
	t.after(() => px.close());
	const policy = makePolicy(ws, scratch(t, "sbx-tmp-"), { network: { mode: "proxy", proxy: { socket, allow } } });
	const b = new LinuxBwrapBackend();
	assert.deepEqual(await b.probe(policy), { ok: true, enforcement: "full", network: "proxy" });
	const r = await run(b, policy, [
		`curl -sS -m 10 -o /dev/null https://example.com`,
		`curl -sS -m 10 http://example.com/`,
		`curl -sS -m 10 -o /dev/null https://sbx-allowed.invalid/`,
		`curl -sS -m 10 http://sbx-allowed.invalid/`,
		`curl -sS -m 10 --noproxy '*' -o /dev/null -w "direct=%{http_code}\\n" https://api.github.com`,
		`true`,
	].join("; "));
	// Refused by the allowlist: CONNECT → 403, plain HTTP → the 403 body.
	assert.match(r.output, /CONNECT tunnel failed, response 403/);
	assert.match(r.output, /sova sandbox: example\.com is not in the sandbox proxy allowlist/);
	// Allowed: past the allowlist, then the dial fails (502), never a 403.
	assert.match(r.output, /CONNECT tunnel failed, response 502/);
	assert.match(r.output, /sova sandbox proxy: cannot resolve sbx-allowed\.invalid/);
	assert.ok(decisions.some((d) => d.host === "example.com" && !d.allowed));
	assert.ok(decisions.filter((d) => d.host === "sbx-allowed.invalid").every((d) => d.allowed === false && /cannot resolve/.test(d.reason ?? "")));
	assert.ok(!decisions.some((d) => d.host === "sbx-allowed.invalid" && /allowlist/.test(d.reason ?? "")));
	// No route out except the proxy.
	assert.match(r.output, /direct=000/);
	// Optional live check, never failing: a real allowlisted host through the tunnel.
	const live = await run(b, policy, `curl -sS -m 15 -o /dev/null -w "tunnel=%{http_connect} status=%{http_code}" https://api.github.com/zen; true`);
	t.diagnostic(`live api.github.com through the proxy: ${live.output.trim()}`);
});

test("network proxy degrades to none, never host, when socat or the socket is missing", { skip }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const tmp = scratch(t, "sbx-tmp-");
	const noSocket = await new LinuxBwrapBackend().confine({
		argv: ["/bin/true"], cwd: ws,
		policy: makePolicy(ws, tmp, { network: { mode: "proxy", proxy: { socket: join(ws, "absent.sock"), allow: [] } } }),
	});
	assert.ok(noSocket.ok);
	assert.equal(noSocket.confined.network, "none");
	assert.ok(noSocket.confined.argv.includes("--unshare-net"));
	assert.match(noSocket.confined.notes?.join() ?? "", /proxy socket/);
	const noSocat = await new LinuxBwrapBackend().confine({
		argv: ["/bin/true"], cwd: ws,
		policy: makePolicy(ws, tmp, { env: { PATH: "/nonexistent" }, network: { mode: "proxy", proxy: { socket: join(ws, "x.sock"), allow: [] } } }),
	});
	assert.ok(noSocat.ok);
	assert.equal(noSocat.confined.network, "none");
	assert.match(noSocat.confined.notes?.join() ?? "", /socat/);
});

test("argv is built without a shell: a hostile command stays one argument", { skip }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const cmd = `echo "$(id -u)"; echo '; rm -rf / #'`;
	const res = await new LinuxBwrapBackend().confine({ argv: ["/bin/bash", "-c", cmd], cwd: ws, policy: makePolicy(ws, scratch(t, "sbx-tmp-")) });
	assert.ok(res.ok);
	assert.equal(res.confined.argv.at(-1), cmd);
	assert.equal(res.confined.argv.at(-3), "/bin/bash");
	const r = spawnSync(res.confined.argv[0]!, res.confined.argv.slice(1), { env: res.confined.env, encoding: "utf8" });
	assert.match(r.stdout, /; rm -rf \/ #/);
});

test("trust stores in a writable state dir stay read-only and cannot be planted when absent", { skip }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const home = scratch(t, "sbx-home-");
	const mise = join(home, ".local", "state", "mise");
	mkdirSync(join(mise, "tracked-configs"), { recursive: true }); // trusted-configs absent: must be created, then pinned
	const policy = makePolicy(ws, scratch(t, "sbx-tmp-"), { writable: [ws, mise], env: { ...scrubEnv(process.env), HOME: home, XDG_STATE_HOME: join(home, ".local", "state") } });
	const r = await run(new LinuxBwrapBackend(), policy, [
		`touch ${mise}/trusted-configs/x`,
		`ln -s ${ws}/.mise.toml ${mise}/tracked-configs/y`,
		`mv ${mise}/trusted-configs ${mise}/t2`,
		`rm -rf ${mise}/trusted-configs`,
		`echo ok > ${mise}/other`,
		`true`,
	].join("; "));
	assert.equal(existsSync(join(mise, "trusted-configs", "x")), false, r.output);
	assert.equal(existsSync(join(mise, "tracked-configs", "y")), false);
	assert.equal(existsSync(join(mise, "t2")), false);
	assert.equal(existsSync(join(mise, "trusted-configs")), true);
	assert.equal(readFileSync(join(mise, "other"), "utf8"), "ok\n", "the rest of the state dir stays writable");
});

test("the real ~/.local/state/mise/trusted-configs is not writable under the default writable roots", { skip: skip || (!existsSync(join(homedir(), ".local/state/mise/trusted-configs")) && "no mise state here") }, async (t) => {
	const ws = scratch(t, "sbx-ws-");
	const b = new LinuxBwrapBackend();
	const defaults = b.platformDefaults({ home: homedir(), agentDir: join(homedir(), ".pi", "agent") });
	const target = join(homedir(), ".local/state/mise/trusted-configs", `sbx-${rand()}`);
	t.after(() => rmSync(target, { force: true }));
	await run(b, makePolicy(ws, scratch(t, "sbx-tmp-"), { writable: [ws, ...defaults.writable] }), `touch ${target}; true`);
	assert.equal(existsSync(target), false);
});

test("parity: checkWrite's verdict equals what the bwrap profile actually lets through", { skip }, async (t) => {
	const { checkWrite } = await import("../../backend.ts");
	const ws = scratch(t, "sbx-ws-");
	const tmp = scratch(t, "sbx-tmp-");
	const outside = scratch(t, "sbx-out-");
	git(ws, "init", "-q");
	mkdirSync(join(ws, ".agent", "sandbox-policy", "linux"), { recursive: true });
	const policyFile = join(ws, ".agent", "sandbox-policy", "linux", "policy.json");
	writeFileSync(policyFile, "{}");
	const policy = makePolicy(ws, tmp, { hidden: [policyFile], readOnlyWithinWritable: [join(ws, "vendor")] });
	mkdirSync(join(ws, "vendor"));
	const targets = [
		join(ws, "a.txt"), join(ws, "sub", "b.txt"), join(ws, ".git", "hooks", "pre-commit"), join(ws, ".git", "config"),
		join(ws, ".git", "objects", "x"), policyFile, join(ws, ".agent", "sandbox-policy", "linux", "new.json"),
		join(ws, "vendor", "v.js"), join(outside, "o.txt"), join(tmp, "t.txt"),
	];
	// Inside the sandbox the session tmp dir is /tmp, so the tmp target is written there.
	const inside = (p: string) => (p.startsWith(tmp + "/") ? "/tmp/" + p.slice(tmp.length + 1) : p);
	const cmd = targets.map((p) => `mkdir -p "$(dirname '${inside(p)}')" 2>/dev/null; echo w > '${inside(p)}' 2>/dev/null`).join("; ") + "; true";
	await run(new LinuxBwrapBackend(), policy, cmd);
	for (const p of targets) {
		const wrote = existsSync(p) && readFileSync(p, "utf8") === "w\n";
		assert.equal(wrote, checkWrite(policy, p).ok, p);
	}
});

test("shadowed ~/.cache: writes land in the shadow source, persist across commands, never touch the host cache", { skip: skip || (!existsSync(join(homedir(), ".cache")) && "no ~/.cache") }, async (t) => {
	const { checkWrite, mapShadowed, shadowSource } = await import("../../backend.ts");
	const ws = scratch(t, "sbx-ws-");
	const agentDir = scratch(t, "sbx-agent-");
	const cache = realpathSync(join(homedir(), ".cache"));
	const source = shadowSource(agentDir, cache);
	const name = `sbx-${rand()}`;
	t.after(() => rmSync(join(cache, name), { force: true }));
	const policy = makePolicy(ws, scratch(t, "sbx-tmp-"), { shadowed: [{ path: cache, source }] });
	const b = new LinuxBwrapBackend();
	assert.equal((await b.probe(policy)).ok, true);
	await run(b, policy, `echo one > ${cache}/${name}`);
	assert.equal(existsSync(join(cache, name)), false, "host ~/.cache untouched");
	assert.equal(readFileSync(join(source, name), "utf8"), "one\n");
	const second = await run(b, policy, `cat ${cache}/${name}`);
	assert.equal(second.output, "one\n", "persists across commands");
	// The write tool's path: judge the view path, write the mapped one; bash then sees it.
	const viaTool = join(cache, `${name}-tool`);
	assert.ok(checkWrite(policy, viaTool).ok);
	writeFileSync(mapShadowed(policy, viaTool), "tool\n");
	assert.equal(existsSync(viaTool), false);
	assert.equal((await run(b, policy, `cat ${viaTool}`)).output, "tool\n");
});

test("test-server layout: shadow source under the read-only agent dir inside cwd; shadow writable, source and policy not", { skip }, async (t) => {
	const { checkWrite, shadowSource } = await import("../../backend.ts");
	const ws = scratch(t, "sbx-ws-");
	const agentDir = join(ws, ".agent");
	const policyFile = join(agentDir, "sandbox-policy", "linux", "policy.json");
	mkdirSync(dirname(policyFile), { recursive: true });
	writeFileSync(policyFile, "{}\n");
	const cache = scratch(t, "sbx-cache-");
	const source = shadowSource(agentDir, cache);
	const policy = makePolicy(ws, scratch(t, "sbx-tmp-"), {
		readOnlyWithinWritable: [agentDir], hidden: [policyFile], shadowed: [{ path: cache, source }],
	});
	const r = await run(new LinuxBwrapBackend(), policy, [
		`echo a > ${cache}/a`,
		`echo b > ${source}/b`,
		`echo x > ${policyFile}`,
		`mv ${agentDir} ${ws}/.agent2`,
		`mv ${source} ${source}-moved`,
		`true`,
	].join("; "));
	assert.equal(readFileSync(join(source, "a"), "utf8"), "a\n", r.output);
	assert.equal(existsSync(join(cache, "a")), false);
	assert.equal(existsSync(join(source, "b")), false);
	assert.equal(readFileSync(policyFile, "utf8"), "{}\n");
	assert.equal(existsSync(join(ws, ".agent2")), false);
	assert.equal(existsSync(`${source}-moved`), false);
	assert.equal(checkWrite(policy, join(cache, "a")).ok, true);
	assert.equal(checkWrite(policy, join(source, "b")).ok, false);
	assert.equal(checkWrite(policy, policyFile).ok, false);
});

test("mountPlan: pins and read-only paths inside a shadow are bound from the shadow, never from the host", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "sbx-plan-")));
	try {
		const cache = join(base, "cache");
		const source = join(base, "src");
		mkdirSync(join(cache, "a", "b"), { recursive: true }); // host content that must not show through
		mkdirSync(join(source, "a", "b"), { recursive: true });
		writeFileSync(join(source, "a", "b", "keep"), "k");
		mkdirSync(join(base, "ws"));
		const { ops } = mountPlan(makePolicy(join(base, "ws"), base, { shadowed: [{ path: cache, source }], readOnlyWithinWritable: [join(cache, "a", "b", "keep")] }));
		const inCache = ops.filter((o) => o.path.startsWith(cache));
		assert.deepEqual(
			inCache.map((o) => [o.op, o.path.slice(base.length), "source" in o && o.source ? o.source.slice(base.length) : undefined]),
			[["bind", "/cache", "/src"], ["bind", "/cache/a", "/src/a"], ["bind", "/cache/a/b", "/src/a/b"], ["ro", "/cache/a/b/keep", "/src/a/b/keep"]],
		);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
