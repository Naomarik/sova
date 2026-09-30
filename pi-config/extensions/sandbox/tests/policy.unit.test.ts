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
		assert.deepEqual(t.writable, ["~/.local/state/mise"]);
	}
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
