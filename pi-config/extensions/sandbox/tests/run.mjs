// run.mjs — the red-team runner: every suite, in dependency order, with a per-suite verdict and a
// final artifact sweep. Usage: node tests/run.mjs [--no-naive]

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import path from "node:path";
import { ARTIFACT_ROOT, TESTS_DIR } from "./harness.mjs";

const noNaive = process.argv.includes("--no-naive");
const suites = [
	...(noNaive ? [] : ["naive.mjs"]),
	"contract.mjs",
	"off-equals-stock.mjs",
	"runtime-escapes.mjs",
	"midflight.mjs",
	"worker-inheritance.mjs",
];

const results = [];
for (const file of suites) {
	console.log(`\n═══ ${file} ═══`);
	const started = Date.now();
	const r = spawnSync(process.execPath, [path.join(TESTS_DIR, file)], { stdio: "inherit", env: process.env, timeout: 10 * 60_000 });
	const status = r.status ?? (r.error ? `killed: ${r.error.message}` : "unknown");
	results.push({ file, status, ms: Date.now() - started });
	if (r.error || r.status !== 0) console.log(`─── ${file}: FAILED (status ${status})`);
}

console.log("\n═══ summary ═══");
let bad = 0;
for (const r of results) {
	console.log(`${r.status === 0 ? "PASS" : "FAIL"}  ${r.file} (${(r.ms / 1000).toFixed(1)}s, exit ${r.status})`);
	if (r.status !== 0) bad++;
}

// Final artifact sweep: every fixture should already be gone; drop anything left.
try {
	const left = existsSync(ARTIFACT_ROOT) ? readdirSync(ARTIFACT_ROOT) : [];
	if (left.length) console.log(`cleanup sweep: artifacts left behind: ${left.join(", ")}`);
	else rmdirSync(ARTIFACT_ROOT);
} catch {}

process.exitCode = bad > 0 ? 1 : 0;
