import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { backendFor, gitProtectedPaths, shadowSource } from "../backend.ts";
import { canonicalize, readDenial, resolvePolicy, writeDenial } from "../policy.ts";
import { mountPlan } from "../backends/linux-bwrap.ts";
import { BROWSER_RULES, DarwinSeatbeltBackend } from "../backends/darwin-seatbelt.ts";
import { spawnSync } from "node:child_process";
import { ensureSessionTmpDir, prepareSessionCommand, resolveSessionPolicy, sessionTmpBase, sessionTmpDir } from "../session-policy.ts";

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

test("a tracked worktree whose folder was removed never reaches the mounts: the sandbox still starts", { skip: !existsSync("/usr/bin/bwrap") && "no bwrap" }, async (t) => {
	const { root, home, agentDir, ws } = rig(t);
	const gone = join(root, "wt-removed");
	const backend = backendFor("linux");
	const tmpDir = join(root, "tmp");
	mkdirSync(tmpDir);
	const r = resolveSessionPolicy({ agentDir, cwd: ws, sessionId: "s-gone", tmpDir, worktreeRoots: [gone], home, platform: "linux" });
	assert.ok(r.ok, r.ok ? "" : r.error);
	const p = r.value;
	const policy = { level: p.level, workspaceRoot: p.workspaceRoot, writable: p.writable, readOnlyWithinWritable: p.readOnlyWithinWritable, hidden: p.hidden, tmpDir: p.tmpDir, shadowed: p.shadowed, network: { mode: "none" as const }, env: {}, sessionId: "s-gone" };
	assert.ok(!mountPlan(policy).ops.some((o) => o.path === gone || o.path.startsWith(`${gone}/`)), "no bind or read-only overlay for the missing folder");
	const res = await backend.confine({ argv: ["/bin/true"], cwd: ws, policy });
	assert.ok(res.ok, res.ok ? "" : res.reason);
	const run = spawnSync(res.confined.argv[0]!, res.confined.argv.slice(1), { env: res.confined.env, encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
});

test("a worktree whose folder is gone is no writable root, and its .agent no read-only path, whichever backend runs", (t) => {
	const { agentDir, home, ws, wt, root } = rig(t);
	const gone = join(root, "retired");
	const r = resolveSessionPolicy({ agentDir, cwd: ws, sessionId: "s-gone", home, platform: "darwin", worktreeRoots: [wt, gone] });
	assert.ok(r.ok);
	if (!r.ok) return;
	assert.ok(r.value.writable.some((p) => p === wt || p === realpathSync(wt)), "the one that's there is a root");
	assert.equal(r.value.writable.some((p) => p.startsWith(gone)), false);
	assert.equal(r.value.readOnlyWithinWritable.some((p) => p.startsWith(gone)), false);
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

test("prepareSessionCommand hands the policy's browser to the backend, as the extension's snapshot does", async (t) => {
	const { home, agentDir, ws } = rig(t);
	// read-only: no proxy to start. The real darwin profile is rendered; only the probe (sandbox-exec) is stubbed.
	const file = join(agentDir, "sandbox-policy", "darwin", "policy.json");
	const setBrowser = (browser: string) => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), level: "read-only", browser }));
	const profileOf = async (parent?: Parameters<typeof prepareSessionCommand>[0]["parent"]) => {
		const backend = new DarwinSeatbeltBackend({ sandboxExec: process.execPath });
		const seen: boolean[] = [];
		backend.probe = async (policy) => {
			seen.push(policy.browser === true);
			return { ok: true, enforcement: "full" };
		};
		const r = await prepareSessionCommand({ agentDir, cwd: ws, sessionId: "s-browser", home, platform: "darwin", ...(parent ? { parent } : {}) }, ["/bin/true"], { backend });
		assert.ok(r.ok, r.ok ? "" : r.error);
		const profile = readFileSync(r.value.argv[r.value.argv.indexOf("-f") + 1]!, "utf8");
		await r.value.dispose();
		return { probed: seen[0], rules: BROWSER_RULES.every((rule) => profile.includes(rule)), any: BROWSER_RULES.some((rule) => profile.includes(rule)) };
	};
	setBrowser("headless-shell");
	assert.deepEqual(await profileOf(), { probed: true, rules: true, any: true });
	setBrowser("none");
	assert.deepEqual(await profileOf(), { probed: false, rules: false, any: false });
	// A worker's is its parent's, never its own file's.
	const scope = { version: 1 as const, level: "read-only" as const, workspaceRoot: ws, writable: [] };
	assert.deepEqual(await profileOf({ ...scope, browser: true }), { probed: true, rules: true, any: true });
	setBrowser("headless-shell");
	assert.deepEqual(await profileOf(scope), { probed: false, rules: false, any: false });
});

test("prepareSessionCommand: a caller's own tmp is the attempt's, and goes with its parent; without one, the default", async (t) => {
	const { home, agentDir, ws } = rig(t);
	const file = join(agentDir, "sandbox-policy", "darwin", "policy.json");
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), level: "read-only" }));
	const run = async (tmpDir?: string) => {
		const backend = new DarwinSeatbeltBackend({ sandboxExec: process.execPath });
		backend.probe = async () => ({ ok: true, enforcement: "full" });
		const r = await prepareSessionCommand({ agentDir, cwd: ws, sessionId: "s-own-tmp", home, platform: "darwin", ...(tmpDir ? { tmpDir } : {}) }, ["/bin/true"], { backend });
		assert.ok(r.ok, r.ok ? "" : r.error);
		return r.value;
	};
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "own-")));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const own = await run(join(parent, "t"));
	assert.equal(own.env.TMPDIR, `${join(parent, "t")}/`);
	assert.equal(statSync(join(parent, "t")).mode & 0o777, 0o700);
	await own.dispose();
	assert.ok(!existsSync(parent), "the caller's folder goes with the attempt");
	const dflt = await run();
	assert.ok(canonicalize(dflt.env.TMPDIR!).startsWith(canonicalize(sessionTmpBase())), "no tmp asked for: the session tmp base");
	const made = dflt.env.TMPDIR!;
	await dflt.dispose();
	assert.ok(!existsSync(made));
});

test("prepareSessionCommand: a caller's own tmp keeps the attempt's proxy socket beside it, whatever TMPDIR is", async (t) => {
	const { home, agentDir, ws } = rig(t);
	let parent: string;
	// A socket path needs to be short: /tmp, which a sandboxed chat running this test can't write. On
	// Linux /dev/shm instead, as proxy.unit.test.ts does: linux-bwrap's hostTmp test, running beside
	// this one, masks every socket in /tmp, and one removed between its scan and bwrap's start fails it.
	const shortRoot = process.platform === "linux" && existsSync("/dev/shm") ? "/dev/shm" : "/tmp";
	try { parent = realpathSync(mkdtempSync(join(shortRoot, "own-"))); } catch { t.skip(`${shortRoot} is closed here`); return; }
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const backend = new DarwinSeatbeltBackend({ sandboxExec: process.execPath });
	let socket: string | undefined;
	backend.probe = async (policy) => { socket = policy.network.proxy?.socket; return { ok: true, enforcement: "full" }; };
	const before = process.env.TMPDIR;
	process.env.TMPDIR = join(parent, "x".repeat(120));
	try {
		const r = await prepareSessionCommand({ agentDir, cwd: ws, sessionId: "s-own-socket", home, platform: "darwin", tmpDir: join(parent, "t") }, ["/bin/true"], { backend });
		assert.ok(r.ok, r.ok ? "" : r.error);
		assert.equal(socket, join(parent, "p.sock"), "beside the tmp, so a long TMPDIR can't take the network away");
		assert.ok(existsSync(socket!));
		await r.value.dispose();
		assert.ok(!existsSync(parent));
	} finally { if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before; }
});
