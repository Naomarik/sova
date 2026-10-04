#!/usr/bin/env node
// Node vs Bun: cold start + run time of the spec tools, spec hooks, worker host and team MCP server,
// invoked with the same argv the server/extensions use (process.execPath + script + args).
// Usage: node scripts/bun-bench-tools.mjs [--runs N] [--out DIR] [--only name,name]
// Runs are interleaved node/bun to spread machine-load drift evenly; one warmup each is discarded.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const RUNS = Number(arg("--runs", "15"));
const OUT = path.resolve(arg("--out", "/tmp/sova-bun-bench/tools"));
const ONLY = arg("--only", "")?.split(",").filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });

const NODE = process.execPath;
const BUN = process.env.BUN_BIN || path.join(execFileSync("mise", ["where", "bun@latest"], { encoding: "utf8" }).trim(), "bin", "bun");
const runtimes = { node: NODE, bun: BUN };
const core = path.join(root, "pi-config/extensions/spec/core");
const hooks = path.join(root, "pi-config/extensions/claude-code/spec-hooks.ts");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const HEAD = git("rev-parse", "HEAD");
const BASE = git("rev-parse", "HEAD~10");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sova-bun-bench-"));

// Hook state seeded once (node, one turn) and copied fresh per run so every run sees the same state.
const seed = path.join(tmp, "hook-seed");
fs.mkdirSync(seed);
const hookInput = (event, extra = {}) => JSON.stringify({ session_id: "bench-session", cwd: root, hook_event_name: event, ...extra });
spawnSync(NODE, [hooks, "turn", "--core", core, "--state", seed], { input: hookInput("UserPromptSubmit", { prompt: "bench" }), cwd: root });
const hookCase = (event, input) => ({
	name: `hook:${event}`,
	argv: (state) => [hooks, event, "--core", core, "--state", state],
	stdin: input,
	setup: () => { const d = fs.mkdtempSync(path.join(tmp, "st-")); fs.cpSync(seed, d, { recursive: true }); return d; },
});

const cases = [
	{ name: "bare -e 0", argv: () => ["-e", "0"] },
	{ name: "spec check", argv: () => [path.join(core, "sova-spec.mjs"), "check", "--root", root, "--json"] },
	{ name: "spec packet", argv: () => [path.join(core, "sova-spec.mjs"), "packet", "§workspace.groups/decisions", "--budget", "12000", "--root", root, "--json"] },
	{ name: "spec impact", argv: () => [path.join(core, "sova-spec.mjs"), "impact", "§chat.composer/behavior", "--root", root, "--json"] },
	// worktrees/spec.ts mergeSpecReport
	{ name: "spec foreign (merge report)", argv: () => [path.join(core, "sova-spec.mjs"), "foreign", "--base", BASE, "--head", HEAD, "--landing", "--drafts", root, "--root", root, "--json"] },
	// server/spec-draft-writer.ts runDraftTool (read-only verbs; NO_COLOR as the server sets it)
	{ name: "draft check", argv: () => [path.join(core, "sova-spec-draft.mjs"), "check", "server-runtime", "--root", root, "--json"], env: { NO_COLOR: "1" } },
	{ name: "draft status", argv: () => [path.join(core, "sova-spec-draft.mjs"), "status", "server-runtime", "--root", root, "--json"], env: { NO_COLOR: "1" } },
	// mode/spec-assessment.ts callAssessment
	{ name: "assess status", argv: () => [path.join(core, "sova-spec-assess.mjs"), "status", "--owner-session", "bench-session", "--root", root, "--json"] },
	hookCase("turn", hookInput("UserPromptSubmit", { prompt: "bench" })),
	hookCase("pre", hookInput("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } })),
	hookCase("post", hookInput("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "x", stderr: "", interrupted: false } })),
	hookCase("stop", hookInput("Stop", { stop_hook_active: false, last_assistant_message: "done" })),
	{ name: "worker host (to hello)", ready: hostReady },
	{ name: "team MCP (to initialize reply)", ready: mcpReady },
].filter((c) => !ONLY?.length || ONLY.includes(c.name));

function runOnce(c, exe) {
	const state = c.setup?.();
	const t0 = process.hrtime.bigint();
	const r = spawnSync(exe, c.argv(state), { cwd: root, input: c.stdin ?? "", env: { ...process.env, ...c.env }, maxBuffer: 64 << 20, timeout: 120_000 });
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	return { ms, exit: r.status, signal: r.signal, stdout: String(r.stdout).replaceAll(state ?? "\0", "<STATE>"), stderr: String(r.stderr) };
}

// Worker host: write a spawn spec (worker = sleep 30), start host.ts detached as host-transport.ts does, time until the
// attached socket says hello, then signal the worker and release.
async function hostReady(exe) {
	const d = fs.mkdtempSync(path.join(tmp, "host-"));
	const f = (n) => path.join(d, n);
	const spec = { v: 1, command: "sleep", args: ["30"], cwd: d, sock: f("h.sock"), outLog: f("out.jsonl"), statusFile: f("status.json"), hostInfoFile: f("host.json"), inLog: f("in.jsonl"), lingerMs: 0, orphanTtlMs: 5000 };
	fs.writeFileSync(f("spawn.json"), JSON.stringify(spec));
	const t0 = process.hrtime.bigint();
	const logFd = fs.openSync(f("host.log"), "a");
	const host = spawn(exe, [path.join(root, "pi-config/extensions/subagents/host.ts"), f("spawn.json")], { cwd: d, detached: true, stdio: ["ignore", logFd, logFd] });
	fs.closeSync(logFd);
	let exited = false; host.on("exit", () => { exited = true; });
	const hello = await new Promise((resolve) => {
		const tryConnect = () => {
			if (exited) return resolve(undefined);
			const s = net.connect(spec.sock);
			let buf = "";
			s.on("data", (b) => { buf += b; const nl = buf.indexOf("\n"); if (nl >= 0) { resolve({ line: buf.slice(0, nl), s }); } });
			s.on("connect", () => s.write(JSON.stringify({ type: "attach", offset: 0 }) + "\n"));
			s.on("error", () => setTimeout(tryConnect, 1));
		};
		tryConnect();
	});
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	let stdout = "";
	if (hello) {
		const j = JSON.parse(hello.line);
		stdout = JSON.stringify(Object.keys(j).sort()) + " t=" + j.t;
		hello.s.write(JSON.stringify({ type: "signal", sig: "SIGKILL" }) + "\n");
		hello.s.write(JSON.stringify({ type: "release" }) + "\n");
		hello.s.end();
	}
	await new Promise((r) => (exited ? r() : host.once("exit", r)));
	return { ms, exit: hello ? 0 : 1, stdout, stderr: fs.readFileSync(f("host.log"), "utf8").replace(/\d+/g, "N") };
}

// Team MCP server: a member context in a scratch team dir, one initialize request, time to the reply line.
async function mcpReady(exe) {
	const d = fs.mkdtempSync(path.join(tmp, "team-"));
	const env = { ...process.env, PI_SUBAGENTS_TEAM_MEMBER: JSON.stringify({ version: 1, teamId: "team_99", teamName: "bench", workerId: "ag_01", role: "bench", orchestrator: false, dir: d }) };
	const t0 = process.hrtime.bigint();
	const p = spawn(exe, [path.join(root, "pi-config/extensions/subagents/member-mcp.ts")], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
	let err = ""; p.stderr.on("data", (b) => { err += b; });
	p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "0" } } }) + "\n");
	const line = await new Promise((resolve) => {
		let buf = "";
		p.stdout.on("data", (b) => { buf += b; const nl = buf.indexOf("\n"); if (nl >= 0) resolve(buf.slice(0, nl)); });
		p.on("exit", () => resolve(undefined));
	});
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	p.stdin.end();
	await new Promise((r) => (p.exitCode !== null ? r() : p.once("exit", r)));
	return { ms, exit: line ? 0 : 1, stdout: line ?? "", stderr: err };
}

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const round = (x) => Math.round(x * 10) / 10;
const results = [];
for (const c of cases) {
	const samples = { node: [], bun: [] };
	const first = {};
	const varied = { node: false, bun: false };
	const exits = { node: new Set(), bun: new Set() };
	for (let i = -1; i < RUNS; i++) {
		for (const rt of i % 2 ? ["node", "bun"] : ["bun", "node"]) {
			const r = c.ready ? await c.ready(runtimes[rt]) : runOnce(c, runtimes[rt]);
			if (i < 0) { first[rt] = r; continue; } // warmup: kept for the output diff only
			samples[rt].push(r.ms);
			exits[rt].add(r.exit);
			if (r.stdout !== first[rt].stdout) varied[rt] = true;
		}
	}
	const slug = c.name.replace(/[^a-z0-9]+/gi, "_");
	for (const rt of ["node", "bun"]) {
		fs.writeFileSync(path.join(OUT, `${slug}.${rt}.stdout`), first[rt].stdout);
		fs.writeFileSync(path.join(OUT, `${slug}.${rt}.stderr`), first[rt].stderr);
	}
	const row = {
		name: c.name,
		argv: c.argv ? c.argv("<STATE>").map((a) => a.replace(root, "<root>")) : undefined,
		identicalStdout: first.node.stdout === first.bun.stdout,
		stdoutBytes: { node: first.node.stdout.length, bun: first.bun.stdout.length },
		stdoutVariesAcrossRuns: varied,
		exits: { node: [...exits.node], bun: [...exits.bun] },
		node: { median: round(q(samples.node, 0.5)), p90: round(q(samples.node, 0.9)), min: round(Math.min(...samples.node)) },
		bun: { median: round(q(samples.bun, 0.5)), p90: round(q(samples.bun, 0.9)), min: round(Math.min(...samples.bun)) },
		samples,
	};
	row.speedup = Math.round((row.node.median / row.bun.median) * 100) / 100;
	results.push(row);
	console.log(`${c.name.padEnd(32)} node ${String(row.node.median).padStart(7)} (p90 ${row.node.p90})  bun ${String(row.bun.median).padStart(7)} (p90 ${row.bun.p90})  x${row.speedup}  same=${row.identicalStdout} exits n=${row.exits.node} b=${row.exits.bun}`);
}
const meta = { at: new Date().toISOString(), runs: RUNS, node: process.version, bun: execFileSync(BUN, ["--version"], { encoding: "utf8" }).trim(), head: HEAD, base: BASE, loadavg: os.loadavg(), cpus: os.cpus().length };
fs.writeFileSync(path.join(OUT, "tools.json"), JSON.stringify({ meta, results }, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${OUT}/tools.json; load ${os.loadavg().map((x) => x.toFixed(1)).join(" ")}`);
