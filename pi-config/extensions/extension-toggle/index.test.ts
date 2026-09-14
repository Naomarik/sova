import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyToggle,
	computeEnabled,
	expandEntry,
	globToRegExp,
	listExtensions,
	manifestExtensionFiles,
	npmSpecName,
	packageBaseDir,
	togglePattern,
	readSettings,
	writeSettings,
} from "./logic.ts";

// ---------------------------------------------------------------------------
// globToRegExp

test("globToRegExp basics", () => {
	assert.ok(globToRegExp("*.ts").test("a.ts"));
	assert.ok(!globToRegExp("*.ts").test("dir/a.ts"));
	assert.ok(globToRegExp("**/*.ts").test("a.ts"), "**/*.ts matches top-level");
	assert.ok(globToRegExp("**/*.ts").test("a/b/c.ts"), "**/*.ts matches nested");
	assert.ok(globToRegExp("extensions/*").test("extensions/foo.ts"));
	assert.ok(globToRegExp("usage-extension/index.ts").test("usage-extension/index.ts"));
	assert.ok(globToRegExp("a?c.ts").test("abc.ts"));
	assert.ok(!globToRegExp("a?c.ts").test("ac.ts"));
	assert.ok(globToRegExp("src/**").test("src/x/y.js"), "src/** matches nested");
});

// ---------------------------------------------------------------------------
// computeEnabled / togglePattern parity with pi's applyPatterns

test("computeEnabled empty patterns = all on", () => {
	assert.equal(computeEnabled("foo/index.ts", []), true);
});

test("computeEnabled include-list semantics", () => {
	// plain patterns act as an allowlist: everything else is off
	assert.equal(computeEnabled("a/index.ts", ["a/**"]), true);
	assert.equal(computeEnabled("b/index.ts", ["a/**"]), false);
	// ! excludes even inside the allowlist
	assert.equal(computeEnabled("a/legacy.ts", ["a/**", "!a/legacy.ts"]), false);
	// + force-includes back
	assert.equal(computeEnabled("a/legacy.ts", ["a/**", "!a/legacy.ts", "+a/legacy.ts"]), true);
	// - force-excludes wins over everything
	assert.equal(computeEnabled("a/legacy.ts", ["a/**", "+a/legacy.ts", "-a/legacy.ts"]), false);
});

test("togglePattern disable then enable round trip", () => {
	const orig: string[] = [];
	const off = togglePattern(orig, "subagents/index.ts", false);
	assert.deepEqual(off, ["!subagents/index.ts"]);
	assert.equal(computeEnabled("subagents/index.ts", off), false);
	const on = togglePattern(off, "subagents/index.ts", true);
	assert.deepEqual(on, []);
	assert.equal(computeEnabled("subagents/index.ts", on), true);
});

test("togglePattern disable inside an allowlist keeps the allowlist", () => {
	const orig = ["usage-extension/index.ts"];
	const off = togglePattern(orig, "usage-extension/index.ts", false);
	assert.deepEqual(off, ["usage-extension/index.ts", "!usage-extension/index.ts"]);
	assert.equal(computeEnabled("usage-extension/index.ts", off), false);
	const on = togglePattern(off, "usage-extension/index.ts", true);
	assert.deepEqual(on, ["usage-extension/index.ts"]);
	assert.equal(computeEnabled("usage-extension/index.ts", on), true);
});

test("togglePattern enable under allowlist that excludes it force-includes", () => {
	const orig = ["a/**"];
	const on = togglePattern(orig, "b/index.ts", true);
	assert.ok(on.includes("+b/index.ts"));
	assert.equal(computeEnabled("b/index.ts", on), true);
});

// ---------------------------------------------------------------------------
// package source resolution

test("npmSpecName handles scoped and pinned specs", () => {
	assert.equal(npmSpecName("npm:pi-lens"), "pi-lens");
	assert.equal(npmSpecName("npm:pi-lens@4.1.6"), "pi-lens");
	assert.equal(npmSpecName("npm:@juicesharp/rpiv-todo@2.10.1"), "@juicesharp/rpiv-todo");
	assert.equal(npmSpecName("npm:@juicesharp/rpiv-todo"), "@juicesharp/rpiv-todo");
});

test("packageBaseDir resolves git source forms", () => {
	const agent = "/home/x/.pi/agent";
	assert.equal(packageBaseDir("git:github.com/tmustier/pi-extensions", agent, "/tmp"), path.join(agent, "git", "github.com", "tmustier", "pi-extensions"));
	assert.equal(packageBaseDir("git:github.com/tmustier/pi-extensions@v1", agent, "/tmp"), path.join(agent, "git", "github.com", "tmustier", "pi-extensions"));
	assert.equal(packageBaseDir("git:git@github.com:user/repo", agent, "/tmp"), path.join(agent, "git", "github.com", "user", "repo"));
	assert.equal(packageBaseDir("https://github.com/user/repo", agent, "/tmp"), path.join(agent, "git", "github.com", "user", "repo"));
	assert.equal(packageBaseDir("npm:pi-web-access", agent, "/tmp"), path.join(agent, "npm", "node_modules", "pi-web-access"));
	const local = packageBaseDir("./my-ext", "/tmp", "/home/x/proj/.pi");
	assert.equal(local, path.resolve("/home/x/proj/.pi", "./my-ext"));
});

// ---------------------------------------------------------------------------
// discovery + applyToggle against a sandbox agent dir

function sandbox(): { agentDir: string; cwd: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-toggle-test-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(agentDir, "extensions", "alpha"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "extensions", "alpha", "index.ts"), "export default () => {};");
	fs.writeFileSync(path.join(agentDir, "extensions", "solo.ts"), "export default () => {};");
	// npm package with manifest
	const pkgDir = path.join(agentDir, "npm", "node_modules", "demo-pkg");
	fs.mkdirSync(path.join(pkgDir, "extensions"), { recursive: true });
	fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "demo-pkg", pi: { extensions: ["./extensions"] } }));
	fs.writeFileSync(path.join(pkgDir, "extensions", "one.ts"), "export default () => {};");
	fs.writeFileSync(path.join(pkgDir, "extensions", "two.ts"), "export default () => {};");
	// git package using conventions (extensions/ dir, no manifest)
	const gitDir = path.join(agentDir, "git", "github.com", "someone", "conv-pkg");
	fs.mkdirSync(path.join(gitDir, "extensions"), { recursive: true });
	fs.writeFileSync(path.join(gitDir, "extensions", "main.ts"), "export default () => {};");
	// settings with both packages
	writeSettings(path.join(agentDir, "settings.json"), {
		packages: ["npm:demo-pkg", { source: "git:github.com/someone/conv-pkg", extensions: ["!extensions/main.ts"] }],
	});
	// project
	const cwd = path.join(root, "proj");
	fs.mkdirSync(path.join(cwd, ".pi", "extensions", "beta"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "extensions", "beta", "index.ts"), "export default () => {};");
	return { agentDir, cwd };
}

test("listExtensions finds local, project, and package resources with state", () => {
	const { agentDir, cwd } = sandbox();
	const res = listExtensions({ agentDir, cwd, includeProject: true });
	const ids = res.map((r) => `${r.kind}:${r.name}:${r.enabled}`);
	const expected = [
		"local:alpha:true",
		"local:beta:true",
		"local:solo:true",
		"package:demo-pkg/extensions/one.ts:true",
		"package:demo-pkg/extensions/two.ts:true",
		"package:conv-pkg:false",
	].sort();
	assert.deepEqual(ids.sort(), expected);
	// untrusted project: beta excluded
	const res2 = listExtensions({ agentDir, cwd, includeProject: false });
	assert.equal(res2.filter((r) => r.name === "beta").length, 0);
});

test("applyToggle local off/on writes and cleans the extensions array", () => {
	const { agentDir, cwd } = sandbox();
	const settingsPath = path.join(agentDir, "settings.json");
	const res = listExtensions({ agentDir, cwd, includeProject: true }).find((r) => r.name === "alpha")!;
	assert.equal(applyToggle(res, false), true);
	let saved = readSettings(settingsPath);
	assert.deepEqual(saved.extensions, ["!alpha/index.ts"]);
	assert.equal(applyToggle(res, true), true);
	saved = readSettings(settingsPath);
	assert.equal(saved.extensions, undefined, "empty pattern array is removed");
	assert.equal(applyToggle(res, true), false, "second enable is a no-op");
});

test("applyToggle package string entry converts to object and back", () => {
	const { agentDir, cwd } = sandbox();
	const settingsPath = path.join(agentDir, "settings.json");
	const one = listExtensions({ agentDir, cwd, includeProject: true }).find((r) => r.name === "demo-pkg/extensions/one.ts")!;
	assert.ok(one, "demo-pkg/extensions/one.ts row exists");
	assert.equal(applyToggle(one, false), true);
	let saved = readSettings(settingsPath);
	assert.deepEqual(saved.packages?.[0], { source: "npm:demo-pkg", extensions: ["!extensions/one.ts"] });
	assert.equal(applyToggle(one, true), true);
	saved = readSettings(settingsPath);
	assert.equal(saved.packages?.[0], "npm:demo-pkg", "reverts to string when no filters remain");
});

test("applyToggle preserves existing package filters and sibling keys", () => {
	const { agentDir, cwd } = sandbox();
	const settingsPath = path.join(agentDir, "settings.json");
	const main = listExtensions({ agentDir, cwd, includeProject: true }).find((r) => r.name === "conv-pkg")!;
	assert.equal(main.fileRel, "extensions/main.ts");
	assert.equal(main.enabled, false);
	assert.equal(applyToggle(main, true), true);
	let saved = readSettings(settingsPath);
	assert.equal(saved.packages?.[1], "git:github.com/someone/conv-pkg", "reverts to string when no filters remain");
	// toggling off again re-creates the object form with just this exclusion
	const reListed = listExtensions({ agentDir, cwd, includeProject: true }).find((r) => r.name === "conv-pkg")!;
	assert.equal(applyToggle(reListed, false), true);
	const reSaved = readSettings(settingsPath);
	assert.deepEqual((reSaved.packages?.[1] as { extensions: string[] }).extensions, ["!extensions/main.ts"]);
});

test("manifestExtensionFiles and expandEntry on real package layouts", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-toggle-manifest-"));
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ pi: { extensions: ["./src/*.ts", "!src/skip.ts"] } }));
	fs.writeFileSync(path.join(dir, "src", "a.ts"), "");
	fs.writeFileSync(path.join(dir, "src", "skip.ts"), "");
	assert.deepEqual(manifestExtensionFiles(dir), ["src/a.ts"]);
	assert.deepEqual(expandEntry(dir, "src"), ["src/a.ts", "src/skip.ts"]);
});
