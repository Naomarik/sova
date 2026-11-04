// The policy's `browser` end to end on macOS: the real policy resolution, the real Seatbelt
// profile through the backend's confine(), and the real chrome-headless-shell taking a screenshot
// of a data: URL (no network, no Playwright). With the key on, a PNG lands on the host; with it
// off, the shell crashes inside the profile and nothing lands. Both profile shapes: a write-only
// worktree worker (Subagents only) and an On session.
//
// Only the headless shell, never an app-bundle Chrome (Google Chrome.app, Chrome for Testing): a
// bundle that crashes under the profile raises a macOS "quit unexpectedly" dialog on the user's
// screen. The binary comes from SANDBOX_TEST_HEADLESS_SHELL, else the newest Playwright revision
// installed; without one (or off macOS, or already inside a sandbox) every case skips, loudly.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Policy } from "../../backend.ts";
import { BROWSER_RULES, DarwinSeatbeltBackend, renderProfile, profilePlan, runCapture, RUNNER_FATAL } from "../../backends/darwin-seatbelt.ts";
import { hostEnv, scrubEnv } from "../../env.ts";
import { type ResolvedPolicy, writeOnlyScope } from "../../policy.ts";
import { resolveSessionPolicy } from "../../session-policy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, "..", "..", "..", "..", "sandbox-policy");
const PNG_MAGIC = "89504e47";

/** The newest numeric revision of Playwright's chrome-headless-shell for macOS, or undefined. */
function newestHeadlessShell(): string | undefined {
	const cache = join(homedir(), "Library", "Caches", "ms-playwright");
	let revisions: { n: number; dir: string }[];
	try {
		revisions = readdirSync(cache)
			.map((d) => ({ d, m: /^chromium_headless_shell-(\d+)$/.exec(d) }))
			.filter((x) => x.m)
			.map((x) => ({ n: Number(x.m![1]), dir: join(cache, x.d) }))
			.sort((a, b) => b.n - a.n);
	} catch {
		return undefined;
	}
	for (const r of revisions) {
		let plats: string[] = [];
		try {
			plats = readdirSync(r.dir).filter((p) => /^chrome-headless-shell-mac-/.test(p));
		} catch {}
		for (const p of plats) {
			const bin = join(r.dir, p, "chrome-headless-shell");
			if (existsSync(bin)) return bin;
		}
	}
	return undefined;
}

const onMac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const shell = process.env.SANDBOX_TEST_HEADLESS_SHELL || (onMac ? newestHeadlessShell() : undefined);
/** Seatbelt cannot nest: inside a sandbox every sandbox-exec fails at sandbox_apply. */
const nested = onMac && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status !== 0;
const skip = !onMac
	? "macOS only"
	: !shell
		? "no chrome-headless-shell; set SANDBOX_TEST_HEADLESS_SHELL"
		: nested
			? "already inside a sandbox: sandbox-exec cannot nest; run from an unconfined shell"
			: false;
if (skip) console.warn(`darwin-seatbelt-browser: SKIPPED: ${skip}`);

test("the binary is a headless shell, never an app bundle", { skip: !shell ? skip : false }, () => {
	assert.ok(!/\.app(\/|$)/.test(shell!), `${shell} is inside an app bundle: refused (a crash raises a dialog)`);
	assert.equal(basename(shell!), "chrome-headless-shell", `${shell} is not chrome-headless-shell`);
	assert.ok(statSync(shell!).isFile());
});

/** A private root with a workspace (a git repo) and an agent dir holding the shipped template, `browser` set. */
function setup(t: { after: (fn: () => void) => void }, browser: "none" | "headless-shell") {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sbx-browser-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ws = join(root, "ws");
	mkdirSync(ws);
	assert.equal(spawnSync("git", ["init", "-q", ws]).status, 0);
	const agentDir = join(root, "agent");
	cpSync(TEMPLATES, join(agentDir, "sandbox-policy"), { recursive: true });
	const file = join(agentDir, "sandbox-policy", "darwin", "policy.json");
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), browser }));
	const tmpDir = join(root, "session", "tmp");
	mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
	return { root, ws, agentDir, tmpDir };
}

/** The backend policy the extension's snapshot() builds from a resolved one (index.ts), minus the proxy. */
function backendPolicy(p: ResolvedPolicy): Policy {
	return {
		level: p.level,
		workspaceRoot: p.workspaceRoot,
		writable: p.writable,
		readOnlyWithinWritable: p.readOnlyWithinWritable,
		hidden: p.hidden,
		tmpDir: p.tmpDir,
		shadowed: p.shadowed,
		network: { mode: p.writeOnly ? "host" : "none" },
		env: p.writeOnly ? hostEnv(process.env) : scrubEnv(process.env, p.envAllow),
		sessionId: "browser-test",
		...(p.writeOnly ? { hostTmp: true } : {}),
		...(p.browser ? { browser: true } : {}),
	};
}

/** Resolve the policy as a session in that state would: a write-only worker takes `browser` from its parent's scope. */
function resolve(shape: "write-only" | "on", s: ReturnType<typeof setup>, browser: boolean): Policy {
	const r = resolveSessionPolicy({
		agentDir: s.agentDir,
		cwd: s.ws,
		sessionId: "browser-test",
		tmpDir: s.tmpDir,
		...(shape === "write-only" ? { parent: writeOnlyScope(s.ws, { browser }) } : { worktreeRoots: [] }),
	});
	assert.ok(r.ok, r.ok ? "" : r.error);
	assert.equal(r.value.browser, browser);
	assert.equal(!!r.value.writeOnly, shape === "write-only");
	return backendPolicy(r.value);
}

const fatal = RUNNER_FATAL.map((s) => new RegExp(s, "m"));

async function confined(policy: Policy, argv: string[]) {
	const res = await new DarwinSeatbeltBackend().confine({ argv, cwd: policy.workspaceRoot, policy });
	assert.ok(res.ok, res.ok ? "" : res.reason);
	const run = await runCapture(res.confined.argv, res.confined.env, policy.workspaceRoot, 45_000);
	assert.ok(!fatal.some((re) => re.test(run.output)), `the sandbox runner itself failed, so nothing was tested:\n${run.output}`);
	return run;
}

async function screenshot(policy: Policy, tmpDir: string, ws: string) {
	const out = join(ws, "shot.png");
	rmSync(out, { force: true });
	const run = await confined(policy, [shell!, "--no-sandbox", `--user-data-dir=${join(tmpDir, "chrome-profile")}`, `--screenshot=${out}`, "data:text/html,<h1>seatbelt</h1>"]);
	return { run, out, png: existsSync(out) ? readFileSync(out).subarray(0, 4).toString("hex") : undefined };
}

for (const shape of ["write-only", "on"] as const) {
	test(`${shape}: browser "headless-shell" writes a PNG the host sees`, { skip }, async (t) => {
		const s = setup(t, "headless-shell");
		const policy = resolve(shape, s, true);
		assert.ok(renderProfile(profilePlan({ policy })).includes(BROWSER_RULES[0]!));
		const { run, png } = await screenshot(policy, s.tmpDir, s.ws);
		assert.equal(png, PNG_MAGIC, `no PNG (exit ${run.code ?? run.signal}):\n${run.output.slice(-3000)}`);
	});

	test(`${shape}: browser "none": the profile applies, the shell runs and crashes, no PNG`, { skip }, async (t) => {
		const s = setup(t, "none");
		const policy = resolve(shape, s, false);
		assert.ok(!renderProfile(profilePlan({ policy })).includes("MachPortRendezvousServer"));
		// The profile itself works: a write in the workspace lands, so the failure below is the shell's.
		const ctl = await confined(policy, ["/bin/sh", "-c", "echo applied > control.txt"]);
		assert.equal(ctl.code, 0, ctl.output);
		assert.equal(readFileSync(join(s.ws, "control.txt"), "utf8"), "applied\n");
		const { run, png } = await screenshot(policy, s.tmpDir, s.ws);
		assert.equal(png, undefined, "a PNG landed without the browser rules");
		assert.ok(run.code !== 0 || run.signal !== null, `the shell exited 0 without a PNG:\n${run.output.slice(-3000)}`);
	});
}
