#!/usr/bin/env node
// Node vs Bun: cold start + run time of the spec tools,
// invoked with the same argv the server/extensions use (process.execPath + script + args).
// Usage: node scripts/bun-bench-tools.mjs [--runs N] [--out DIR] [--only name,name]
// Runs are interleaved node/bun to spread machine-load drift evenly; one warmup each is discarded.
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
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
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const HEAD = git("rev-parse", "HEAD");
const BASE = git("rev-parse", "HEAD~10");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sova-bun-bench-"));

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
].filter((c) => !ONLY?.length || ONLY.includes(c.name));

function runOnce(c, exe) {
	const state = c.setup?.();
	const t0 = process.hrtime.bigint();
	const r = spawnSync(exe, c.argv(state), { cwd: root, input: c.stdin ?? "", env: { ...process.env, ...c.env }, maxBuffer: 64 << 20, timeout: 120_000 });
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	return { ms, exit: r.status, signal: r.signal, stdout: String(r.stdout).replaceAll(state ?? "\0", "<STATE>"), stderr: String(r.stderr) };
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
