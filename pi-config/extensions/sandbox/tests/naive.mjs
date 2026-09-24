// naive.mjs — proof that every escape case in the contract suite has teeth: run the same command
// against the NAIVE profile `bwrap --ro-bind / / --dev /dev --proc /proc --bind <cwd> <cwd> -- bash -c <cmd>`
// and assert the escape SUCCEEDS (host-side effect happens), so a green contract run is never a
// vacuous pass. Evidence of this run is saved to NAIVE-RUN.txt in this directory.
//
// This file deliberately imports nothing from the sandbox implementation and needs none of it to
// exist. Seam-only properties (fail-closed, read-only level, run classification, unsupported
// platform, proxy allowlist enforcement) have no naive-profile counterpart and are not here.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeSuite, ok, includes, eq } from "./kit.mjs";
import {
	TESTS_DIR, abstractListener, cleanupAll, envKeys, hostHttpStatus, hostListener,
	hostMntNs, hostNetNs, makeFixture, rand, run, sha, FORBIDDEN_ENV,
} from "./harness.mjs";

const t = makeSuite("naive");
const lines = [];
const orig = console.log.bind(console);
console.log = (...a) => { lines.push(a.map(String).join(" ")); orig(...a); };
const note = (s) => console.log(`       ${s}`);

const fx = makeFixture();
const naive = (cmd, opts) =>
	run(["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", fx.cwd, fx.cwd, "--", "bash", "-c", cmd],
		{ cwd: fx.cwd, env: process.env, ...opts });
const shq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

console.log(`host facts: mnt-ns=${hostMntNs()} bwrap=${execFileSync("bwrap", ["--version"]).toString().trim()}`);
console.log(`fixture: cwd=${fx.cwd} escape=${fx.escape}`);

await t.test("N0 control: the naive profile itself runs commands", async () => {
	const r = await naive("echo hello");
	eq(r.code, 0, "naive profile should run");
	includes(r.stdout, "hello", "control output");
});

await t.test("N1 control: plain touch outside cwd is EROFS even under the naive profile", async () => {
	// The naive profile's --ro-bind / / already refuses plain writes. The out-of-cwd write escapes
	// that matter against it are the indirect ones: the user bus (N3), sockets (N4-N7). Contract C1
	// still discriminates a broken real profile (e.g. a wrong bind order leaves $HOME writable).
	const target = path.join(process.env.HOME, `sova-redteam-${rand()}`);
	try {
		const r = await naive(`touch ${shq(target)}`);
		ok(r.code !== 0, `expected refusal under ro-bind /, got exit 0 (stderr: ${r.stderr.trim()})`);
		ok(!existsSync(target), `control: ${target} absent on the host`);
	} finally {
		rmSync(target, { force: true });
	}
});

await t.test("N2 control: a symlink out of cwd hits EROFS under the naive profile", async () => {
	// Same control as N1: the bash-level target is read-only under --ro-bind / /. The symlink case
	// discriminates the in-process write TOOL (no kernel boundary), which runtime-escapes covers.
	const link = path.join(fx.cwd, "link-escape");
	const victim = path.join(fx.escape, `planted-${rand()}`);
	execFileSync("ln", ["-s", fx.escape, link]);
	const r = await naive(`echo naive > ${shq(link)}/${path.basename(victim)}`);
	ok(r.code !== 0, "expected refusal under ro-bind /");
	ok(!existsSync(victim), `control: ${victim} absent on the host`);
});

const hostBusCtl = await run(["busctl", "--user", "list"], { env: process.env });
if (hostBusCtl.code === 0) {
	await t.test("N3 escape: systemd-run --user executes on the HOST; busctl --user works", async () => {
		const victim = path.join(fx.escape, `svc-${rand()}`);
		const r = await naive(`systemd-run --user --wait -q touch ${shq(victim)}`, { timeoutMs: 45_000 });
		eq(r.code, 0, `systemd-run exit code (stderr: ${r.stderr.trim()})`);
		ok(existsSync(victim), `escape evidence: ${victim} exists on the host`);
		const b = await naive("busctl --user list >/dev/null");
		eq(b.code, 0, "busctl --user exit code");
	});
} else {
	t.skip("N3 escape: systemd-run --user", `host user bus unavailable (busctl exit ${hostBusCtl.code})`);
}

const listener = await hostListener();
try {
	await t.test("N4 escape: 127.0.0.1 listener is reachable", async () => {
		const r = await naive(`curl -s -m 5 -o /dev/null http://127.0.0.1:${listener.port}/`);
		eq(r.code, 0, "curl exit code");
		ok(listener.hits.length > 0, "escape evidence: host listener recorded the connection");
	});
} finally {
	await listener.close();
}

const s4810 = await hostHttpStatus("http://127.0.0.1:4810/api/sessions");
if (s4810 !== null)
	await t.test("N4b escape: the test server :4810 is reachable", async () => {
		const r = await naive("curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:4810/api/sessions");
		eq(r.code, 0, "curl exit code");
		note(`escape evidence: :4810 answered HTTP ${r.stdout.trim()} (host pre-check was ${s4810})`);
	});
else t.skip("N4b escape: :4810", "test server not listening");

const dockerSock = ["/run/docker.sock", "/var/run/docker.sock"].find((s) => existsSync(s));
if (dockerSock && (await run(["curl", "-s", "-m", "5", "--unix-socket", dockerSock, "http://localhost/version"], {})).code === 0)
	await t.test("N5 escape: docker socket answers inside the naive profile", async () => {
		const r = await naive(`curl -s -m 5 --unix-socket ${dockerSock} http://localhost/version`);
		eq(r.code, 0, "curl exit code");
		includes(r.stdout, '"Version"', "escape evidence: docker /version JSON");
	});
else t.skip("N5 escape: docker socket", "no reachable docker socket on this host");

const hostSshAdd = await run(["ssh-add", "-l"], { env: process.env });
if (hostSshAdd.code !== 2)
	await t.test("N6 escape: ssh-agent is reachable (ssh-add -l != exit 2)", async () => {
		const r = await naive("ssh-add -l");
		ok(r.code === 0 || r.code === 1, `escape evidence: agent reached (exit ${r.code}); unreachable would be 2`);
	});
else t.skip("N6 escape: ssh-agent", "no live ssh-agent on this host");

try {
	const abs = await abstractListener();
	try {
		await t.test("N7 escape: abstract unix socket is reachable (socat)", async () => {
			const r = await naive(`echo | socat - ABSTRACT-CONNECT:${abs.name}`);
			eq(r.code, 0, `socat exit code (stderr: ${r.stderr.trim()})`);
			ok(abs.hits.length > 0, "escape evidence: abstract listener recorded the connection");
		});
	} finally {
		await abs.close();
	}
} catch {
	t.skip("N7 escape: abstract socket", "abstract sockets unsupported here");
}

await t.test("N8 escape: git config + planted hook write succeed", async () => {
	const cfg = path.join(fx.cwd, ".git/config");
	const before = sha(cfg);
	const r1 = await naive(`git config core.hooksPath /tmp/naive-hooks-${rand()}`);
	eq(r1.code, 0, "git config exit code");
	ok(sha(cfg) !== before, "escape evidence: host .git/config hash changed");
	const hook = path.join(fx.cwd, ".git/hooks/pre-commit");
	const r2 = await naive(`printf '#!/bin/sh\\necho pwned\\n' > .git/hooks/pre-commit`);
	eq(r2.code, 0, "hook write exit code");
	ok(existsSync(hook), "escape evidence: .git/hooks/pre-commit exists on the host");
});

await t.test("N9 escape: the policy file (agent dir inside cwd) is writable", async () => {
	// The repo template may not exist yet; the escape is "the path can be written", proven either by
	// a hash change or by creation. Contract C10 pins the same path against the real profile.
	mkdirSync(path.dirname(fx.policyFile), { recursive: true });
	const existed = existsSync(fx.policyFile);
	const before = existed ? sha(fx.policyFile) : "<absent>";
	const r = await naive(`printf '%s' '{"level":"full"}' > ${shq(fx.policyFile)}`);
	eq(r.code, 0, "exit code");
	const after = sha(fx.policyFile);
	ok(existed ? after !== before : after !== "<absent>", `escape evidence: policy file ${existed ? "hash changed" : "was created"} (${before} -> ${after})`);
	if (!existed) rmSync(fx.policyFile, { force: true }); // restore fixture state
});

await t.test("N9b escape: ancestor rename of the protected dir defeats path masks", async () => {
	// backend's case (a): mv .agent aside, recreate the policy path with a loosened file.
	// The naive profile's protection is nothing but the lack of a write bind; here cwd IS bound rw,
	// so the rename + replace runs cleanly. The real profile must keep the original file's content.
	mkdirSync(path.dirname(fx.policyFile), { recursive: true });
	if (!existsSync(fx.policyFile)) writeFileSync(fx.policyFile, '{"level":"workspace-write"}\n');
	const rel = path.relative(fx.cwd, fx.agentDir);
	const r = await naive(
		`mv ${shq(rel)} ${shq(`${rel}2`)} && mkdir -p ${shq(path.join(rel, "sandbox-policy/linux"))} ` +
		`&& printf '%s' '{"level":"full"}' > ${shq(path.join(rel, "sandbox-policy/linux/policy.json"))}`,
	);
	eq(r.code, 0, `rename+replace exit code (stderr: ${r.stderr.trim()})`);
	note(`escape evidence: ${fx.policyFile} now reads ${JSON.stringify(readFileSafe(fx.policyFile))}`);
	ok(readFileSafe(fx.policyFile).includes('"full"'), "escape evidence: policy path now holds the loosened file");
});

await t.test("N10 escape: the naive profile has direct egress with no allowlist step", async () => {
	// Hermetic contrast anchor: two names distinguished only by an allowlist a naive profile does not
	// have. Both die the SAME direct-DNS death (curl 6); contract C11 shows the real profile answers
	// them DIFFERENTLY (403 allowlist vs 502 dial). No live internet involved.
	const r1 = await naive("curl -s -m 10 -o /dev/null https://sbx-blocked.invalid/");
	const r2 = await naive("curl -s -m 10 -o /dev/null https://sbx-allowed.invalid/");
	eq(r1.code, 6, `blocked name: plain DNS failure (got ${r1.code}: ${r2.stderr.trim().slice(0, 80)})`);
	eq(r2.code, 6, `allowed name: same plain DNS failure (got ${r2.code})`);
	note("escape evidence: identical untreated egress for both names; there is no proxy to decide anything");
});

{
	const online = (await hostHttpStatus("https://example.com")) !== null;
	if (!online) t.skip("N10-opt escape: live internet egress", "host is offline");
	else await t.test("N10-opt escape: live internet egress (optional, labelled, never fatal)", async () => {
		try {
			const r = await naive("curl -s -m 10 -o /dev/null -w '%{http_code}' https://example.com");
			eq(r.code, 0, "exit 0");
			ok(r.stdout.trim() !== "000", `HTTP ${r.stdout.trim()} — the naive profile egresses to the real internet`);
		} catch (err) {
			t.skip("N10-opt result", `live egress misbehaved (informational): ${err?.message}`);
		}
	});
}

await t.test("N11 escape: host environment is not scrubbed", async () => {
	const expected = FORBIDDEN_ENV.filter((k) => process.env[k] !== undefined);
	ok(expected.length > 0, "precondition: host has at least one forbidden variable set");
	const r = await naive("env -0");
	eq(r.code, 0, "env exit code");
	const leaked = expected.filter((k) => envKeys(r.stdout).includes(k));
	ok(leaked.length > 0, `escape evidence: ${leaked.length} forbidden vars visible inside (e.g. ${leaked.slice(0, 3).join(", ")})`);
});

await t.test("N13 escape: in a linked worktree, hooks and git config are plantable", async () => {
	// Orchestrator's worktree case. The naive profile binds the writable roots WITHOUT the git
	// protections (ro-bind overlays on hooks/config): cwd=wt plus the common repo, both rw.
	const main = path.join(fx.root, "n13-main");
	execFileSync("git", ["init", "-q", main]);
	execFileSync("git", ["-C", main, "config", "user.email", "rt@example.invalid"]);
	execFileSync("git", ["-C", main, "config", "user.name", "rt"]);
	execFileSync("git", ["-C", main, "commit", "-q", "--allow-empty", "-m", "x"]);
	execFileSync("git", ["-C", main, "config", "extensions.worktreeConfig", "true"]);
	const wt = path.join(fx.root, "n13-wt");
	execFileSync("git", ["-C", main, "worktree", "add", "-q", wt]);
	const naiveWt = (cmd) =>
		run(["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", wt, wt, "--bind", main, main, "--", "bash", "-c", cmd],
			{ cwd: wt, env: process.env });
	// (a) plant a hook in the COMMON hooks dir (shared by all worktrees of the repo)
	const hook = path.join(main, ".git/hooks/pre-commit");
	const ra = await naiveWt(`printf '#!/bin/sh\\necho pwned\\n' > ${shq(path.join(main, ".git/hooks/pre-commit"))}`);
	eq(ra.code, 0, "hook plant exit code");
	ok(existsSync(hook), "escape evidence: common .git/hooks/pre-commit exists on the host");
	const gitfileN = readFileSync(path.join(wt, ".git"), "utf8").trim();
	const adminN = /^gitdir: (.+)$/.exec(gitfileN)?.[1];
	ok(adminN, `worktree .git is a gitfile: ${gitfileN}`);
	// (b) git config core.hooksPath writes the common config; --worktree writes <admin>/config.worktree
	const cfg = path.join(main, ".git/config");
	const beforeCfg = sha(cfg);
	const rb = await naiveWt(`git config core.hooksPath /tmp/n13-${rand()} && git config --worktree rt.planted yes`);
	eq(rb.code, 0, `git config exit code (stderr: ${rb.stderr.trim()})`);
	ok(sha(cfg) !== beforeCfg, "escape evidence: common .git/config hash changed");
	ok(existsSync(path.join(adminN, "config.worktree")), "escape evidence: config.worktree created on the host");
	// control: commit in wt works too (the sandbox must preserve THIS while blocking the above)
	const rc = await naiveWt(`git -c user.email=rt@example.invalid -c user.name=rt commit -q --allow-empty -m ok`);
	eq(rc.code, 0, "commit control exit code");
});

await t.test("N12 anchor: the naive profile shares the host NETWORK namespace (F3 contrast)", async () => {
	// bwrap always makes a new mount ns; the naive profile's deficit is sharing net/pid/ipc.
	const r = await naive("readlink /proc/self/ns/net");
	eq(r.stdout.trim(), hostNetNs(), "naive profile shares the host network namespace");
	const m = await naive("readlink /proc/self/ns/mnt");
	ok(m.stdout.trim() !== hostMntNs(), "note: bwrap mounts are always a fresh mount namespace");
});

cleanupAll();
const failures = t.done();
console.log = orig;

const header = [
	"# NAIVE-RUN.txt — escape cases against the naive bwrap profile",
	`# date: ${new Date().toISOString()}`,
	`# host: ${process.platform} ${process.arch}, bwrap ${execFileSync("bwrap", ["--version"]).toString().trim()}, node ${process.version}`,
	"# profile: bwrap --ro-bind / / --dev /dev --proc /proc --bind <cwd> <cwd> -- bash -c <cmd> (host env passed through)",
	"# A PASS here means the escape SUCCEEDS, i.e. the corresponding contract case would FAIL against",
	"# this profile and is therefore a real test. Seam-only properties (fail-closed, read-only,",
	"# classification, unsupported platform, proxy allowlist) have no naive counterpart by design.",
	"",
];
writeFileSync(path.join(TESTS_DIR, "NAIVE-RUN.txt"), `${header.join("\n")}${lines.join("\n")}\n`);
orig(`wrote ${path.join(TESTS_DIR, "NAIVE-RUN.txt")}`);
process.exitCode = failures > 0 ? 1 : 0;

function readFileSafe(p) {
	try {
		return readFileSync(p, "utf8").trim();
	} catch {
		return "<absent>";
	}
}
