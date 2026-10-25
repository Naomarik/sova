// Real Pi startup/teardown: the extension loads and registers /agents. (A live worker run is the chat-runtime trial's.)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
import path from "node:path";
import { cli, root } from "./runtime.mjs";

// Offline, never the host's agent dir or Claude directory: a throwaway home before anything under
// test loads (pi writes auth.json and models-store.json there). --live's model calls need the real one.
if (!process.argv.includes("--live")) await import("../../claude-code/tests/hermetic-env.mjs");

async function deadline(promise, ms, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

const child = spawn(
	process.execPath,
	[cli, "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "-e", path.join(root, "index.ts")],
	{ cwd: root, stdio: ["pipe", "pipe", "pipe"] },
);
const closed = once(child, "close");
let stderr = "";
let buffer = "";
const decoder = new StringDecoder("utf8");
const startupErrors = [];
child.stderr.on("data", (b) => {
	stderr += b.toString();
});
const commands = new Promise((resolve, reject) => {
	child.once("error", reject);
	child.once("close", () => reject(new Error(`Pi closed before RPC response: ${stderr}`)));
	child.stdout.on("data", (chunk) => {
		buffer += decoder.write(chunk);
		let n;
		while ((n = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, n);
			buffer = buffer.slice(n + 1);
			if (!line.trim()) continue;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				startupErrors.push(line);
				continue;
			}
			if (event.type === "extension_error") startupErrors.push(event.error);
			if (event.type === "response" && event.id === "commands") resolve(event);
		}
	});
});
try {
	child.stdin.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n");
	const response = await deadline(commands, 30000, "extension startup");
	assert.equal(response.success, true);
	assert.ok(
		response.data.commands.some((c) => c.name === "agents"),
		"/agents must register",
	);
	assert.deepEqual(startupErrors, []);
	assert.equal(stderr.trim(), "", `Unexpected startup stderr: ${stderr}`);
	console.log("PASS: real Pi loaded the extension and registered /agents.");
} finally {
	// Only signal the exact child captured above, never a process-name pattern.
	child.kill("SIGTERM");
	try {
		await deadline(closed, 5000, "Pi shutdown");
	} catch {
		child.kill("SIGKILL");
		await deadline(closed, 5000, "forced Pi shutdown");
	}
	if (process.platform === "linux") assert.equal(fs.existsSync(`/proc/${child.pid}`), false);
}

// A real model run of a worker needs Sova's server (a worker is a chat process it starts): that is the
// chat-runtime trial's (scripts/chat-runtime-trial, its worker checks), never this file's.
if (process.argv.includes("--live")) console.log("SKIP: --live moved to the chat-runtime trial (workers run as chat processes of Sova's server).");
