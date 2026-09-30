// claude-confine.mjs — the worker launch seam (launch.ts `confineLaunch`, state.ts `workerLaunch`) as
// a Claude Code worker uses it: the WHOLE process confined, and every child it starts (an MCP
// server) with it. The scope comes from a REAL parent runtime's `sandbox:state` emission (the tap
// worker-inheritance W4 uses), never hand-built; the launch is spawned for real exactly as
// `ConfinedLaunch` says (command/args/spawnEnv/fds, detached, no shell), and every verdict is
// checked on the HOST side or by the inner probe (claude-probe-inner.mjs), whose JSON the suite
// judges. No model is called anywhere; `claude --version` is the only real Claude run.
//
// Cases: CC0 routing (pi keeps its flags, other backends get a confinement), CC1 real
// `claude --version`, CC2 the launcher and its MCP child under workspace-write (writes, hidden
// paths, read-only paths, kill and /proc, loopback, env allowlist, token nowhere, proxy allowlist),
// CC3 read-only (API-only network), CC4 write-only in a tracked worktree with the sandbox off,
// CC5 off and no worktree = nothing applied, CC6 fail closed, CC7 no survivors.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { makeSuite, ok, eq } from "./kit.mjs";
import {
	EXT_DIR, FORBIDDEN_ENV, TESTS_DIR, cleanupAll, hostHttpStatus, hostListener, hostMntNs, jiti, makeBus, makeFixture, openSession, rand, sleep,
} from "./harness.mjs";

const t = makeSuite("claude-confine");
const INNER = path.join(TESTS_DIR, "claude-probe-inner.mjs");
const HOME = homedir();
const API_HOSTS = ["api.anthropic.com"];
const LOOPBACK = [4800, 4810, 4840];
const denied = (r) => r && r.ok === false && ["EROFS", "EACCES", "EPERM"].includes(r.code);
const deniedOrMissing = (r) => r && r.ok === false && ["EROFS", "EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes(r.code);

let state;
let LAUNCH;
let loadError;
try {
	state = await jiti.import(path.join(EXT_DIR, "state.ts"));
	LAUNCH = await jiti.import(path.join(EXT_DIR, "launch.ts"));
} catch (err) {
	loadError = err;
}

/** A real parent runtime with the sandbox extension on a tapped bus; its newest `sandbox:state`. */
async function parentRuntime(fx, { on = true, level, worktreeRoots } = {}) {
	if (level) {
		const pf = JSON.parse(readFileSync(fx.policyFile, "utf8"));
		pf.level = level;
		writeFileSync(fx.policyFile, `${JSON.stringify(pf, null, 2)}\n`);
	}
	const bus = makeBus();
	const emitted = [];
	bus.on(state.SANDBOX_STATE_EVENT, (e) => emitted.push(e));
	const parent = await openSession({ cwd: fx.cwd, agentDir: fx.agentDir, withExtension: true, eventBus: bus });
	eq(parent.errors.length, 0, `parent loaded clean: ${parent.errors.join(" | ")}`);
	if (on) await parent.command("sandbox", "on");
	if (worktreeRoots) {
		bus.emit("worktrees:state", { version: 1, active: worktreeRoots });
		await sleep(300); // the extension re-snapshots, then emits
	}
	bus.emit(state.SANDBOX_DISCOVER_EVENT, { version: 1 });
	const last = emitted.at(-1);
	ok(last, "the parent emitted its sandbox state on the tapped bus");
	return { parent, bus, last, emitted };
}

/** The Claude-shaped needs, with fixture paths: a private config dir, a projects bind, the token on fd 3. */
function claudeNeeds(fx, token, extra = {}) {
	const privateCfg = path.join(fx.root, "private-cfg");
	const slugHost = path.join(fx.root, "real-claude-projects", "-redteam-slug");
	mkdirSync(privateCfg, { recursive: true });
	mkdirSync(slugHost, { recursive: true });
	const loginDir = path.join(fx.root, "login-dir");
	mkdirSync(loginDir, { recursive: true });
	return {
		privateCfg, slugHost, loginDir,
		needs: {
			writable: [privateCfg],
			binds: [{ source: slugHost, target: path.join(privateCfg, "projects", "-redteam-slug") }],
			proxyHosts: API_HOSTS,
			env: { CLAUDE_CONFIG_DIR: privateCfg, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3", DISABLE_AUTOUPDATER: "1" },
			fds: [{ fd: 3, data: token }],
			spawnEnv: { CLAUDE_CONFIG_DIR: loginDir },
			...extra,
		},
	};
}

/** The environment the unconfined launch would have had: this process's, plus planted secrets the scrub must drop. */
const PLANTED_GH = `ghp_REDTEAMplanted${rand(8)}`;
function launchEnv(token, { claudeStripped = false } = {}) {
	const env = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	const planted = { ...env, GH_TOKEN: PLANTED_GH, SSH_AUTH_SOCK: "/run/planted" };
	// A write-only launch keeps the host env: the Claude side strips its own credentials first
	// (confined-launch.ts confinedSourceEnv), so they are planted only where the scrub is the seam's.
	if (claudeStripped) return planted;
	return { ...planted, CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: `sk-ant-api03-planted-${rand(8)}` };
}

/** Spawn a ConfinedLaunch exactly as documented; resolves the first stdout line, keeps the process. */
function spawnConfined(cl, cwd) {
	const max = Math.max(2, ...cl.fds.map((f) => f.fd));
	const stdio = Array.from({ length: max + 1 }, (_, i) => (i <= 2 || cl.fds.some((f) => f.fd === i) ? "pipe" : "ignore"));
	const child = spawn(cl.command, cl.args, { cwd, env: cl.spawnEnv, stdio, detached: true, shell: false });
	// A program that exits without reading its fd (claude --version) resets the pipe: not an error here.
	for (const f of cl.fds) child.stdio[f.fd].on("error", () => {}).end(f.data);
	child.stdin.on("error", () => {});
	let out = "";
	let err = "";
	const exited = new Promise((r) => child.on("close", (code, signal) => r({ code, signal })));
	child.on("error", (e) => (err += String(e)));
	const firstLine = new Promise((resolve) => {
		child.stdout.on("data", (d) => {
			out += d;
			if (out.includes("\n")) resolve(out.slice(0, out.indexOf("\n")));
		});
		exited.then(() => resolve(out.split("\n")[0] || ""));
	});
	return { child, firstLine, exited, stderr: () => err, stdoutAll: () => out, collectErr: child.stderr.on("data", (d) => (err += d)) };
}

/** Every descendant of `pid` (inclusive), from the host's /proc. */
function descendants(pid) {
	const kids = new Map();
	for (const d of readdirSync("/proc")) {
		if (!/^\d+$/.test(d)) continue;
		try {
			const stat = readFileSync(`/proc/${d}/stat`, "utf8");
			const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
			if (!kids.has(ppid)) kids.set(ppid, []);
			kids.get(ppid).push(Number(d));
		} catch {}
	}
	const out = [];
	const walk = (p) => { out.push(p); for (const k of kids.get(p) ?? []) walk(k); };
	walk(pid);
	return out;
}
function procRead(pid, f) {
	try { return readFileSync(`/proc/${pid}/${f}`, "latin1"); } catch { return null; }
}

function writeSpec(fx, spec) {
	const file = path.join(fx.cwd, `.probe-spec-${rand()}.json`);
	writeFileSync(file, JSON.stringify(spec));
	return file;
}

/** The workspace-write battery's spec: what the inner probe tries, and the sentinel. */
function batterySpec(fx, { token, sentinelPid, extraPorts = [], wt } = {}) {
	const tag = rand();
	const claudeAccountsFx = path.join(fx.agentDir, "claude-accounts");
	mkdirSync(path.join(claudeAccountsFx, "l-redteam"), { recursive: true });
	writeFileSync(path.join(claudeAccountsFx, "l-redteam", ".credentials.json"), '{"claudeAiOauth":{"refreshToken":"planted"}}');
	const writeTargets = {
		escape: path.join(fx.escape, `cc-${tag}`),
		home: path.join(HOME, `.sova-redteam-cc-${tag}`),
		policyFile: fx.policyFile,
		agentDir: path.join(fx.agentDir, `cc-${tag}`),
		gitHooks: path.join(fx.cwd, ".git/hooks", `cc-${tag}`),
		gitConfig: path.join(fx.cwd, ".git/config"),
		miseTrust: path.join(HOME, ".local/state/mise/trusted-configs", `cc-${tag}`),
		direnvAllow: path.join(HOME, ".local/share/direnv/allow", `cc-${tag}`),
		dotClaude: path.join(HOME, ".claude", `cc-${tag}`),
		// positive controls
		cwd: path.join(wt ?? fx.cwd, `cc-ok-${tag}`),
		tmp: `/tmp/cc-ok-${tag}`,
	};
	if (wt) {
		writeTargets.wtAgent = path.join(wt, ".agent", `cc-${tag}`);
		// The admin dir itself stays writable (index, HEAD: commits work, C17r); its redirects must not.
		writeTargets.wtCommondir = path.join(fx.cwd, ".git/worktrees", path.basename(wt), "commondir");
		writeTargets.wtGitfile = path.join(wt, ".git");
		writeTargets.mainRepo = path.join(fx.cwd, `cc-${tag}`);
	}
	return {
		tag,
		spec: {
			hold: true,
			token,
			sentinelPid,
			writeTargets,
			readTargets: {
				credentials: path.join(HOME, ".claude/.credentials.json"),
				piAuth: path.join(HOME, ".pi/agent/auth.json"),
				fxAuth: path.join(fx.agentDir, "auth.json"),
				fxLoginCred: path.join(claudeAccountsFx, "l-redteam", ".credentials.json"),
			},
			listTargets: {
				ssh: path.join(HOME, ".ssh"),
				realClaudeAccounts: path.join(HOME, ".pi/agent/claude-accounts"),
				fxClaudeAccounts: claudeAccountsFx,
			},
			ports: [...LOOPBACK, ...extraPorts],
			proxyHosts: ["api.anthropic.com", "github.com", "example.com"],
		},
	};
}

/** Host-side leftovers of a battery: anything that landed outside is a failure, and is removed. */
function landed(spec) {
	const hits = [];
	for (const [name, file] of Object.entries(spec.writeTargets)) {
		if (["cwd", "tmp", "gitConfig", "policyFile", "wtCommondir", "wtGitfile"].includes(name)) continue;
		if (existsSync(file)) {
			hits.push(name);
			try { rmSync(file, { force: true }); } catch {}
		}
	}
	return hits;
}

/** The confinement checks every confined process (the launcher and its MCP child) must pass. */
function judgeBattery(who, r, { sentinelPid, readOnly = false, writeOnly = false }) {
	ok(r && !r.spawnError && !r.bad && r.writes, `${who}: the inner probe ran (${JSON.stringify(r).slice(0, 300)})`);
	ok(r.mntns !== hostMntNs(), `${who}: runs in its own mount namespace (${r.mntns})`);
	for (const k of ["escape", "home", "agentDir", "gitHooks", "miseTrust", "direnvAllow", "dotClaude"])
		ok(deniedOrMissing(r.writes[k]), `${who}: write ${k} must be refused, got ${JSON.stringify(r.writes[k])}`);
	for (const k of ["gitConfig", "policyFile"]) ok(denied(r.writes[k]), `${who}: ${k} must be read-only, got ${JSON.stringify(r.writes[k])}`);
	if (r.writes.wtAgent) ok(deniedOrMissing(r.writes.wtAgent), `${who}: <worktree>/.agent must be read-only, got ${JSON.stringify(r.writes.wtAgent)}`);
	for (const k of ["wtCommondir", "wtGitfile"]) if (r.writes[k]) ok(denied(r.writes[k]), `${who}: ${k} must be read-only, got ${JSON.stringify(r.writes[k])}`);
	if (r.writes.mainRepo) ok(deniedOrMissing(r.writes.mainRepo), `${who}: the main checkout (outside the worktree) must be read-only, got ${JSON.stringify(r.writes.mainRepo)}`);
	if (readOnly) ok(denied(r.writes.cwd), `${who}: read-only: cwd write refused, got ${JSON.stringify(r.writes.cwd)}`);
	else eq(r.writes.cwd?.ok, true, `${who}: control: cwd write works (${JSON.stringify(r.writes.cwd)})`);
	eq(r.writes.tmp?.ok, true, `${who}: control: /tmp write works (${JSON.stringify(r.writes.tmp)})`);
	if (!writeOnly) {
		for (const k of ["credentials", "piAuth", "fxAuth", "fxLoginCred"])
			ok(r.reads[k]?.ok === false, `${who}: read ${k} must fail, got ${JSON.stringify(r.reads[k])}`);
		for (const k of ["ssh", "realClaudeAccounts", "fxClaudeAccounts"])
			ok(r.lists[k]?.ok === false || r.lists[k]?.entries === 0, `${who}: ${k} must look empty, got ${JSON.stringify(r.lists[k])}`);
		eq(r.kill?.code, "ESRCH", `${who}: kill(sentinel) must fail ESRCH (${JSON.stringify(r.kill)})`);
		eq(r.procSentinel, false, `${who}: /proc/<sentinel> must be invisible`);
		for (const p of LOOPBACK) eq(r.ports[p]?.ok, false, `${who}: 127.0.0.1:${p} must be unreachable (${JSON.stringify(r.ports[p])})`);
	}
	eq(r.envHasToken, false, `${who}: no env value holds the token`);
	eq(r.proc.hits.length, 0, `${who}: no /proc/*/cmdline|environ visible inside holds the token (${r.proc.hits.join(",")})`);
	eq(r.fd.leaked, false, `${who}: no inherited fd yields the token (${JSON.stringify(r.fd.fds.filter((f) => !/anon_inode|^pipe:/.test(f.target)))})`);
}

function judgeEnv(who, keys, needsEnv) {
	const allowed = new Set([
		"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TZ", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
		"XDG_DATA_HOME", "XDG_STATE_HOME", "PI_CODING_AGENT_DIR", "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOROOT", "JAVA_HOME", "NVM_DIR",
		"EDITOR", "VISUAL", "PAGER", "NO_COLOR", "FORCE_COLOR", "CI", "TMPDIR", "PWD", "SHLVL", "_", "NODE_USE_ENV_PROXY",
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
		...Object.keys(needsEnv),
	]);
	const extra = keys.filter((k) => !allowed.has(k) && !k.startsWith("LC_") && !k.startsWith("MISE_"));
	eq(extra.length, 0, `${who}: env is the allowlist plus needs.env only; extra: ${extra.join(",")}`);
	for (const k of [...FORBIDDEN_ENV, "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_MESSAGING_TOKEN"]) ok(!keys.includes(k), `${who}: ${k} must not be inside`);
}

/** The outside view of a running launch: token in no cmdline/environ, the login dir visible on the spawned pid. */
function judgeOutside(pid, token, loginDir) {
	const pids = descendants(pid);
	ok(pids.length >= 3, `outside: the launch has descendants (bwrap → launcher → mcp child), got ${pids.length}`);
	const hits = [];
	for (const p of pids) for (const f of ["cmdline", "environ"]) if (procRead(p, f)?.includes(token)) hits.push(`${p}/${f}`);
	eq(hits.length, 0, `outside: no /proc/<pid>/cmdline|environ of the launch holds the token (${hits.join(",")})`);
	const env0 = procRead(pid, "environ") ?? "";
	ok(env0.split("\0").includes(`CLAUDE_CONFIG_DIR=${loginDir}`), "outside: the spawned pid's environ still names the login dir (claudeRunsOn, drain)");
	return pids;
}

/** Start a host sentinel `sleep 3003` in its own group; never killed by anything but us. */
function sentinel() {
	const s = spawn("sleep", ["3003"], { detached: true, stdio: "ignore" });
	s.unref();
	return s;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Run a full battery through a confinement; returns the parsed inner JSON and the host-side facts. */
async function runBattery(fx, scope, { cwd = fx.cwd, needsExtra, wt, extraPorts, writeOnly = false } = {}) {
	const token = `sk-ant-oat01-REDTEAM${rand(16)}`;
	const sn = sentinel();
	const { spec } = batterySpec(fx, { token, sentinelPid: sn.pid, wt, extraPorts });
	const specFile = writeSpec(fx, spec);
	const c = claudeNeeds(fx, token, needsExtra);
	const cl = await LAUNCH.confineLaunch(scope, c.needs, { command: process.execPath, args: [INNER, "launcher", specFile], cwd, env: launchEnv(token, { claudeStripped: writeOnly }) });
	if ("refused" in cl) { try { process.kill(sn.pid, "SIGKILL"); } catch {} throw new Error(`confineLaunch refused: ${cl.refused}`); }
	// Nothing token-bearing in what the spawner is handed, beyond the fd payload itself.
	ok(!JSON.stringify([cl.command, cl.args]).includes(token), "the argv never holds the token");
	// /proc/<pid>/cmdline is world-readable (no hidepid): no environment VALUE may ride on the argv.
	ok(!cl.args.includes(PLANTED_GH), "F1: a host secret (planted GH_TOKEN) is not on the argv (/proc/<bwrap>/cmdline is world-readable)");
	ok(!JSON.stringify(cl.spawnEnv).includes(token), "spawnEnv never holds the token");
	ok(!JSON.stringify(cl.env).includes(token), "the displayed env never holds the token");
	eq(cl.fds.filter((f) => f.data === token).length, 1, "the token rides on exactly one fd payload");
	const run = spawnConfined(cl, cwd);
	const line = await Promise.race([run.firstLine, sleep(60_000).then(() => "")]);
	let parsed;
	try { parsed = JSON.parse(line); } catch { parsed = undefined; }
	let outside;
	let outsideErr;
	try { if (parsed) outside = judgeOutside(run.child.pid, token, c.loginDir); } catch (e) { outsideErr = e; }
	run.child.stdin.end();
	const ex = await Promise.race([run.exited, sleep(15_000).then(() => ({ timeout: true }))]);
	const sentinelAlive = alive(sn.pid);
	try { process.kill(sn.pid, "SIGKILL"); } catch {}
	const leftovers = landed(spec);
	await cl.cleanup?.();
	if (!parsed) throw new Error(`no inner result: stdout=${run.stdoutAll().slice(0, 400)} stderr=${run.stderr().slice(0, 600)}`);
	if (outsideErr) throw outsideErr;
	return { parsed, cl, c, token, ex, sentinelAlive, leftovers, outside, specFile };
}

// ─── the cases ─────────────────────────────────────────────────────────────────────────────────

if (!state || !LAUNCH) {
	t.pending("CC0-CC7", `launch.ts/state.ts failed to load: ${loadError?.message ?? loadError}`);
} else if (process.platform !== "linux") {
	t.skip("CC0-CC7", "the Claude launch battery reads /proc; Linux only");
} else {
	let implemented = true;
	try {
		LAUNCH.decodeLaunchScope("x");
	} catch (e) {
		if (/not implemented/.test(String(e?.message))) implemented = false;
	}
	if (!implemented) {
		t.pending("CC0-CC7", "launch.ts is still the interface stub (not implemented)");
	} else {
		const fx = makeFixture();
		const P = await parentRuntime(fx);
		const scopeOf = (req) => P.last.workerLaunch?.(req);

		await t.test("CC0 routing: pi keeps its flags and extension; claude-code gets an opaque confinement at launch.ts", async () => {
			ok(typeof P.last.workerLaunch === "function", "the state event carries workerLaunch");
			const pi = scopeOf({ cwd: fx.cwd, backend: "pi", owner: `w-pi-${rand(3)}` });
			eq(pi.kind, "pi", `pi worker: ${JSON.stringify(pi).slice(0, 200)}`);
			eq(pi.flags.sandbox, "on", "pi worker gets --sandbox on");
			ok(typeof pi.flags["sandbox-parent"] === "string" && JSON.parse(pi.flags["sandbox-parent"]).version === 1, "pi worker gets --sandbox-parent <scope json>");
			eq(pi.extensionPath, realpathSync(EXT_DIR), "pi worker loads this sandbox extension");
			const cc = scopeOf({ cwd: fx.cwd, backend: "claude-code", owner: `w-cc-${rand(3)}` });
			eq(cc.kind, "confine", `claude worker: ${JSON.stringify(cc).slice(0, 200)}`);
			eq(realpathSync(cc.module), realpathSync(path.join(EXT_DIR, "launch.ts")), "module is the sandbox's launch.ts");
			ok(typeof cc.scope === "string" && JSON.parse(JSON.stringify(cc)).scope === cc.scope, "scope is serializable data");
			ok(!("claudeSettingsJson" in P.last) && !("claudePermissionMode" in P.last), "no Claude-specific fields remain on the state event");
			const outside = scopeOf({ cwd: fx.escape, backend: "claude-code", owner: "w-out" });
			eq(outside.kind, "refused", `a claude worker outside the parent's roots is refused (${JSON.stringify(outside).slice(0, 200)})`);
		});

		await t.test("CC1 real `claude --version` runs confined (exit 0, version line)", async () => {
			let claudeBin;
			try { claudeBin = realpathSync(execFileSync("bash", ["-lc", "command -v claude"], { encoding: "utf8" }).trim().split("\n").pop()); } catch {}
			if (!claudeBin || !existsSync(claudeBin)) claudeBin = realpathSync("/usr/local/bin/claude");
			const cc = scopeOf({ cwd: fx.cwd, backend: "claude-code", owner: `w-ver-${rand(3)}` });
			const token = `sk-ant-oat01-REDTEAM${rand(16)}`;
			const c = claudeNeeds(fx, token);
			const cl = await LAUNCH.confineLaunch(cc.scope, c.needs, { command: claudeBin, args: ["--version"], cwd: fx.cwd, env: launchEnv(token) });
			ok(!("refused" in cl), `not refused: ${cl.refused}`);
			const run = spawnConfined(cl, fx.cwd);
			const ex = await Promise.race([run.exited, sleep(60_000).then(() => ({ timeout: true }))]);
			await cl.cleanup?.();
			eq(ex.code, 0, `exit 0 (stderr ${run.stderr().slice(0, 300)})`);
			ok(/^\d+\.\d+\.\d+ \(Claude Code\)/.test(run.stdoutAll().trim()), `version line: ${JSON.stringify(run.stdoutAll())}`);
			const inHome = readdirSync(c.loginDir);
			eq(inHome.length, 0, `the login dir on the host is untouched (${inHome.join(",")})`);
		});

		await t.test("CC2 workspace-write: the launcher AND its MCP child are confined; token nowhere; proxy = policy + API hosts", async () => {
			const cc = scopeOf({ cwd: fx.cwd, backend: "claude-code", owner: `w-ww-${rand(3)}` });
			const host = await hostListener();
			let r;
			try {
				eq(await hostHttpStatus(`http://127.0.0.1:${host.port}/`), 200, "host precheck: the host listener answers");
				r = await runBattery(fx, cc.scope, { extraPorts: [host.port] });
				eq(host.hits.length, 1, "host listener saw only the precheck");
			} finally {
				await host.close();
			}
			const { parsed, sentinelAlive, leftovers } = r;
			eq(parsed.tokenFd.present, true, "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR is set inside");
			eq(parsed.tokenFd.matches, true, `the fd delivers exactly the token (${JSON.stringify(parsed.tokenFd)})`);
			for (const [who, b] of [["launcher", parsed.self], ["mcp child", parsed.child]]) {
				judgeBattery(who, b, {});
				judgeEnv(who, b.envKeys, r.c.needs.env);
				eq(b.proxy["api.anthropic.com"]?.status, 200, `${who}: API host allowed (${JSON.stringify(b.proxy["api.anthropic.com"])})`);
				eq(b.proxy["github.com"]?.status, 200, `${who}: policy host allowed (${JSON.stringify(b.proxy["github.com"])})`);
				eq(b.proxy["example.com"]?.status, 403, `${who}: other host refused (${JSON.stringify(b.proxy["example.com"])})`);
			}
			eq(parsed.child.mntns, parsed.self.mntns, "the MCP child shares the launcher's sandbox");
			eq(sentinelAlive, true, "host: the sentinel survived");
			eq(leftovers.length, 0, `host: nothing landed outside (${leftovers.join(",")})`);
			ok(existsSync(r.c.privateCfg), "the private config dir exists");
		});

		await t.test("CC2b the needs' own state is writable, the projects bind lands on the host slug dir", async () => {
			const cc = scopeOf({ cwd: fx.cwd, backend: "claude-code", owner: `w-st-${rand(3)}` });
			const token = `sk-ant-oat01-REDTEAM${rand(16)}`;
			const c = claudeNeeds(fx, token);
			const tag = rand();
			const specFile = writeSpec(fx, { writeTargets: { cfg: path.join(c.privateCfg, `s-${tag}`), slug: path.join(c.privateCfg, "projects", "-redteam-slug", `r-${tag}.jsonl`) } });
			// keep the files: write via a shell that does not remove them
			const cl = await LAUNCH.confineLaunch(cc.scope, c.needs, {
				command: "/bin/sh", args: ["-c", `echo a > '${path.join(c.privateCfg, `s-${tag}`)}' && echo b > '${path.join(c.privateCfg, "projects", "-redteam-slug", `r-${tag}.jsonl`)}' && echo OK`], cwd: fx.cwd, env: launchEnv(token),
			});
			ok(!("refused" in cl), `not refused: ${cl.refused}`);
			const run = spawnConfined(cl, fx.cwd);
			await run.exited;
			await cl.cleanup?.();
			eq(run.stdoutAll().trim(), "OK", `writes into own state succeed (${run.stderr().slice(0, 300)})`);
			ok(existsSync(path.join(c.slugHost, `r-${tag}.jsonl`)), "the record landed in the host slug dir (bind source)");
			void specFile;
		});

		const fxRo = makeFixture();
		await t.test("CC3 read-only: cwd read-only, network API hosts only", async () => {
			const R = await parentRuntime(fxRo, { level: "read-only" });
			try {
				const cc = R.last.workerLaunch({ cwd: fxRo.cwd, backend: "claude-code", owner: `w-ro-${rand(3)}` });
				eq(cc.kind, "confine", `read-only claude worker is confined: ${JSON.stringify(cc).slice(0, 160)}`);
				const r = await runBattery(fxRo, cc.scope);
				for (const [who, b] of [["launcher", r.parsed.self], ["mcp child", r.parsed.child]]) {
					judgeBattery(who, b, { readOnly: true });
					eq(b.proxy["api.anthropic.com"]?.status, 200, `${who}: API host allowed under read-only (${JSON.stringify(b.proxy["api.anthropic.com"])})`);
					ok(b.proxy["github.com"]?.status !== 200, `${who}: policy hosts NOT allowed under read-only (${JSON.stringify(b.proxy["github.com"])})`);
					ok(b.proxy["example.com"]?.status !== 200, `${who}: other hosts refused`);
				}
				eq(r.leftovers.length, 0, `host: nothing landed outside (${r.leftovers.join(",")})`);
			} finally {
				await R.parent.dispose();
			}
		});

		// A linked worktree of the fixture repo, with its own .agent: the tracked-worktree cases.
		function makeWorktree(f) {
			const wt = path.join(f.root, `wt-${rand(3)}`);
			execFileSync("git", ["-C", f.cwd, "worktree", "add", "-q", wt, "-b", `rt-${rand(3)}`]);
			mkdirSync(path.join(wt, ".agent"), { recursive: true });
			writeFileSync(path.join(wt, ".agent", "settings.json"), "{}\n");
			return realpathSync(wt);
		}

		const fxOn = makeFixture();
		await t.test("CC3b sandbox on, worker in a tracked worktree: narrowed to it; main checkout, .agent and admin dir read-only", async () => {
			const wt = makeWorktree(fxOn);
			const R = await parentRuntime(fxOn, { worktreeRoots: [wt] });
			try {
				const cc = R.last.workerLaunch({ cwd: wt, root: wt, backend: "claude-code", owner: `w-wt-${rand(3)}` });
				eq(cc.kind, "confine", `narrowed claude worker: ${JSON.stringify(cc).slice(0, 160)}`);
				const r = await runBattery(fxOn, cc.scope, { cwd: wt, wt });
				for (const [who, b] of [["launcher", r.parsed.self], ["mcp child", r.parsed.child]]) judgeBattery(who, b, {});
				eq(r.leftovers.length, 0, `host: nothing landed outside (${r.leftovers.join(",")})`);
			} finally {
				await R.parent.dispose();
			}
		});

		const fxWo = makeFixture();
		await t.test("CC4 sandbox OFF, worker in a tracked worktree: write-only (writes only there; host network; token still on the fd)", async () => {
			const wt = makeWorktree(fxWo);
			const R = await parentRuntime(fxWo, { on: false, worktreeRoots: [wt] });
			try {
				eq(R.last.on, false, "the parent is off");
				const cc = R.last.workerLaunch?.({ cwd: wt, root: wt, backend: "claude-code", owner: `w-wo-${rand(3)}` });
				eq(cc?.kind, "confine", `write-only claude worker: ${JSON.stringify(cc).slice(0, 160)}`);
				const host = await hostListener();
				let r;
				try {
					r = await runBattery(fxWo, cc.scope, { cwd: wt, wt, extraPorts: [host.port], writeOnly: true });
				} finally {
					await host.close();
				}
				const { parsed } = r;
				eq(parsed.tokenFd.matches, true, "write-only: the token still arrives on the fd");
				for (const [who, b] of [["launcher", parsed.self], ["mcp child", parsed.child]]) {
					ok(b.mntns !== hostMntNs(), `${who}: own mount namespace`);
					for (const k of ["wtCommondir", "wtGitfile"]) ok(denied(b.writes[k]), `${who}: write-only: ${k} read-only, got ${JSON.stringify(b.writes[k])}`);
					for (const k of ["escape", "home", "mainRepo", "wtAgent", "gitHooks", "miseTrust", "direnvAllow", "dotClaude", "agentDir"])
						ok(deniedOrMissing(b.writes[k]), `${who}: write-only: ${k} refused, got ${JSON.stringify(b.writes[k])}`);
					eq(b.writes.cwd?.ok, true, `${who}: the worktree is writable`);
					eq(b.envHasToken, false, `${who}: the token is in no env value`);
					eq(b.proc.hits.length, 0, `${who}: the token is in no visible /proc cmdline|environ`);
				}
				eq(r.leftovers.length, 0, `host: nothing landed outside (${r.leftovers.join(",")})`);
			} finally {
				await R.parent.dispose();
			}
		});

		const fxOff = makeFixture();
		await t.test("CC5 sandbox OFF and no worktree: nothing applied (the launch stays today's)", async () => {
			const R = await parentRuntime(fxOff, { on: false });
			try {
				const cc = R.last.workerLaunch?.({ cwd: fxOff.cwd, backend: "claude-code", owner: "w-none" });
				eq(cc?.kind ?? "none", "none", `off + no worktree: ${JSON.stringify(cc)}`);
				const pi = R.last.workerLaunch?.({ cwd: fxOff.cwd, backend: "pi", owner: "w-none-pi" });
				eq(pi?.kind ?? "none", "none", `off + no worktree, pi: ${JSON.stringify(pi)}`);
			} finally {
				await R.parent.dispose();
			}
		});

		await t.test("CC6 fail closed: a forged scope, a scope widened by hand, and a missing bwrap all refuse", async () => {
			const cc = scopeOf({ cwd: fx.cwd, backend: "claude-code", owner: `w-fc-${rand(3)}` });
			const launch = { command: "/bin/sh", args: ["-c", `touch '${path.join(fx.escape, "cc6")}'`], cwd: fx.cwd, env: { PATH: process.env.PATH } };
			const forged = await LAUNCH.confineLaunch("{not a scope", {}, launch);
			ok("refused" in forged, `garbage scope refused (${JSON.stringify(forged).slice(0, 160)})`);
			// widen: decode, add / to writable, re-encode — the parent's policy is re-read, so the
			// widening must not reach the mount plan (or the scope must refuse).
			const d = LAUNCH.decodeLaunchScope(cc.scope);
			ok(d.ok, "the real scope decodes");
			const wide = LAUNCH.encodeLaunchScope({ ...d.value, parent: { ...d.value.parent, writable: [...d.value.parent.writable, fx.escape] } });
			const w = await LAUNCH.confineLaunch(wide, {}, launch);
			if (!("refused" in w)) {
				const run = spawnConfined(w, fx.cwd);
				await run.exited;
				await w.cleanup?.();
				const landedWide = existsSync(path.join(fx.escape, "cc6"));
				rmSync(path.join(fx.escape, "cc6"), { force: true });
				console.log(`       note: a hand-widened scope is honoured (${landedWide ? "the write LANDED" : "no write"}); the scope is trusted data from the parent, as --sandbox-parent is`);
			}
			const savedPath = process.env.PATH;
			process.env.PATH = "/nonexistent";
			let noBwrap;
			try {
				noBwrap = await LAUNCH.confineLaunch(cc.scope, {}, { ...launch, env: { PATH: "/nonexistent" } });
			} finally {
				process.env.PATH = savedPath;
			}
			ok("refused" in noBwrap, `no bwrap → refusal, never an unconfined argv (${JSON.stringify(noBwrap).slice(0, 200)})`);
			ok(!existsSync(path.join(fx.escape, "cc6")), "host: nothing landed");
		});

		await t.test("CC7 no survivors: TERM to the launch's process group leaves no bwrap, launcher or MCP child; cleanup stops the proxy", async () => {
			const cc = scopeOf({ cwd: fx.cwd, backend: "claude-code", owner: `w-kill-${rand(3)}` });
			const token = `sk-ant-oat01-REDTEAM${rand(16)}`;
			const c = claudeNeeds(fx, token);
			const specFile = writeSpec(fx, { hold: true, token });
			const sockDir = path.join(process.env.XDG_RUNTIME_DIR ?? "/nonexistent", "sova-sandbox");
			const socks = () => { try { return readdirSync(sockDir); } catch { return []; } };
			const before = new Set(socks());
			const cl = await LAUNCH.confineLaunch(cc.scope, c.needs, { command: process.execPath, args: [INNER, "launcher", specFile], cwd: fx.cwd, env: launchEnv(token) });
			ok(!("refused" in cl), `not refused: ${cl.refused}`);
			const run = spawnConfined(cl, fx.cwd);
			await Promise.race([run.firstLine, sleep(30_000)]);
			const pids = descendants(run.child.pid);
			ok(pids.length >= 3, `bwrap, launcher and child are up (${pids.length})`);
			process.kill(-run.child.pid, "SIGTERM"); // what the transport does: signal the group
			await Promise.race([run.exited, sleep(10_000)]);
			await sleep(500);
			const left = pids.filter(alive);
			eq(left.length, 0, `no process survives (${left.join(",")})`);
			ok(socks().some((x) => !before.has(x)), "the launch had a proxy socket of its own");
			await cl.cleanup();
			const leftSocks = socks().filter((x) => !before.has(x));
			eq(leftSocks.length, 0, `cleanup removed the launch's proxy socket (${leftSocks.join(",")})`);
		});

		await t.test("CC8 secretEnv: set inside, never on the argv, spawnEnv or display env, never in bwrap's cmdline/environ", async () => {
			const cc = scopeOf({ cwd: fx.cwd, backend: "claude-code", owner: `w-se-${rand(3)}` });
			const secret = `sk-ant-oat01-SECRETENV${rand(12)}`;
			const cl = await LAUNCH.confineLaunch(cc.scope, { secretEnv: { REDTEAM_SECRET: secret } }, {
				command: "/bin/sh", args: ["-c", 'test "$REDTEAM_SECRET" = "$1" && echo SEEN; read x'], cwd: fx.cwd, env: { PATH: process.env.PATH },
			});
			ok(!("refused" in cl), `not refused: ${cl.refused}`);
			// the expected value goes in as $1? no: it would be argv. Compare by length instead.
			ok(!JSON.stringify([cl.command, cl.args, cl.spawnEnv, cl.env]).includes(secret), "secret not in args/spawnEnv/env");
			const cl2 = await LAUNCH.confineLaunch(cc.scope, { secretEnv: { REDTEAM_SECRET: secret } }, {
				command: "/bin/sh", args: ["-c", 'echo "len=${#REDTEAM_SECRET}"; read x'], cwd: fx.cwd, env: { PATH: process.env.PATH },
			});
			await cl.cleanup();
			const run = spawnConfined(cl2, fx.cwd);
			const line = await Promise.race([run.firstLine, sleep(15_000).then(() => "")]);
			const pids = descendants(run.child.pid);
			const hits = [];
			for (const p of pids) for (const f of ["cmdline", "environ"]) if (procRead(p, f)?.includes(secret)) hits.push(`${p}/${f}`);
			const bwrapPid = run.child.pid;
			run.child.stdin.end();
			await Promise.race([run.exited, sleep(10_000)]);
			await cl2.cleanup();
			eq(line, `len=${secret.length}`, `the secret arrives inside (${line}; ${run.stderr().slice(0, 200)})`);
			ok(!hits.includes(`${bwrapPid}/cmdline`) && !hits.includes(`${bwrapPid}/environ`), `bwrap's own cmdline/environ never hold it (${hits.join(",")})`);
			console.log(`       secretEnv visible from outside only in the inner program's own environ (by design, q1 fallback): ${hits.join(",") || "nowhere"}`);
		});

		await t.test("CC9 needs cannot punch through hidden paths: writable or bind under a hidden path is refused; a broad writable keeps hidden hidden", async () => {
			const cc = scopeOf({ cwd: fx.cwd, backend: "claude-code", owner: `w-hid-${rand(3)}` });
			const launch = { command: "/bin/sh", args: ["-c", "true"], cwd: fx.cwd, env: { PATH: process.env.PATH } };
			const auth = path.join(fx.agentDir, "auth.json");
			writeFileSync(auth, '{"planted":true}');
			const acct = path.join(fx.agentDir, "claude-accounts");
			mkdirSync(acct, { recursive: true });
			for (const [label, needs] of [
				["writable = hidden file", { writable: [auth] }],
				["writable = hidden dir", { writable: [acct] }],
				["writable = ~/.ssh", { writable: [path.join(HOME, ".ssh")] }],
				["bind source = hidden dir", { binds: [{ source: acct, target: path.join(fx.cwd, "acct-view") }] }],
				["bind target = hidden dir", { binds: [{ source: fx.escape, target: path.join(HOME, ".ssh") }] }],
			]) {
				const r = await LAUNCH.confineLaunch(cc.scope, needs, launch);
				if (!("refused" in r)) await r.cleanup();
				ok("refused" in r, `${label}: refused (${JSON.stringify(r).slice(0, 160)})`);
			}
			// A writable that CONTAINS hidden paths: the hidden ones stay hidden inside.
			const cl = await LAUNCH.confineLaunch(cc.scope, { writable: [fx.agentDir] }, {
				command: "/bin/sh", args: ["-c", `cat '${auth}' 2>/dev/null && echo READ || echo DENIED; ls -A '${acct}' | wc -l`], cwd: fx.cwd, env: { PATH: process.env.PATH },
			});
			if ("refused" in cl) {
				console.log(`       a writable containing hidden paths is refused outright: ${cl.refused}`);
				return;
			}
			const run = spawnConfined(cl, fx.cwd);
			await run.exited;
			await cl.cleanup();
			const out = run.stdoutAll().trim().split("\n");
			eq(out[0], "DENIED", `auth.json under a writable agent dir stays unreadable (${run.stdoutAll()})`);
			eq(out[1], "0", "claude-accounts under a writable agent dir stays empty");
		});

		await t.test("CC10 per-worker tmp: two workers never share one, neither is the parent's session tmp, a hosted tmpDir is used as given", async () => {
			const a = scopeOf({ cwd: fx.cwd, backend: "claude-code", owner: "w-tmp-a" });
			const b = scopeOf({ cwd: fx.cwd, backend: "claude-code", owner: "w-tmp-b" });
			const ta = LAUNCH.workerTmpDir(a.scope);
			const tb = LAUNCH.workerTmpDir(b.scope);
			ok(ta.host !== tb.host, `distinct tmps (${ta.host} vs ${tb.host})`);
			const sessionTmp = (await jiti.import(path.join(EXT_DIR, "session-policy.ts"))).sessionTmpDir(P.parent.session.sessionManager.getSessionId());
			ok(ta.host !== sessionTmp && !sessionTmp.startsWith(`${ta.host}/`), `worker tmp is not the parent's session tmp (${sessionTmp})`);
			const marker = `m-${rand()}`;
			const cla = await LAUNCH.confineLaunch(a.scope, {}, { command: "/bin/sh", args: ["-c", `echo x > /tmp/${marker}; ls /tmp`], cwd: fx.cwd, env: { PATH: process.env.PATH } });
			const ra = spawnConfined(cla, fx.cwd);
			await ra.exited;
			await cla.cleanup();
			ok(existsSync(path.join(ta.host, marker)), "worker a's /tmp is its own host tmp");
			const clb = await LAUNCH.confineLaunch(b.scope, {}, { command: "/bin/sh", args: ["-c", `test -e /tmp/${marker} && echo SHARED || echo PRIVATE`], cwd: fx.cwd, env: { PATH: process.env.PATH } });
			const rb = spawnConfined(clb, fx.cwd);
			await rb.exited;
			await clb.cleanup();
			eq(rb.stdoutAll().trim(), "PRIVATE", "worker b does not see worker a's /tmp");
			const hosted = path.join(fx.root, "hosted-worker-dir");
			mkdirSync(hosted, { recursive: true });
			const clh = await LAUNCH.confineLaunch(a.scope, { tmpDir: hosted }, { command: "/bin/sh", args: ["-c", `echo h > /tmp/${marker}`], cwd: fx.cwd, env: { PATH: process.env.PATH } });
			ok(!("refused" in clh), `hosted tmp accepted: ${clh.refused}`);
			eq(clh.tmpDir, hosted, "the hosted tmp is the one used");
			const rh = spawnConfined(clh, fx.cwd);
			await rh.exited;
			await clh.cleanup();
			ok(existsSync(path.join(hosted, marker)), "the hosted worker's /tmp is its own dir");
			LAUNCH.releaseWorkerTmp(a.scope);
			LAUNCH.releaseWorkerTmp(b.scope);
			ok(!existsSync(ta.host) && !existsSync(tb.host), "releaseWorkerTmp removes the default tmps");
			ok(existsSync(hosted), "a hosted tmpDir is never removed by releaseWorkerTmp");
		});

		await P.parent.dispose();
	}
}

await sleep(400);
cleanupAll();
t.done();
