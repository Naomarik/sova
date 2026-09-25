import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Confined, Policy } from "../../backend.ts";
import {
	DarwinSeatbeltBackend,
	MACH_ALLOW,
	profilePlan,
	renderProfile,
	runCapture,
	SANDBOX_EXEC_OVERRIDE,
	sbplString,
	shadowEnv,
	spellings,
	writeLayers,
	writeProfile,
} from "../../backends/darwin-seatbelt.ts";

const onMac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

/** A workspace (a git repo), a session tmp, a secret and an outside dir, all under one private root. */
function setup(t: { after: (fn: () => void) => void }) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sbx-seatbelt-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ws = join(root, "ws");
	mkdirSync(ws);
	assert.equal(spawnSync("git", ["init", "-q", ws]).status, 0);
	const tmpDir = join(root, "session", "tmp");
	mkdirSync(tmpDir, { recursive: true });
	const secret = join(root, "secret");
	mkdirSync(secret);
	writeFileSync(join(secret, "key"), "SECRET");
	const outside = join(root, "outside");
	mkdirSync(outside);
	const policy: Policy = {
		level: "workspace-write",
		workspaceRoot: ws,
		writable: [ws],
		readOnlyWithinWritable: [],
		hidden: [secret],
		tmpDir,
		network: { mode: "none" },
		env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root },
		sessionId: "s",
	};
	return { root, ws, tmpDir, secret, outside, policy };
}

async function sh(policy: Policy, script: string, cwd = policy.workspaceRoot): Promise<{ code: number | null; output: string; confined: Confined }> {
	const res = await new DarwinSeatbeltBackend().confine({ argv: ["/bin/sh", "-c", script], cwd, policy });
	assert.ok(res.ok, res.ok ? "" : res.reason);
	const run = await runCapture(res.confined.argv, res.confined.env, cwd, 20_000);
	return { ...run, confined: res.confined };
}

test("spellings: the /private firmlinks get their short spelling too, nothing else does", () => {
	assert.deepEqual(spellings("/private/tmp/a"), ["/private/tmp/a", "/tmp/a"]);
	assert.deepEqual(spellings("/private/var/folders/x"), ["/private/var/folders/x", "/var/folders/x"]);
	assert.deepEqual(spellings("/private/tmpfoo"), ["/private/tmpfoo"]);
	assert.deepEqual(spellings("/Users/me"), ["/Users/me"]);
});

test("sbplString escapes quotes and backslashes", () => {
	assert.equal(sbplString('a"b\\c'), '"a\\"b\\\\c"');
});

test("the profile: deny by default, mach allowlist, Keychain denied after it, network only to the listed ports", (t) => {
	const { policy, ws, secret, tmpDir } = setup(t);
	const text = renderProfile(profilePlan({ policy: { ...policy, network: { mode: "none", localPorts: [5555] } }, relayPort: 4321 }));
	assert.match(text, /^\(version 1\)\n/);
	assert.match(text, /\(deny default\)/);
	for (const n of MACH_ALLOW) assert.ok(text.includes(`(global-name "${n}")`), n);
	assert.ok(!MACH_ALLOW.some((n) => /security|SecurityServer/i.test(n)), "no security service on the allowlist");
	const allowMach = text.indexOf("(allow mach-lookup");
	const denyKeychain = text.indexOf('(global-name-prefix "com.apple.SecurityServer")');
	assert.ok(allowMach >= 0 && denyKeychain > allowMach, "the Keychain deny comes after (so wins over) the allowlist");
	const denyNet = text.indexOf("(deny network*)");
	assert.ok(denyNet >= 0);
	const remotes = [...text.matchAll(/\(remote ip "([^"]+)"\)/g)].map((m) => m[1]);
	assert.deepEqual(remotes.sort(), ["localhost:4321", "localhost:5555"]);
	assert.ok(text.indexOf('(remote ip "localhost:4321")') > denyNet);
	// Canonical /private spellings, and the writes: tmp and the workspace, then git's read-only paths after.
	assert.ok(text.includes(`(subpath ${sbplString(ws)})`));
	assert.ok(text.includes(`(subpath ${sbplString(tmpDir)})`));
	if (ws.startsWith("/private/")) assert.ok(text.includes(`(subpath ${sbplString(ws.slice("/private".length))})`));
	assert.ok(text.indexOf(`(subpath ${sbplString(join(ws, ".git", "hooks"))})`) > text.indexOf("(allow file-write*\n"));
	assert.ok(text.includes(`(literal ${sbplString(join(ws, ".git"))})`), ".git itself is pinned (no rename)");
	assert.match(text, new RegExp(`\\(deny file-read\\* file-write\\*\\n  \\(subpath ${sbplString(secret).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\)`));
});

test("writeLayers: the deeper path comes later, so it wins; for the identical path read-only wins", () => {
	const layers = writeLayers({ writable: ["/r", "/r/.git/worktrees/a", "/t", "/same"], readOnly: ["/r/.git/worktrees", "/r/.git/worktrees/a/gitdir", "/r/.git/hooks", "/same"] });
	assert.deepEqual(layers, [
		{ allow: ["/r", "/t", "/same"], deny: [] },
		{ allow: [], deny: ["/same", "/r/.git/hooks", "/r/.git/worktrees"] },
		{ allow: ["/r/.git/worktrees/a"], deny: [] },
		{ allow: [], deny: ["/r/.git/worktrees/a/gitdir"] },
	]);
});

test("read-only: only the session tmp is writable and there is no network", (t) => {
	const { policy, ws, tmpDir } = setup(t);
	const plan = profilePlan({ policy: { ...policy, level: "read-only" } });
	assert.deepEqual(plan.writable, [tmpDir]);
	assert.deepEqual(plan.ports, []);
	assert.ok(!renderProfile(plan).includes(`(subpath ${sbplString(ws)})`));
});

test("shadowed: the host path is read-only, its source writable, and the tool variables point at the source", (t) => {
	const { policy, root } = setup(t);
	const host = join(root, ".npm");
	const source = join(root, "shadow-npm");
	mkdirSync(host);
	const plan = profilePlan({ policy: { ...policy, writable: [policy.workspaceRoot, host], shadowed: [{ path: host, source }] } });
	assert.ok(plan.writable.includes(source));
	assert.ok(!plan.writable.includes(host));
	assert.ok(plan.readOnly.includes(host));
	assert.deepEqual(shadowEnv(plan.shadowed, {}, root), { npm_config_cache: source });
});

test("writeProfile: a 0600 file beside the session tmp, named by its hash; a tampered copy is replaced", (t) => {
	const { tmpDir } = setup(t);
	const file = writeProfile(tmpDir, "(version 1)\n(deny default)\n");
	assert.equal(dirname(file), dirname(tmpDir));
	assert.match(file, /seatbelt-[0-9a-f]{16}\.sb$/);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	writeFileSync(file, "(version 1)\n(allow default)\n");
	assert.equal(writeProfile(tmpDir, "(version 1)\n(deny default)\n"), file);
	assert.equal(readFileSync(file, "utf8"), "(version 1)\n(deny default)\n");
});

test("confine: sandbox-exec -f <file>, never an inline profile; TMPDIR is the session tmp", { skip: !onMac }, async (t) => {
	const { policy, tmpDir } = setup(t);
	const res = await new DarwinSeatbeltBackend().confine({ argv: ["/bin/echo", "hi"], cwd: policy.workspaceRoot, policy });
	assert.ok(res.ok);
	const argv = res.confined.argv;
	assert.deepEqual(argv.slice(0, 2), ["/usr/bin/sandbox-exec", "-f"]);
	assert.ok(!argv.includes("-p"));
	assert.ok(existsSync(argv[2]!));
	assert.deepEqual(argv.slice(3), ["/bin/echo", "hi"]);
	assert.equal(res.confined.env.TMPDIR, tmpDir + "/");
	assert.equal(res.confined.enforcement, "full");
});

test("under sandbox-exec: writes land only in the workspace and the session tmp", { skip: !onMac }, async (t) => {
	const { policy, ws, outside, tmpDir } = setup(t);
	const r = await sh(policy, `echo w > a.txt; echo t > "$TMPDIR/t.txt"; echo o > '${outside}/o.txt'; echo x > /tmp/sbx-seatbelt-escape-$$`);
	assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "w\n");
	assert.equal(readFileSync(join(tmpDir, "t.txt"), "utf8"), "t\n");
	assert.equal(existsSync(join(outside, "o.txt")), false);
	assert.match(r.output, /Operation not permitted/);
});

test("under sandbox-exec: git's hooks and config stay read-only, and .git cannot be renamed away", { skip: !onMac }, async (t) => {
	const { policy, ws } = setup(t);
	const before = readFileSync(join(ws, ".git", "config"), "utf8");
	await sh(policy, "echo evil > .git/hooks/pre-commit; echo '[core]' >> .git/config; mv .git .gitx; mkdir -p .git2 && echo ok > .git2/f");
	assert.equal(existsSync(join(ws, ".git", "hooks", "pre-commit")), false);
	assert.equal(readFileSync(join(ws, ".git", "config"), "utf8"), before);
	assert.equal(existsSync(join(ws, ".gitx")), false);
	assert.equal(readFileSync(join(ws, ".git2", "f"), "utf8"), "ok\n", "the rest of the workspace stays writable");
	const commit = await sh(policy, "git -c user.name=a -c user.email=b commit -q --allow-empty -m x && git log --oneline | wc -l");
	assert.equal(commit.code, 0, commit.output);
});

test("under sandbox-exec: a linked worktree commits, while the common dir's hooks, config, HEAD, index and other worktrees stay read-only", { skip: !onMac }, async (t) => {
	const { root, policy } = setup(t);
	const main = join(root, "main");
	const git = (...args: string[]) => spawnSync("git", ["-C", main, "-c", "user.name=a", "-c", "user.email=b", ...args], { encoding: "utf8" });
	assert.equal(spawnSync("git", ["init", "-q", main]).status, 0);
	assert.equal(git("commit", "-q", "--allow-empty", "-m", "init").status, 0);
	const wt = join(root, "wt");
	assert.equal(git("worktree", "add", "-q", "-b", "wt", wt).status, 0);
	assert.equal(git("worktree", "add", "-q", "-b", "other", join(root, "other")).status, 0);
	const common = join(main, ".git");
	const admin = join(common, "worktrees", "wt");
	const other = join(common, "worktrees", "other");
	const wtPolicy: Policy = { ...policy, workspaceRoot: wt, writable: [wt] };
	const plan = profilePlan({ policy: wtPolicy });
	assert.ok(plan.writable.includes(admin) && plan.writable.includes(common));
	assert.ok(plan.pins.includes(admin), "the admin dir itself cannot be renamed or removed");

	const guarded = [join(common, "config"), join(common, "HEAD"), join(common, "index"), join(other, "HEAD"), join(admin, "gitdir"), join(admin, "commondir")];
	const before = new Map(guarded.map((f) => [f, readFileSync(f, "utf8")]));
	const commit = await sh(wtPolicy, "echo x > f && git add f && git -c user.name=a -c user.email=b commit -q -m in-sandbox && git log --oneline | wc -l", wt);
	assert.equal(commit.code, 0, commit.output);
	assert.equal(commit.output.trim(), "2");
	assert.equal(git("log", "-1", "--format=%s", "wt").stdout.trim(), "in-sandbox");

	const attack = guarded.map((f) => `echo evil >> '${f}'`);
	attack.push(
		`echo evil > '${join(common, "hooks", "pre-commit")}'`,
		`echo evil > '${join(admin, "config.worktree")}'`,
		`mkdir '${join(common, "worktrees", "planted")}'`,
		`mv '${admin}' '${join(wt, "moved")}'`,
		`mv '${other}' '${join(common, "worktrees", "x")}'`,
	);
	const r = await sh(wtPolicy, attack.join("; ") + "; true", wt);
	assert.match(r.output, /Operation not permitted/);
	for (const [f, text] of before) assert.equal(readFileSync(f, "utf8"), text, f);
	assert.equal(existsSync(join(common, "hooks", "pre-commit")), false);
	assert.equal(existsSync(join(admin, "config.worktree")), false);
	assert.equal(existsSync(join(common, "worktrees", "planted")), false);
	assert.equal(existsSync(join(wt, "moved")), false);
	assert.equal(existsSync(join(admin, "HEAD")), true);
	assert.equal(existsSync(join(other, "HEAD")), true);
});

test("under sandbox-exec: hidden paths are neither read nor listed; Keychain files and service are refused", { skip: !onMac }, async (t) => {
	const { policy, secret } = setup(t);
	const r = await sh(policy, `cat '${secret}/key'; ls '${secret}'; /usr/bin/security find-generic-password -s sova-sandbox-test-nonexistent; echo "sec=$?"`);
	assert.ok(!r.output.includes("SECRET"));
	assert.match(r.output, /Operation not permitted/);
	assert.doesNotMatch(r.output, /sec=0/);
});

test("under sandbox-exec: loopback is reachable only on the allowed ports (confirmed by the listeners)", { skip: !onMac }, async (t) => {
	const { policy } = setup(t);
	const hits = { allowed: 0, bait: 0 };
	const listen = (k: keyof typeof hits) =>
		new Promise<{ port: number; close: () => void }>((r) => {
			const s = createServer((c) => {
				hits[k]++;
				c.destroy();
			});
			s.listen(0, "127.0.0.1", () => r({ port: (s.address() as { port: number }).port, close: () => s.close() }));
		});
	const allowed = await listen("allowed");
	const bait = await listen("bait");
	t.after(() => (allowed.close(), bait.close()));
	await sh({ ...policy, network: { mode: "none", localPorts: [allowed.port] } }, `/usr/bin/nc -z -G 2 127.0.0.1 ${allowed.port}; /usr/bin/nc -z -G 2 127.0.0.1 ${bait.port}; true`);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(hits.allowed, 1);
	assert.equal(hits.bait, 0);
});

test("probe: passes on the real profile, and is cached per policy", { skip: !onMac }, async (t) => {
	const { policy } = setup(t);
	const b = new DarwinSeatbeltBackend();
	const p = await b.probe(policy);
	assert.ok(p.ok, p.ok ? "" : p.reason);
	assert.equal(p.ok && p.enforcement, "full");
	assert.equal(await b.probe(policy), p);
});

test("a missing sandbox-exec refuses; it never runs unconfined", async (t) => {
	const { policy } = setup(t);
	const res = await new DarwinSeatbeltBackend({ sandboxExec: "/nonexistent/sandbox-exec" }).confine({ argv: ["/bin/true"], cwd: policy.workspaceRoot, policy });
	assert.equal(res.ok, false);
	assert.equal(!res.ok && res.code, "SANDBOX_UNAVAILABLE");
});

test("the test-only global override replaces sandbox-exec; a broken one fails the probe", { skip: !onMac }, async (t) => {
	const { policy, root } = setup(t);
	const fake = join(root, "sandbox-exec");
	writeFileSync(fake, "#!/bin/sh\necho 'sandbox-exec: broken' >&2\nexit 1\n", { mode: 0o755 });
	const g = globalThis as Record<symbol, unknown>;
	g[SANDBOX_EXEC_OVERRIDE] = fake;
	t.after(() => delete g[SANDBOX_EXEC_OVERRIDE]);
	const b = new DarwinSeatbeltBackend();
	const res = await b.confine({ argv: ["/bin/true"], cwd: policy.workspaceRoot, policy });
	assert.ok(res.ok && res.confined.argv[0] === fake);
	const p = await b.probe(policy);
	assert.equal(p.ok, false);
});
