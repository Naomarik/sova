// Real pi startup: the extension loads and registers /explain, with no model request.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { cli, root } from "./runtime.mjs";

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
	child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
	const response = await deadline(commands, 30000, "extension startup");
	assert.equal(response.success, true);
	const explain = response.data.commands.find((c) => c.name === "explain");
	assert.ok(explain, "/explain must register");
	assert.ok(explain.description.startsWith("<topic>"), "the argument hint leads the description");
	assert.deepEqual(startupErrors, []);
	assert.equal(stderr.trim(), "", `Unexpected startup stderr: ${stderr}`);
	console.log("PASS: real pi loaded the extension and registered /explain.");
} finally {
	// Only signal the exact child captured above, never a process-name pattern.
	child.kill("SIGTERM");
	try {
		await deadline(closed, 5000, "pi shutdown");
	} catch {
		child.kill("SIGKILL");
		await deadline(closed, 5000, "forced pi shutdown");
	}
	if (process.platform === "linux") assert.equal(fs.existsSync(`/proc/${child.pid}`), false);
}
