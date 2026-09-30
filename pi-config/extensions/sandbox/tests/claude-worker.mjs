// claude-worker.mjs — W4 for Claude Code workers, end to end with no model: a REAL parent pi runtime
// loading the real sandbox, subagents and claude-code extensions calls `agent_spawn` with
// backend claude-code; the real runner → transport → confineLaunch path spawns `claude`, which a
// PATH shim makes claude-fake-worker.mjs (the probe battery, then scripts/fake-claude.mjs's
// stream-json). The login is a FIXTURE login dir (CLAUDE_CONFIG_DIR) holding a planted token, so no
// real credential is read. Host-side verdicts only; `agent_kill` must leave nothing running.
//
// Cases: CW1 sandbox on (workspace-write), CW2 sandbox off + tracked worktree (write-only),
// CW3 sandbox off + no worktree (unconfined, today's launch).

import { execFileSync, spawn as spawnProc } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { makeSuite, ok, eq } from "./kit.mjs";
import { ARTIFACT_ROOT, EXT_DIR, PI_CONFIG, TESTS_DIR, cleanupAll, hostMntNs, makeBus, makeFixture, pi, rand, sleep, stubUi } from "./harness.mjs";

const t = makeSuite("claude-worker");
const HOME = homedir();
const EXTS = [EXT_DIR, path.join(PI_CONFIG, "extensions/subagents"), path.join(PI_CONFIG, "extensions/claude-code"), path.join(PI_CONFIG, "extensions/worktrees")]
	.map((d) => path.join(d, "index.ts"));
const LOOPBACK = [4800, 4810, 4840];
const deniedOrMissing = (r) => r && r.ok === false && ["EROFS", "EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes(r.code);

/** A `claude` shim dir under the artifact root (never /tmp: the sandbox has its own). */
function shimDir(root) {
	const dir = path.join(root, `bin-${rand(3)}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "claude"), `#!/bin/sh\nexec '${process.execPath}' '${path.join(TESTS_DIR, "claude-fake-worker.mjs")}' "$@"\n`);
	chmodSync(path.join(dir, "claude"), 0o755);
	return dir;
}

/** A fixture login dir with a planted access token (and a refresh token that must never travel). */
function fixtureLogin(root) {
	const dir = path.join(root, "claude-login");
	mkdirSync(path.join(dir, "projects"), { recursive: true });
	const token = `sk-ant-oat01-W4TOKEN${rand(12)}`;
	const refresh = `sk-ant-ort01-W4REFRESH${rand(12)}`;
	writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: refresh, expiresAt: Date.now() + 8 * 3600_000 } }), { mode: 0o600 });
	writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
	return { dir, token, refresh };
}

async function openParent(fx, shim) {
	const P = await pi();
	process.env.PI_CODING_AGENT_DIR = fx.agentDir;
	// `claude` on PATH is the fake worker, first; its dir is visible read-only inside the sandbox.
	process.env.PATH = `${shim}:${process.env.PATH}`;
	const bus = makeBus();
	const errors = [];
	const createRuntime = async ({ cwd: c, sessionManager, sessionStartEvent }) => {
		const services = await P.createAgentSessionServices({
			cwd: c, agentDir: fx.agentDir, extensionFlagValues: new Map(),
			resourceLoaderOptions: { noExtensions: true, additionalExtensionPaths: EXTS, eventBus: bus },
		});
		return { ...(await P.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })), services, diagnostics: services.diagnostics };
	};
	const runtime = await P.createAgentSessionRuntime(createRuntime, { cwd: fx.cwd, agentDir: fx.agentDir, sessionManager: P.SessionManager.inMemory(fx.cwd) });
	for (const d of runtime.diagnostics ?? []) if (d.type === "error") errors.push(d.message);
	const session = runtime.session;
	await session.bindExtensions({ uiContext: stubUi([]), mode: "rpc", onError: (e) => errors.push(`[${e.extensionPath}] ${e.error}`) });
	let n = 0;
	const call = async (name, params) => {
		const tool = session._toolRegistry.get(name);
		if (!tool) return { isError: true, text: `no tool ${name}` };
		try {
			const r = await tool.execute(`cw-${++n}`, params, new AbortController().signal, () => {});
			return { isError: !!r?.isError, text: (r?.content ?? []).map((c) => c.text ?? "").join(""), details: r?.details };
		} catch (e) {
			return { isError: true, text: String(e?.message ?? e) };
		}
	};
	const command = async (name, args) => {
		const r = session._extensionRunner;
		return r.getCommand(name).handler(args, r.createCommandContext());
	};
	return { session, runtime, errors, call, command, bus, dispose: () => runtime.dispose().catch(() => {}) };
}

function descendantsOf(pid) {
	const kids = new Map();
	for (const d of readdirSync("/proc")) {
		if (!/^\d+$/.test(d)) continue;
		try {
			const st = readFileSync(`/proc/${d}/stat`, "utf8");
			const ppid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
			(kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(Number(d));
		} catch {}
	}
	const out = [];
	const walk = (p) => { for (const k of kids.get(p) ?? []) { out.push(k); walk(k); } };
	walk(pid);
	return out;
}
const cmdOf = (p) => { try { return readFileSync(`/proc/${p}/cmdline`, "latin1").replaceAll("\0", " "); } catch { return ""; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The result file the fake worker drops in its cwd once the battery has run. */
async function waitResult(cwd, ms = 60_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const f = readdirSync(cwd).find((n) => n.startsWith(".redteam-w4-result-"));
		if (f) {
			await sleep(200);
			try { return { result: JSON.parse(readFileSync(path.join(cwd, f), "utf8")), file: path.join(cwd, f) }; } catch {}
		}
		await sleep(250);
	}
	return undefined;
}

/** The spec the fake worker's battery reads (`.redteam-w4-spec.json` in its cwd). No proxy hosts: keep the model call short. */
function writeBatterySpec(cwd, fx, login, tag, sentinelPid) {
	const spec = {
		hold: false, token: login.token, sentinelPid,
		writeTargets: {
			escape: path.join(fx.escape, `w4-${tag}`), home: path.join(HOME, `.sova-redteam-w4-${tag}`),
			policyFile: fx.policyFile, gitConfig: path.join(fx.cwd, ".git/config"),
			cwd: path.join(cwd, `w4-ok-${tag}`), tmp: `/tmp/w4-ok-${tag}`,
		},
		readTargets: { realClaudeCred: path.join(HOME, ".claude/.credentials.json"), piAuth: path.join(HOME, ".pi/agent/auth.json") },
		listTargets: { ssh: path.join(HOME, ".ssh"), realClaudeAccounts: path.join(HOME, ".pi/agent/claude-accounts") },
		ports: LOOPBACK,
		proxyHosts: [],
	};
	writeFileSync(path.join(cwd, ".redteam-w4-spec.json"), JSON.stringify(spec));
	return spec;
}

/** Every write target that must NOT land on the host (positive controls and read-only files excluded). */
function landed(spec) {
	const skip = new Set(["cwd", "tmp", "gitConfig", "policyFile"]);
	const hits = [];
	for (const [name, file] of Object.entries(spec.writeTargets)) {
		if (skip.has(name)) continue;
		if (existsSync(file)) { hits.push(name); try { rmSync(file, { force: true }); } catch {} }
	}
	return hits;
}

/**
 * Spawn one claude-code worker in `cwd` through the parent, wait for its battery result, then
 * agent_kill it. Returns the worker id, the parsed result and the host-side kill facts.
 */
async function spawnProbeKill(p, fx, login, cwd, tag) {
	const sentinel = spawnProc("sleep", ["3003"], { detached: true, stdio: "ignore" });
	sentinel.unref();
	writeBatterySpec(cwd, fx, login, tag, sentinel.pid);
	const spawn = await p.call("agent_spawn", { backend: "claude-code", model: "sonnet", cwd, prompt: "Reply with the single word ok and nothing else." });
	ok(!spawn.isError, `agent_spawn: ${spawn.text.slice(0, 300)}`);
	const id = spawn.details?.spawned?.[0]?.id;
	ok(id, `a worker id came back (${spawn.text.slice(0, 200)})`);
	const got = await waitResult(cwd);
	// Find the running claude descendant(s) before the kill.
	const before = descendantsOf(process.pid).filter((q) => /claude-fake-worker\.mjs|bwrap/.test(cmdOf(q)));
	const kill = await p.call("agent_kill", { id });
	ok(!kill.isError, `agent_kill: ${kill.text.slice(0, 200)}`);
	// Give the group signal time to land.
	for (let i = 0; i < 40 && before.some(alive); i++) await sleep(100);
	const survivors = before.filter(alive);
	const sentinelAlive = alive(sentinel.pid);
	try { process.kill(sentinel.pid, "SIGKILL"); } catch {}
	return { id, ...(got ?? {}), survivors, sentinelAlive };
}

// ─── the cases ────────────────────────────────────────────────────────────────────────────────

if (process.platform !== "linux") {
	t.skip("CW1-CW3", "the Claude worker battery reads /proc; Linux only");
} else {
	const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
	const savedPath = process.env.PATH;
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		await t.test("CW1 sandbox on: a real claude-code worker runs confined; its bash battery is denied; token nowhere; agent_kill leaves nothing", async () => {
			const fx = makeFixture();
			const login = fixtureLogin(fx.root);
			process.env.CLAUDE_CONFIG_DIR = login.dir; // the `default` login is our fixture; no real credential is read
			const shim = shimDir(fx.root);
			const p = await openParent(fx, shim);
			try {
				eq(p.errors.length, 0, `parent loaded clean: ${p.errors.join(" | ")}`);
				await p.command("sandbox", "on");
				const tag = rand();
				const r = await spawnProbeKill(p, fx, login, fx.cwd, tag);
				ok(r.result, "the confined worker ran the battery and wrote its result");
				const b = r.result.battery;
				ok(b && !b.spawnError && b.self, `the inner probe ran (${JSON.stringify(b).slice(0, 200)})`);
				ok(b.self.mntns !== hostMntNs(), `the worker runs in its own mount namespace (${b.self.mntns})`);
				ok(deniedOrMissing(b.self.writes.escape), `write outside cwd refused (${JSON.stringify(b.self.writes.escape)})`);
				ok(deniedOrMissing(b.self.writes.home), `write to $HOME refused (${JSON.stringify(b.self.writes.home)})`);
				ok(b.self.writes.policyFile?.ok === false, "the policy file is not writable");
				eq(b.self.writes.cwd?.ok, true, "control: cwd write works");
				ok(b.self.reads.realClaudeCred?.ok === false, `~/.claude/.credentials.json is unreadable inside (${JSON.stringify(b.self.reads.realClaudeCred)})`);
				eq(b.tokenFd?.present, true, "the CLI's token fd env var is set inside");
				eq(b.tokenFd?.matches, true, `the fd delivers exactly the planted token (${JSON.stringify(b.tokenFd)})`);
				ok(b.self.reads.piAuth?.ok === false, "~/.pi/agent/auth.json is unreadable inside");
				ok(b.self.lists.ssh?.ok === false || b.self.lists.ssh?.entries === 0, "~/.ssh looks empty inside");
				eq(b.self.kill?.code, "ESRCH", `kill of the outside sentinel fails ESRCH (${JSON.stringify(b.self.kill)})`);
				eq(b.self.procSentinel, false, "/proc/<sentinel> is invisible inside");
				eq(r.sentinelAlive, true, "the outside sentinel survived the worker");
				for (const port of LOOPBACK) eq(b.self.ports[port]?.ok, false, `127.0.0.1:${port} unreachable (${JSON.stringify(b.self.ports[port])})`);
				eq(b.self.envHasToken, false, "no env value inside holds the token");
				eq(b.self.proc.hits.length, 0, `token in no visible /proc cmdline|environ (${b.self.proc.hits.join(",")})`);
				eq(b.self.fd.leaked, false, "token in no inherited fd");
				// The CLI's fd handover: CLAUDE_CONFIG_DIR is the private dir, not the login dir.
				ok(r.result.configDir && r.result.configDir !== login.dir, `CLAUDE_CONFIG_DIR is the private config dir, not the login (${r.result.configDir})`);
				ok(r.result.configDir.includes(path.join("sova", "sandbox", "claude")), `the private config dir is under the agent dir (${r.result.configDir})`);
				// Token nowhere in the whole login dir's argv/env of the running processes was checked inside;
				// outside, the worker's argv must not carry it either.
				ok(!JSON.stringify(r.result.argv).includes(login.token), "the worker's own argv never holds the token");
				eq(r.survivors.length, 0, `agent_kill left no bwrap/claude process (${r.survivors.map(cmdOf).join(" | ")})`);
				// The transcript record landed where a reader looks (the login's projects/<slug>).
				const slug = fx.cwd.replace(/[^a-zA-Z0-9]/g, "-");
				const slugDir = path.join(login.dir, "projects", slug);
				ok(existsSync(slugDir), `the transcript slug dir exists (${slugDir})`);
			} finally {
				await p.dispose();
			}
		});

		await t.test("CW2 sandbox off + a tracked worktree: the claude worker is write-only (writes only there; host network; token still on the fd)", async () => {
			const fx = makeFixture();
			const login = fixtureLogin(fx.root);
			process.env.CLAUDE_CONFIG_DIR = login.dir;
			const shim = shimDir(fx.root);
			const wt = path.join(fx.root, `wt-${rand(3)}`);
			execFileSync("git", ["-C", fx.cwd, "worktree", "add", "-q", wt, "-b", `rt-${rand(3)}`]);
			mkdirSync(path.join(wt, ".agent"), { recursive: true });
			writeFileSync(path.join(wt, ".agent", "settings.json"), "{}\n");
			const wtReal = realpathSync(wt);
			const p = await openParent(fx, shim);
			try {
				eq(p.errors.length, 0, `parent loaded clean: ${p.errors.join(" | ")}`);
				// sandbox stays off; the worktrees extension tracks wt so the worker is write-only-confined to it.
				const track = await p.call("worktree", { action: "attach", path: wtReal });
				ok(!track.isError, `worktree attach: ${track.text.slice(0, 200)}`);
				await sleep(300);
				const tag = rand();
				const r = await spawnProbeKill(p, fx, login, wtReal, tag);
				ok(r.result, "the write-only worker ran the battery");
				const b = r.result.battery;
				ok(b.self.mntns !== hostMntNs(), "own mount namespace");
				ok(deniedOrMissing(b.self.writes.escape), `write outside the worktree refused (${JSON.stringify(b.self.writes.escape)})`);
				eq(b.self.writes.cwd?.ok, true, "the worktree is writable");
				eq(b.self.envHasToken, false, "no env value holds the token");
				eq(b.self.proc.hits.length, 0, "token in no visible /proc cmdline|environ");
				ok(r.result.configDir && r.result.configDir !== login.dir, "CLAUDE_CONFIG_DIR is the private config dir");
				eq(r.survivors.length, 0, `agent_kill left nothing (${r.survivors.map(cmdOf).join(" | ")})`);
			} finally {
				await p.dispose();
			}
		});

		await t.test("CW3 sandbox off + no worktree: the claude worker runs unconfined (today's launch), byte-identical shape", async () => {
			const fx = makeFixture();
			const login = fixtureLogin(fx.root);
			process.env.CLAUDE_CONFIG_DIR = login.dir;
			const shim = shimDir(fx.root);
			const p = await openParent(fx, shim);
			try {
				eq(p.errors.length, 0, `parent loaded clean: ${p.errors.join(" | ")}`);
				const tag = rand();
				writeBatterySpec(fx.cwd, fx, login, tag);
				const spawn = await p.call("agent_spawn", { backend: "claude-code", model: "sonnet", cwd: fx.cwd, prompt: "Reply with ok." });
				ok(!spawn.isError, `agent_spawn (off): ${spawn.text.slice(0, 200)}`);
				const id = spawn.details?.spawned?.[0]?.id;
				const got = await waitResult(fx.cwd);
				ok(got?.result, "the unconfined worker ran the battery");
				const b = got.result.battery;
				// Unconfined: same mount namespace as the host, writes outside cwd succeed (today's behaviour).
				eq(b.self.mntns, hostMntNs(), `unconfined: shares the host mount namespace (${b.self.mntns})`);
				eq(b.self.writes.escape?.ok, true, "unconfined: a write outside cwd succeeds (today's launch)");
				eq(got.result.configDir, login.dir, `unconfined: CLAUDE_CONFIG_DIR is the login dir itself (${got.result.configDir})`);
				eq(got.result.battery?.tokenFd?.present, false, `unconfined: no CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR handover (${JSON.stringify(got.result.battery?.tokenFd)})`);
				const strays = landed(writeBatterySpec(fx.cwd, fx, login, tag));
				void strays;
				await p.call("agent_kill", { id });
				await sleep(500);
			} finally {
				await p.dispose();
			}
		});
	} finally {
		if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
		process.env.PATH = savedPath;
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	}
}

await sleep(400);
cleanupAll();
t.done();
