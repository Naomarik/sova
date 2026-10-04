#!/usr/bin/env node
// Run test files one by one on Node (tsx --test, as `pnpm test`) and Bun (`bun test`), each runtime in its own
// fresh HOME set in the environment (Bun's os.homedir() ignores the in-process HOME switch of hermetic-env.mjs).
// Usage: node scripts/bun-bench-perfile.mjs --files list.txt [--jobs 6] [--timeout 240] [--out file.json]
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const files = fs.readFileSync(arg("--files"), "utf8").split("\n").filter(Boolean);
const JOBS = Number(arg("--jobs", "6"));
const TIMEOUT = Number(arg("--timeout", "240")) * 1000;
const OUT = arg("--out", "/tmp/sova-bun-bench/perfile.json");
const only = arg("--runtimes", "node,bun").split(",");
const BUN = process.env.BUN_BIN || path.join(execFileSync("mise", ["where", "bun@latest"], { encoding: "utf8" }).trim(), "bin", "bun");
const preload = "./pi-config/extensions/claude-code/tests/hermetic-env.mjs";
const DROP = ["PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_SESSIONS_DIR", "CLAUDE_CONFIG_DIR", "SOVA_EXTENSIONS_FILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "SOVA_DEVICE_ID", "SOVA_MESH_IDENTITY", "SOVA_CLAUDE_ACCOUNTS_DEV"];

const cmd = {
	node: (f) => [path.join(root, "node_modules/.bin/tsx"), ["--import", preload, "--test", f]],
	bun: (f) => [BUN, ["test", "--timeout=60000", "--preload", preload, `./${f}`]],
};
const counts = {
	node: (s) => ({ pass: +(s.match(/^ℹ pass (\d+)/m)?.[1] ?? NaN), fail: +(s.match(/^ℹ fail (\d+)/m)?.[1] ?? NaN), skip: +(s.match(/^ℹ skipped (\d+)/m)?.[1] ?? NaN) }),
	bun: (s) => ({ pass: +(s.match(/^\s*(\d+) pass/m)?.[1] ?? NaN), fail: +(s.match(/^\s*(\d+) fail/m)?.[1] ?? NaN), skip: +(s.match(/^\s*(\d+) skip/m)?.[1] ?? 0) }),
};
const firstError = (rt, s) => {
	const lines = s.split("\n");
	const i = rt === "node" ? lines.findIndex((l) => /^\s*(error|Error|AssertionError|TypeError)|^\s+\w*Error \[/.test(l) || /^\s*'?(Expected|The input)/.test(l)) : lines.findIndex((l) => /^(error|\w*Error):/.test(l.trim()));
	return i >= 0 ? lines[i].trim().slice(0, 300) : undefined;
};

function runOne(rt, f) {
	// The layout hermetic-env.mjs adopts as is when SOVA_TEST_HOME is set and HOME is its home/.
	const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sova-bun-perfile-"));
	const home = path.join(testRoot, "home");
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	const env = { ...process.env, HOME: home, SOVA_TEST_HOME: testRoot, NO_COLOR: "1", FORCE_COLOR: "0" };
	for (const k of DROP) delete env[k];
	const [exe, args] = cmd[rt](f);
	return new Promise((resolve) => {
		const t0 = process.hrtime.bigint();
		const p = spawn(exe, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let out = "";
		p.stdout.on("data", (b) => { out += b; });
		p.stderr.on("data", (b) => { out += b; });
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, "SIGKILL"); } catch {} }, TIMEOUT);
		p.on("close", (code) => {
			clearTimeout(timer);
			const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
			try { process.kill(-p.pid, "SIGKILL"); } catch {}
			fs.rmSync(testRoot, { recursive: true, force: true });
			const logDir = path.join(path.dirname(OUT), "perfile-logs");
			fs.mkdirSync(logDir, { recursive: true });
			fs.writeFileSync(path.join(logDir, `${f.replace(/\//g, "__")}.${rt}.log`), out);
			resolve({ rt, file: f, ms, code, timedOut, ...counts[rt](out), firstError: firstError(rt, out) });
		});
	});
}

const queue = files.flatMap((f) => only.map((rt) => [rt, f]));
const results = [];
await Promise.all(Array.from({ length: JOBS }, async () => {
	while (queue.length) {
		const [rt, f] = queue.shift();
		const r = await runOne(rt, f);
		results.push(r);
		console.log(`${rt.padEnd(4)} ${String(r.ms).padStart(7)}ms exit=${r.code}${r.timedOut ? " TIMEOUT" : ""} pass=${r.pass} fail=${r.fail} ${f}${r.fail ? "  | " + (r.firstError ?? "") : ""}`);
	}
}));
fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), loadavg: os.loadavg(), results }, null, 1));
