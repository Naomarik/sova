/**
 * How a pi worker is started (pi-invocation.ts): resolved from the host, never from a worker's cwd.
 * Every case builds its own fake tree under a temp dir; no pi, bun or mise runs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bunGuardFlags, getPiInvocation, PI_PACKAGE, piLaunch, type PiLaunchHost, resetPiLaunch, resolvePiLaunch } from "./pi-invocation.ts";

const skip = process.platform === "win32";

async function exe(file: string, body = "#!/bin/sh\n"): Promise<string> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, body);
	await chmod(file, 0o755);
	return file;
}

/** A Sova-like tree: <root>/app/server/index.ts with pi's package in <root>/app/node_modules. */
async function tree(t: { after(fn: () => Promise<void>): void }) {
	const root = await mkdtemp(path.join(tmpdir(), "pi-invocation-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const app = path.join(root, "app");
	await mkdir(path.join(app, "server"), { recursive: true });
	await writeFile(path.join(app, "package.json"), JSON.stringify({ name: "sova" }));
	const server = path.join(app, "server", "index.ts");
	await writeFile(server, "");
	const pkg = path.join(app, "node_modules", ...PI_PACKAGE.split("/"));
	await mkdir(path.join(pkg, "dist", "bundle"), { recursive: true });
	await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: PI_PACKAGE, bin: { pi: "dist/bundle/cli.js" } }));
	const cli = path.join(pkg, "dist", "bundle", "cli.js");
	await writeFile(cli, "");
	const bin = path.join(root, "bin");
	await mkdir(bin);
	const host = (over: Partial<PiLaunchHost> = {}): PiLaunchHost => ({
		env: { PATH: bin },
		execPath: "/opt/runtime/bun",
		bunVersion: "1.4.2",
		currentScript: server,
		moduleDir: path.join(app, "pi-config", "extensions", "subagents"),
		cwd: app,
		miseWhich: () => assert.fail("mise is never asked without a shim"),
		...over,
	});
	return { root, app, server, cli, bin, host };
}

test("a Bun host runs pi's own package script on itself, with the cwd guard flags", { skip }, async (t) => {
	const { cli, host } = await tree(t);
	assert.deepEqual(resolvePiLaunch(host()), { command: "/opt/runtime/bun", prefix: [...bunGuardFlags(), cli], via: "package" });
	assert.deepEqual(bunGuardFlags().slice(0, 1), ["--no-env-file"]);
	assert.ok(bunGuardFlags().some((f) => f.startsWith("--config=")), "the worker cwd's bunfig.toml is never read");
});

test("pi's package is found from the host's script when this module sits elsewhere", { skip }, async (t) => {
	const { root, cli, host } = await tree(t);
	assert.equal(resolvePiLaunch(host({ moduleDir: path.join(root, "elsewhere") })).prefix.at(-1), cli);
});

test("a Node host finds Bun: $SOVA_BUN, else bun on PATH, else its own runtime", { skip }, async (t) => {
	const { root, cli, bin, host } = await tree(t);
	const node = { execPath: "/opt/runtime/node", bunVersion: undefined };
	// No Bun anywhere: the host's own runtime, without Bun's flags.
	assert.deepEqual(resolvePiLaunch(host(node)), { command: "/opt/runtime/node", prefix: [cli], via: "package" });
	const onPath = await exe(path.join(bin, "bun"));
	assert.deepEqual(resolvePiLaunch(host(node)), { command: onPath, prefix: [...bunGuardFlags(), cli], via: "package" });
	const configured = await exe(path.join(root, "custom", "bun"));
	assert.equal(resolvePiLaunch(host({ ...node, env: { PATH: bin, SOVA_BUN: configured } })).command, configured);
	// A $SOVA_BUN that is not there is passed over.
	assert.equal(resolvePiLaunch(host({ ...node, env: { PATH: bin, SOVA_BUN: path.join(root, "gone") } })).command, onPath);
});

test("a mise shim on PATH is resolved once, from the host's cwd, never left to the worker's", { skip }, async (t) => {
	const { root, app, cli, bin, host } = await tree(t);
	const mise = await exe(path.join(root, "mise-install", "mise"));
	await symlink(mise, path.join(bin, "bun"));
	const realBun = await exe(path.join(root, "installs", "bun", "1.4.2", "bin", "bun"));
	const asked: string[] = [];
	const miseWhich = (m: string, name: string, cwd: string) => {
		asked.push(`${m} ${name} ${cwd}`);
		return realBun;
	};
	const node = { execPath: "/opt/runtime/node", bunVersion: undefined, miseWhich };
	assert.deepEqual(resolvePiLaunch(host(node)), { command: realBun, prefix: [...bunGuardFlags(), cli], via: "package" });
	assert.deepEqual(asked, [`${mise} bun ${app}`]);
	// The shim can't name one: no Bun, the host's runtime.
	assert.equal(resolvePiLaunch(host({ ...node, miseWhich: () => undefined })).command, "/opt/runtime/node");
});

test("a host that is pi re-runs its own script; a compiled pi re-runs itself", { skip }, async (t) => {
	const { cli, host } = await tree(t);
	assert.deepEqual(resolvePiLaunch(host({ currentScript: cli })), { command: "/opt/runtime/bun", prefix: [...bunGuardFlags(), cli], via: "pi-host" });
	assert.deepEqual(resolvePiLaunch(host({ currentScript: cli, execPath: "/opt/runtime/node", bunVersion: undefined })), {
		command: "/opt/runtime/node", prefix: [cli], via: "pi-host",
	});
	assert.deepEqual(resolvePiLaunch(host({ execPath: "/usr/local/bin/pi", bunVersion: undefined })), { command: "/usr/local/bin/pi", prefix: [], via: "pi-binary" });
	// Bun's compiled virtual script is never taken for a file.
	assert.equal(resolvePiLaunch(host({ currentScript: "/$bunfs/root/pi" })).via, "package");
});

test("$SOVA_PI_CLI wins: a script runs on Bun, anything else runs as it is", { skip }, async (t) => {
	const { root, host } = await tree(t);
	const script = path.join(root, "my-pi", "cli.mjs");
	assert.deepEqual(resolvePiLaunch(host({ env: { SOVA_PI_CLI: script } })), { command: "/opt/runtime/bun", prefix: [...bunGuardFlags(), script], via: "override" });
	assert.deepEqual(resolvePiLaunch(host({ env: { SOVA_PI_CLI: "/usr/local/bin/pi" } })), { command: "/usr/local/bin/pi", prefix: [], via: "override" });
	// Relative to the host's cwd, not a worker's.
	assert.equal(resolvePiLaunch(host({ env: { SOVA_PI_CLI: "tools/pi" } })).command, path.join(root, "app", "tools", "pi"));
});

test("without pi's package: `pi` from the host's PATH, absolute; bare only when there is none", { skip }, async (t) => {
	const { root, bin, host } = await tree(t);
	const noPackage = { moduleDir: path.join(root, "elsewhere"), currentScript: path.join(root, "elsewhere", "x.ts") };
	assert.deepEqual(resolvePiLaunch(host(noPackage)), { command: "pi", prefix: [], via: "bare" });
	const pi = await exe(path.join(bin, "pi"));
	assert.deepEqual(resolvePiLaunch(host(noPackage)), { command: pi, prefix: [], via: "path" });
	// A shim there is resolved in the host's cwd too.
	await rm(pi);
	const mise = await exe(path.join(root, "mise-install", "mise"));
	await symlink(mise, pi);
	const real = await exe(path.join(root, "node", "25", "bin", "pi"));
	assert.deepEqual(resolvePiLaunch(host({ ...noPackage, miseWhich: () => real })), { command: real, prefix: [], via: "path" });
});

test("this process resolves once and keeps it, whatever cwd asks", { skip }, () => {
	resetPiLaunch();
	const first = piLaunch();
	assert.equal(piLaunch(), first);
	// This checkout has pi's package, and the suite runs on Bun or Node: never a bare `pi`.
	assert.equal(first.via, "package");
	assert.ok(path.isAbsolute(first.command));
	const inv = getPiInvocation(["--mode", "rpc"]);
	assert.deepEqual(inv.args.slice(-2), ["--mode", "rpc"]);
	assert.match(inv.args[inv.args.length - 3], /cli\.js$/);
	resetPiLaunch();
});
