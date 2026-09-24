// runtime-escapes.mjs — escape and fail-closed cases through a real pi runtime with the sandbox
// extension ON, driving the same wrapped tools the agent loop runs. Host-side assertions only.
// File-tool checks are in-process (policy-enforced, per §chat.sandbox/limits) and bash is the OS
// boundary; both are exercised here. Needs index.ts; PENDING while absent.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeSuite, ok, eq, includes, notIncludes } from "./kit.mjs";
import {
	EXT_ENTRY, PLATFORM_DIR, cleanupAll, envKeys, hostHttpStatus, hostMntNs, makeFixture, openSession, rand, sha,
} from "./harness.mjs";

const t = makeSuite("runtime-escapes");
const DENIAL = "[sandbox:";

if (!existsSync(EXT_ENTRY)) {
	t.pending("RE0-RE11", "pi-config/extensions/sandbox/index.ts does not exist yet");
	t.done();
} else {
	const fx = makeFixture();
	mkdirSync(path.dirname(fx.policyFile), { recursive: true });
	if (!existsSync(fx.policyFile)) writeFileSync(fx.policyFile, '{"level":"workspace-write","defaultOn":false}\n');
	const policyBefore = sha(fx.policyFile);
	// A sentinel credential inside the hermetic agent dir (hidden by the policy defaults for it).
	const sentinelAuth = path.join(fx.agentDir, "auth.json");
	writeFileSync(sentinelAuth, `{"token":"sentinel-${rand(12)}"}`);
	const sentinel = JSON.parse(readFileSync(sentinelAuth, "utf8")).token;

	let s;
	await t.test("RE0 runtime opens; /sandbox on succeeds", async () => {
		s = await openSession({ cwd: fx.cwd, agentDir: fx.agentDir, withExtension: true });
		eq(s.errors.length, 0, `session loaded clean: ${s.errors.join(" | ")}`);
		await s.command("sandbox", "on");
		const r = await s.bash("readlink /proc/self/ns/mnt");
		ok(!r.isError && r.text.trim() !== hostMntNs(), `ON confirmed by mount namespace (got ${r.text.trim()})`);
	});

	const needOn = (n) => { if (!s) { t.skip(n, "no ON runtime"); return false; } return true; };

	if (needOn("RE1")) await t.test("RE1 write tool: outside cwd refused, absent; /tmp maps to the session tmp", async () => {
		const v1 = path.join(fx.escape, `re1-${rand()}`);
		const r1 = await s.call("write", { path: v1, content: "pwned" });
		ok(r1.isError, `write outside cwd must be a tool error (got ${r1.text.slice(0, 120)})`);
		ok(!existsSync(v1), "host-side: file absent");
		// The designed mapping (extension's contract note): /tmp is the session tmp.
		const tname = `re1-${rand()}`;
		const r2 = await s.call("write", { path: `/tmp/${tname}`, content: "session-tmp" });
		ok(!existsSync(path.join("/tmp", tname)), "host-side: nothing at the real /tmp even if the write succeeded");
	});

	if (needOn("RE2")) await t.test("RE2 write tool: symlink escape refused at the canonical path", async () => {
		symlinkSync(fx.escape, path.join(fx.cwd, "sym-out"));
		const victim = path.join(fx.cwd, "sym-out", `re2-${rand()}`);
		const r = await s.call("write", { path: victim, content: "pwned" });
		ok(r.isError, `write through symlink must be a tool error (got ${r.text.slice(0, 120)})`);
		ok(!existsSync(path.join(fx.escape, path.basename(victim))), "host-side: target absent");
		const v2 = path.join(fx.cwd, "sym-out", "..", "..", `re2b-${rand()}`);
		const r2 = await s.call("write", { path: v2, content: "pwned" });
		ok(r2.isError, "lexical .. escape must be refused");
	});

	if (needOn("RE3")) await t.test("RE3 write tool: hidden paths refused", async () => {
		const v = path.join(process.env.HOME, ".ssh", `re3-${rand()}`);
		try {
			const r = await s.call("write", { path: v, content: "pwned" });
			ok(r.isError, `write into ~/.ssh must be a tool error (got ${r.text.slice(0, 120)})`);
			ok(!existsSync(v), "host-side: absent");
		} finally {
			rmSync(v, { force: true });
		}
	});

	if (needOn("RE4")) await t.test("RE4 read tool: hidden auth.json never echoes its content", async () => {
		const r = await s.call("read", { path: sentinelAuth });
		notIncludes(r.text, sentinel, "the sentinel credential must never appear in a read result");
		const b = await s.bash(`cat ${sentinelAuth}`);
		notIncludes(b.text, sentinel, "nor through bash");
	});

	if (needOn("RE5")) await t.test("RE5 bash tool: outside write denied with the sandbox note", async () => {
		const v = path.join(fx.escape, `re5-${rand()}`);
		const r = await s.bash(`touch '${v}'`);
		ok(r.isError, "a denied bash write is an ordinary tool failure");
		includes(r.text, DENIAL, "denial note is appended for the model");
		ok(!existsSync(v), "host-side: file absent");
	});

	if (needOn("RE6")) await t.test("RE6 bash+write tools: git delayed-execution files immutable", async () => {
		const cfg = path.join(fx.cwd, ".git/config");
		const before = sha(cfg);
		const r1 = await s.bash(`git config core.hooksPath /tmp/re6-${rand()}`);
		ok(r1.isError, "git config must fail");
		eq(sha(cfg), before, "host-side: .git/config hash unchanged");
		const hook = path.join(fx.cwd, ".git/hooks/pre-commit");
		const r2 = await s.call("write", { path: hook, content: "#!/bin/sh\necho pwned\n" });
		ok(r2.isError, "write tool must refuse the hook path");
		ok(!existsSync(hook), "host-side: hook absent");
	});

	if (needOn("RE7")) await t.test("RE7 policy file (agent dir inside cwd) is untouchable by both layers", async () => {
		const r1 = await s.call("write", { path: fx.policyFile, content: '{"level":"full"}' });
		ok(r1.isError, "write tool must refuse the policy file");
		eq(sha(fx.policyFile), policyBefore, "host-side: policy hash unchanged (write tool)");
		const r2 = await s.call("edit", { path: fx.policyFile, oldText: "workspace-write", newText: "full" });
		ok(r2.isError, "edit tool must refuse the policy file");
		const r3 = await s.bash(`printf '%s' '{"level":"full"}' > '${fx.policyFile}'`);
		ok(r3.isError, "bash overwrite must fail");
		eq(sha(fx.policyFile), policyBefore, "host-side: policy hash unchanged (bash)");
		// Inside, the file reads empty (mask) or is absent entirely; either way its content never leaks.
		const r4 = await s.bash(`cat '${fx.policyFile}'`);
		notIncludes(r4.text, "workspace-write", "the real policy content never reaches the model via bash");
		const r5 = await s.call("read", { path: fx.policyFile });
		notIncludes(r5.text, "workspace-write", "read tool never serves the real policy content");
	});

	if (needOn("RE8")) await t.test("RE8 ancestor rename of .agent does not loosen the NEXT tool call", async () => {
		// backend's gap case (a) at the runtime level: whatever the rename pipeline manages on disk,
		// the policy re-read on the next call must still be the original one — proven by behavior.
		const rel = path.relative(fx.cwd, fx.agentDir);
		await s.bash(
			`mv '${rel}' '${rel}-moved' 2>/dev/null; mkdir -p '${path.join(rel, "sandbox-policy", PLATFORM_DIR)}' 2>/dev/null; ` +
			`printf '%s' '{"level":"full"}' > '${path.join(rel, "sandbox-policy", PLATFORM_DIR, "policy.json")}' 2>/dev/null; echo staged`,
		);
		const victim = path.join(fx.escape, `re8-${rand()}`);
		const r = await s.call("write", { path: victim, content: "pwned" });
		ok(r.isError, "after a rename attack the next write outside cwd is STILL refused");
		ok(!existsSync(victim), "host-side: absent");
		const r2 = await s.bash(`touch '${path.join(fx.escape, `re8b-${rand()}`)}'`);
		ok(r2.isError, "and the bash layer is still confined");
	});

	if (needOn("RE9")) await t.test("RE9 the agent cannot reach Sova or flip the toggle", async () => {
		ok(!s.session.getToolDefinition("sandbox"), "there is no sandbox TOOL (only the user command)");
		if ((await hostHttpStatus("http://127.0.0.1:4810/api/sessions")) !== null) {
			const r = await s.bash("curl -s -m 6 -o /dev/null http://127.0.0.1:4810/api/sessions");
			ok(r.isError, "curl to the test server must fail under ON");
		} else console.log("       :4810 not listening; API reachability half skipped");
		eq(s.uiLog.filter((x) => x[0] === "confirm").length, 0, "no escalation prompt fired during these cases");
	});

	if (needOn("RE10")) await t.test("RE10 linked worktree through the tools (contract C17's in-process half)", async () => {
		const main = path.join(fx.root, "re10-main");
		execFileSync("git", ["init", "-q", main]);
		execFileSync("git", ["-C", main, "config", "user.email", "rt@example.invalid"]);
		execFileSync("git", ["-C", main, "config", "user.name", "rt"]);
		execFileSync("git", ["-C", main, "commit", "-q", "--allow-empty", "-m", "x"]);
		const wt = path.join(fx.cwd, "re10-wt");
		execFileSync("git", ["-C", main, "worktree", "add", "-q", wt]);
		const common = path.join(main, ".git");
		const cfgHash = sha(path.join(common, "config"));
		const hook = path.join(common, "hooks/pre-commit");
		// A second runtime whose cwd IS the worktree.
		const s2 = await openSession({ cwd: wt, agentDir: fx.agentDir, withExtension: true });
		try {
			eq(s2.errors.length, 0, `worktree session loaded clean: ${s2.errors.join(" | ")}`);
			await s2.command("sandbox", "on");
			const r1 = await s2.call("write", { path: hook, content: "#!/bin/sh\necho pwned\n" });
			ok(r1.isError, "write tool refuses the common hooks dir");
			ok(!existsSync(hook), "host-side: hook absent");
			const r2 = await s2.call("edit", { path: path.join(common, "config"), oldText: "repositoryformatversion", newText: "pwned" });
			ok(r2.isError, "edit tool refuses the common config");
			const r3 = await s2.bash(`git config core.hooksPath /tmp/re10-${rand()}`);
			ok(r3.isError, "bash git config is denied");
			eq(sha(path.join(common, "config")), cfgHash, "host-side: common config hash unchanged");
			const r4 = await s2.bash(`git -c user.email=rt@example.invalid -c user.name=rt commit -q --allow-empty -m ok`);
			eq(r4.isError, false, `control: commit in the worktree succeeds under ON (stderr: ${r4.text.slice(-200)})`);
		} finally {
			await s2.dispose().catch(() => {});
		}
	});

	// RE11 — fail-closed through the tools: PATH with a fake bwrap before the runtime even opens.
	// Kept last; restores PATH in a finally. (plan §11 #2, tool level: refusal names the sandbox.)
	await t.test("RE11 fake bwrap on PATH → refusing tools, no file, error names the sandbox", async () => {
		const fakebin = path.join(fx.root, "fakebin");
		mkdirSync(fakebin, { recursive: true });
		writeFileSync(path.join(fakebin, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const realPath = process.env.PATH;
		const fx2 = makeFixture();
		let s3;
		const realTemplate = existsSync(fx2.policyFile); // copied from pi-config/sandbox-policy by makeFixture
		if (!realTemplate) {
			console.log("       policy template absent; fx2 has no valid policy — case would refuse vacuously; skipping");
			return;
		}
		try {
			process.env.PATH = `${fakebin}:${realPath}`;
			s3 = await openSession({ cwd: fx2.cwd, agentDir: fx2.agentDir, withExtension: true });
			eq(s3.errors.length, 0, `session loaded clean: ${s3.errors.join(" | ")}`);
			await s3.command("sandbox", "on");
			const victim = path.join(fx2.cwd, `re11-${rand()}`);
			const r = await s3.bash(`touch '${victim}'`);
			ok(r.isError, "the bash tool must refuse when the runner is broken");
			ok(/sandbox/i.test(r.text) && /unavailable|refus/i.test(r.text), `the refusal names the sandbox (got: ${r.text.slice(0, 160)})`);
			ok(!existsSync(victim), "host-side: no file");
			ok(existsSync(fx2.policyFile) && sha(fx2.policyFile) !== "<absent>", "policy intact");
			// entry records unavailable
			const entries = s3.entries().filter((e) => e.type === "custom" && e.customType === "sandbox");
			ok(entries.length >= 1, "a sandbox entry exists");
			console.log(`       last entry: ${JSON.stringify(entries.at(-1).data ?? entries.at(-1)).slice(0, 200)}`);
		} finally {
			process.env.PATH = realPath;
			await s3?.dispose().catch(() => {});
		}
	});

	await s?.dispose().catch(() => {});
	cleanupAll();
	t.done();
}
process.exitCode ??= 0;
