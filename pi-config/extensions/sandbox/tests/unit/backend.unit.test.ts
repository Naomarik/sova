import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendFor, canonicalizePath, classifyRun, isWithin, policyKey, type Confined, type Policy } from "../../backend.ts";
import { DarwinSeatbeltBackend } from "../../backends/darwin-seatbelt.ts";
import { UnsupportedBackend } from "../../backends/unsupported.ts";
import { type RealpathIo, tolerantRealpath } from "../../realpath.ts";

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

test("backendFor picks linux-bwrap on linux, darwin-seatbelt on darwin, and refuses elsewhere", async () => {
	assert.equal(backendFor("linux").id, "linux-bwrap");
	assert.ok(backendFor("darwin") instanceof DarwinSeatbeltBackend);
	for (const p of ["win32", "freebsd"] as const) {
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

/** Real fs, except realpath throws `code` for the paths `denied` matches (as Bun does on macOS TCC dirs). */
function failingIo(denied: (p: string) => boolean, code = "EPERM"): RealpathIo & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		realpath: (p) => {
			calls.push(p);
			if (denied(p)) throw Object.assign(new Error(`${code}: operation not permitted, lstat '${p}'`), { code });
			return realpathSync(p);
		},
		lstat: (p) => lstatSync(p),
		readlink: (p) => readlinkSync(p),
	};
}

/** root/real/{Cookies,Mail -> root/target}, root/lib -> root/real, root/target/file. */
function tccTree(t: { after: (fn: () => void) => void }) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sbx-canon-eperm-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "real", "Cookies"), { recursive: true });
	mkdirSync(join(root, "target"));
	writeFileSync(join(root, "target", "file"), "");
	symlinkSync(join(root, "real"), join(root, "lib"));
	symlinkSync(join(root, "target"), join(root, "real", "Mail"));
	return root;
}

test("darwin, EPERM/EACCES from realpath on a leaf (Bun on TCC dirs): the canonical path, symlinked ancestors and leaves resolved", (t) => {
	const root = tccTree(t);
	for (const code of ["EPERM", "EACCES"]) {
		const cookies = failingIo((p) => p.endsWith("/Cookies"), code);
		// The refused leaf: its parent's realpath (through the `lib` link) plus the basename.
		assert.equal(canonicalizePath(join(root, "lib", "Cookies"), undefined, cookies, "darwin"), join(root, "real", "Cookies"));
		// Below it, missing: the not-found walk reaches the refused dir and appends the rest.
		assert.equal(canonicalizePath(join(root, "lib", "Cookies", "missing", "x"), undefined, cookies, "darwin"), join(root, "real", "Cookies", "missing", "x"));
		// A refused leaf that is itself a symlink is followed, so a deny rule names its target.
		const mail = failingIo((p) => p.endsWith("/Mail"), code);
		assert.equal(canonicalizePath(join(root, "lib", "Mail"), undefined, mail, "darwin"), join(root, "target"));
		// Every component under the temp root refused: still resolved component-wise.
		const all = failingIo((p) => p.startsWith(root), code);
		assert.equal(tolerantRealpath(join(root, "lib", "Mail"), all, "darwin"), join(root, "target"));
		assert.equal(tolerantRealpath(join(root, "lib", "Cookies"), all, "darwin"), join(root, "real", "Cookies"));
	}
	// A symlink loop under EPERM ends (bounded) with the original error, never a hang.
	symlinkSync(join(root, "loopB"), join(root, "loopA"));
	symlinkSync(join(root, "loopA"), join(root, "loopB"));
	assert.throws(() => tolerantRealpath(join(root, "loopA"), failingIo((p) => p.includes("/loop")), "darwin"), { code: "EPERM" });
});

test("darwin, a refused relative symlink reached through a symlinked parent resolves against the real parent", (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sbx-canon-relink-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "deep", "real"), { recursive: true });
	mkdirSync(join(root, "deep", "t"));
	symlinkSync(join(root, "deep", "real"), join(root, "lib"));
	symlinkSync("../t", join(root, "deep", "real", "Rel"));
	const io = failingIo((p) => p.endsWith("/Rel"));
	assert.equal(canonicalizePath(join(root, "lib", "Rel"), undefined, io, "darwin"), realpathSync(join(root, "deep", "t")));
});

test("unchanged: ENOENT/ENOTDIR walk, symlinked ancestors, missing paths, other errors, and non-darwin never falls back", (t) => {
	const root = tccTree(t);
	for (const platform of ["darwin", "linux"] as const) {
		const io = failingIo(() => false);
		assert.equal(canonicalizePath(join(root, "lib", "Cookies"), undefined, io, platform), join(root, "real", "Cookies"));
		assert.equal(canonicalizePath(join(root, "lib", "nope", "deeper"), undefined, io, platform), join(root, "real", "nope", "deeper"));
		assert.equal(canonicalizePath("/definitely-not-here-sbx/a/b", undefined, io, platform), "/definitely-not-here-sbx/a/b");
		// ENOTDIR: a path through a file walks up the same way.
		assert.throws(() => realpathSync(join(root, "lib", "Mail", "file", "x")), { code: "ENOTDIR" });
		assert.equal(canonicalizePath(join(root, "lib", "Mail", "file", "x"), undefined, io, platform), join(root, "target", "file", "x"));
		// The default io is the real realpathSync: same answers.
		assert.equal(canonicalizePath(join(root, "lib", "Cookies"), undefined, undefined, platform), join(root, "real", "Cookies"));
		// Errors other than ENOENT/ENOTDIR/EPERM/EACCES propagate, on every platform.
		const eio = failingIo(() => true, "EIO");
		assert.throws(() => canonicalizePath(join(root, "lib"), undefined, eio, platform), { code: "EIO" });
		assert.deepEqual(eio.calls, [join(root, "lib")]);
	}
	// Off darwin, EPERM/EACCES propagate exactly as before: one realpath call, no lstat/readlink fallback.
	for (const platform of ["linux", "win32", "freebsd"] as const) {
		for (const code of ["EPERM", "EACCES"]) {
			const io = failingIo((p) => p.endsWith("/Cookies"), code);
			let touched = false;
			io.lstat = () => ((touched = true), lstatSync(root));
			io.readlink = () => ((touched = true), "");
			assert.throws(() => canonicalizePath(join(root, "lib", "Cookies"), undefined, io, platform), { code });
			assert.throws(() => tolerantRealpath(join(root, "lib", "Cookies"), io, platform), { code });
			assert.equal(touched, false);
			assert.deepEqual(io.calls, [join(root, "lib", "Cookies"), join(root, "lib", "Cookies")]);
		}
	}
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
