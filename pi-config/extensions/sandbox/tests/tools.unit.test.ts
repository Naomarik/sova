import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Backend, Confined, Policy } from "../backend.ts";
import { backendFor, gitProtectedPaths, mapShadowed, shadowSource } from "../backend.ts";
import { spawnSync } from "node:child_process";
import { scrubEnv } from "../env.ts";
import { canonicalize, isWithin, readDenial, resolvePolicy, type ResolvedPolicy, writeDenial } from "../policy.ts";
import { type AnyToolDefinition, confinedDefinitions, sandboxView, filterHidden, mapTmp, type Snapshot, stockDefinitions, TOOL_NAMES } from "../tools.ts";

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "sandbox-policy");

/** The test-server layout: agent dir (and policy dir) inside the workspace. */
function setup(opts: { git?: boolean } = {}) {
	// Not under /tmp: the file tools map /tmp into the session tmp, as bash sees it.
	const root = realpathSync(mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : tmpdir(), "sbx-tools-")));
	const ws = join(root, "ws");
	const agentDir = join(ws, ".agent");
	mkdirSync(join(agentDir, "sandbox-policy"), { recursive: true });
	cpSync(TEMPLATE_DIR, join(agentDir, "sandbox-policy"), { recursive: true });
	const home = join(root, "home");
	mkdirSync(join(home, ".ssh"), { recursive: true });
	writeFileSync(join(home, ".ssh", "id_test"), "SECRET-KEY");
	const tmpDir = join(root, "sessiontmp");
	mkdirSync(tmpDir);
	mkdirSync(join(root, "outside"));
	writeFileSync(join(ws, "a.txt"), "hello\nworld\n");
	if (opts.git) assert.equal(spawnSync("git", ["init", "-q", ws]).status, 0);
	const r = resolvePolicy({ agentDir, cwd: ws, tmpDir, platform: "linux", home, git: gitProtectedPaths });
	assert.ok(r.ok, r.ok ? "" : r.error);
	return { root, ws, agentDir, home, tmpDir, policy: r.value, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function backendPolicy(p: ResolvedPolicy): Policy {
	return {
		level: p.level,
		workspaceRoot: p.workspaceRoot,
		writable: p.writable,
		readOnlyWithinWritable: p.readOnlyWithinWritable,
		hidden: p.hidden,
		tmpDir: p.tmpDir,
		shadowed: p.shadowed,
		network: { mode: "none" },
		env: scrubEnv(process.env, p.envAllow),
		sessionId: "unit",
	};
}

/** Records confine calls and runs the argv as is: exercises the plumbing, not isolation. */
function passthroughBackend(overrides: Partial<Confined> = {}): Backend & { calls: number } {
	const b = {
		id: "linux-bwrap" as const,
		calls: 0,
		async probe() {
			return { ok: true as const, enforcement: "full" as const, network: "none" as const };
		},
		async confine(req: { argv: string[]; policy: Policy; env?: Record<string, string> }) {
			b.calls++;
			const confined: Confined = {
				argv: req.argv,
				env: { ...req.policy.env, ...(req.env ?? {}) },
				enforcement: "full",
				network: "none",
				denialSignatures: ["Read-only file system"],
				runnerFailure: { fatalSignatures: ["^bwrap: "] },
				...overrides,
			};
			return { ok: true as const, confined };
		},
		async canonicalize(p: string) {
			return p;
		},
		platformDefaults() {
			return { hidden: [], writable: [], readOnlyWithinWritable: [], shadowed: [] };
		},
	};
	return b;
}

function defs(ws: string, snap: () => Promise<Snapshot>): Map<string, AnyToolDefinition> {
	return new Map(confinedDefinitions(ws, {}, { snapshot: snap }).map((d) => [d.name, d]));
}

async function run(def: AnyToolDefinition, params: Record<string, unknown>, cwd: string) {
	const sessionManager = { getSessionId: () => "unit", getSessionFile: () => undefined };
	return def.execute("id", params, undefined, undefined, { cwd, sessionManager } as never);
}

function text(r: { content: { type: string; text?: string }[] }): string {
	return r.content.map((c) => c.text ?? "").join("");
}

test("F1: every confined tool keeps the stock model-visible fields exactly", () => {
	const ws = realpathSync(tmpdir());
	const opts = { autoResizeImages: true, commandPrefix: "set -e", shellPath: undefined };
	const stock = stockDefinitions(ws, opts);
	const confined = confinedDefinitions(ws, opts, { snapshot: async () => ({ ok: false, reason: "x" }) });
	assert.deepEqual(confined.map((d) => d.name).sort(), [...TOOL_NAMES].sort());
	for (const s of stock) {
		const c = confined.find((d) => d.name === s.name)!;
		for (const k of ["name", "label", "description", "promptSnippet", "promptGuidelines", "parameters", "constrainedSampling"] as const) {
			assert.deepEqual(JSON.stringify(c[k]), JSON.stringify(s[k]), `${s.name}.${k}`);
		}
		assert.notEqual(c.execute, s.execute);
	}
});

test("unavailable: every tool refuses and nothing runs", async () => {
	const { ws, cleanup } = setup();
	const d = defs(ws, async () => ({ ok: false, reason: "bwrap not found on PATH" }));
	for (const [name, params] of [
		["bash", { command: `touch ${join(ws, "ran")}` }],
		["read", { path: "a.txt" }],
		["write", { path: "b.txt", content: "x" }],
		["edit", { path: "a.txt", edits: [{ oldText: "hello", newText: "bye" }] }],
		["ls", {}],
		["find", { pattern: "*.txt" }],
		["grep", { pattern: "hello" }],
	] as const) {
		await assert.rejects(run(d.get(name)!, params, ws), /Sandbox unavailable: bwrap not found on PATH\. Nothing ran\./, name);
	}
	assert.equal(existsSync(join(ws, "ran")), false);
	assert.equal(existsSync(join(ws, "b.txt")), false);
	assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "hello\nworld\n");
	cleanup();
});

test("file tools: allowed inside the workspace, refused outside, hidden and policy paths refused", async () => {
	const { root, ws, agentDir, home, tmpDir, policy, cleanup } = setup();
	const backend = passthroughBackend();
	const snap = async (): Promise<Snapshot> => ({ ok: true, policy, backendPolicy: backendPolicy(policy), backend, enforcement: "full" });
	const d = defs(ws, snap);
	assert.match(text(await run(d.get("read")!, { path: "a.txt" }, ws)), /hello/);
	await run(d.get("write")!, { path: "sub/b.txt", content: "new" }, ws);
	assert.equal(readFileSync(join(ws, "sub", "b.txt"), "utf8"), "new");
	await run(d.get("edit")!, { path: "a.txt", edits: [{ oldText: "hello", newText: "bye" }] }, ws);
	assert.match(readFileSync(join(ws, "a.txt"), "utf8"), /^bye/);

	await assert.rejects(run(d.get("write")!, { path: join(root, "outside", "x.txt"), content: "x" }, ws), /outside the sandbox's writable roots.*\[sandbox:/);
	assert.equal(existsSync(join(root, "outside", "x.txt")), false);
	const policyJson = join(agentDir, "sandbox-policy", "linux", "policy.json");
	const before = readFileSync(policyJson, "utf8");
	await assert.rejects(run(d.get("write")!, { path: policyJson, content: "{}" }, ws), /\[sandbox:/);
	await assert.rejects(run(d.get("edit")!, { path: policyJson, edits: [{ oldText: "false", newText: "true" }] }, ws), /\[sandbox:/);
	await assert.rejects(run(d.get("read")!, { path: policyJson }, ws), /hidden/);
	assert.equal(readFileSync(policyJson, "utf8"), before);
	await assert.rejects(run(d.get("read")!, { path: join(home, ".ssh", "id_test") }, ws), /hidden/);
	await assert.rejects(run(d.get("ls")!, { path: join(home, ".ssh") }, ws), /hidden/);

	// A symlink in the workspace that leads out is judged by where it leads.
	symlinkSync(join(root, "outside"), join(ws, "escape"));
	await assert.rejects(run(d.get("write")!, { path: "escape/y.txt", content: "y" }, ws), /\[sandbox:/);
	assert.equal(existsSync(join(root, "outside", "y.txt")), false);
	// A dangling link at the target is not followed out either.
	symlinkSync(join(root, "outside", "z.txt"), join(ws, "dangle"));
	await assert.rejects(run(d.get("write")!, { path: "dangle", content: "z" }, ws), /\[sandbox:/);
	assert.equal(existsSync(join(root, "outside", "z.txt")), false);

	if (process.platform === "linux") {
		// /tmp in the file tools is the session tmp, as bash sees it; host /tmp is never written.
		await run(d.get("write")!, { path: join(tmpdir(), "sbx-unit-host.txt"), content: "h" }, ws);
		assert.equal(existsSync(join(tmpdir(), "sbx-unit-host.txt")), false);
		assert.equal(readFileSync(join(tmpDir, "sbx-unit-host.txt"), "utf8"), "h");
		await run(d.get("write")!, { path: "/tmp/note.txt", content: "t" }, ws);
		assert.equal(readFileSync(join(tmpDir, "note.txt"), "utf8"), "t");
		assert.match(text(await run(d.get("read")!, { path: "/tmp/note.txt" }, ws)), /^t/);
	} else {
		// darwin: no /tmp mapping by design (mapTmp is linux-only); the real host /tmp is just
		// another path outside the writable roots, refused rather than redirected.
		const hostTmpNote = `/tmp/sbx-unit-darwin-${process.pid}.txt`;
		await assert.rejects(run(d.get("write")!, { path: hostTmpNote, content: "t" }, ws), /outside the sandbox's writable roots.*\[sandbox:/);
		assert.equal(existsSync(hostTmpNote), false);
	}
	cleanup();
});

test("ls, find and grep leave hidden paths out", async () => {
	const { ws, home, agentDir, policy, cleanup } = setup();
	writeFileSync(join(home, ".ssh", "marker.txt"), "needle in secret");
	writeFileSync(join(home, "open.txt"), "needle in home");
	writeFileSync(join(ws, "b.txt"), "needle in workspace");
	const snap = async (): Promise<Snapshot> => ({ ok: true, policy, backendPolicy: backendPolicy(policy), backend: passthroughBackend(), enforcement: "full" });
	const d = defs(ws, snap);
	assert.doesNotMatch(text(await run(d.get("ls")!, { path: home }, ws)), /\.ssh/);
	const grep = text(await run(d.get("grep")!, { pattern: "needle", path: home }, ws));
	assert.match(grep, /needle in home/);
	assert.doesNotMatch(grep, /needle in secret/);
	assert.match(grep, /\[sandbox: 1 result line\(s\) under hidden paths were omitted\]/);
	assert.match(text(await run(d.get("grep")!, { pattern: "needle" }, ws)), /needle in workspace/);
	assert.doesNotMatch(text(await run(d.get("find")!, { pattern: "*.txt", path: home }, ws)), /marker\.txt/);
	await assert.rejects(run(d.get("grep")!, { pattern: "x", path: join(home, ".ssh") }, ws), /hidden/);
	// The policy files are hidden, the note beside them is not.
	const pol = text(await run(d.get("grep")!, { pattern: "defaultOn", path: join(agentDir, "sandbox-policy") }, ws));
	assert.match(pol, /CLAUDE\.md/);
	assert.doesNotMatch(pol, /policy\.json/);
	assert.doesNotMatch(text(await run(d.get("ls")!, { path: join(agentDir, "sandbox-policy", "linux") }, ws)), /policy\.json/);
	await assert.rejects(run(d.get("read")!, { path: join(agentDir, "sandbox-policy", "linux", "policy.json") }, ws), /hidden/);
	assert.match(text(await run(d.get("read")!, { path: join(agentDir, "sandbox-policy", "linux", "CLAUDE.md") }, ws)), /cannot edit this file from inside the sandbox/);
	cleanup();
});

test("filterHidden drops every output shape under a hidden path, and only those", () => {
	const out = ["sec:1: a", "sec-2- b", "sec/x.txt", "sec/", "secret.txt", "src/sec:1: c", "ok.txt"].join("\n");
	const r = filterHidden(out, "/r", ["/r/sec"]);
	assert.deepEqual(r.text.split("\n"), ["secret.txt", "src/sec:1: c", "ok.txt"]);
	assert.equal(r.dropped, 4);
});

test("mapTmp maps /tmp into the session tmp, never out of it", { skip: process.platform !== "linux" }, () => {
	const p = { tmpDir: "/s/tmp", writable: ["/tmp/ws", "/s/tmp"] };
	assert.equal(mapTmp("/tmp/x", p, "write"), "/s/tmp/x");
	assert.equal(mapTmp("/tmpfoo", p, "write"), "/tmpfoo");
	assert.equal(mapTmp("/home/u/x", p, "write"), "/home/u/x");
	assert.equal(mapTmp("/tmp/ws/a.txt", p, "write"), "/tmp/ws/a.txt");
	assert.equal(mapTmp("/tmp/does-not-exist-anywhere", p, "read"), "/tmp/does-not-exist-anywhere");
	// A write-only worker sees the host's /tmp (read-only): nothing is mapped, so a write there is
	// checked, and refused, at the host path, as bwrap's read-only /tmp refuses it.
	const wo = { ...p, writeOnly: true };
	assert.equal(mapTmp("/tmp/x", wo, "write"), "/tmp/x");
	assert.equal(mapTmp("/tmp/x", wo, "read"), "/tmp/x");
	assert.equal(mapTmp("/s/tmp/x", wo, "write"), "/s/tmp/x");
});

test("bash: denial note, runner failure, per-call env only from PATH and PI_*", async () => {
	const { ws, policy, cleanup } = setup();
	const backend = passthroughBackend();
	const snap = async (): Promise<Snapshot> => ({ ok: true, policy, backendPolicy: backendPolicy(policy), backend, enforcement: "full" });
	const bash = defs(ws, snap).get("bash")!;
	await assert.rejects(run(bash, { command: "echo 'x: Read-only file system' >&2; exit 1" }, ws), (e: Error) => /Read-only file system\n\n?\[sandbox: /.test(e.message) && /exited with code 1/.test(e.message));
	await assert.rejects(run(bash, { command: "echo 'bwrap: cannot mount' >&2; exit 1" }, ws), /sandbox runner failed, the command did not run: bwrap: cannot mount/);
	process.env.SANDBOX_UNIT_SECRET = "leak";
	process.env.PI_UNIT_TOKEN = "leak";
	const env = text(await run(bash, { command: "env" }, ws));
	delete process.env.SANDBOX_UNIT_SECRET;
	delete process.env.PI_UNIT_TOKEN;
	assert.doesNotMatch(env, /SANDBOX_UNIT_SECRET|PI_UNIT_TOKEN/);
	assert.match(env, /^PI_SESSION_ID=unit$/m);
	assert.match(env, /^PATH=/m);
	assert.equal(backend.calls, 3);
	cleanup();
});

test("bash under the real backend: writes land in the workspace only", { skip: process.platform !== "linux" || !existsSync("/usr/bin/bwrap") }, async () => {
	const { root, ws, policy, cleanup } = setup();
	const backend = backendFor("linux");
	const bp = backendPolicy(policy);
	const probe = await backend.probe(bp);
	if (!probe.ok) {
		cleanup();
		return assert.fail(`probe failed on a host with bwrap: ${probe.reason}`);
	}
	const snap = async (): Promise<Snapshot> => ({ ok: true, policy, backendPolicy: bp, backend, enforcement: probe.enforcement });
	const bash = defs(ws, snap).get("bash")!;
	await run(bash, { command: "echo in > inside.txt" }, ws);
	assert.equal(readFileSync(join(ws, "inside.txt"), "utf8"), "in\n");
	await assert.rejects(run(bash, { command: `echo out > ${join(root, "outside", "o.txt")}` }, ws), /\[sandbox: /);
	assert.equal(existsSync(join(root, "outside", "o.txt")), false);
	const policyJson = join(ws, ".agent", "sandbox-policy", "linux", "policy.json");
	const before = readFileSync(policyJson, "utf8");
	await assert.rejects(run(bash, { command: `echo '{}' > ${policyJson}` }, ws));
	assert.equal(readFileSync(policyJson, "utf8"), before);
	cleanup();
});

test("bash under the real backend: no variable on bwrap's argv; the command's environment is the one --setenv gave", { skip: process.platform !== "linux" || !existsSync("/usr/bin/bwrap") }, async () => {
	const { ws, policy, cleanup } = setup();
	const backend = backendFor("linux");
	const bp = { ...backendPolicy(policy), env: { ...backendPolicy(policy).env, MISE_GITHUB_TOKEN: "gh-unit-1", LANG: "C.UTF-8" } };
	const seen: string[][] = [];
	const spy: typeof backend = Object.assign(Object.create(Object.getPrototypeOf(backend)), backend, {
		confine: async (req: Parameters<typeof backend.confine>[0]) => {
			const r = await backend.confine(req);
			if (r.ok) seen.push(r.confined.argv);
			return r;
		},
	});
	const snap = async (): Promise<Snapshot> => ({ ok: true, policy, backendPolicy: bp, backend: spy, enforcement: "full" });
	const viaFd = text(await run(defs(ws, snap).get("bash")!, { command: "env -0 | sort -z | tr '\\0' '\\n'; ls /proc/$$/fd | tr '\\n' ' '" }, ws));
	assert.equal(seen.length, 1);
	assert.ok(!seen[0]!.includes("--setenv") && !seen[0]!.join(" ").includes("gh-unit-1"), "nothing of the environment on argv");
	// The old spelling (--setenv on argv), run directly: the same environment, and fds 0-2 only either way.
	const old = await backend.confine({ argv: ["/bin/sh", "-c", "env -0 | sort -z | tr '\\0' '\\n'; ls /proc/$$/fd | tr '\\n' ' '"], cwd: ws, policy: bp, env: { PATH: process.env.PATH!, PI_SESSION_ID: "unit" } });
	assert.ok(old.ok);
	const { execFileSync } = await import("node:child_process");
	const direct = execFileSync(old.confined.argv[0]!, old.confined.argv.slice(1), { cwd: ws, env: old.confined.env, encoding: "utf8" });
	assert.ok(viaFd.includes("MISE_GITHUB_TOKEN=gh-unit-1"));
	assert.equal(viaFd.replace(/^PATH=.*$/m, "").trim(), direct.replace(/^PATH=.*$/m, "").trim());
	cleanup();
});

test("bash in a write-only worker (host network, host env): no variable on bwrap's argv; the host env arrives inside", { skip: process.platform !== "linux" || !existsSync("/usr/bin/bwrap") }, async () => {
	const { ws, policy, cleanup } = setup();
	const backend = backendFor("linux");
	const bp: Policy = { ...backendPolicy(policy), network: { mode: "host" }, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, GH_TOKEN: "gh-wo-1" } };
	const seen: string[][] = [];
	const spy: typeof backend = Object.assign(Object.create(Object.getPrototypeOf(backend)), backend, {
		confine: async (req: Parameters<typeof backend.confine>[0]) => {
			const r = await backend.confine(req);
			if (r.ok) seen.push(r.confined.argv);
			return r;
		},
	});
	const snap = async (): Promise<Snapshot> => ({ ok: true, policy, backendPolicy: bp, backend: spy, enforcement: "full" });
	const out = text(await run(defs(ws, snap).get("bash")!, { command: "echo gh=$GH_TOKEN" }, ws));
	assert.match(out, /gh=gh-wo-1/);
	assert.equal(seen.length, 1);
	assert.ok(!seen[0]!.includes("--setenv") && !seen[0]!.join(" ").includes("gh-wo-1"), "nothing of the host env on argv");
	assert.ok(!seen[0]!.includes("--unshare-net"), "it is the write-only (host network) profile");
	cleanup();
});

test("agent dir inside the cwd: the policy files are in hidden and refused for write and read", async () => {
	const { ws, agentDir, policy, cleanup } = setup();
	assert.ok(isWithin(agentDir, ws));
	const root = join(agentDir, "sandbox-policy");
	for (const f of ["linux/policy.json", "darwin/policy.json"]) {
		const c = canonicalize(join(root, f));
		assert.ok(policy.hidden.includes(c), f);
		assert.ok(writeDenial(policy, c), `write ${f}`);
		assert.ok(readDenial(policy, c), `read ${f}`);
	}
	// The note beside it is for an agent to read; it is still unwritable, and so is anything new there.
	for (const f of ["linux/CLAUDE.md", "darwin/CLAUDE.md"]) {
		const c = canonicalize(join(root, f));
		assert.equal(readDenial(policy, c), undefined, `read ${f}`);
		assert.ok(writeDenial(policy, c), `write ${f}`);
	}
	assert.ok(writeDenial(policy, canonicalize(join(root, "linux", "evil.json")), { creating: true }));
	cleanup();
});

test("shadowed caches: the file tools read and write the private copy, never the host path", async () => {
	const { root, ws, agentDir, home, tmpDir, cleanup } = setup();
	const hostCache = join(home, ".cache");
	mkdirSync(hostCache, { recursive: true });
	writeFileSync(join(hostCache, "host.txt"), "host");
	const r = resolvePolicy({ agentDir, cwd: ws, tmpDir, platform: "linux", home, shadowSource: (a, p) => shadowSource(a, p, home) });
	assert.ok(r.ok);
	const policy = r.value;
	// The template shadows ~/.cache; its private copy lives under the agent dir.
	const source = join(agentDir, "sova", "sandbox", "shadow", "home-.cache");
	assert.deepEqual(policy.shadowed.find((sh) => sh.path === hostCache), { path: hostCache, source });
	assert.ok(!policy.writable.includes(hostCache));
	const snap = async (): Promise<Snapshot> => ({ ok: true, policy, backendPolicy: backendPolicy(policy), backend: passthroughBackend(), enforcement: "full" });
	const d = defs(ws, snap);
	await run(d.get("write")!, { path: join(hostCache, "tool", "x.txt"), content: "sandboxed" }, ws);
	assert.equal(existsSync(join(hostCache, "tool")), false, "the host cache is untouched");
	assert.equal(readFileSync(join(source, "tool", "x.txt"), "utf8"), "sandboxed");
	assert.match(text(await run(d.get("read")!, { path: join(hostCache, "tool", "x.txt") }, ws)), /sandboxed/);
	await assert.rejects(run(d.get("read")!, { path: join(hostCache, "host.txt") }, ws), /ENOENT/);
	// The rest of the agent dir stays read-only; only the shadow source is writable.
	await assert.rejects(run(d.get("write")!, { path: join(agentDir, "sova", "other.txt"), content: "x" }, ws), /\[sandbox:/);
	cleanup();
});

test("git: write/edit cannot plant a hook or touch .git/config; the host files are unchanged", async () => {
	const { ws, policy, cleanup } = setup({ git: true });
	const hook = join(ws, ".git", "hooks", "pre-commit");
	const config = join(ws, ".git", "config");
	const configBefore = readFileSync(config, "utf8");
	assert.ok(policy.readOnlyWithinWritable.includes(join(ws, ".git", "hooks")));
	assert.ok(policy.readOnlyWithinWritable.includes(config));
	const snap = async (): Promise<Snapshot> => ({ ok: true, policy, backendPolicy: backendPolicy(policy), backend: passthroughBackend(), enforcement: "full" });
	const d = defs(ws, snap);
	await assert.rejects(run(d.get("write")!, { path: ".git/hooks/pre-commit", content: "#!/bin/sh\ntouch /var/tmp/pwned\n" }, ws), /read-only.*\[sandbox:/);
	await assert.rejects(run(d.get("edit")!, { path: ".git/config", edits: [{ oldText: "[core]", newText: "[core]\n\thooksPath = /var/tmp" }] }, ws), /\[sandbox:/);
	await assert.rejects(run(d.get("write")!, { path: ".git/config", content: "" }, ws), /\[sandbox:/);
	assert.equal(existsSync(hook), false);
	assert.equal(readFileSync(config, "utf8"), configBefore);
	// Ordinary files in the repo are still writable.
	await run(d.get("write")!, { path: "src/ok.ts", content: "ok" }, ws);
	assert.equal(readFileSync(join(ws, "src", "ok.ts"), "utf8"), "ok");
	cleanup();
});

test("git: in a directory that is not a repo, a file tool cannot create .git (a later host git would run it)", async () => {
	const { ws, policy, cleanup } = setup();
	const snap = async (): Promise<Snapshot> => ({ ok: true, policy, backendPolicy: backendPolicy(policy), backend: passthroughBackend(), enforcement: "full" });
	const d = defs(ws, snap);
	await assert.rejects(run(d.get("write")!, { path: ".git/hooks/pre-commit", content: "x" }, ws), /\[sandbox:/);
	await assert.rejects(run(d.get("write")!, { path: ".git/config", content: "x" }, ws), /\[sandbox:/);
	assert.equal(existsSync(join(ws, ".git")), false);
	cleanup();
});

test("a NEW directory that is an ancestor of a protected path cannot be created", async () => {
	const { ws, policy: base, cleanup } = setup();
	// A protected path whose ancestors do not exist yet.
	const policy = { ...base, readOnlyWithinWritable: [...base.readOnlyWithinWritable, join(ws, "deploy", "hooks", "post")] };
	const snap = async (): Promise<Snapshot> => ({ ok: true, policy, backendPolicy: backendPolicy(policy), backend: passthroughBackend(), enforcement: "full" });
	const d = defs(ws, snap);
	await assert.rejects(run(d.get("write")!, { path: "deploy/hooks", content: "x" }, ws), /holds a path the sandbox protects/);
	await assert.rejects(run(d.get("write")!, { path: "deploy/hooks/post/run.sh", content: "x" }, ws), /\[sandbox:/);
	assert.equal(existsSync(join(ws, "deploy", "hooks")), false);
	cleanup();
});

test("sandboxView matches the backend's mapShadowed, including a real root nested in a shadow", () => {
	const policy = { tmpDir: "/s/tmp", writable: ["/h/.cache/proj", "/s/tmp"], shadowed: [{ path: "/h/.cache", source: "/a/shadow/home-.cache" }] };
	const bp = { level: "workspace-write", workspaceRoot: "/h/.cache/proj", writable: ["/h/.cache/proj"], readOnlyWithinWritable: [], hidden: [], tmpDir: "/s/tmp", network: { mode: "none" }, env: {}, sessionId: "x", shadowed: policy.shadowed } as Policy;
	for (const p of ["/h/.cache/x/y", "/h/.cache", "/h/.cache/proj/src/a.ts", "/h/other"]) {
		assert.equal(sandboxView(p, policy, "write").real, mapShadowed(bp, p), p);
	}
});
