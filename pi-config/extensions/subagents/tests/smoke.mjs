// Real Pi startup/teardown. --live provider/model additionally makes two small model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
import path from "node:path";
import { cli, jiti, root } from "./runtime.mjs";

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

const liveIndex = process.argv.indexOf("--live");
if (liveIndex >= 0) {
	const model = process.argv[liveIndex + 1];
	assert.ok(model?.includes("/"), "Usage: node tests/smoke.mjs --live provider/model");
	const { SubagentRunner } = await jiti.import(path.join(root, "runner.ts"));
	// The runner normally executes inside Pi; give its CLI reinvocation logic that same argv.
	const oldScript = process.argv[1];
	process.argv[1] = cli;
	let trackedChild;
	let resolveSettled;
	let settled = new Promise((resolve) => {
		resolveSettled = resolve;
	});
	const runner = new SubagentRunner(
		{
			id: "smoke",
			groupId: "smoke",
			name: "smoke",
			cwd: root,
			model,
			effort: "off",
			tools: [],
			task: "Reply with exactly SUBAGENT_SMOKE_FIRST and no other text.",
			spawnImpl(command, args, options) {
				trackedChild = spawn(command, args, options);
				return trackedChild;
			},
		},
		{ onChange() {}, onExit() {}, onSettled: () => resolveSettled() },
	);
	process.argv[1] = oldScript;
	try {
		await deadline(settled, 90000, "first task");
		assert.equal(runner.taskOutcome, "success", runner.error);
		assert.equal(runner.finalOutput().trim(), "SUBAGENT_SMOKE_FIRST");
		assert.ok(runner.sessionId);
		assert.ok(runner.sessionFile);
		assert.ok(fs.statSync(runner.sessionFile).isFile(), "child session must actually be persisted");
		settled = new Promise((resolve) => {
			resolveSettled = resolve;
		});
		const accepted = await runner.steer("Reply with exactly SUBAGENT_SMOKE_SECOND and no other text.");
		assert.equal(accepted.ok, true, accepted.reason);
		await deadline(settled, 90000, "steered task");
		assert.equal(runner.taskOutcome, "success", runner.error);
		assert.equal(runner.finalOutput().trim(), "SUBAGENT_SMOKE_SECOND");
		await deadline(runner.kill("smoke test complete"), 10000, "worker kill");
		assert.equal(runner.status, "killed");
		console.log(
			`PASS: real model task, idle steering, fresh output, persisted session, and awaited shutdown (${model}).`,
		);
	} finally {
		try {
			await deadline(runner.dispose(), 10000, "worker cleanup");
		} finally {
			if (trackedChild && trackedChild.exitCode === null && trackedChild.signalCode === null) {
				const stopped = once(trackedChild, "close");
				trackedChild.kill("SIGKILL");
				await deadline(stopped, 5000, "emergency cleanup");
			}
			if (trackedChild && process.platform === "linux") assert.equal(fs.existsSync(`/proc/${trackedChild.pid}`), false);
		}
	}
}
