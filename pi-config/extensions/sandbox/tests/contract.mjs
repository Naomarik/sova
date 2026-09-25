// contract.mjs — the backend-agnostic contract/escape suite (plan v2 §2.3, §11 cases 1-16 plus
// v3 §8 #5/#6 backend-level parts and backend's flagged gaps). Drives Backend.probe/confine and a
// REAL spawn of the confined argv, and asserts HOST-side effects: file absence, unchanged hashes,
// untouched listeners. Written against backend.ts (types, backendFor, classifyRun,
// canonicalizePath, isWithin) and the plans/spec only; no implementation file is imported here.
//
// When backends/linux-bwrap.ts does not exist yet every Linux case reports PENDING rather than
// FAIL, so run.mjs stays useful during development; once the file lands this suite is strict.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import path from "node:path";
import { makeSuite, ok, eq, includes, notIncludes } from "./kit.mjs";
import {
	ARTIFACT_ROOT, EXT_DIR, PLATFORM_DIR, TESTS_DIR, abstractListener, baseEnv, cleanupAll, envKeys,
	hostHttpStatus, hostListener, jiti, makeFixture, rand, run, sha, FORBIDDEN_ENV,
} from "./harness.mjs";

const t = makeSuite("contract");
const LINUX_IMPL = path.join(EXT_DIR, "backends", "linux-bwrap.ts");

let BE;
let loadError;
try {
	BE = await jiti.import(path.join(EXT_DIR, "backend.ts"));
} catch (err) {
	loadError = err;
}
const linuxReady = !!BE && existsSync(LINUX_IMPL) && process.platform === "linux";

const shq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/** Raw HTTP/1.1 CONNECT over a unix socket; resolves the response head (through the empty line). */
function rawConnect(socketPath, authority) {
	return new Promise((resolve, reject) => {
		const s = netConnect(socketPath);
		let buf = "";
		s.on("connect", () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
		s.on("data", (d) => {
			buf += d.toString("utf8");
			if (buf.includes("\r\n\r\n")) { s.destroy(); resolve(buf); }
		});
		s.on("error", reject);
		s.setTimeout(8000, () => { s.destroy(); reject(new Error(`rawConnect timeout: ${buf}`)); });
	});
}

/** The per-backend hidden list the spec promises; missing paths are skipped by the backend. */
const FXreal = (p) => BE.canonicalizePath(p);
function hiddenFor(fx) {
	const home = process.env.HOME;
	const raw = [
		`${home}/.ssh`, `${home}/.gnupg`, `${home}/.aws`, `${home}/.docker`, `${home}/.config/gh`,
		`${home}/.netrc`, `${home}/.git-credentials`,
		path.join(fx.agentDir, "auth.json"),
		fx.policyFile,
	];
	const out = [];
	for (const p of raw) {
		try { out.push(existsSync(p) ? FXreal(p) : p); } catch { out.push(p); }
	}
	return out;
}

function makePolicy(fx, { level = "workspace-write", network, extraHidden = [], extraReadOnly = [], envExtra = {} } = {}) {
	return {
		level,
		workspaceRoot: FXreal(fx.cwd),
		writable: [FXreal(fx.cwd)],
		readOnlyWithinWritable: extraReadOnly, // git's two files are the backend's own duty (backend.ts Policy comment)
		hidden: [...hiddenFor(fx), ...extraHidden],
		tmpDir: fx.tmp,
		network: network ?? { mode: "none" },
		env: baseEnv(envExtra),
		sessionId: `rt-${rand(8)}`,
	};
}

/** confine + real spawn, the exact drive shape backend published. Never throws. */
async function confinedRun(backend, cmd, policy, { cwd = policy.workspaceRoot, env, timeoutMs = 30_000 } = {}) {
	const res = await backend.confine({ argv: ["/bin/bash", "-c", cmd], cwd, policy, env });
	if (!res.ok) return { refused: true, reason: res.reason, code: res.code };
	const out = await run(res.confined.argv, { env: res.confined.env, cwd, timeoutMs });
	const cls = BE.classifyRun(res.confined, { exitCode: out.code, output: `${out.stdout}\n${out.stderr}` });
	try { await res.confined.cleanup?.(); } catch {}
	return { refused: false, confined: res.confined, out, cls };
}

// ─── seam-only cases that need no Linux backend ────────────────────────────────────────────────

if (!BE) {
	t.pending("all contract cases", `backend.ts failed to load: ${loadError?.message ?? loadError}`);
} else {
	// C16 unsupported platform: refusal at probe, no argv to spawn (plan §11 #16; BRIEF 9).
	// darwin now has a real backend (darwin-seatbelt), so it is exercised as a supported platform
	// below rather than here; only platforms with no backend at all stay "unsupported".
	await t.test("C16 unsupported platform refuses at probe and confine (no spawn possible)", async () => {
		for (const platform of ["win32", "freebsd"]) {
			const b = BE.backendFor(platform);
			eq(b.id, "unsupported", `${platform} backend id`);
			const probe = await b.probe({});
			ok(probe.ok === false, `${platform} probe must refuse, got ${JSON.stringify(probe)}`);
			const fx = makeFixture();
			const res = await b.confine({ argv: ["/bin/bash", "-c", "touch SHOULD_NOT_EXIST"], cwd: fx.cwd, policy: makePolicy(fx) });
			ok(res.ok === false && res.code === "SANDBOX_UNAVAILABLE", `${platform} confine must refuse SANDBOX_UNAVAILABLE, got ${JSON.stringify(res)}`);
			ok(!("confined" in res), `${platform}: a refusal carries no argv, so nothing can be spawned`);
		}
	});

	if (process.platform === "darwin") {
		await t.test("C16-darwin backend is real, not unsupported", async () => {
			const b = BE.backendFor("darwin");
			eq(b.id, "darwin-seatbelt", "darwin backend id");
		});
	} else {
		t.skip("C16-darwin backend is real, not unsupported", "not darwin");
	}

	// C15b classification is platform-neutral: build a Confined-shaped spec by hand from the
	// documented contract fields (the Linux-specific spec comes from C14's real confinement).
	await t.test("C15b classifyRun: runner failure wins over denial; denial vs failed", async () => {
		const confined = {
			argv: [], env: {}, enforcement: "full", network: "none",
			denialSignatures: ["Read-only file system"],
			runnerFailure: { fatalSignatures: ["^bwrap: Can't mkdir"], allowedExitCodes: [1] },
		};
		const runner = BE.classifyRun(confined, { exitCode: 2, output: "bwrap: Can't mkdir /run/x: Permission denied" });
		eq(runner.kind, "runner-failure", "fatal signature, disallowed exit");
		const wins = BE.classifyRun(confined, { exitCode: 2, output: "bwrap: Can't mkdir /run/x\nRead-only file system" });
		eq(wins.kind, "runner-failure", "runner failure wins over denial");
		const denied = BE.classifyRun(confined, { exitCode: 1, output: "touch: cannot touch '/x': Read-only file system" });
		eq(denied.kind, "denied", "denial signature with an allowed exit code");
		const plain = BE.classifyRun(confined, { exitCode: 127, output: "bash: foo: command not found" });
		eq(plain.kind, "failed", "plain command failure");
		const okRun = BE.classifyRun(confined, { exitCode: 0, output: "Read-only file system" });
		eq(okRun.kind, "ok", "exit 0 is always ok");
	});

	// canonicalizePath / isWithin shared helpers.
	await t.test("C-helper canonicalizePath resolves through symlinks; isWithin bounds", async () => {
		const fx = makeFixture();
		mkdirSync(path.join(fx.escape, "real"), { recursive: true });
		const link = path.join(fx.cwd, "c-link");
		symlinkSync(fx.escape, link);
		const canonical = BE.canonicalizePath(path.join(link, "escape-canary"));
		ok(BE.isWithin(canonical, FXreal(fx.escape)), `canonical path must land inside the escape dir: ${canonical}`);
		ok(!BE.isWithin(canonical, FXreal(fx.cwd)), `canonical path must NOT be inside cwd: ${canonical}`);
		const missing = BE.canonicalizePath(path.join(fx.cwd, "does-not-exist-yet", "file"));
		ok(BE.isWithin(missing, FXreal(fx.cwd)), `future path stays inside cwd: ${missing}`);
	});
}

// ─── Linux backend cases ───────────────────────────────────────────────────────────────────────

if (!linuxReady) {
	t.pending(
		"C0-C17/X1 the Linux contract suite",
		process.platform !== "linux"
			? `not linux (${process.platform}); see the darwin contract suite below`
			: existsSync(LINUX_IMPL)
				? `backend.ts load failed: ${loadError?.message}`
				: "backends/linux-bwrap.ts does not exist yet",
	);
} else {
	const fx = makeFixture(); // agent dir INSIDE cwd, the test-server shape (BRIEF 7)
	mkdirSync(path.dirname(fx.policyFile), { recursive: true });
	if (!existsSync(fx.policyFile)) writeFileSync(fx.policyFile, '{"level":"workspace-write","defaultOn":false}\n');

	// Network fixture: the REAL proxy (proxy.ts) on a unix socket, with a resolver seam so no live
	// internet host decides anything: *.invalid names reject with ENOTFOUND after the allowlist
	// check; real names resolve normally (used only by the optional, skippable extra C11-online).
	const proxyMod = await jiti.import(path.join(EXT_DIR, "proxy.ts"));
	ok(typeof proxyMod.startProxy === "function", "proxy.ts exports startProxy (backend's API note)");
	const ALLOWED_GONE = "sbx-allowed.invalid"; // allowlisted, never resolvable: expect 502 at the dial
	const BLOCKED = "sbx-blocked.invalid"; // not allowlisted: expect the 403 allowlist text
	const proxyAllow = [ALLOWED_GONE, "github.com", "api.github.com"];
	const proxySock = path.join(ARTIFACT_ROOT, `px-${rand()}.sock`);
	const decisions = [];
	const proxy = await proxyMod.startProxy({
		socket: proxySock,
		allow: proxyAllow,
		onDecision: (d) => decisions.push(d),
		resolve: async (host) => {
			if (host.endsWith(".invalid")) throw new Error(`ENOTFOUND ${host} (test resolver)`);
			const { lookup: sysLookup } = await import("node:dns/promises");
			return (await sysLookup(host)).address;
		},
	});
	const proxyNet = { mode: "proxy", proxy: { socket: proxySock, allow: proxyAllow } };
	const policyWW = makePolicy(fx, { network: proxyNet });
	const backend = BE.backendFor("linux");

	let probe;
	await t.test("C0 probe: real profile against a no-op runs and reports enforcement", async () => {
		probe = await backend.probe(policyWW);
		ok(probe.ok === true, `probe must succeed on this host: ${JSON.stringify(probe)}`);
		console.log(`       probe: enforcement=${probe.enforcement} network=${probe.network} notes=${JSON.stringify(probe.notes ?? [])} reasons=${JSON.stringify(probe.reasons ?? [])}`);
		const again = await backend.probe(policyWW);
		eq(JSON.stringify(again), JSON.stringify(probe), "probe is cached per policy and stable");
	});

	const needProbe = (caseName) => {
		if (probe?.ok !== true) { t.skip(caseName, "probe failed"); return false; }
		return true;
	};

	// C1 — write outside cwd (plan §11 #1)
	if (needProbe("C1")) await t.test("C1 write outside cwd is refused; host file absent; denial classified", async () => {
		const victim = path.join(fx.escape, `c1-${rand()}`);
		const r = await confinedRun(backend, `touch ${shq(victim)}`, policyWW);
		ok(!r.refused, `confine itself must succeed (only the write is denied): ${r.reason}`);
		ok(!existsSync(victim), `host-side: ${victim} must not exist`);
		ok(r.out.code !== 0, "exit must be nonzero");
		const hitsDenial = r.confined.denialSignatures.some((s) => `${r.out.stdout}\n${r.out.stderr}`.includes(s));
		ok(hitsDenial || r.cls.kind === "denied", `stderr must carry a denial signature (got ${JSON.stringify(r.out.stderr.trim())}, signatures ${JSON.stringify(r.confined.denialSignatures)})`);
		// Host-side control: the same path is writable for an UNconfined process.
		const ctl = await run(["/bin/bash", "-c", `touch ${shq(victim)}`], {});
		eq(ctl.code, 0, "control write must succeed on the host");
		ok(existsSync(victim), "control: file now exists (removed by cleanup)");
	});

	// C2 — fail closed when the runner is broken (plan §11 #2), driven in a CHILD process so the
	// hijacked PATH is in place before any bwrap resolution happens.
	if (needProbe("C2")) await t.test("C2 a bwrap that exits 1 → refusal; no file; never a real run", async () => {
		const fakebin = path.join(fx.root, "fakebin");
		mkdirSync(fakebin);
		writeFileSync(path.join(fakebin, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const victim = path.join(fx.cwd, `c2-${rand()}`);
		const child = await run(
			[process.execPath, path.join(TESTS_DIR, "child-fakebwrap.mjs"), fakebin, victim, JSON.stringify(makePolicy(fx, { network: { mode: "none" } }))],
			{ timeoutMs: 60_000 },
		);
		let report;
		try { report = JSON.parse(child.stdout.trim().split("\n").pop()); } catch { /* fall through */ }
		ok(report, `child must print a JSON report, got: ${child.stdout.trim()} ${child.stderr.trim()}`);
		console.log(`       fail-closed report: ${JSON.stringify(report)}`);
		ok(!existsSync(victim), "host-side: the file must not exist whatever the child did");
		ok(report.probeOk === false || report.confineOk === false || report.spawnExit !== 0, "a broken runner must chain to a refusal or a failed spawn, never exit 0");
	});

	// C3 — symlink escape at the bash level (plan §11 #3): the mount layer decides.
	if (needProbe("C3")) await t.test("C3 bash write through a symlink out of cwd is EROFS; target absent", async () => {
		const link = path.join(fx.cwd, "sym-out");
		symlinkSync(fx.escape, link);
		const victim = path.join(link, `c3-${rand()}`);
		const r = await confinedRun(backend, `echo pwned > ${shq(victim)}`, policyWW);
		ok(!r.refused, `confine must succeed: ${r.reason}`);
		ok(r.out.code !== 0, "exit must be nonzero");
		ok(!existsSync(path.join(fx.escape, path.basename(victim))), "host-side: target absent");
	});

	// C4 — the user-bus escape (plan §11 #4)
	if (needProbe("C4")) await t.test("C4 systemd-run --user and busctl --user cannot reach the host bus", async () => {
		const hostBus = await run(["busctl", "--user", "list"], {});
		if (hostBus.code !== 0) { console.log("       host user bus unavailable; assertion is reachability-only"); }
		const victim = path.join(fx.escape, `svc-${rand()}`);
		const r1 = await confinedRun(backend, `systemd-run --user --wait -q touch ${shq(victim)}`, policyWW, { timeoutMs: 45_000 });
		ok(!r1.refused, `confine must succeed: ${r1.reason}`);
		ok(r1.out.code !== 0, `systemd-run must fail, got exit 0 (the unit ran): ${r1.out.stderr.trim()}`);
		ok(!existsSync(victim), "host-side: the service file must not exist");
		const r2 = await confinedRun(backend, "busctl --user list", policyWW);
		ok(r2.out.code !== 0, "busctl --user must fail");
		if (hostBus.code === 0) {
			const ctl = await run(["busctl", "--user", "list"], {});
			eq(ctl.code, 0, "control: host bus answers outside the sandbox");
		}
	});

	// C5 — loopback and the test server (plan §11 #5; v3 §8 #6 first half)
	if (needProbe("C5")) await t.test("C5 127.0.0.1 listeners and :4810 are unreachable; host sees nothing", async () => {
		const listener = await hostListener();
		try {
			const r = await confinedRun(backend, `curl -s -m 6 -o /dev/null http://127.0.0.1:${listener.port}/`, policyWW);
			ok(!r.refused, `confine must succeed: ${r.reason}`);
			ok(r.out.code !== 0, `curl to the host listener must fail, got ${r.out.code}`);
			eq(listener.hits.length, 0, "host-side: the listener must record zero connections");
		} finally {
			await listener.close();
		}
		if ((await hostHttpStatus("http://127.0.0.1:4810/api/sessions")) !== null) {
			const r = await confinedRun(backend, "curl -s -m 6 -o /dev/null http://127.0.0.1:4810/api/sessions", policyWW);
			ok(!r.refused, `confine must succeed: ${r.reason}`);
			ok(r.out.code !== 0, `curl to :4810 must fail (exit ${r.out.code}, out ${r.out.stdout.trim()})`);
		} else console.log("       :4810 not listening; that half skipped");
	});

	// C6 — docker sockets (plan §11 #6)
	const dockerSock = ["/run/docker.sock", "/var/run/docker.sock"].find((s) => existsSync(s));
	const dockerLive = dockerSock && (await run(["curl", "-s", "-m", "5", "--unix-socket", dockerSock, "http://localhost/version"], {})).code === 0;
	if (!dockerLive) t.skip("C6 docker sockets", "no reachable docker socket on this host");
	else if (needProbe("C6")) await t.test("C6 docker sockets are gone inside", async () => {
		for (const p of ["/var/run/docker.sock", "/run/docker.sock"]) {
			const r = await confinedRun(backend, `curl -s -m 5 --unix-socket ${p} http://localhost/version`, policyWW);
			ok(!r.refused, `confine must succeed: ${r.reason}`);
			ok(r.out.code !== 0, `curl via ${p} must fail`);
			notIncludes(r.out.stdout, '"Version"', `no docker JSON from ${p}`);
		}
	});

	// C7 — ssh-agent (plan §11 #7)
	if ((await run(["ssh-add", "-l"], { env: process.env })).code === 2) t.skip("C7 ssh-agent", "no live ssh-agent on this host");
	else if (needProbe("C7")) await t.test("C7 ssh-agent is unreachable inside", async () => {
		const r = await confinedRun(backend, "ssh-add -l", policyWW);
		ok(!r.refused, `confine must succeed: ${r.reason}`);
		eq(r.out.code, 2, "ssh-add without an agent exits 2 (0/1 would mean the host agent answered)");
		includes(r.out.stderr, "Could not open a connection", "ssh-add reports the agent unreachable");
	});

	// C8 — abstract sockets (plan §11 #8)
	if (needProbe("C8")) await t.test("C8 abstract unix sockets are unreachable", async () => {
		const abs = await abstractListener();
		try {
			const r = await confinedRun(backend, `echo | socat - ABSTRACT-CONNECT:${abs.name}`, policyWW);
			ok(!r.refused, `confine must succeed: ${r.reason}`);
			ok(r.out.code !== 0, `socat to an abstract socket must fail, got ${r.out.code}`);
			eq(abs.hits.length, 0, "host-side: abstract listener must record zero connections");
		} finally {
			await abs.close();
		}
	});

	// C9 — git's delayed-execution files (plan §11 #9; the backend protects these itself)
	if (needProbe("C9")) await t.test("C9 git config and hook planting fail; .git/config hash unchanged", async () => {
		const cfg = path.join(fx.cwd, ".git/config");
		const before = sha(cfg);
		const r1 = await confinedRun(backend, `git config core.hooksPath /tmp/rt-hooks-${rand()}`, policyWW);
		ok(!r1.refused, `confine must succeed: ${r1.reason}`);
		eq(sha(cfg), before, `host-side: .git/config hash must be unchanged (config exit ${r1.out.code})`);
		ok(r1.out.code !== 0, "git config core.hooksPath must fail");
		const hook = path.join(fx.cwd, ".git/hooks/pre-commit");
		const r2 = await confinedRun(backend, `printf '#!/bin/sh\\necho pwned\\n' > .git/hooks/pre-commit`, policyWW);
		ok(!existsSync(hook), "host-side: .git/hooks/pre-commit must not exist");
		ok(r2.out.code !== 0, "hook plant must fail");
		// control: both work outside the sandbox
		const ctl = await run(["git", "config", "core.hooksPath", "/tmp/rt-ctl"], { cwd: fx.cwd });
		eq(ctl.code, 0, "control git config on host");
		await run(["git", "config", "--unset", "core.hooksPath"], { cwd: fx.cwd });
		eq(sha(cfg), before, "control cleanup restored .git/config");
	});

	// C10 — the policy file, agent dir INSIDE cwd (plan §11 #10; BRIEF 7 hard case)
	if (needProbe("C10")) await t.test("C10 policy file under <cwd>/.agent is immutable and reads masked", async () => {
		const before = sha(fx.policyFile);
		for (const cmd of [
			`printf '%s' '{"level":"full"}' > ${shq(fx.policyFile)}`,
			`printf 'x' >> ${shq(fx.policyFile)}`,
			`rm -f ${shq(fx.policyFile)}`,
		]) {
			const r = await confinedRun(backend, cmd, policyWW);
			ok(!r.refused, `confine must succeed: ${r.reason}`);
			eq(sha(fx.policyFile), before, `host-side: policy hash must be unchanged after \`${cmd.slice(0, 40)}\``);
		}
		const rd = await confinedRun(backend, `wc -c < ${shq(fx.policyFile)} 2>/dev/null || echo MISSING`, policyWW);
		ok(rd.out.stdout.trim() === "0" || rd.out.stdout.trim() === "MISSING", `the policy file reads empty or absent inside (got ${JSON.stringify(rd.out.stdout.trim())})`);
	});

	// C10b — backend's gap case (a): ancestor rename of the protected directory
	if (needProbe("C10b")) await t.test("C10b ancestor rename cannot defeat the policy-file mask", async () => {
		const before = sha(fx.policyFile);
		const rel = path.relative(fx.cwd, fx.agentDir);
		const pipeline =
			`mv ${shq(rel)} ${shq(`${rel}-moved`)} 2>/dev/null; ` +
			`mkdir -p ${shq(path.join(rel, "sandbox-policy", PLATFORM_DIR))} 2>/dev/null; ` +
			`printf '%s' '{"level":"full"}' > ${shq(path.join(rel, "sandbox-policy", PLATFORM_DIR, "policy.json"))} 2>/dev/null; ` +
			`echo done`;
		const r = await confinedRun(backend, pipeline, policyWW);
		ok(!r.refused, `confine must succeed: ${r.reason}`);
		// The reagentDir path is where policy.ts will re-read on the next tool call: its content must
		// be the original file or nothing — never the loosened replacement.
		const after = sha(fx.policyFile);
		ok(after === before || after === "<absent>", `policy path content must be original-or-absent, got hash ${after} (was ${before})`);
		const moved = sha(path.join(fx.cwd, `${rel}-moved`, "sandbox-policy", PLATFORM_DIR, "policy.json"));
		ok(moved === "<absent>" || moved === before, "the renamed-away copy must keep its original content");
	});

	// C17 — linked worktree (orchestrator's case; backend's gap case (b)). Session cwd = the
	// worktree; the common git dir sits OUTSIDE it. The backend auto-adds the common dir writable
	// with the git protections (plan §6 / open q9): a commit must still succeed, while hooks,
	// both configs and the gitfile stay byte-identical on the host.
	if (needProbe("C17")) await t.test("C17 linked worktree: hooks unreachable, configs immutable, commit still works", async () => {
		const main = path.join(fx.root, "mainrepo");
		execFileSync("git", ["init", "-q", main]);
		execFileSync("git", ["-C", main, "config", "user.email", "rt@example.invalid"]);
		execFileSync("git", ["-C", main, "config", "user.name", "rt"]);
		writeFileSync(path.join(main, "f"), "x\n");
		execFileSync("git", ["-C", main, "add", "f"]);
		execFileSync("git", ["-C", main, "commit", "-qm", "init"]);
		execFileSync("git", ["-C", main, "config", "extensions.worktreeConfig", "true"]);
		execFileSync("git", ["-C", main, "config", "--worktree", "rt.baseline", "1"]); // ensure config.worktree exists
		const wt = path.join(fx.cwd, "linked-wt");
		execFileSync("git", ["-C", main, "worktree", "add", "-q", wt]);
		const gitfile = readFileSync(path.join(wt, ".git"), "utf8").trim();
		const m = /^gitdir: (.+)$/.exec(gitfile);
		ok(m, `worktree .git is a gitfile: ${gitfile}`);
		const adminDir = m[1]; // <main>/.git/worktrees/<name>
		const commonDir = readFileSync(path.join(adminDir, "commondir"), "utf8").trim();
		const common = path.resolve(adminDir, commonDir); // <main>/.git
		const cfg = path.join(common, "config");
		const cfgWt = path.join(common, "config.worktree");
		const hashes = {
			gitfile: sha(path.join(wt, ".git")), config: sha(cfg), configWt: sha(cfgWt),
			commondir: sha(path.join(adminDir, "commondir")), adminGitdir: sha(path.join(adminDir, "gitdir")),
			adminHead: sha(path.join(adminDir, "HEAD")), commonHead: sha(path.join(common, "HEAD")),
		};
		const wtPolicy = makePolicy(fx, { network: { mode: "none" } });
		wtPolicy.workspaceRoot = FXreal(wt);
		wtPolicy.writable = [FXreal(wt)]; // the common dir auto-add is the backend's own duty
		const wtBackend = BE.backendFor("linux");
		const probeWt = await wtBackend.probe(wtPolicy);
		ok(probeWt.ok === true, `probe on the worktree cwd must succeed: ${JSON.stringify(probeWt)}`);
		// Legit controls FIRST (before any vandalism): commit + branch switch prove the session keeps
		// its own branch state — the worktree's admin HEAD is writable BY DESIGN.
		const rctl0 = await confinedRun(wtBackend,
			`git -c user.email=rt@example.invalid -c user.name=rt commit -q --allow-empty -m rt-ctl && git switch -q -c rt-keep-${rand(3)}`,
			wtPolicy, { cwd: FXreal(wt) });
		ok(!rctl0.refused, `confine must succeed: ${rctl0.reason}`);
		eq(rctl0.out.code, 0, `control: commit and switch in the worktree succeed inside (stderr: ${rctl0.out.stderr.trim()})`);
		console.log(`       by design: the worktree's own admin HEAD advanced to ${readFileSync(path.join(adminDir, "HEAD"), "utf8").trim()}`);
		// All attacks next; every assertion is host-side afterwards so one failure hides none.
		const hookA = path.join(common, "hooks/pre-commit"); // common hooks dir: git EXECUTES these
		const hookB = path.join(adminDir, "hooks/pre-commit"); // admin hooks dir: git never reads it
		const run1 = await confinedRun(wtBackend,
			`mkdir -p ${shq(path.join(common, "hooks"))} ${shq(path.join(adminDir, "hooks"))} 2>/dev/null; ` +
			`printf '#!/bin/sh\necho pwned\n' > ${shq(hookA)} 2>/dev/null; printf '#!/bin/sh\necho pwned\n' > ${shq(hookB)} 2>/dev/null; ` +
			`git config core.hooksPath /tmp/rt-hooks-${rand()} 2>/dev/null; git config --worktree rt.planted yes 2>/dev/null; ` +
			`printf '[core]\n\thooksPath = /tmp/rt\n' >> ${shq(cfg)} 2>/dev/null; ` +
			`printf '/tmp/rt-evilcommon\n' > ${shq(path.join(adminDir, "commondir"))} 2>/dev/null; ` +
			`printf 'gitdir: /tmp/rt-evil/.git\n' > ${shq(path.join(adminDir, "gitdir"))} 2>/dev/null; ` +
			`printf 'ref: refs/heads/evil\n' > ${shq(path.join(common, "HEAD"))} 2>/dev/null; ` +
			`echo staged`, wtPolicy, { cwd: FXreal(wt) });
		ok(!run1.refused, `confine must succeed: ${run1.reason}`);
		ok(!existsSync(hookA), "host-side: common hooks/pre-commit absent (git would execute this one)");
		eq(sha(cfg), hashes.config, "host-side: common config hash unchanged (hooksPath attack + direct append)");
		eq(sha(cfgWt), hashes.configWt, "host-side: config.worktree hash unchanged (--worktree attack)");
		eq(sha(path.join(wt, ".git")), hashes.gitfile, "host-side: worktree gitfile unchanged");
		eq(sha(path.join(adminDir, "commondir")), hashes.commondir, "host-side: commondir unchanged (redirect of the common dir)");
		eq(sha(path.join(adminDir, "gitdir")), hashes.adminGitdir, "host-side: admin gitdir unchanged (read-only overlay; host worktree repair/prune trusts it)");
		eq(sha(path.join(common, "HEAD")), hashes.commonHead, "host-side: common HEAD unchanged");
		console.log(`       admin-hooks plant (git never reads this path): ${existsSync(hookB) ? "LANDED (recorded)" : "refused"}`);
		// control: a commit in the worktree still succeeds inside the sandbox even after the attacks
		const rctl = await confinedRun(wtBackend, `git -c user.email=rt@example.invalid -c user.name=rt commit -q --allow-empty -m rt-${rand()}`, wtPolicy, { cwd: FXreal(wt) });
		ok(!rctl.refused, `confine must succeed: ${rctl.reason}`);
		eq(rctl.out.code, 0, `git commit in the worktree must succeed inside the sandbox (stderr: ${rctl.out.stderr.trim()})`);
	});


	// C16b — backend's gap case (d): the REAL ~/.pi/agent/auth.json reads as empty
	if (needProbe("C16b")) await t.test("C16b real ~/.pi/agent/auth.json is hidden even though agentDir is the hermetic one", async () => {
		const auth = path.join(process.env.HOME, ".pi/agent/auth.json");
		if (!existsSync(auth)) { console.log("       no host auth.json; case vacuous"); return; }
		const host = readFileSync(auth, "utf8");
		ok(host.length > 8, "precondition: host auth.json is nonempty");
		const p = makePolicy(fx, { network: { mode: "none" }, extraHidden: [BE.canonicalizePath(auth)] });
		const probe2 = await backend.probe(p);
		ok(probe2.ok === true, `probe with the extra hidden file must succeed: ${JSON.stringify(probe2)}`);
		const r = await confinedRun(backend, `cat ${shq(auth)}`, p);
		ok(!r.refused, `confine must succeed: ${r.reason}`);
		notIncludes(r.out.stdout, host.slice(0, 24), "confined cat must never echo the real credentials");
	});

	// C11 — proxy allowlist decisions, hermetic (plan §11 #11; orchestrator: no live host decides).
	// The contrast is the proxy's OWN verdict: allowed name → 502 at the upstream dial; blocked name →
	// 403 allowlist refusal. Both are curl'd from INSIDE the sandbox through the relay.
	if (needProbe("C11")) await t.test("C11 proxy: blocked name 403'd, allowed-but-gone name 502'd, verdicts differ", async () => {
		const r1 = await confinedRun(backend, `curl -sS -m 15 -o /dev/null -w '%{http_code}' https://${BLOCKED}/`, policyWW, { timeoutMs: 45_000 });
		ok(!r1.refused, `confine must succeed: ${r1.reason}`);
		ok(r1.out.code !== 0 && r1.out.stdout.trim() === "000", `blocked CONNECT: curl fails with no origin status (got exit ${r1.out.code}, code ${JSON.stringify(r1.out.stdout.trim())})`);
		includes(r1.out.stderr, "response 403", "blocked CONNECT sees the proxy's 403");
		const blockedDecision = decisions.find((d) => d.host === BLOCKED);
		ok(blockedDecision && blockedDecision.allowed === false, `proxy decision log records the refusal: ${JSON.stringify(blockedDecision)}`);
		includes(blockedDecision.reason, "allowlist", "refusal reason is the allowlist");
		eq(r1.cls.kind, "denied", `a refused connection classifies as denied so the model sees the note (got ${r1.cls.kind}; stderr ${JSON.stringify(r1.out.stderr.trim())})`);

		decisions.length = 0;
		const r2 = await confinedRun(backend, `curl -sS -m 15 -o /dev/null -w '%{http_code}' https://${ALLOWED_GONE}/`, policyWW, { timeoutMs: 45_000 });
		ok(!r2.refused, `confine must succeed: ${r2.reason}`);
		ok(r2.out.code !== 0 && r2.out.stdout.trim() === "000", `allowed-but-gone CONNECT: curl fails with no origin status (got exit ${r2.out.code}, code ${JSON.stringify(r2.out.stdout.trim())})`);
		includes(r2.out.stderr, "response 502", "allowed CONNECT got PAST the allowlist and failed at the upstream dial (502), not 403");
		const allowedDecision = decisions.find((d) => d.host === ALLOWED_GONE);
		ok(allowedDecision && /cannot resolve/.test(allowedDecision.reason ?? ""), `proxy decision log records the pass-through-allowlist, dial-stage failure: ${JSON.stringify(allowedDecision)}`);
		ok(!/allowlist/.test(allowedDecision.reason ?? ""), "an allowed name never sees the allowlist refusal");

		// Plain-HTTP form of the same two decisions (absolute-URI path through the proxy).
		const r3 = await confinedRun(backend, `curl -sS -m 15 http://${BLOCKED}/`, policyWW, { timeoutMs: 45_000 });
		includes(r3.out.stdout + r3.out.stderr, "allowlist", "blocked plain-HTTP carries the allowlist deny text (visible to the model)");
		const r4 = await confinedRun(backend, `curl -sS -m 15 http://${ALLOWED_GONE}/`, policyWW, { timeoutMs: 45_000 });
		includes(r4.out.stdout + r4.out.stderr, "cannot resolve", "allowed plain-HTTP dies at resolution, not at the allowlist");
	});

	// C11-raw — raw sockets have no route at all (no DNS needed; TEST-NET-3 is unroutable-real).
	if (needProbe("C11-raw")) await t.test("C11-raw raw TCP bypasses nothing", async () => {
		const r = await confinedRun(backend, "timeout 6 bash -c 'exec 3<>/dev/tcp/203.0.113.1/443'", policyWW, { timeoutMs: 20_000 });
		ok(!r.refused, `confine must succeed: ${r.reason}`);
		ok(r.out.code !== 0, "raw TCP must fail (no route)");
	});

	// C11-online — the only case that touches the live internet; optional and never failing.
	if ((await hostHttpStatus("https://api.github.com")) === null) t.skip("C11-online real egress", "host is offline");
	else await t.test("C11-online real egress through the proxy (optional, labelled, never fatal)", async () => {
		try {
			const r = await confinedRun(backend, "curl -sS -m 15 -o /dev/null -w '%{http_code}' https://api.github.com", policyWW, { timeoutMs: 45_000 });
			eq(r.out.code, 0, `curl exit (stderr ${r.out.stderr.trim()})`);
			ok(r.out.stdout.trim() !== "000", `origin answered (HTTP ${r.out.stdout.trim()}; 403 = GitHub rate-limit, still an answer)`);
		} catch (err) {
			t.skip("C11-online result", `live egress misbehaved (informational): ${err?.message}`);
		}
	});

	// C11b — backend's gap case (e): an allowlisted name resolving to loopback is refused by the real
	// proxy. Raw HTTP/1.1 CONNECT over the unix socket (this curl cannot proxy over unix sockets).
	await t.test("C11b an allowlisted name that resolves to loopback is refused (allowlist cannot reach the host)", async () => {
		const listener = await hostListener();
		let px;
		try {
			const loopDecisions = [];
			const sock = path.join(ARTIFACT_ROOT, `pxloop-${rand()}.sock`);
			px = await proxyMod.startProxy({ socket: sock, allow: ["localhost", "127.0.0.1"], ports: [80, 443, listener.port], onDecision: (d) => loopDecisions.push(d) });
			for (const name of ["localhost", "127.0.0.1"]) {
				const head = await rawConnect(sock, `${name}:${listener.port}`);
				includes(head, " 403 ", `CONNECT ${name} refused with 403`);
				includes(head, "x-sova-sandbox: denied", "refusal is the sandbox proxy's own");
				const d = loopDecisions.find((x) => x.host === name);
				ok(d && d.allowed === false && /local address/.test(d.reason ?? ""), `decision for ${name} is a local-address refusal: ${JSON.stringify(d)}`);
			}
			eq(listener.hits.length, 0, "host-side: loopback listener sees zero connections through the proxy");
		} finally {
			await listener.close();
			try { await px?.close?.(); } catch {}
		}
	});

	// C12 — the scrubbed environment is what the sandbox sees; the backend adds, never widens
	if (needProbe("C12")) await t.test("C12 env inside is the scrubbed allowlist plus backend additions only", async () => {
		const r = await confinedRun(backend, "env -0", policyWW);
		ok(!r.refused, `confine must succeed: ${r.reason}`);
		eq(r.out.code, 0, "env must run");
		const inside = envKeys(r.out.stdout);
		const leaked = FORBIDDEN_ENV.filter((k) => inside.includes(k));
		eq(leaked.length, 0, `forbidden variables visible inside: ${leaked.join(", ")}`);
		// Widening check: baseEnv plus the documented backend additions. PWD/OLDPWD/SHLVL/_ are set by
		// the wrapped bash itself, not the backend; NODE_USE_ENV_PROXY pairs with the proxy vars.
		const allowedBasis = new Set([...Object.keys(baseEnv()), "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
			"http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY",
			"PI_SESSION_ID", "PI_SESSION_FILE", "PWD", "OLDPWD", "SHLVL", "_"]);
		const unexpected = inside.filter((k) => !allowedBasis.has(k));
		console.log(`       env inside: ${inside.join(" ")}`);
		eq(unexpected.length, 0, `backend widened the env with: ${unexpected.join(", ")}`);
	});

	// C14 — the read-only level (plan §11 #14)
	if (needProbe("C14")) await t.test("C14 read-only: cwd and caches writes fail; /tmp stays private", async () => {
		const p = makePolicy(fx, { level: "read-only", network: { mode: "none" } });
		const probeRO = await backend.probe(p);
		ok(probeRO.ok === true, `probe (read-only) must succeed: ${JSON.stringify(probeRO)}`);
		const victim = path.join(fx.cwd, `ro-${rand()}`);
		const r1 = await confinedRun(backend, `touch ${shq(victim)}`, p);
		ok(!r1.refused, `confine must succeed: ${r1.reason}`);
		ok(r1.out.code !== 0, "write in cwd must fail under read-only");
		ok(!existsSync(victim), "host-side: file absent in cwd");
		const tmpName = `ro-tmp-${rand()}`;
		const r2 = await confinedRun(backend, `touch "$TMPDIR/${tmpName}" && echo wrote`, p);
		ok(!r2.refused, `confine must succeed: ${r2.reason}`);
		eq(r2.out.code, 0, `the private tmp must be writable (stderr ${r2.out.stderr.trim()})`);
		ok(!existsSync(path.join("/tmp", tmpName)), "host-side: nothing may appear at the real /tmp");
	});

	// C15 — classification on a REAL confinement (plan §11 #15)
	if (needProbe("C15")) await t.test("C15 real denial classifies as denied; runner failure as runner-failure", async () => {
		const victim = path.join(fx.escape, `c15-${rand()}`);
		const r = await confinedRun(backend, `touch ${shq(victim)}`, policyWW);
		ok(!r.refused, `confine must succeed: ${r.reason}`);
		eq(r.cls.kind, "denied", `a refused write must classify as denied, got ${r.cls.kind} (stderr ${JSON.stringify(r.out.stderr.trim())})`);
		const rf = BE.classifyRun(r.confined, { exitCode: null, output: "bwrap: Can't mkdir /run/sova: Permission denied" });
		eq(rf.kind, "runner-failure", "runner failure without an exit code");
		includes(rf.message ?? "", "sandbox", "runner failure message names the sandbox");
	});

	// X1 — backend's known gap (f): git init in a NON-repo cwd, then plant .git/hooks. XFAIL-tracked.
	await t.xfail("X1 git init into a fresh repo lets .git/hooks be planted (known gap)", async () => {
		const bare = makeFixture({ agentInsideCwd: false });
		rmSync(path.join(bare.cwd, ".git"), { recursive: true, force: true }); // make it a non-repo cwd
		const p = makePolicy(bare, { network: { mode: "none" } });
		const b2 = BE.backendFor("linux");
		const probeB = await b2.probe(p);
		ok(probeB.ok === true, `probe on the non-repo cwd must succeed: ${JSON.stringify(probeB)}`);
		const hook = path.join(bare.cwd, ".git/hooks/pre-commit");
		rmSync(hook, { force: true });
		const r = await confinedRun(b2, `git init -q . && printf '#!/bin/sh\\necho pwned\\n' > .git/hooks/pre-commit`, p);
		ok(!r.refused, `confine must succeed: ${r.reason}`);
		ok(!existsSync(hook), "known gap: the fresh repo's hook file must not be plantable");
	});

	await proxy.close();
	cleanupAll();
}

// ─── darwin backend cases ──────────────────────────────────────────────────────────────────────
// The deep Seatbelt cases (writable roots, hidden paths, network, shadowed caches, linked
// worktrees...) live in tests/unit/darwin-seatbelt.unit.test.ts (backend's suite); this is the
// contract-level smoke check that mirrors C0: the real profile, probed for real, must enforce.

if (!BE) {
	t.pending("C0-darwin probe", `backend.ts failed to load: ${loadError?.message ?? loadError}`);
} else if (process.platform !== "darwin") {
	t.skip("C0-darwin probe", `not darwin (${process.platform})`);
} else {
	const fxD = makeFixture();
	mkdirSync(path.dirname(fxD.policyFile), { recursive: true });
	if (!existsSync(fxD.policyFile)) writeFileSync(fxD.policyFile, '{"level":"workspace-write","defaultOn":false}\n');
	const darwinBackend = BE.backendFor("darwin");
	const policyD = makePolicy(fxD, { network: { mode: "none" } });

	await t.test("C0-darwin probe: real Seatbelt profile against a no-op runs and reports enforcement", async () => {
		const probeD = await darwinBackend.probe(policyD);
		ok(probeD.ok === true, `probe must succeed on this host: ${JSON.stringify(probeD)}`);
		console.log(`       darwin probe: enforcement=${probeD.enforcement} network=${probeD.network} notes=${JSON.stringify(probeD.notes ?? [])}`);
		const again = await darwinBackend.probe(policyD);
		eq(JSON.stringify(again), JSON.stringify(probeD), "probe is cached per policy and stable");
	});

	await t.test("C0-darwin a write outside the writable roots is refused; host file absent", async () => {
		const victim = path.join(fxD.escape, `c0d-${rand()}`);
		const r = await confinedRun(darwinBackend, `touch ${shq(victim)}`, policyD);
		ok(!r.refused, `confine itself must succeed (only the write is denied): ${r.reason}`);
		ok(!existsSync(victim), `host-side: ${victim} must not exist`);
		ok(r.out.code !== 0, "exit must be nonzero");
	});

	cleanupAll();
}

const failures = t.done();
process.exitCode = failures > 0 ? 1 : 0;
