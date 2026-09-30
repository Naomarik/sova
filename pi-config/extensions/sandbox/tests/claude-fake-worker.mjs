#!/usr/bin/env node
// claude-fake-worker.mjs — NOT a suite. The `claude` a red-team shim puts first on PATH for the
// Claude W4 (claude-worker.mjs): the real subagents → claude-code runner → transport →
// confineLaunch path spawns THIS, confined, instead of the CLI. Before it serves the stream-json
// protocol (scripts/fake-claude.mjs, no model, no network), it records how it was launched and runs
// the probe battery (claude-probe-inner.mjs launcher, which also starts an MCP-style child), handing
// its fd 3 on as the CLI would read it. Results go to `<cwd>/.redteam-w4-result-<pid>.json`; the spec
// is `<cwd>/.redteam-w4-spec.json`. Node builtins only.
import { spawn } from "node:child_process";
import { existsSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");
const args = process.argv.slice(2);

if (args[0] === "--version") {
	process.stdout.write("0.0.0-redteam (Claude Code)\n");
	process.exit(0);
}

const specFile = path.join(process.cwd(), ".redteam-w4-spec.json");
if (existsSync(specFile)) {
	const fd3 = (() => { try { return readlinkSync("/proc/self/fd/3"); } catch { return null; } })();
	const battery = await new Promise((resolve) => {
		const stdio = ["ignore", "pipe", "pipe"];
		if (fd3) stdio.push(3);
		const c = spawn(process.execPath, [path.join(here, "claude-probe-inner.mjs"), "launcher", specFile], { stdio });
		let out = "";
		let err = "";
		c.stdout.on("data", (d) => (out += d));
		c.stderr.on("data", (d) => (err += d));
		c.on("error", (e) => resolve({ spawnError: String(e) }));
		c.on("close", () => { try { resolve(JSON.parse(out.trim().split("\n").at(-1))); } catch { resolve({ out: out.slice(0, 400), err: err.slice(0, 400) }); } });
	});
	writeFileSync(path.join(process.cwd(), `.redteam-w4-result-${process.pid}.json`), JSON.stringify({
		argv: args,
		envKeys: Object.keys(process.env).sort(),
		configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
		fd3,
		mntns: readlinkSync("/proc/self/ns/mnt"),
		battery,
	}));
}

// Serve the protocol exactly as the hermetic stand-in does.
await import(path.join(repo, "scripts/fake-claude.mjs"));
