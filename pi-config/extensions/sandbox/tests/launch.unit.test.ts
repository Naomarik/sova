// confineLaunch (launch.ts): a whole worker process confined under its parent's scope. The
// composition through a capturing fake backend (any platform), then real bwrap runs on Linux.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Backend, ConfineRequest, Policy } from "../backend.ts";
import { LinuxBwrapBackend } from "../backends/linux-bwrap.ts";
import { type ConfinedLaunch, confineLaunch, decodeLaunchScope, encodeLaunchScope, type LaunchNeeds, releaseWorkerTmp, workerTmpDir } from "../launch.ts";
import { narrowScope, type ParentScope, writeOnlyScope } from "../policy.ts";
import { sessionTmpBase } from "../session-policy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(mkdtempSync(join("/var/tmp", "sbx-launch-")));
const agentDir = join(root, "agent");
mkdirSync(join(agentDir, "sandbox-policy"), { recursive: true });
cpSync(join(HERE, "..", "..", "..", "sandbox-policy"), join(agentDir, "sandbox-policy"), { recursive: true });
const sessionId = `launch-test-${process.pid}`;
test.after(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(join(sessionTmpBase(), sessionId), { recursive: true, force: true });
});

const linux = process.platform === "linux" && existsSync("/usr/bin/bwrap");

/** A workspace with a tracked-worktree-like `.agent`, a private state dir, a ledger file and a transcript source. */
function world(name: string) {
	const base = join(root, name);
	const ws = join(base, "ws");
	mkdirSync(join(ws, ".agent"), { recursive: true });
	const priv = join(base, "private");
	mkdirSync(priv, { recursive: true });
	const ledger = join(base, "ledger.jsonl");
	writeFileSync(ledger, "");
	const projects = join(base, "projects-src");
	mkdirSync(projects, { recursive: true });
	const secretDir = join(base, "secret");
	mkdirSync(secretDir);
	const full: ParentScope = { version: 1, level: "workspace-write", workspaceRoot: ws, writable: [ws], readOnly: [join(ws, ".agent")], hidden: [secretDir], proxyAllow: ["registry.npmjs.org"], envAllow: [] };
	return { base, ws, priv, ledger, projects, secretDir, full };
}

const scopeOf = (parent: ParentScope, owner = "w1") => encodeLaunchScope({ v: 1, agentDir, sessionId, owner, parent });

/** A backend that records what it was asked and wraps with a marker instead of a sandbox. */
function fakeBackend(probe: Awaited<ReturnType<Backend["probe"]>> = { ok: true, enforcement: "full", network: "none" }) {
	const seen: { probe?: Policy; confine?: ConfineRequest } = {};
	const real = new LinuxBwrapBackend();
	const backend: Backend = {
		id: "linux-bwrap",
		probe: async (p) => ((seen.probe = p), probe),
		confine: async (req) => {
			seen.confine = req;
			return {
				ok: true,
				confined: {
					argv: ["/sandbox", ...req.argv],
					env: { ...req.policy.env, ...(req.env ?? {}) },
					enforcement: "full",
					network: req.policy.network.mode,
					denialSignatures: [],
					runnerFailure: { fatalSignatures: [] },
					...(req.secretEnv ? { fds: [{ fd: req.secretFd!, data: "SECRET-PAYLOAD" }] } : {}),
				},
			};
		},
		canonicalize: async (p) => p,
		platformDefaults: (ctx) => real.platformDefaults(ctx),
	};
	return { backend, seen };
}

const HOST_ENV = { PATH: "/usr/bin:/bin", HOME: "/home/u", SSH_AUTH_SOCK: "/run/agent", ANTHROPIC_API_KEY: "sk-host", CLAUDECODE: "1" };

function needsFor(w: ReturnType<typeof world>): LaunchNeeds {
	return {
		writable: [w.priv, w.ledger],
		binds: [{ source: w.projects, target: join(w.priv, "projects", "slug") }],
		proxyHosts: ["API.example.com"],
		env: { PROGRAM_CONFIG_DIR: w.priv },
		secretEnv: { PROGRAM_TOKEN: "tok-123" },
		fds: [{ fd: 3, data: "fd-token" }],
		spawnEnv: { PROGRAM_CONFIG_DIR: "/login/dir" },
	};
}

test("composition: the parent's scope, .agent read-only, binds, env allowlist, proxy hosts, secrets on an fd, a tmp per worker", async () => {
	const w = world("compose");
	const { backend, seen } = fakeBackend();
	const r = await confineLaunch(scopeOf(w.full), needsFor(w), { command: "/bin/prog", args: ["--x"], cwd: w.ws, env: HOST_ENV }, { backend, platform: "linux" });
	assert.ok(!("refused" in r), "refused" in r ? r.refused : "");
	const c = r as ConfinedLaunch;
	const p = seen.probe!;
	assert.deepEqual(seen.confine!.policy, p, "the probed policy is the one confined");
	assert.ok(p.writable.includes(w.ws));
	assert.ok(p.readOnlyWithinWritable.includes(join(w.ws, ".agent")), "a tracked worktree's .agent stays read-only");
	assert.ok(p.hidden.includes(w.secretDir), "the parent's hidden list rides along");
	assert.deepEqual(p.binds, [
		{ path: w.priv, source: w.priv },
		{ path: w.ledger, source: w.ledger },
		{ path: join(w.priv, "projects", "slug"), source: w.projects },
	]);
	assert.equal(p.network.mode, "proxy");
	assert.deepEqual(p.network.proxy!.allow, ["registry.npmjs.org", "api.example.com"], "the policy's hosts plus the program's");
	assert.ok(existsSync(p.network.proxy!.socket));
	assert.deepEqual(Object.keys(p.env).sort(), ["HOME", "PATH"], "scrubbed: no agent socket, key or nesting marker");
	assert.deepEqual(seen.confine!.env, { PROGRAM_CONFIG_DIR: w.priv });
	assert.deepEqual(seen.confine!.secretEnv, { PROGRAM_TOKEN: "tok-123" });
	assert.equal(seen.confine!.secretFd, 4, "above every fd the program asked for");
	assert.equal(seen.confine!.envOnFd, true, "the whole environment on the fd, never argv");
	assert.deepEqual(c.fds, [{ fd: 3, data: "fd-token" }, { fd: 4, data: "SECRET-PAYLOAD" }]);
	assert.deepEqual([c.command, ...c.args], ["/sandbox", "/bin/prog", "--x"]);
	assert.deepEqual(c.spawnEnv, { PROGRAM_CONFIG_DIR: "/login/dir" }, "bwrap's own process carries only the outside variables");
	assert.equal(c.env.PROGRAM_CONFIG_DIR, w.priv);
	const flat = JSON.stringify([c.command, c.args, c.env, c.spawnEnv]);
	assert.ok(!flat.includes("tok-123"), "the secret is in no argv, env or spawn env");
	assert.equal(c.tmpDir, join(sessionTmpBase(), sessionId, "w-w1", "tmp"));
	assert.equal(c.tmpInside, "/tmp");
	assert.equal(p.tmpDir, c.tmpDir);
	const other = await confineLaunch(scopeOf(w.full, "w2"), {}, { command: "/bin/prog", args: [], cwd: w.ws, env: HOST_ENV }, { backend, platform: "linux" });
	assert.ok(!("refused" in other));
	assert.notEqual((other as ConfinedLaunch).tmpDir, c.tmpDir, "each worker its own tmp");
	assert.notEqual(seen.probe!.network.proxy!.socket, p.network.proxy!.socket, "each launch its own proxy");
	await c.cleanup();
	assert.equal(existsSync(p.network.proxy!.socket), false, "cleanup stops the proxy");
	await (other as ConfinedLaunch).cleanup();
	releaseWorkerTmp(scopeOf(w.full, "w2"));
	assert.equal(existsSync((other as ConfinedLaunch).tmpDir), false);
	assert.ok(existsSync(c.tmpDir), "only that worker's");
});

test("levels: read-only gets only the program's hosts (none: no network); write-only the host network and env", async () => {
	const w = world("levels");
	const { backend, seen } = fakeBackend();
	const launch = { command: "/bin/prog", args: [], cwd: w.ws, env: HOST_ENV };
	const ro: ParentScope = { ...w.full, level: "read-only", writable: [] };
	const a = await confineLaunch(scopeOf(ro), { proxyHosts: ["api.example.com"], writable: [w.priv] }, launch, { backend, platform: "linux" });
	assert.ok(!("refused" in a));
	assert.equal(seen.probe!.level, "read-only");
	assert.deepEqual(seen.probe!.network.proxy?.allow, ["api.example.com"]);
	assert.deepEqual(seen.probe!.binds, [{ path: w.priv, source: w.priv }], "its own state stays writable under read-only");
	await (a as ConfinedLaunch).cleanup();
	const b = await confineLaunch(scopeOf(ro), {}, launch, { backend, platform: "linux" });
	assert.ok(!("refused" in b));
	assert.equal(seen.probe!.network.mode, "none");
	const wo = await confineLaunch(scopeOf(writeOnlyScope(w.ws)), { proxyHosts: ["api.example.com"], env: { X: "1" } }, launch, { backend, platform: "linux" });
	assert.ok(!("refused" in wo));
	assert.equal(seen.probe!.network.mode, "host");
	assert.deepEqual(seen.probe!.hidden, []);
	assert.equal(seen.probe!.env.SSH_AUTH_SOCK, "/run/agent", "write-only: the environment as it is");
	assert.ok(seen.probe!.readOnlyWithinWritable.includes(join(w.ws, ".agent")));
	assert.equal((wo as ConfinedLaunch).env.X, "1");
	const n = await confineLaunch(scopeOf(narrowScope(w.full, join(w.ws, "sub"))), {}, { ...launch, cwd: w.ws }, { backend, platform: "linux" });
	assert.ok("refused" in n && /outside the parent's sandbox/.test(n.refused), "a cwd outside the narrowed root refuses");
});

test("refusals: probe failure, partial without acceptPartial, bad scope or needs, binds under hidden or over the agent dir", async () => {
	const w = world("refuse");
	const launch = { command: "/bin/prog", args: [], cwd: w.ws, env: HOST_ENV };
	const opts = (probe?: Awaited<ReturnType<Backend["probe"]>>) => ({ backend: fakeBackend(probe).backend, platform: "linux" as const });
	const cases: [string, Promise<unknown>, RegExp][] = [
		["probe", confineLaunch(scopeOf(w.full), {}, launch, opts({ ok: false, reason: "bwrap: nope" })), /^Sandbox unavailable: bwrap: nope\. A worker cannot start sandboxed\.$/],
		["partial", confineLaunch(scopeOf(w.full), {}, launch, opts({ ok: true, enforcement: "partial", reasons: ["r"], network: "none" })), /^Sandbox enforcement is partial \(r\); set acceptPartial/],
		["scope", confineLaunch("{", {}, launch, opts()), /launch scope is not valid JSON/],
		["owner", confineLaunch(encodeLaunchScope({ v: 1, agentDir, sessionId, owner: "../x", parent: w.full }), {}, launch, opts()), /malformed/],
		["relative", confineLaunch(scopeOf(w.full), { writable: ["rel"] }, launch, opts()), /absolute/],
		["fd", confineLaunch(scopeOf(w.full), { fds: [{ fd: 2, data: "x" }] }, launch, opts()), /fds/],
		["hidden", confineLaunch(scopeOf(w.full), { writable: [w.secretDir] }, launch, opts()), /hides/],
		["holds hidden", confineLaunch(scopeOf(w.full), { writable: [w.base] }, launch, opts()), /hides/],
		["agent dir", confineLaunch(scopeOf(w.full), { writable: [agentDir] }, launch, opts()), /agent dir or the policy/],
		["policy", confineLaunch(scopeOf(w.full), { binds: [{ source: w.priv, target: join(agentDir, "sandbox-policy", "x") }] }, launch, opts()), /agent dir or the policy/],
		["missing", confineLaunch(scopeOf(w.full), { writable: [join(w.base, "nope")] }, launch, opts()), /does not exist/],
	];
	for (const [name, p, re] of cases) {
		const r = (await p) as { refused?: string };
		assert.ok(r.refused, name);
		assert.match(r.refused!, re, name);
	}
});

test("workerTmpDir: the default per worker, or a hosted worker's own dir", () => {
	const w = world("tmp");
	const t = workerTmpDir(scopeOf(w.full, "w9"), undefined, "linux");
	assert.equal(t.host, join(sessionTmpBase(), sessionId, "w-w9", "tmp"));
	assert.equal(t.inside, "/tmp");
	const hosted = join(w.base, "hosted-worker");
	const h = workerTmpDir(scopeOf(w.full, "w9"), { tmpDir: hosted }, "darwin");
	assert.deepEqual(h, { host: hosted, inside: hosted });
	assert.ok(decodeLaunchScope(scopeOf(w.full)).ok);
});

/** Spawn a confined launch as a spawner must: spawnEnv exactly, a pipe at each fd with its payload. */
function run(c: ConfinedLaunch, cwd: string): Promise<{ code: number | null; out: string }> {
	return new Promise((done) => {
		const top = Math.max(2, ...c.fds.map((f) => f.fd));
		const stdio: ("ignore" | "pipe")[] = ["ignore", "pipe", "pipe"];
		for (let i = 3; i <= top; i++) stdio.push(c.fds.some((f) => f.fd === i) ? "pipe" : "ignore");
		const child = spawn(c.command, c.args, { cwd, env: c.spawnEnv, stdio });
		for (const f of c.fds) {
			const s = child.stdio[f.fd] as NodeJS.WritableStream;
			s.end(f.data);
		}
		let out = "";
		child.stdout!.on("data", (d) => (out += d));
		child.stderr!.on("data", (d) => (out += d));
		child.on("close", (code) => done({ code, out }));
	});
}

test("real bwrap: secrets arrive inside but never on argv; binds, .agent, tmp and fds as composed", { skip: !linux }, async () => {
	const w = world("bwrap");
	const script = [
		`echo "token=$PROGRAM_TOKEN cfg=$PROGRAM_CONFIG_DIR"`,
		`echo "fd3=$(cat <&3)"`,
		`echo ok > "$PROGRAM_CONFIG_DIR/state" && echo priv-ok`,
		`echo line >> "$1" && echo ledger-ok`,
		`echo t > "$PROGRAM_CONFIG_DIR/projects/slug/rec.jsonl" && echo bind-ok`,
		`echo x > .agent/evil 2>/dev/null && echo agent-WRITABLE || echo agent-ro`,
		`ls "$2" 2>/dev/null | wc -l | sed 's/^/hidden-count=/'`,
		`echo t > /tmp/t && echo tmp-ok`,
		`tr '\\0' ' ' < /proc/1/cmdline | grep -c "tok-12""3" | sed 's/^/argv-hits=/'`,
		`env | grep -c SSH_AUTH_SOCK | sed 's/^/ssh=/'`,
	].join("\n");
	writeFileSync(join(w.secretDir, "key"), "k");
	const needs = needsFor(w);
	const r = await confineLaunch(scopeOf(w.full), needs, { command: "/bin/sh", args: ["-c", script, "sh", w.ledger, w.secretDir], cwd: w.ws, env: { ...process.env, SSH_AUTH_SOCK: "/run/x" } as Record<string, string> });
	assert.ok(!("refused" in r), "refused" in r ? r.refused : "");
	const c = r as ConfinedLaunch;
	try {
		assert.ok(!JSON.stringify([c.command, c.args, c.spawnEnv]).includes("tok-123"));
		assert.ok(c.args.includes("--args"));
		assert.ok(!c.args.includes("--setenv"), "no variable on bwrap's argv under workspace-write");
		assert.ok(!c.args.some((a) => a.startsWith("PROGRAM_CONFIG_DIR") || a === "PATH"), "not even the plain ones");
		const { code, out } = await run(c, w.ws);
		assert.equal(code, 0, out);
		for (const line of [`token=tok-123 cfg=${w.priv}`, "fd3=fd-token", "priv-ok", "ledger-ok", "bind-ok", "agent-ro", "hidden-count=0", "tmp-ok", "argv-hits=0", "ssh=0"]) assert.ok(out.includes(line), `${line} in:\n${out}`);
		assert.equal(readFileSync(join(w.projects, "rec.jsonl"), "utf8"), "t\n", "the bind lands in its source");
		assert.equal(readFileSync(w.ledger, "utf8"), "line\n");
		assert.equal(existsSync(join(w.ws, ".agent", "evil")), false);
		assert.equal(readFileSync(join(c.tmpDir, "t"), "utf8"), "t\n", "/tmp is the worker's own tmp");
	} finally {
		await c.cleanup();
	}
});

test("real bwrap: write-only runs on the host network with writes confined to the root", { skip: !linux }, async () => {
	const w = world("bwrap-wo");
	const outside = join(w.base, "outside.txt");
	const r = await confineLaunch(scopeOf(writeOnlyScope(w.ws)), { writable: [w.priv] }, { command: "/bin/sh", args: ["-c", `echo a > in.txt; echo b > "$1" 2>/dev/null; echo c > .agent/x 2>/dev/null; echo d > "$2/s"; echo "gh=$GH_TOKEN"; grep -c : /proc/net/dev`, "sh", outside, w.priv], cwd: w.ws, env: { ...(process.env as Record<string, string>), GH_TOKEN: "gh-planted" } });
	assert.ok(!("refused" in r), "refused" in r ? r.refused : "");
	const c = r as ConfinedLaunch;
	assert.ok(!c.args.includes("--setenv"), "no variable on bwrap's argv");
	assert.ok(!JSON.stringify([c.command, c.args, c.spawnEnv]).includes("gh-planted"), "the host's tokens stay off argv and the spawn env");
	const { code, out } = await run(c, w.ws);
	await c.cleanup();
	assert.equal(code, 0, out);
	assert.ok(existsSync(join(w.ws, "in.txt")));
	assert.equal(existsSync(outside), false);
	assert.equal(existsSync(join(w.ws, ".agent", "x")), false, "the root's .agent stays read-only");
	assert.ok(existsSync(join(w.priv, "s")));
	assert.ok(out.includes("gh=gh-planted"), "write-only: the host environment still arrives inside");
	assert.ok(Number(out.trim().split("\n").at(-1)) > 1, "the host's interfaces");
});
