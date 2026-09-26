// install.sh: settings.json is seeded and merged, never symlinked; --check and
// --save. Every run is sandboxed: a plain copy of install.sh with a fixture
// seed, a temp HOME and a temp PI_AGENT_DIR. The real ~/.pi/agent,
// ~/.local/bin and this directory's settings.json are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const SEED = {
	theme: "dark",
	hideThinkingBlock: true,
	retry: { enabled: true, maxRetries: 3 },
	packages: ["npm:a@1.0.0", { source: "npm:b@2.0.0", extensions: ["!index.ts"] }],
};

function sandbox() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-install-")));
	const copy = path.join(root, "pi-config");
	fs.mkdirSync(path.join(copy, "extensions/sessions/bin"), { recursive: true });
	fs.copyFileSync(path.join(here, "install.sh"), path.join(copy, "install.sh"));
	fs.writeFileSync(path.join(copy, "extensions/sessions/bin/pi-sessions.ts"), "");
	for (const f of ["keybindings.json", "models.json", "vision-delegate.json"]) {
		fs.writeFileSync(path.join(copy, f), "{}\n");
	}
	const seed = path.join(copy, "settings.json");
	fs.writeFileSync(seed, JSON.stringify(SEED, null, 2) + "\n");
	const home = path.join(root, "home");
	const agent = path.join(root, "agent");
	fs.mkdirSync(home);
	const run = (...args) => {
		const r = spawnSync("bash", [path.join(copy, "install.sh"), ...args], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, PI_AGENT_DIR: agent, PI_CODING_AGENT_DIR: "" },
		});
		return { code: r.status, out: r.stdout + r.stderr };
	};
	const live = path.join(agent, "settings.json");
	const readLive = () => JSON.parse(fs.readFileSync(live, "utf8"));
	const writeLive = (v) => fs.writeFileSync(live, JSON.stringify(v, null, 2) + "\n");
	const readSeed = () => JSON.parse(fs.readFileSync(seed, "utf8"));
	return { root, agent, live, seed, run, readLive, writeLive, readSeed };
}

// Every file under dir with its content (symlinks as "-> target").
function snapshot(dir) {
	const out = {};
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isSymbolicLink()) out[p] = `-> ${fs.readlinkSync(p)}`;
			else if (e.isDirectory()) walk(p);
			else out[p] = fs.readFileSync(p, "utf8");
		}
	};
	walk(dir);
	return out;
}

test("fresh install writes the seed as a regular file; a rerun keeps runtime keys", () => {
	const s = sandbox();
	const r = s.run();
	assert.equal(r.code, 0, r.out);
	assert.ok(fs.lstatSync(s.live).isFile() && !fs.lstatSync(s.live).isSymbolicLink());
	assert.equal(fs.readFileSync(s.live, "utf8"), fs.readFileSync(s.seed, "utf8"));
	assert.ok(fs.lstatSync(path.join(s.agent, "models.json")).isSymbolicLink());

	s.writeLive({ ...s.readLive(), defaultProvider: "p", defaultModel: "m", lastChangelogVersion: "9.9.9" });
	assert.equal(s.run().code, 0);
	assert.deepEqual(s.readLive(), { ...SEED, defaultProvider: "p", defaultModel: "m", lastChangelogVersion: "9.9.9" });
});

test("an existing regular file merges: seed wins for declared keys, others kept, arrays replaced", () => {
	const s = sandbox();
	fs.mkdirSync(s.agent);
	const before = {
		defaultModel: "m",
		theme: "light",
		retry: { enabled: false, baseDelayMs: 5 },
		packages: ["npm:mine@0.0.1"],
	};
	s.writeLive(before);
	const raw = fs.readFileSync(s.live, "utf8");
	const r = s.run();
	assert.equal(r.code, 0, r.out);
	assert.deepEqual(s.readLive(), {
		defaultModel: "m",
		theme: "dark",
		retry: { enabled: true, baseDelayMs: 5, maxRetries: 3 },
		packages: SEED.packages,
		hideThinkingBlock: true,
	});
	assert.equal(fs.readFileSync(`${s.live}.bak`, "utf8"), raw);
	assert.ok(!fs.existsSync(`${s.live}.lock`));
});

test("a pre-existing symlink is replaced without writing into its target", () => {
	const s = sandbox();
	fs.mkdirSync(s.agent);
	const target = path.join(s.root, "elsewhere.json");
	const content = JSON.stringify({ theme: "light", defaultProvider: "p" }, null, 2) + "\n";
	fs.writeFileSync(target, content);
	fs.symlinkSync(target, s.live);
	const r = s.run();
	assert.equal(r.code, 0, r.out);
	assert.equal(fs.readFileSync(target, "utf8"), content);
	assert.ok(!fs.lstatSync(s.live).isSymbolicLink());
	assert.deepEqual(s.readLive(), { theme: "dark", defaultProvider: "p", ...SEED });
});

test("--check passes in sync, names a drifted key, and changes nothing", () => {
	const s = sandbox();
	assert.equal(s.run().code, 0);
	s.writeLive({ ...s.readLive(), defaultModel: "m" });
	let r = s.run("--check");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /^ok: /m);

	s.writeLive({ ...s.readLive(), theme: "light", retry: { enabled: true, maxRetries: 7 } });
	const before = snapshot(s.root);
	r = s.run("--check");
	assert.notEqual(r.code, 0);
	assert.match(r.out, /theme: want "dark", have "light"/);
	assert.match(r.out, /retry\.maxRetries: want 3, have 7/);
	assert.doesNotMatch(r.out, /defaultModel/);
	assert.deepEqual(snapshot(s.root), before);
});

test("--check fails on a symlinked settings.json and on a missing one", () => {
	const s = sandbox();
	fs.mkdirSync(s.agent);
	fs.symlinkSync(s.seed, s.live);
	let r = s.run("--check");
	assert.notEqual(r.code, 0);
	assert.match(r.out, /is a symlink, want a regular file/);
	fs.unlinkSync(s.live);
	r = s.run("--check");
	assert.notEqual(r.code, 0);
	assert.match(r.out, /missing: /);
	assert.ok(!fs.existsSync(s.live));
});

test("--save promotes only seed-declared keys into the seed", () => {
	const s = sandbox();
	assert.equal(s.run().code, 0);
	const packages = ["npm:a@1.1.0"];
	const live = { ...s.readLive(), theme: "light", packages, defaultProvider: "p", lastChangelogVersion: "9.9.9" };
	delete live.hideThinkingBlock;
	live.retry = { enabled: true, maxRetries: 3, baseDelayMs: 9 };
	s.writeLive(live);
	const r = s.run("--save");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /saved theme/);
	assert.match(r.out, /saved packages/);
	const seed = s.readSeed();
	assert.deepEqual(seed, { ...SEED, theme: "light", packages });
	assert.deepEqual(Object.keys(seed), Object.keys(SEED));
	assert.ok(!("defaultProvider" in seed) && !("lastChangelogVersion" in seed) && !("baseDelayMs" in seed.retry));
	// The live file still lacks hideThinkingBlock, which the seed kept.
	const check = s.run("--check");
	assert.notEqual(check.code, 0);
	assert.deepEqual(check.out.match(/differs from seed: .*/g), [`differs from seed: ${s.live} hideThinkingBlock: want true, have (missing)`]);
});

test("--save without a live file exits 2", () => {
	const s = sandbox();
	const before = fs.readFileSync(s.seed, "utf8");
	const r = s.run("--save");
	assert.equal(r.code, 2);
	assert.match(r.out, /no live settings file/);
	assert.equal(fs.readFileSync(s.seed, "utf8"), before);
});

test("the tracked seed pins no model, provider or runtime state", () => {
	const seed = JSON.parse(fs.readFileSync(path.join(here, "settings.json"), "utf8"));
	for (const k of ["defaultProvider", "defaultModel", "lastChangelogVersion", "enabledModels", "modelThinkingLevels"]) {
		assert.ok(!(k in seed), `${k} must not be tracked`);
	}
});

test("the sandbox policy is copied, never linked, never overwritten; --check reports drift", () => {
	const s = sandbox();
	const copy = path.join(s.root, "pi-config");
	fs.cpSync(path.join(here, "sandbox-policy"), path.join(copy, "sandbox-policy"), { recursive: true });
	const dst = path.join(s.agent, "sandbox-policy", "linux", "policy.json");
	assert.equal(s.run().code, 0);
	assert.equal(fs.lstatSync(path.join(s.agent, "sandbox-policy")).isSymbolicLink(), false);
	assert.equal(fs.lstatSync(dst).isSymbolicLink(), false);
	assert.equal(fs.readFileSync(dst, "utf8"), fs.readFileSync(path.join(here, "sandbox-policy/linux/policy.json"), "utf8"));
	assert.ok(fs.existsSync(path.join(s.agent, "sandbox-policy", "darwin", "CLAUDE.md")));
	let r = s.run("--check");
	assert.equal(r.code, 0, r.out);
	assert.doesNotMatch(r.out, /sandbox-policy/);

	// A user edit is kept by a rerun and reported (not failed) by --check.
	const edited = fs.readFileSync(dst, "utf8").replace('"defaultOn": false', '"defaultOn": true');
	fs.writeFileSync(dst, edited);
	assert.equal(s.run().code, 0);
	assert.equal(fs.readFileSync(dst, "utf8"), edited);
	r = s.run("--check");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /differs from the template \(kept, never overwritten\): .*linux\/policy\.json/);
	assert.match(r.out, /\+  "defaultOn": true/);

	// A missing file or a symlink fails --check; install replaces a link with a copy.
	fs.rmSync(dst);
	fs.symlinkSync(path.join(copy, "sandbox-policy/linux/policy.json"), dst);
	r = s.run("--check");
	assert.notEqual(r.code, 0);
	assert.match(r.out, /is a symlink, want a copy/);
	assert.equal(s.run().code, 0);
	assert.equal(fs.lstatSync(dst).isSymbolicLink(), false);
	fs.rmSync(path.join(s.agent, "sandbox-policy", "darwin", "CLAUDE.md"));
	r = s.run("--check");
	assert.notEqual(r.code, 0);
	assert.match(r.out, /missing: .*darwin\/CLAUDE\.md/);
	fs.rmSync(s.root, { recursive: true, force: true });
});

test("--links links new extensions, prunes dangling ones into this dir, and touches nothing else", () => {
	const s = sandbox();
	const copy = path.join(s.root, "pi-config");
	fs.cpSync(path.join(here, "sandbox-policy"), path.join(copy, "sandbox-policy"), { recursive: true });
	fs.mkdirSync(path.join(copy, "extensions/alpha"));
	assert.equal(s.run().code, 0);
	s.writeLive({ ...s.readLive(), theme: "light", defaultModel: "m" });
	const ext = path.join(s.agent, "extensions");

	// Nothing to do: silent, and the whole agent dir is byte-identical.
	let before = snapshot(s.agent);
	let r = s.run("--links");
	assert.equal(r.code, 0, r.out);
	assert.equal(r.out, "");
	assert.deepEqual(snapshot(s.agent), before);

	// A new extension dir and a new single-file extension are linked; a removed one's
	// dangling link is pruned; a foreign dangling link and a foreign real dir are kept.
	fs.mkdirSync(path.join(copy, "extensions/beta"));
	fs.writeFileSync(path.join(copy, "extensions/gamma.ts"), "");
	fs.rmSync(path.join(copy, "extensions/alpha"), { recursive: true });
	fs.symlinkSync(path.join(s.root, "elsewhere"), path.join(ext, "foreign"));
	fs.mkdirSync(path.join(ext, "mine"));
	before = snapshot(s.agent);
	r = s.run("--links");
	assert.equal(r.code, 0, r.out);
	assert.equal(fs.readlinkSync(path.join(ext, "beta")), path.join(copy, "extensions/beta"));
	assert.equal(fs.readlinkSync(path.join(ext, "gamma.ts")), path.join(copy, "extensions/gamma.ts"));
	assert.equal(fs.lstatSync(path.join(ext, "alpha"), { throwIfNoEntry: false }), undefined);
	assert.equal(fs.readlinkSync(path.join(ext, "foreign")), path.join(s.root, "elsewhere"));
	assert.ok(fs.statSync(path.join(ext, "mine")).isDirectory());
	assert.match(r.out, /removed dangling .*alpha/);
	// Outside extensions/ nothing moved: runtime settings, config links, policy.
	const outside = (snap) => Object.fromEntries(Object.entries(snap).filter(([p]) => !p.startsWith(ext + path.sep)));
	assert.deepEqual(outside(snapshot(s.agent)), outside(before));
	assert.equal(s.readLive().theme, "light");

	// A real file where an extension wants its link is left alone and warned about, exit 0.
	fs.mkdirSync(path.join(copy, "extensions/delta"));
	fs.writeFileSync(path.join(ext, "delta"), "user file");
	r = s.run("--links");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /left alone, not a symlink: .*delta/);
	assert.equal(fs.readFileSync(path.join(ext, "delta"), "utf8"), "user file");
	assert.equal(fs.existsSync(path.join(ext, "delta.bak")), false);
	fs.rmSync(s.root, { recursive: true, force: true });
});
