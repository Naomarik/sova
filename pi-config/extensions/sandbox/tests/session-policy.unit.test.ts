import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { backendFor, gitProtectedPaths, shadowSource } from "../backend.ts";
import { canonicalize, readDenial, resolvePolicy, writeDenial } from "../policy.ts";
import { ensureSessionTmpDir, resolveSessionPolicy, sessionTmpBase, sessionTmpDir } from "../session-policy.ts";

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "sandbox-policy");

/** A home with an agent dir seeded from the shipped templates, a workspace and a worktree. */
function rig(t: { after: (fn: () => void) => void }) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sbx-session-policy-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	cpSync(TEMPLATE_DIR, join(agentDir, "sandbox-policy"), { recursive: true });
	const ws = join(root, "ws");
	const wt = join(root, "wt");
	mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
	mkdirSync(join(wt, ".agent"), { recursive: true });
	mkdirSync(join(home, ".ssh"), { recursive: true });
	return { root, home, agentDir, ws, wt };
}

test("the session policy is exactly what the extension's snapshot resolved before", (t) => {
	const { home, agentDir, ws, wt } = rig(t);
	const backend = backendFor("linux");
	const tmpDir = sessionTmpDir("s1");
	const got = resolveSessionPolicy({ agentDir, cwd: ws, sessionId: "s1", worktreeRoots: [wt], home, platform: "linux" });
	const want = resolvePolicy({
		agentDir, cwd: ws, tmpDir, home, platform: "linux",
		defaults: backend.platformDefaults({ home, agentDir }), shadowSource, git: gitProtectedPaths,
		extraWritable: [wt], extraReadOnly: [join(wt, ".agent")],
	});
	assert.deepEqual(got, want);
	assert.ok(got.ok);
});

test("worktrees are writable roots with their .agent read-only; platform secrets are hidden; git hooks are protected", (t) => {
	const { home, agentDir, ws, wt } = rig(t);
	const r = resolveSessionPolicy({ agentDir, cwd: ws, sessionId: "s2", worktreeRoots: [wt], home, platform: "linux" });
	assert.ok(r.ok, r.ok ? "" : r.error);
	const p = r.value;
	assert.equal(writeDenial(p, canonicalize(join(ws, "a.txt")), { creating: true }), undefined);
	assert.equal(writeDenial(p, canonicalize(join(wt, "b.txt")), { creating: true }), undefined);
	assert.ok(writeDenial(p, canonicalize(join(wt, ".agent", "x")), { creating: true }));
	assert.ok(writeDenial(p, canonicalize(join(ws, ".git", "hooks", "pre-commit")), { creating: true }));
	assert.ok(writeDenial(p, canonicalize(join(home, "elsewhere")), { creating: true }));
	assert.ok(readDenial(p, canonicalize(join(home, ".ssh"))));
	assert.equal(p.tmpDir, canonicalize(sessionTmpDir("s2")));
	// Without the worktree it is not writable.
	const bare = resolveSessionPolicy({ agentDir, cwd: ws, sessionId: "s2", home, platform: "linux" });
	assert.ok(bare.ok);
	assert.ok(writeDenial(bare.value, canonicalize(join(wt, "b.txt")), { creating: true }));
});

test("fails closed without a policy file, and never creates the session tmp", (t) => {
	const { root, home, ws } = rig(t);
	const r = resolveSessionPolicy({ agentDir: join(root, "no-agent"), cwd: ws, sessionId: "never-made", home, platform: "linux" });
	assert.equal(r.ok, false);
	assert.equal(existsSync(join(sessionTmpBase(), "never-made")), false);
});

test("an injected backend supplies the platform lists", (t) => {
	const { home, agentDir, ws } = rig(t);
	const secret = join(ws, "secret");
	const backend = { platformDefaults: () => ({ hidden: [secret], writable: [], readOnlyWithinWritable: [], shadowed: [] }) };
	const r = resolveSessionPolicy({ agentDir, cwd: ws, sessionId: "s3", home, platform: "linux", backend });
	assert.ok(r.ok);
	assert.ok(readDenial(r.value, canonicalize(secret)));
});

test("the session tmp path: sanitised id, pid fallback, made 0700 on demand", (t) => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "sbx-session-tmp-")));
	const saved = process.env.TMPDIR;
	process.env.TMPDIR = base;
	t.after(() => {
		if (saved === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = saved;
		rmSync(base, { recursive: true, force: true });
	});
	assert.equal(sessionTmpDir("a/b c"), join(sessionTmpBase(), "a_b_c", "tmp"));
	assert.equal(sessionTmpDir(""), join(sessionTmpBase(), `pid${process.pid}`, "tmp"));
	assert.ok(sessionTmpBase().startsWith(base));
	const made = ensureSessionTmpDir("s4");
	assert.equal(made, sessionTmpDir("s4"));
	assert.equal(statSync(made).mode & 0o777, 0o700);
	assert.equal(statSync(sessionTmpBase()).mode & 0o777, 0o700);
});
