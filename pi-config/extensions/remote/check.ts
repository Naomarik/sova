#!/usr/bin/env node
/**
 * Verify a target entry end to end through the SAME argv builder the remote extension and Sova use.
 *
 *   node check.ts <entry.json | -> [--registry targets.json] [--cmd 'shell code'] [--list PATH] [--timeout S]
 *
 * <entry.json> holds ONE target object (the would-be entry), `-` reads it from stdin. `--registry`
 * resolves `via` against an existing targets.json (default: $PI_CODING_AGENT_DIR or ~/.pi/agent).
 * Default command: the probe (user, hostname, $HOME, cwd, tools). Prints validation errors, the
 * argv, wall time, exit code, stdout and stderr. Exit 0 only if the entry is valid and the command
 * succeeded. Changes nothing, locally or remotely (unless --cmd does).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildListDirsArgv, buildTargetArgv, parseListDirsOutput, parseTargetsFile, shJoin, type Target, targetsFilePath, validateTarget } from "./argv.ts";
import { runArgv } from "./exec.ts";

const PROBE = [
	`echo "user=$(id -un)"`,
	`echo "hostname=$(uname -n)"`,
	`echo "home=$HOME"`,
	`echo "pwd=$(pwd)"`,
	`for t in docker node npm git rg pi incus; do printf '%s=%s\\n' "$t" "$(command -v "$t" || echo -)"; done`,
	`for s in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server; do [ -x "$s" ] && echo "sftp-server=$s"; done; true`,
].join("\n");

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
	const src = process.argv[2];
	if (!src || src.startsWith("--")) {
		console.error("usage: node check.ts <entry.json | -> [--registry targets.json] [--cmd 'shell code'] [--list PATH] [--timeout S]");
		process.exit(2);
	}
	const entry = JSON.parse(readFileSync(src === "-" ? 0 : src, "utf8")) as Target;
	const errors = validateTarget(entry);
	if (errors.length) {
		console.log(`INVALID entry:\n  - ${errors.join("\n  - ")}`);
		process.exit(1);
	}
	const agentDir = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
	const registryFile = arg("--registry") ?? targetsFilePath(agentDir);
	let registry: Target[] = [];
	if (entry.via) {
		registry = parseTargetsFile(readFileSync(registryFile, "utf8")).targets;
	}
	registry = [...registry.filter((t) => t.name !== entry.name), entry];
	const list = arg("--list");
	const argv = list !== undefined ? buildListDirsArgv(entry, list, registry) : buildTargetArgv(entry, { command: arg("--cmd") ?? PROBE, registry });
	console.log(`argv: ${shJoin(argv)}`);
	const t0 = performance.now();
	const r = await runArgv(argv, { timeoutMs: Number(arg("--timeout") ?? 30) * 1000 });
	const ms = Math.round(performance.now() - t0);
	console.log(`time: ${ms} ms${r.timedOut ? " (TIMED OUT)" : ""}\nexit: ${r.exitCode}`);
	const out = r.stdout.toString("utf8");
	if (list !== undefined) {
		const parsed = parseListDirsOutput(out);
		console.log(parsed ? `path: ${parsed.path}\ndirs: ${parsed.dirs.join("  ")}` : `no listing\n${out}`);
	} else if (out) console.log(`--- stdout\n${out.trimEnd()}`);
	if (r.stderr.trim()) console.log(`--- stderr\n${r.stderr.trimEnd()}`);
	process.exit(r.exitCode === 0 ? 0 : 1);
}

main().catch((e: Error) => {
	console.error(e.message);
	process.exit(2);
});
