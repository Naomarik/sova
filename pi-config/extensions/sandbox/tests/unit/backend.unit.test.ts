import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendFor, canonicalizePath, classifyRun, isWithin, policyKey, type Confined, type Policy } from "../../backend.ts";
import { UnsupportedBackend } from "../../backends/unsupported.ts";

const policy = (over: Partial<Policy> = {}): Policy => ({
	level: "workspace-write",
	workspaceRoot: "/w",
	writable: ["/w"],
	readOnlyWithinWritable: [],
	hidden: [],
	tmpDir: "/t",
	network: { mode: "none" },
	env: { PATH: "/usr/bin" },
	sessionId: "s",
	...over,
});

test("backendFor picks linux-bwrap on linux and refuses elsewhere", async () => {
	assert.equal(backendFor("linux").id, "linux-bwrap");
	for (const p of ["darwin", "win32", "freebsd"] as const) {
		const b = backendFor(p);
		assert.ok(b instanceof UnsupportedBackend);
		const probe = await b.probe(policy());
		assert.deepEqual(probe, { ok: false, reason: `no sandbox backend for ${p}` });
		const c = await b.confine({ argv: ["/bin/true"], cwd: "/w", policy: policy() });
		assert.equal(c.ok, false);
		assert.equal(!c.ok && c.code, "SANDBOX_UNAVAILABLE");
	}
});

test("canonicalizePath resolves symlinks of the deepest existing ancestor", (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sbx-canon-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "real"));
	symlinkSync(join(root, "real"), join(root, "link"));
	assert.equal(canonicalizePath(join(root, "link", "a", "b")), join(root, "real", "a", "b"));
	assert.equal(canonicalizePath(join(root, "link")), join(root, "real"));
	assert.equal(canonicalizePath("x/../y", root), join(root, "y"));
	// A link inside the workspace pointing out is seen at its real place, outside the root.
	symlinkSync("/etc", join(root, "real", "out"));
	assert.equal(isWithin(canonicalizePath(join(root, "real", "out", "passwd")), root), false);
});

test("isWithin is component-wise", () => {
	assert.ok(isWithin("/a/b", "/a"));
	assert.ok(isWithin("/a", "/a"));
	assert.ok(!isWithin("/ab", "/a"));
	assert.ok(isWithin("/x", "/"));
});

test("policyKey ignores list order and env values", () => {
	const a = policyKey(policy({ hidden: ["/b", "/a"], env: { A: "1", B: "2" } }));
	const b = policyKey(policy({ hidden: ["/a", "/b"], env: { B: "x", A: "y" } }));
	assert.equal(a, b);
	assert.notEqual(a, policyKey(policy({ level: "read-only" })));
});

const confined: Confined = {
	argv: [],
	env: {},
	enforcement: "full",
	network: "none",
	denialSignatures: ["Read-only file system", "not in the sandbox proxy allowlist"],
	runnerFailure: { fatalSignatures: ["^bwrap: "] },
};

test("classifyRun: runner failure, denial, plain failure, success", () => {
	assert.deepEqual(classifyRun(confined, { exitCode: 0, output: "bwrap: whatever" }), { kind: "ok" });
	const rf = classifyRun(confined, { exitCode: 1, output: "bwrap: Can't mkdir /x: Read-only file system\n" });
	assert.equal(rf.kind, "runner-failure");
	const den = classifyRun(confined, { exitCode: 1, output: "touch: cannot touch '/home/x': Read-only file system\n" });
	assert.equal(den.kind, "denied");
	assert.equal(classifyRun(confined, { exitCode: 2, output: "grep: no match\n" }).kind, "failed");
	// "bwrap: " must start a line; a command echoing it mid-line is not a runner failure.
	assert.equal(classifyRun(confined, { exitCode: 1, output: "note: bwrap: x\n" }).kind, "failed");
	assert.equal(classifyRun(confined, { exitCode: null, output: "bwrap: execvp x: No such file\n" }).kind, "runner-failure");
	const withInfo = { ...confined, runnerFailure: { fatalSignatures: ["^bwrap: "], informationalLines: ["^bwrap: info"] } };
	assert.equal(classifyRun(withInfo, { exitCode: 1, output: "bwrap: info only\n" }).kind, "failed");
});

test("checkWrite: git, trust stores, hidden, outside, tmp, symlinks, non-repo .git, read-only level", async (t) => {
	const { execFileSync } = await import("node:child_process");
	const { writeFileSync } = await import("node:fs");
	const { checkWrite } = await import("../../backend.ts");
	const base = realpathSync(mkdtempSync(join(tmpdir(), "sbx-cw-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const ws = join(base, "ws");
	const plain = join(base, "plain");
	const tmp = join(base, "tmp");
	const home = join(base, "home");
	for (const d of [ws, plain, tmp, join(home, ".local", "state", "mise")]) mkdirSync(d, { recursive: true });
	execFileSync("git", ["init", "-q", ws]);
	writeFileSync(join(ws, "secret.json"), "x");
	symlinkSync(join(ws, ".git", "hooks"), join(ws, "hooks-link"));
	const p = policy({
		workspaceRoot: ws, writable: [ws, plain, join(home, ".local", "state", "mise")], tmpDir: tmp, hidden: [join(ws, "secret.json")],
		env: { HOME: home, XDG_STATE_HOME: join(home, ".local", "state") },
	});
	const ok = (path: string) => checkWrite(p, path).ok;
	assert.ok(ok(join(ws, "src", "a.ts")));
	assert.ok(ok("rel/b.ts"), "relative paths resolve against the workspace");
	assert.ok(ok(join(ws, ".git", "objects", "ab")));
	assert.ok(!ok(join(ws, ".git", "hooks", "pre-commit")));
	assert.ok(!ok(join(ws, ".git", "config")));
	assert.ok(!ok(join(ws, "hooks-link", "post-commit")), "a symlink is judged at its target");
	assert.ok(!ok(join(ws, "secret.json")));
	assert.ok(!ok(join(base, "elsewhere")));
	assert.ok(ok(join(tmp, "x")));
	assert.ok(!ok(join(plain, ".git", "hooks", "pre-commit")), "no repo yet: creating .git is refused");
	assert.ok(!ok(join(home, ".local", "state", "mise", "trusted-configs", "x")));
	assert.ok(ok(join(home, ".local", "state", "mise", "other")));
	const r = checkWrite(p, join(ws, ".git", "config"));
	assert.equal(r.ok, false);
	assert.match(!r.ok ? r.reason : "", /read-only inside the workspace/);
	const ro = policy({ ...p, level: "read-only" });
	assert.ok(!checkWrite(ro, join(ws, "a")).ok);
	assert.ok(checkWrite(ro, join(tmp, "a")).ok);
});

test("checkWrite in a linked worktree: own admin dir and objects writable, redirects and main checkout not", async (t) => {
	const { execFileSync } = await import("node:child_process");
	const { checkWrite } = await import("../../backend.ts");
	const base = realpathSync(mkdtempSync(join(tmpdir(), "sbx-cwwt-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const main = join(base, "main");
	const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: main });
	mkdirSync(main);
	g("init", "-q");
	g("commit", "-q", "--allow-empty", "-m", "r");
	const wt = join(base, "wt");
	g("worktree", "add", "-q", "-b", "side", wt);
	const common = join(main, ".git");
	const p = policy({ workspaceRoot: wt, writable: [wt], tmpDir: join(base, "tmp") });
	const ok = (path: string) => checkWrite(p, path).ok;
	assert.ok(ok(join(common, "worktrees", "wt", "index")));
	assert.ok(ok(join(common, "objects", "ab", "cd")));
	assert.ok(ok(join(common, "refs", "heads", "side")));
	assert.ok(!ok(join(common, "worktrees", "wt", "commondir")));
	assert.ok(!ok(join(common, "worktrees", "wt", "gitdir")));
	assert.ok(ok(join(common, "worktrees", "wt", "HEAD")), "this worktree's own branch state");
	assert.ok(!ok(join(common, "worktrees", "other", "commondir")));
	assert.ok(!ok(join(common, "hooks", "post-commit")));
	assert.ok(!ok(join(common, "config")));
	assert.ok(!ok(join(common, "HEAD")));
	assert.ok(!ok(join(common, "index")));
	assert.ok(!ok(join(wt, ".git")));
	assert.ok(!ok(join(main, "file")));
});

test("shadowSource names are readable, collision-free and under <agentDir>/sova/sandbox/shadow", async () => {
	const { shadowSource } = await import("../../backend.ts");
	assert.equal(shadowSource("/a", "~/.cache", "/home/u"), "/a/sova/sandbox/shadow/home-.cache");
	assert.equal(shadowSource("/a", "/home/u/.npm", "/home/u"), "/a/sova/sandbox/shadow/home-.npm");
	assert.equal(shadowSource("/a", "/home/u/x/y", "/home/u"), "/a/sova/sandbox/shadow/home-x%2Fy");
	assert.notEqual(shadowSource("/a", "/home/u/x-y", "/home/u"), shadowSource("/a", "/home/u/x/y", "/home/u"));
	assert.equal(shadowSource("/a", "/opt/c", "/home/u"), "/a/sova/sandbox/shadow/root-opt%2Fc");
});

test("mapShadowed and checkWrite: the view path is judged, the source is where it lives", async (t) => {
	const { checkWrite, mapShadowed } = await import("../../backend.ts");
	const base = realpathSync(mkdtempSync(join(tmpdir(), "sbx-sh-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const ws = join(base, "ws");
	const cache = join(base, "cache");
	const source = join(ws, ".agent", "shadow", "cache");
	mkdirSync(ws);
	mkdirSync(cache);
	const p = policy({ workspaceRoot: ws, writable: [ws], readOnlyWithinWritable: [join(ws, ".agent")], tmpDir: join(base, "t"), shadowed: [{ path: cache, source }] });
	assert.equal(mapShadowed(p, join(cache, "a", "b")), join(source, "a", "b"));
	assert.equal(mapShadowed(p, cache), source);
	assert.equal(mapShadowed(p, join(ws, "x")), join(ws, "x"));
	assert.ok(checkWrite(p, join(cache, "a")).ok, "the shadow is writable");
	assert.ok(!checkWrite(p, join(source, "a")).ok, "its source, seen at its real place under the read-only agent dir, is not");
	assert.equal(mapShadowed(policy({ ...p, level: "read-only" }), join(cache, "a")), join(cache, "a"), "read-only ignores shadows");
	assert.ok(!checkWrite(policy({ ...p, level: "read-only" }), join(cache, "a")).ok);
});
