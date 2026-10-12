/**
 * Which Claude program every spawn runs (claude-executable.ts): found from the host, never from a
 * chat's cwd. Every case builds its own fake tree under a temp dir; no claude or mise runs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeExecutable, type ClaudeExecutableHost, resetClaudeExecutable, resolveClaudeExecutable } from "./claude-executable.ts";

const skip = process.platform === "win32";

async function exe(file: string, body = "#!/bin/sh\n"): Promise<string> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, body);
	await chmod(file, 0o755);
	return file;
}

async function scratch(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "claude-executable-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

function host(root: string, PATH: string, extra: Partial<ClaudeExecutableHost> = {}): ClaudeExecutableHost {
	return {
		env: { PATH },
		home: path.join(root, "home"),
		cwd: path.join(root, "sova"),
		moduleDir: path.join(root, "sova", "pi-config"),
		miseWhich: () => assert.fail("mise is never asked without a shim"),
		...extra,
	};
}

test("the first claude on the host's PATH, as an absolute path kept as found (not followed through its link)", { skip }, async (t) => {
	const root = await scratch(t);
	const version = await exe(path.join(root, "versions", "2.1.300"));
	const bin = path.join(root, "bin");
	await mkdir(bin, { recursive: true });
	await symlink(version, path.join(bin, "claude"));
	await exe(path.join(root, "later", "claude"));
	const found = resolveClaudeExecutable(host(root, [path.join(root, "empty"), bin, path.join(root, "later")].join(path.delimiter)));
	assert.deepEqual(found, { path: path.join(bin, "claude") });
});

test("relative PATH entries are never searched: a chat folder's ./node_modules/.bin or . cannot supply claude", { skip }, async (t) => {
	const root = await scratch(t);
	const sova = path.join(root, "sova");
	await exe(path.join(sova, "claude"), "#!/bin/sh\necho hostile\n");
	await exe(path.join(sova, "node_modules", ".bin", "claude"), "#!/bin/sh\necho hostile\n");
	const real = await exe(path.join(root, "bin", "claude"));
	const PATH = [".", "node_modules/.bin", path.join(root, "bin")].join(path.delimiter);
	assert.deepEqual(resolveClaudeExecutable(host(root, PATH)), { path: real });
});

test("a mise shim is resolved from the host's cwd, then Sova's tree, and never stays a shim", { skip }, async (t) => {
	const root = await scratch(t);
	const mise = await exe(path.join(root, "mise-install", "mise"));
	const shims = path.join(root, "shims");
	await mkdir(shims, { recursive: true });
	await symlink(mise, path.join(shims, "claude"));
	const real = await exe(path.join(root, "installs", "claude", "2.1.300", "claude"));
	const asked: string[] = [];
	const h = host(root, shims, {
		miseWhich: (m, name, cwd) => {
			assert.equal(m, mise);
			assert.equal(name, "claude");
			asked.push(cwd);
			return cwd === path.join(root, "sova", "pi-config") ? real : undefined;
		},
	});
	assert.deepEqual(resolveClaudeExecutable(h), { path: real });
	assert.deepEqual(asked, [path.join(root, "sova"), path.join(root, "sova", "pi-config")], "the host's cwd first, then Sova's tree; nothing else");
});

test("a shim neither folder resolves is skipped for the next claude on PATH", { skip }, async (t) => {
	const root = await scratch(t);
	const mise = await exe(path.join(root, "mise-install", "mise"));
	const shims = path.join(root, "shims");
	await mkdir(shims, { recursive: true });
	await symlink(mise, path.join(shims, "claude"));
	const real = await exe(path.join(root, "bin", "claude"));
	const found = resolveClaudeExecutable(host(root, [shims, path.join(root, "bin")].join(path.delimiter), { miseWhich: () => undefined }));
	assert.deepEqual(found, { path: real });
});

test("with none on PATH, ~/.local/bin/claude", { skip }, async (t) => {
	const root = await scratch(t);
	const installed = await exe(path.join(root, "home", ".local", "bin", "claude"));
	assert.deepEqual(resolveClaudeExecutable(host(root, path.join(root, "empty"))), { path: installed });
});

test("none anywhere: 'Claude program not found', naming the PATH searched and the fallback", { skip }, async (t) => {
	const root = await scratch(t);
	await mkdir(path.join(root, "bin"), { recursive: true });
	await writeFile(path.join(root, "bin", "claude"), "not executable");
	const PATH = [path.join(root, "bin"), "relative/dir"].join(path.delimiter);
	const found = resolveClaudeExecutable(host(root, PATH));
	assert.deepEqual(found, {
		error: `Claude program not found: no \`claude\` on Sova's PATH (${path.join(root, "bin")}) or at ${path.join(root, "home", ".local", "bin", "claude")}. Install Claude Code, or start Sova with it on its PATH.`,
	});
});

test("claudeExecutable keeps its answer whatever the cwd becomes, and looks again once it is gone", { skip }, async (t) => {
	const root = await scratch(t);
	const first = await exe(path.join(root, "a", "claude"));
	const second = await exe(path.join(root, "b", "claude"));
	// A project folder with a hostile mise.toml and its own claude shim.
	const project = path.join(root, "project");
	await mkdir(project, { recursive: true });
	await writeFile(path.join(project, "mise.toml"), '[tools]\n"npm:@anthropic-ai/claude-code" = "0.0.1"\n');
	await exe(path.join(project, "claude"), "#!/bin/sh\necho hostile\n");
	const env = { PATH: [".", path.join(root, "a"), path.join(root, "b")].join(path.delimiter) };
	const cwd = process.cwd();
	resetClaudeExecutable();
	t.after(() => { process.chdir(cwd); resetClaudeExecutable(); });
	assert.equal(claudeExecutable(env), first);
	process.chdir(project);
	assert.equal(claudeExecutable(env), first, "the project's folder changes nothing");
	await rm(first);
	assert.equal(claudeExecutable(env), second, "a program that went away is looked up again");
	await rm(second);
	assert.throws(() => claudeExecutable(env), /^Error: Claude program not found: /);
});
