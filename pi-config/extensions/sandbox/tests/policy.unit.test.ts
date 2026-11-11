import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	applyProjectTightening,
	canonicalize,
	loadPolicyFile,
	narrowScope,
	parentBrowser,
	parentScopeOf,
	parseParentScope,
	type PolicyFile,
	policyFilePath,
	readDenial,
	resolvePolicy,
	validatePolicyFile,
	workerCwdRefusal,
	writeDenial,
	writeOnlyScope,
} from "../policy.ts";

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "sandbox-policy");
const template = (platform = "linux"): PolicyFile => {
	const v = validatePolicyFile(JSON.parse(readText(join(TEMPLATE_DIR, platform, "policy.json"))));
	assert.ok(v.ok, v.ok ? "" : v.error);
	return v.value;
};
const readText = (p: string) => readFileSync(p, "utf8");

function tmp(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "sbx-policy-")));
}

test("the shipped templates validate, start off, and mean workspace-write", () => {
	for (const p of ["linux", "darwin"]) {
		const t = template(p);
		assert.equal(t.defaultOn, false);
		assert.equal(t.level, "workspace-write");
		assert.ok(t.proxy.allow.includes("registry.npmjs.org"));
	}
});

test("validation fails closed: unknown, missing and malformed keys", () => {
	const t = template();
	assert.match(String((validatePolicyFile({ ...t, hiden: [] }) as { error: string }).error), /unknown key "hiden"/);
	const { hidden: _h, ...missing } = t;
	assert.match(String((validatePolicyFile(missing) as { error: string }).error), /missing key "hidden"/);
	assert.equal(validatePolicyFile({ ...t, level: "full" }).ok, false);
	assert.equal(validatePolicyFile({ ...t, version: 2 }).ok, false);
	assert.equal(validatePolicyFile({ ...t, hidden: ["~/.ssh", 3] }).ok, false);
	assert.equal(validatePolicyFile({ ...t, proxy: { allow: ["evil.com/path"] } }).ok, false);
	assert.equal(validatePolicyFile({ ...t, proxy: { allow: [], extra: 1 } }).ok, false);
	assert.equal(validatePolicyFile({ ...t, env: { allow: ["BAD-NAME"] } }).ok, false);
	assert.equal(validatePolicyFile({ ...t, defaultOn: "yes" }).ok, false);
	const { shadowed: _s, ...noShadow } = t;
	assert.match(String((validatePolicyFile(noShadow) as { error: string }).error), /missing key "shadowed"/);
	assert.match(String((validatePolicyFile({ ...t, writable: ["~/.cache"] }) as { error: string }).error), /cannot be at or inside shadowed "~\/\.cache"/);
	assert.match(String((validatePolicyFile({ ...t, writable: ["~/.cache/foo"] }) as { error: string }).error), /cannot be at or inside shadowed "~\/\.cache"/);
	assert.equal(validatePolicyFile({ ...t, writable: ["~/.cachex"] }).ok, true);
	assert.equal(validatePolicyFile([]).ok, false);
});

test("loadPolicyFile re-reads a changed file and reports a missing one", () => {
	const dir = tmp();
	const path = join(dir, "policy.json");
	assert.match(String((loadPolicyFile(path) as { error: string }).error), /no policy file/);
	writeFileSync(path, JSON.stringify(template()));
	assert.equal(loadPolicyFile(path).ok, true);
	writeFileSync(path, "{ not json");
	utimesSync(path, new Date(), new Date(Date.now() + 5000));
	assert.match(String((loadPolicyFile(path) as { error: string }).error), /unreadable policy/);
	rmSync(dir, { recursive: true, force: true });
});

test("a project file only tightens", () => {
	const t = { ...template(), writable: ["~/.cache", "~/.local/state/mise"], shadowed: ["~/.npm", "~/.m2"] };
	const { policy, ignored } = applyProjectTightening(t, {
		level: "read-only",
		hidden: [".env"],
		readOnlyWithinWritable: ["Makefile"],
		writable: ["~/.cache", "/etc"],
		proxy: { allow: ["github.com", "evil.example"] },
		shadowed: ["~/.npm", "/etc"],
		defaultOn: true,
		acceptPartial: true,
		env: { allow: ["AWS_*"] },
	});
	assert.equal(policy.level, "read-only");
	assert.ok(policy.hidden.includes(".env") && policy.hidden.includes("~/.ssh"));
	assert.ok(policy.readOnlyWithinWritable.includes("Makefile"));
	assert.deepEqual(policy.writable, ["~/.cache"]);
	assert.deepEqual(policy.proxy.allow, ["github.com"]);
	assert.deepEqual(policy.shadowed, ["~/.npm"]);
	assert.ok(ignored.includes("shadowed (entries not in the global policy)"));
	assert.equal(policy.defaultOn, false);
	assert.equal(policy.acceptPartial, false);
	assert.deepEqual(policy.env.allow, []);
	for (const k of ["defaultOn", "acceptPartial", "env"]) assert.ok(ignored.includes(k), k);
	// Raising the level is not possible.
	const ro = { ...t, level: "read-only" as const };
	assert.equal(applyProjectTightening(ro, { level: "workspace-write" }).policy.level, "read-only");
	assert.deepEqual(applyProjectTightening(ro, { level: "workspace-write" }).ignored, ["level"]);
	// The input is never mutated.
	assert.equal(t.level, "workspace-write");
});

test("canonicalize follows links, including dangling ones, and spells missing tails", () => {
	const d = tmp();
	mkdirSync(join(d, "ws"));
	mkdirSync(join(d, "outside"));
	symlinkSync(join(d, "outside"), join(d, "ws", "link"));
	symlinkSync(join(d, "outside", "nope", "deep"), join(d, "ws", "dangling"));
	assert.equal(canonicalize(join(d, "ws", "link", "f.txt")), join(d, "outside", "f.txt"));
	assert.equal(canonicalize(join(d, "ws", "dangling")), join(d, "outside", "nope", "deep"));
	assert.equal(canonicalize(join(d, "ws", "a", "b", "..", "c")), join(d, "ws", "a", "c"));
	rmSync(d, { recursive: true, force: true });
});

/** The test server's layout: the agent dir, and so the policy dir, INSIDE the writable cwd. */
function hardCase() {
	const ws = tmp();
	const agentDir = join(ws, ".agent");
	mkdirSync(join(agentDir, "sandbox-policy"), { recursive: true });
	cpSync(TEMPLATE_DIR, join(agentDir, "sandbox-policy"), { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), "{}");
	writeFileSync(join(agentDir, "auth.json"), "{}");
	const tmpDir = join(ws, "..", `${ws.split("/").pop()}-tmp`);
	mkdirSync(tmpDir, { recursive: true });
	const home = tmp();
	mkdirSync(join(home, ".ssh"));
	const r = resolvePolicy({ agentDir, cwd: ws, tmpDir, platform: "linux", home });
	assert.ok(r.ok, r.ok ? "" : r.error);
	return { ws, agentDir, tmpDir, home, policy: r.value, cleanup: () => [ws, tmpDir, home].forEach((p) => rmSync(p, { recursive: true, force: true })) };
}

test("hard case: the policy dir inside the writable cwd is still refused, by canonical path", () => {
	const { ws, agentDir, policy, cleanup } = hardCase();
	const policyJson = policyFilePath(agentDir, "linux");
	assert.ok(writeDenial(policy, canonicalize(policyJson)));
	assert.ok(readDenial(policy, canonicalize(policyJson)));
	assert.ok(writeDenial(policy, canonicalize(join(agentDir, "sandbox-policy", "linux", "new.json")), { creating: true }));
	// The rest of the agent dir is read-only too (sessions, settings, extensions run later unsandboxed).
	assert.ok(writeDenial(policy, canonicalize(join(agentDir, "settings.json"))));
	assert.ok(readDenial(policy, canonicalize(join(agentDir, "auth.json"))));
	// Through a symlink planted in the workspace.
	symlinkSync(join(agentDir, "sandbox-policy"), join(ws, "innocent"));
	assert.ok(writeDenial(policy, canonicalize(join(ws, "innocent", "linux", "policy.json"))));
	assert.ok(readDenial(policy, canonicalize(join(ws, "innocent", "linux", "policy.json"))));
	// Ordinary workspace files are fine.
	assert.equal(writeDenial(policy, canonicalize(join(ws, "src", "a.ts")), { creating: true }), undefined);
	assert.equal(readDenial(policy, canonicalize(join(ws, "README.md"))), undefined);
	cleanup();
});

test("writes outside the writable roots, into hidden or git paths, are refused", () => {
	const { ws, tmpDir, home, policy, cleanup } = hardCase();
	assert.ok(writeDenial(policy, canonicalize(join(ws, "..", "sibling.txt"))));
	assert.ok(writeDenial(policy, canonicalize(join(home, ".bashrc"))));
	assert.ok(writeDenial(policy, canonicalize(join(home, ".ssh", "authorized_keys"))));
	assert.ok(readDenial(policy, canonicalize(join(home, ".ssh", "id_ed25519"))));
	assert.ok(writeDenial(policy, canonicalize(join(ws, ".git", "hooks", "pre-commit"))));
	assert.ok(writeDenial(policy, canonicalize(join(ws, ".git", "config"))));
	assert.equal(writeDenial(policy, canonicalize(join(tmpDir, "scratch"))), undefined);
	// Creating an ancestor of a protected path that does not exist yet is refused.
	assert.ok(writeDenial(policy, canonicalize(join(ws, ".git")), { creating: true }));
	cleanup();
});

test("read-only level: the cwd is not writable, the session tmp is", () => {
	const ws = tmp();
	const agentDir = join(ws, "agent");
	mkdirSync(join(agentDir, "sandbox-policy", "linux"), { recursive: true });
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify({ ...template(), level: "read-only" }));
	const tmpDir = join(ws, "t");
	mkdirSync(tmpDir);
	const r = resolvePolicy({ agentDir, cwd: join(ws), tmpDir, platform: "linux" });
	assert.ok(r.ok);
	assert.ok(writeDenial(r.value, canonicalize(join(ws, "x.txt"))));
	assert.equal(writeDenial(r.value, canonicalize(join(tmpDir, "x.txt"))), undefined);
	rmSync(ws, { recursive: true, force: true });
});

test("a project file tightens the resolved policy and reports what it ignored", () => {
	const { ws, agentDir, tmpDir, home, cleanup } = hardCase();
	mkdirSync(join(ws, ".sova"));
	writeFileSync(join(ws, ".sova", "sandbox.json"), JSON.stringify({ hidden: [".env"], defaultOn: true }));
	const r = resolvePolicy({ agentDir, cwd: ws, tmpDir, platform: "linux", home });
	assert.ok(r.ok);
	assert.ok(readDenial(r.value, canonicalize(join(ws, ".env"))));
	assert.deepEqual(r.value.notices, ["Sandbox: `.sova/sandbox.json` can only tighten; ignored `defaultOn`."]);
	cleanup();
});

test("no policy file: resolvePolicy fails closed", () => {
	const d = tmp();
	const r = resolvePolicy({ agentDir: d, cwd: d, tmpDir: d, platform: "linux" });
	assert.equal(r.ok, false);
	rmSync(d, { recursive: true, force: true });
});

test("the templates shadow the host caches and list none as writable", () => {
	for (const p of ["linux", "darwin"]) {
		const t = template(p);
		assert.deepEqual(t.shadowed, ["~/.cache", "~/.npm", "~/.m2"]);
		assert.deepEqual(t.writable, [], "mise's state is a platform private copy, never a host writable root");
	}
});

test("resolve: the platform's private tool state is shadowed On and write-only, and supersedes a writable entry instead of failing closed", () => {
	const ws = tmp();
	const agentDir = join(ws, "agent");
	const home = tmp();
	mkdirSync(join(agentDir, "sandbox-policy", "linux"), { recursive: true });
	const mise = join(home, ".local", "state", "mise");
	const pnpm = join(home, ".local", "share", "pnpm", "store");
	// An older template's entry: the user's live file still lists mise's state as writable.
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify({ ...template(), writable: ["~/.local/state/mise", "~/.local/state/mise/sub"] }));
	const src = (_a: string, p: string) => join(agentDir, "shadow", p.replaceAll("/", "_"));
	const defaults = { hidden: [], writable: [mise], readOnlyWithinWritable: [], shadowed: [join(home, ".cache")], privateState: [mise, pnpm] };
	const on = resolvePolicy({ agentDir, cwd: ws, tmpDir: join(ws, "t"), platform: "linux", home, shadowSource: src, defaults });
	assert.ok(on.ok, on.ok ? "" : on.error);
	assert.ok(!on.value.writable.some((w) => w === mise || w.startsWith(`${mise}/`)), "the writable entries are dropped");
	// Private tool state is copied only while the host has it (ifPresent); a cache is copied whatever.
	for (const p of [mise, pnpm]) assert.deepEqual(on.value.shadowed.find((s) => s.path === p), { path: p, source: src(agentDir, p), ifPresent: true });
	assert.equal(on.value.shadowed.find((s) => s.path === join(home, ".cache"))?.ifPresent, undefined);
	const wo = resolvePolicy({ agentDir, cwd: ws, tmpDir: join(ws, "t"), platform: "linux", home, shadowSource: src, defaults, parent: writeOnlyScope(ws) });
	assert.ok(wo.ok);
	assert.deepEqual(wo.value.shadowed.map((s) => `${s.path}${s.ifPresent ? " ifPresent" : ""}`).sort(), [join(home, ".cache"), `${mise} ifPresent`, `${pnpm} ifPresent`].sort());
	// The file's own writable entry inside its own shadow still fails closed.
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify({ ...template(), writable: ["~/.npm/x"] }));
	utimesSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), new Date(), new Date(Date.now() + 9000));
	assert.equal(resolvePolicy({ agentDir, cwd: ws, tmpDir: join(ws, "t"), platform: "linux", home, shadowSource: src, defaults }).ok, false);
	[ws, home].forEach((p) => rmSync(p, { recursive: true, force: true }));
});

test("resolve: shadows come from the file, never double as writable roots, and vanish under read-only", () => {
	const ws = tmp();
	const agentDir = join(ws, "agent");
	const home = tmp();
	mkdirSync(join(agentDir, "sandbox-policy", "linux"), { recursive: true });
	const write = (v: object) => writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify({ ...template(), ...v }));
	const src = (_a: string, p: string) => join(agentDir, "shadow", p.split("/").pop()!);
	write({});
	// A platform default that lists a cache as writable does not undo its shadow.
	let r = resolvePolicy({ agentDir, cwd: ws, tmpDir: ws, platform: "linux", home, shadowSource: src, defaults: { hidden: [], writable: [join(home, ".cache")], readOnlyWithinWritable: [] } });
	assert.ok(r.ok);
	assert.deepEqual(r.value.shadowed.map((s) => s.path), [".cache", ".npm", ".m2"].map((c) => join(home, c)));
	assert.ok(!r.value.writable.includes(join(home, ".cache")));
	write({ level: "read-only" });
	utimesSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), new Date(), new Date(Date.now() + 9000));
	r = resolvePolicy({ agentDir, cwd: ws, tmpDir: ws, platform: "linux", home, shadowSource: src });
	assert.ok(r.ok);
	assert.deepEqual(r.value.shadowed, []);
	[ws, home].forEach((p) => rmSync(p, { recursive: true, force: true }));
});

test("resolve: a writable root inside a shadow fails closed even when only the canonical spellings meet", () => {
	const ws = tmp();
	const home = tmp();
	const agentDir = join(ws, "agent");
	mkdirSync(join(agentDir, "sandbox-policy", "linux"), { recursive: true });
	mkdirSync(join(home, ".cache", "foo"), { recursive: true });
	symlinkSync(join(home, ".cache", "foo"), join(home, "cachelink"));
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify({ ...template(), writable: ["~/cachelink"] }));
	const r = resolvePolicy({ agentDir, cwd: ws, tmpDir: ws, platform: "linux", home, shadowSource: (_a, p) => join(agentDir, "shadow", p.split("/").pop()!) });
	assert.equal(r.ok, false);
	assert.match((r as { error: string }).error, /inside a shadowed path/);
	// The session cwd itself may sit inside a shadow.
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify(template()));
	utimesSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), new Date(), new Date(Date.now() + 9000));
	const cwd = join(home, ".cache", "foo");
	const ok = resolvePolicy({ agentDir, cwd, tmpDir: ws, platform: "linux", home, shadowSource: (_a, p) => join(agentDir, "shadow", p.split("/").pop()!) });
	assert.ok(ok.ok);
	assert.ok(ok.value.writable.includes(cwd));
	[ws, home].forEach((p) => rmSync(p, { recursive: true, force: true }));
});

test("worker scope: parse, hand down without the session tmp, refuse a cwd outside, never widen", () => {
	assert.equal(parseParentScope("{x").ok, false);
	assert.equal(parseParentScope(JSON.stringify({ version: 1, level: "full", workspaceRoot: "/a", writable: [] })).ok, false);
	assert.equal(parseParentScope(JSON.stringify({ version: 1, level: "workspace-write", workspaceRoot: "/a", writable: ["rel"] })).ok, false);
	const scope = parentScopeOf({ level: "workspace-write", workspaceRoot: "/a", writable: ["/a", "/t", "/c"], tmpDir: "/t" });
	assert.deepEqual(scope, { version: 1, level: "workspace-write", workspaceRoot: "/a", writable: ["/a", "/c"] });
	assert.deepEqual(parseParentScope(JSON.stringify(scope)), { ok: true, value: scope });
	assert.equal(workerCwdRefusal(scope, "/a/x"), undefined);
	assert.equal(workerCwdRefusal(scope, "x"), undefined);
	assert.equal(workerCwdRefusal(scope, "/ab"), "Sandbox: worker cwd /ab is outside the parent's sandbox");
	assert.equal(workerCwdRefusal({ ...scope, level: "read-only", writable: [] }, "/anywhere"), undefined);

	const ws = tmp();
	const agentDir = join(ws, "agent");
	mkdirSync(join(agentDir, "sandbox-policy", "linux"), { recursive: true });
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify(template()));
	mkdirSync(join(ws, "a", "sub"), { recursive: true });
	mkdirSync(join(ws, "b"));
	const parent = { version: 1 as const, level: "workspace-write" as const, workspaceRoot: join(ws, "a"), writable: [join(ws, "a")] };
	const inside = resolvePolicy({ agentDir, cwd: join(ws, "a", "sub"), tmpDir: join(ws, "t"), platform: "linux", parent });
	assert.ok(inside.ok);
	assert.deepEqual(inside.value.writable.sort(), [join(ws, "a"), join(ws, "t")].sort(), "exactly the parent's roots plus its own tmp");
	assert.equal(inside.value.outsideParent, undefined);
	const outside = resolvePolicy({ agentDir, cwd: join(ws, "b"), tmpDir: join(ws, "t"), platform: "linux", parent });
	assert.ok(outside.ok);
	assert.equal(outside.value.outsideParent, true);
	assert.ok(!outside.value.writable.includes(join(ws, "b")), "the worker's cwd is never added");
	assert.ok(writeDenial(outside.value, join(ws, "b", "x")));
	const ro = resolvePolicy({ agentDir, cwd: join(ws, "b"), tmpDir: join(ws, "t"), platform: "linux", parent: { ...parent, level: "read-only", writable: [] } });
	assert.ok(ro.ok);
	assert.equal(ro.value.level, "read-only", "a read-only parent lowers the worker");
	assert.equal(ro.value.outsideParent, undefined);
	rmSync(ws, { recursive: true, force: true });
});

test("tracked worktrees: writable roots of the session, their .agent read-only; never a worker's own", () => {
	const ws = tmp();
	const agentDir = join(ws, "agent");
	mkdirSync(join(agentDir, "sandbox-policy", "linux"), { recursive: true });
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify(template()));
	const live = join(ws, "live");
	const wt = join(ws, "wt");
	mkdirSync(live);
	mkdirSync(join(wt, ".agent"), { recursive: true });
	const r = resolvePolicy({ agentDir, cwd: live, tmpDir: join(ws, "t"), platform: "linux", extraWritable: [wt], extraReadOnly: [join(wt, ".agent")] });
	assert.ok(r.ok);
	assert.equal(writeDenial(r.value, join(wt, "src", "a.ts"), { creating: true }), undefined);
	assert.match(writeDenial(r.value, join(wt, ".agent", "sandbox-policy", "linux", "policy.json"), { creating: true }) ?? "", /read-only/);
	assert.match(writeDenial(r.value, join(wt, ".agent", "settings.json")) ?? "", /read-only/);
	// A worktree under a shadowed cache is a real writable root, like the cwd (seen live under ~/.cache).
	const cache = join(ws, "cache");
	const cachedWt = join(cache, "wt");
	mkdirSync(cachedWt, { recursive: true });
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify({ ...template(), shadowed: [cache], writable: [] }));
	const shadowSource = (a: string, p: string) => join(a, "shadow", p.replaceAll("/", "_"));
	const sh = resolvePolicy({ agentDir, cwd: live, tmpDir: join(ws, "t"), platform: "linux", extraWritable: [cachedWt], shadowSource });
	assert.ok(sh.ok, sh.ok ? "" : sh.error);
	assert.ok(sh.value.writable.includes(cachedWt));
	assert.equal(writeDenial(sh.value, join(cachedWt, "x"), { creating: true }), undefined);
	// And a worker narrowed to it (the parent's scope) is inside its parent, not refused.
	const narrowed = resolvePolicy({ agentDir, cwd: cachedWt, tmpDir: join(ws, "t2"), platform: "linux", shadowSource, parent: narrowScope(parentScopeOf(sh.value), cachedWt) });
	assert.ok(narrowed.ok);
	assert.equal(narrowed.value.outsideParent, undefined);
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify(template()));
	// A worker's roots are its parent's scope, whatever extras it is handed.
	const parent = { version: 1 as const, level: "workspace-write" as const, workspaceRoot: live, writable: [live] };
	const w = resolvePolicy({ agentDir, cwd: live, tmpDir: join(ws, "t"), platform: "linux", parent, extraWritable: [wt] });
	assert.ok(w.ok);
	assert.ok(writeDenial(w.value, join(wt, "x")));
	// Under read-only nothing extra is writable.
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify({ ...template(), level: "read-only" }));
	const ro = resolvePolicy({ agentDir, cwd: live, tmpDir: join(ws, "t"), platform: "linux", extraWritable: [wt] });
	assert.ok(ro.ok);
	assert.ok(writeDenial(ro.value, join(wt, "x")));
	rmSync(ws, { recursive: true, force: true });
});

test("readOnly (--sandbox-read-only, the merge thread): the read-only level whatever the file says; only the tmp is writable, no policy root or worktree, and its workers get no more", () => {
	const ws = tmp();
	const agentDir = join(ws, "agent");
	mkdirSync(join(agentDir, "sandbox-policy", "linux"), { recursive: true });
	const extra = join(ws, "extra");
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify({ ...template(), level: "workspace-write", writable: [extra], shadowed: [] }));
	const repo = join(ws, "repo");
	const wt = join(ws, "wt");
	mkdirSync(join(wt, ".agent"), { recursive: true });
	mkdirSync(repo);
	mkdirSync(extra);
	const tmpDir = join(ws, "t");
	const r = resolvePolicy({ agentDir, cwd: repo, tmpDir, platform: "linux", extraWritable: [wt], cwdWritable: false, readOnly: true });
	assert.ok(r.ok, r.ok ? "" : r.error);
	assert.equal(r.value.level, "read-only");
	assert.deepEqual(r.value.writable, [r.value.tmpDir], "the tmp alone");
	for (const p of [join(repo, "a.txt"), join(extra, "x"), join(wt, "src", "a.ts"), join(repo, ".git", "refs", "heads", "master")]) assert.match(writeDenial(r.value, p, { creating: true }) ?? "", /outside the sandbox's writable roots|read-only/, p);
	assert.equal(writeDenial(r.value, join(tmpDir, "clone", "x"), { creating: true }), undefined);
	assert.equal(parentScopeOf(r.value).level, "read-only");
	// Without the flag the same file gives workspace-write: the flag only tightens.
	const plain = resolvePolicy({ agentDir, cwd: repo, tmpDir, platform: "linux" });
	assert.ok(plain.ok);
	assert.equal(plain.value.level, "workspace-write");
	rmSync(ws, { recursive: true, force: true });
});

test("a stand-in cwd (cwdWritable: false) is never a writable root; tmp, policy roots and worktrees still are, and its workers get no more", () => {
	const ws = tmp();
	const agentDir = join(ws, "agent");
	mkdirSync(join(agentDir, "sandbox-policy", "linux"), { recursive: true });
	const extra = join(ws, "extra");
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify({ ...template(), writable: [extra], shadowed: [] }));
	const home = join(ws, "home");
	const wt = join(home, "wt");
	mkdirSync(join(wt, ".agent"), { recursive: true });
	mkdirSync(extra);
	const tmpDir = join(ws, "t");
	const own = resolvePolicy({ agentDir, cwd: home, tmpDir, platform: "linux", extraWritable: [wt] });
	assert.ok(own.ok);
	assert.equal(writeDenial(own.value, join(home, "notes.txt"), { creating: true }), undefined, "the default: the cwd is writable");
	const r = resolvePolicy({ agentDir, cwd: home, tmpDir, platform: "linux", extraWritable: [wt], cwdWritable: false });
	assert.ok(r.ok, r.ok ? "" : r.error);
	assert.ok(!r.value.writable.includes(home));
	assert.equal(r.value.workspaceRoot, home, "it is still the cwd tools run in");
	assert.match(writeDenial(r.value, join(home, "notes.txt"), { creating: true }) ?? "", /outside the sandbox's writable roots/);
	assert.match(writeDenial(r.value, join(home, ".bashrc")) ?? "", /outside/);
	assert.equal(writeDenial(r.value, join(tmpDir, "x"), { creating: true }), undefined);
	assert.equal(writeDenial(r.value, join(extra, "x"), { creating: true }), undefined);
	assert.equal(writeDenial(r.value, join(wt, "src", "a.ts"), { creating: true }), undefined);
	// Its workers are handed its roots: the home folder is not among them.
	const scope = parentScopeOf(r.value);
	assert.ok(!scope.writable.includes(home));
	assert.match(workerCwdRefusal(scope, home) ?? "", /outside the parent's sandbox/);
	rmSync(ws, { recursive: true, force: true });
});

test("a worker keeps a tracked worktree's .agent read-only: full scope, narrowed and write-only", () => {
	const ws = tmp();
	const agentDir = join(ws, "agent");
	mkdirSync(join(agentDir, "sandbox-policy", "linux"), { recursive: true });
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify(template()));
	const live = join(ws, "live");
	const wt = join(ws, "wt");
	mkdirSync(live);
	mkdirSync(join(wt, ".agent"), { recursive: true });
	const session = resolvePolicy({ agentDir, cwd: live, tmpDir: join(ws, "t"), platform: "linux", extraWritable: [wt], extraReadOnly: [join(wt, ".agent")] });
	assert.ok(session.ok);
	const full = parseParentScope(JSON.stringify(parentScopeOf(session.value)));
	assert.ok(full.ok);
	assert.ok(full.value.readOnly?.includes(join(wt, ".agent")), "the scope carries the worktree's .agent");
	assert.ok(!full.value.readOnly?.includes(agentDir), "only paths inside the roots handed down");
	const narrowed = narrowScope(full.value, wt);
	assert.deepEqual(narrowed.readOnly, [join(wt, ".agent")], "narrowed: only the read-only paths under the new root");
	assert.equal(narrowScope({ ...full.value, level: "read-only" }, wt).readOnly, undefined);
	const wo = writeOnlyScope(wt);
	assert.deepEqual(parseParentScope(JSON.stringify(wo)), { ok: true, value: wo });
	const noPolicy = join(ws, "no-policy-agent");
	mkdirSync(noPolicy);
	for (const [name, parent, dir] of [["full scope", full.value, agentDir], ["narrowed", narrowed, agentDir], ["write-only", wo, noPolicy]] as const) {
		const w = resolvePolicy({ agentDir: dir, cwd: wt, tmpDir: join(ws, "t2"), platform: "linux", parent });
		assert.ok(w.ok, name);
		assert.equal(w.value.outsideParent, undefined, name);
		assert.ok(w.value.readOnlyWithinWritable.includes(join(wt, ".agent")), `${name}: the backend mounts it read-only`);
		assert.match(writeDenial(w.value, join(wt, ".agent", "settings.json")) ?? "", /read-only/, name);
		assert.match(writeDenial(w.value, join(wt, ".agent", "sandbox-policy", "linux", "policy.json"), { creating: true }) ?? "", /read-only/, name);
		assert.equal(writeDenial(w.value, join(wt, "src", "a.ts"), { creating: true }), undefined, `${name}: the rest of the worktree stays writable`);
	}
	assert.equal(parseParentScope(JSON.stringify({ ...wo, readOnly: ["rel"] })).ok, false, "a relative read-only path is malformed");
	rmSync(ws, { recursive: true, force: true });
});

test("a worker is held to its parent's hidden list and allowlists, not a looser file in its own agent dir", () => {
	const ws = tmp();
	const agentDir = join(ws, "tree-agent");
	mkdirSync(join(agentDir, "sandbox-policy", "linux"), { recursive: true });
	// The worker's own (worktree) policy: nothing hidden, every host allowed, every variable passed.
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify({ ...template(), hidden: [], proxy: { allow: ["*.evil.example"] }, env: { allow: ["SECRET_TOKEN"] } }));
	mkdirSync(join(ws, "a"));
	const secret = join(ws, "home", ".ssh");
	const scope = parentScopeOf({ level: "workspace-write", workspaceRoot: join(ws, "a"), writable: [join(ws, "a"), "/t"], tmpDir: "/t", hidden: [secret], proxyAllow: ["registry.npmjs.org"], envAllow: [] });
	assert.deepEqual(scope.hidden, [secret]);
	const parsed = parseParentScope(JSON.stringify(scope));
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.value, scope);
	const r = resolvePolicy({ agentDir, cwd: join(ws, "a"), tmpDir: join(ws, "t"), platform: "linux", parent: parsed.value });
	assert.ok(r.ok);
	assert.ok(readDenial(r.value, join(secret, "id_ed25519")));
	assert.deepEqual(r.value.proxyAllow, ["registry.npmjs.org"]);
	assert.deepEqual(r.value.envAllow, []);
	// Narrowed to one root, the rest rides along.
	const n = narrowScope(scope, join(ws, "a", "wt"));
	assert.deepEqual(n.writable, [join(ws, "a", "wt")]);
	assert.deepEqual(n.hidden, [secret]);
	assert.equal(parseParentScope(JSON.stringify({ ...scope, proxyAllow: [3] })).ok, false);
	rmSync(ws, { recursive: true, force: true });
});

test("write-only scope: writes only in the root; reads, network and env untouched; no policy file needed", () => {
	const ws = tmp();
	const agentDir = join(ws, "no-policy-agent");
	mkdirSync(agentDir);
	const wt = join(ws, "wt");
	mkdirSync(join(wt, "src"), { recursive: true });
	const secret = join(ws, "home", ".ssh", "id");
	mkdirSync(dirname(secret), { recursive: true });
	writeFileSync(secret, "k");
	const scope = writeOnlyScope(wt);
	assert.deepEqual(parseParentScope(JSON.stringify(scope)), { ok: true, value: scope });
	assert.equal(parseParentScope(JSON.stringify({ ...scope, level: "read-only" })).ok, false);
	assert.equal(parseParentScope(JSON.stringify({ ...scope, writeOnly: "yes" })).ok, false);
	const r = resolvePolicy({ agentDir, cwd: join(wt, "src"), tmpDir: join(ws, "t"), platform: "linux", parent: scope, defaults: { hidden: [dirname(secret)], writable: [join(ws, "state")], readOnlyWithinWritable: [], shadowed: [] } });
	assert.ok(r.ok, r.ok ? "" : r.error);
	assert.equal(r.value.writeOnly, true);
	assert.deepEqual(r.value.hidden, [], "nothing hidden, not even the platform list");
	assert.equal(readDenial(r.value, secret), undefined);
	assert.equal(writeDenial(r.value, join(wt, "src", "a.ts"), { creating: true }), undefined);
	assert.ok(writeDenial(r.value, join(ws, "elsewhere.txt"), { creating: true }));
	assert.ok(writeDenial(r.value, join(ws, "state", "x"), { creating: true }), "the platform's extra writable roots are not added");
	assert.ok(writeDenial(r.value, join(agentDir, "settings.json")), "its agent dir stays read-only");
	assert.equal(r.value.outsideParent, undefined);
	// A worktree inside a shadowed cache is still the writable root (seen live: a worktree under ~/.cache).
	const cache = join(ws, "cache");
	const inCache = join(cache, "wt");
	mkdirSync(inCache, { recursive: true });
	const cached = resolvePolicy({ agentDir, cwd: inCache, tmpDir: join(ws, "t"), platform: "linux", parent: writeOnlyScope(inCache), defaults: { hidden: [], writable: [], readOnlyWithinWritable: [], shadowed: [cache] }, shadowSource: (a, p) => join(a, "shadow", p.replaceAll("/", "_")) });
	assert.ok(cached.ok);
	assert.equal(cached.value.outsideParent, undefined);
	assert.equal(writeDenial(cached.value, join(inCache, "x"), { creating: true }), undefined);
	assert.deepEqual(cached.value.shadowed, [], "the shadow that would hold the root is dropped");
	const out = resolvePolicy({ agentDir, cwd: ws, tmpDir: join(ws, "t"), platform: "linux", parent: scope });
	assert.ok(out.ok);
	assert.equal(out.value.outsideParent, true);
	rmSync(ws, { recursive: true, force: true });
});

test("browser: \"none\" and \"headless-shell\" load, absent means none, anything else fails closed", () => {
	const t = template();
	assert.equal(t.browser, "none", "the template names it, off");
	for (const p of ["linux", "darwin"]) assert.equal(template(p).browser, "none", p);
	const { browser: _b, ...absent } = t;
	const a = validatePolicyFile(absent);
	assert.ok(a.ok, "the key is optional");
	assert.equal(a.value.browser, undefined);
	const on = validatePolicyFile({ ...t, browser: "headless-shell" });
	assert.ok(on.ok);
	assert.equal(on.value.browser, "headless-shell");
	for (const bad of [true, "chrome", 1, "", null, "Headless-Shell"]) {
		const r = validatePolicyFile({ ...t, browser: bad });
		assert.equal(r.ok, false, JSON.stringify(bad));
		assert.match(String((r as { error: string }).error), /browser must be "none" or "headless-shell"/);
	}
});

test("browser in a project file: \"none\" tightens, \"headless-shell\" is ignored with a notice unless the global file already says so", () => {
	const on = { ...template(), browser: "headless-shell" as const };
	const off = template();
	assert.deepEqual(applyProjectTightening(on, { browser: "none" }), { policy: { ...on, browser: "none" }, ignored: [] });
	assert.deepEqual(applyProjectTightening(off, { browser: "headless-shell" }), { policy: off, ignored: ["browser"] });
	const { browser: _b, ...absent } = off;
	assert.deepEqual(applyProjectTightening(absent, { browser: "headless-shell" }).ignored, ["browser"], "absent is none: no loosening");
	assert.equal(applyProjectTightening(absent, { browser: "headless-shell" }).policy.browser, undefined);
	assert.deepEqual(applyProjectTightening(on, { browser: "headless-shell" }), { policy: on, ignored: [] }, "the global value again changes nothing");
	assert.deepEqual(applyProjectTightening(on, { browser: true }).ignored, ["browser"]);
	assert.equal(applyProjectTightening(on, { browser: true }).policy.browser, "headless-shell");
});

test("browser resolves from the file and the project file; a worker takes its parent's, never its own file's", () => {
	const ws = tmp();
	const agentDir = join(ws, "agent");
	const file = join(agentDir, "sandbox-policy", "linux", "policy.json");
	mkdirSync(dirname(file), { recursive: true });
	mkdirSync(join(ws, "a"));
	const write = (browser?: string) => {
		const { browser: _b, ...rest } = template();
		writeFileSync(file, JSON.stringify(browser === undefined ? rest : { ...rest, browser }));
		utimesSync(file, new Date(), new Date(Date.now() + Math.random() * 1e6));
	};
	const resolve = (parent?: Parameters<typeof resolvePolicy>[0]["parent"]) => {
		const r = resolvePolicy({ agentDir, cwd: join(ws, "a"), tmpDir: join(ws, "t"), platform: "linux", ...(parent ? { parent } : {}) });
		assert.ok(r.ok, r.ok ? "" : r.error);
		return r.value;
	};
	write();
	assert.equal(resolve().browser, false, "absent");
	write("none");
	assert.equal(resolve().browser, false);
	write("headless-shell");
	assert.equal(resolve().browser, true);
	mkdirSync(join(ws, "a", ".sova"));
	writeFileSync(join(ws, "a", ".sova", "sandbox.json"), JSON.stringify({ browser: "none" }));
	assert.equal(resolve().browser, false, "the project file turns it off");
	rmSync(join(ws, "a", ".sova"), { recursive: true });
	// Handed down: parentScopeOf carries it, narrowScope keeps it, parse accepts only a literal true.
	const scope = parentScopeOf({ ...resolve(), tmpDir: join(ws, "t") });
	assert.equal(scope.browser, true);
	assert.equal(narrowScope(scope, join(ws, "a")).browser, true);
	assert.deepEqual(parseParentScope(JSON.stringify(scope)), { ok: true, value: scope });
	for (const bad of [false, "true", 1, "headless-shell", null]) assert.equal(parseParentScope(JSON.stringify({ ...scope, browser: bad })).ok, false, JSON.stringify(bad));
	const { browser: _x, ...noBrowser } = scope;
	assert.equal(parentScopeOf({ ...resolve(noBrowser), tmpDir: join(ws, "t") }).browser, undefined);
	// A worker's own file says headless-shell; its parent's scope has none: none.
	assert.equal(resolve(noBrowser).browser, false, "a worker ignores its own file's browser");
	write("none");
	assert.equal(resolve(scope).browser, true, "and takes its parent's even when its own file says none");
	// Write-only: from the scope only (no policy file is read).
	assert.equal(resolve(writeOnlyScope(join(ws, "a"))).browser, false);
	assert.equal(resolve(writeOnlyScope(join(ws, "a"), { browser: true })).browser, true);
	assert.deepEqual(writeOnlyScope(join(ws, "a"), { browser: false }), writeOnlyScope(join(ws, "a")), "off adds no key");
	assert.deepEqual(parseParentScope(JSON.stringify(writeOnlyScope(join(ws, "a"), { browser: true }))), { ok: true, value: writeOnlyScope(join(ws, "a"), { browser: true }) });
	rmSync(ws, { recursive: true, force: true });
});

test("parentBrowser: the parent's file after its cwd's project file; any failure means no browser", () => {
	const ws = tmp();
	const agentDir = join(ws, "agent");
	const file = join(agentDir, "sandbox-policy", "linux", "policy.json");
	const cwd = join(ws, "cwd");
	mkdirSync(cwd);
	assert.equal(parentBrowser(agentDir, cwd, "linux"), false, "no file");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "{ not json");
	assert.equal(parentBrowser(agentDir, cwd, "linux"), false, "unreadable");
	writeFileSync(file, JSON.stringify({ ...template(), browser: true }));
	utimesSync(file, new Date(), new Date(Date.now() + 10_000));
	assert.equal(parentBrowser(agentDir, cwd, "linux"), false, "malformed");
	writeFileSync(file, JSON.stringify({ ...template(), browser: "headless-shell" }));
	utimesSync(file, new Date(), new Date(Date.now() + 20_000));
	assert.equal(parentBrowser(agentDir, cwd, "linux"), true);
	mkdirSync(join(cwd, ".sova"));
	writeFileSync(join(cwd, ".sova", "sandbox.json"), JSON.stringify({ browser: "none" }));
	assert.equal(parentBrowser(agentDir, cwd, "linux"), false, "the parent's project file tightens");
	rmSync(ws, { recursive: true, force: true });
});
