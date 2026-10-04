// OPT-IN LIVE TEST — this one really does spend (small) model calls.
//
// Proves that a background fork (../fork/background.ts, the path /explain uses) reads the
// parent's warm prompt cache on its FIRST request. A throwaway parent pi (RPC mode, the agent
// dir's own extensions, so the prefix is a realistic one) answers a few one-word turns, then
// `/fork-probe` (tests/fork-probe.ts) starts one background fork with a one-word task. The parent's
// last request and the fork's first request are read from the two session JSONLs' usage.
//
//   PI_CODING_AGENT_DIR=<hermetic agent dir> node tests/fork-cache-live.mjs --model zai/glm-5.3
//   ... --model openai-codex/gpt-6-sol --thinking low
//   ... --model claude-code-cli/haiku --cwd <a dir whose Claude project dir is writable>   (real `claude`)
//
// The parent's first message carries a block unique to this run (--unique <chars>, default 16000,
// about 4k tokens), so a cache hit on it can only be the parent's own entry, never the system prompt
// every run shares. Everything lands in a temp directory that is deleted afterwards (--keep keeps it). Prints one
// JSON line, and fails when the fork's first request reads less than --min (default 0.8) of the
// tokens the parent's last request read from cache.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { packageDir } from "./runtime.mjs";

const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : fallback;
};
const model = arg("--model");
if (!model) throw new Error("--model <provider/id> is required");
const thinking = arg("--thinking", "low");
const turns = Number(arg("--turns", "2"));
const min = Number(arg("--min", "0.8"));
// A block no other request has ever sent: the system prompt and tools are the same in every run,
// so a hit on them proves nothing about THIS parent's cache. A fork that reads this block from
// cache read the parent's own entry.
const uniqueChars = Number(arg("--unique", "16000"));
const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let seed = [...nonce].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const syllables = ["ka", "lo", "mir", "tes", "van", "qu", "zor", "eli", "pan", "dru", "sef", "ob", "tri", "nel", "gas", "hu"];
let unique = "";
while (unique.length < uniqueChars) {
	seed = (seed * 1103515245 + 12345) >>> 0;
	unique += `${syllables[seed % 16]}${syllables[(seed >>> 4) % 16]}${syllables[(seed >>> 8) % 16]} `;
}
const firstPrompt = `Reference block ${nonce} (just keep it in context, do not summarize):\n${unique}\nReply with exactly OK0 and nothing else. Do not call any tool.`;
const keep = process.argv.includes("--keep");
const cli = path.join(packageDir, "dist/bundle/cli.js");
const probe = fileURLToPath(new URL("./fork-probe.ts", import.meta.url));

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fork-cache-live-")));
const sessions = path.join(work, "parent");
const forks = path.join(work, "forks");
fs.mkdirSync(sessions);
fs.mkdirSync(forks);
// A claude-code-cli model exists only once its provider registered at session_start: set it over
// RPC, the way the subagents runner does (rpcScopedModel).
const rpcModel = model.startsWith("claude-code-cli/");
const extra = (arg("--args", "") || "").split(" ").filter(Boolean);
if (rpcModel && !extra.includes("--claude-code-provider")) extra.push("--claude-code-provider");
const args = [cli, "--mode", "rpc", "--session-dir", sessions, ...(rpcModel ? [] : ["--model", model]), "--thinking", thinking, "-e", probe, ...extra];
const child = spawn(process.execPath, args, {
	cwd: arg("--cwd", work),
	env: { ...process.env, PI_FORK_PROBE_DIR: forks },
	stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (b) => {
	stderr += b;
});
const pending = new Map();
const notes = [];
let settles = 0;
let buffer = "";
const decoder = new StringDecoder("utf8");
child.stdout.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	let n;
	while ((n = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, n);
		buffer = buffer.slice(n + 1);
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "response" && pending.has(event.id)) {
			pending.get(event.id)(event);
			pending.delete(event.id);
		}
		if (event.type === "extension_ui_request" && event.method === "notify" && String(event.message).startsWith("FORK-PROBE")) notes.push(String(event.message));
		if (event.type === "agent_settled") settles++;
	}
});
const request = (id, body) =>
	new Promise((resolve) => {
		pending.set(id, resolve);
		child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
	});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, check, ms = 600_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = check();
		if (value) return value;
		if (child.exitCode !== null) throw new Error(`pi exited while waiting for ${label}: ${stderr}`);
		await sleep(500);
	}
	throw new Error(`timed out waiting for ${label}`);
}
const read = (file) =>
	fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
const assistants = (entries) => entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
const usage = (e) => e && { input: e.message.usage?.input ?? 0, cacheRead: e.message.usage?.cacheRead ?? 0, cacheWrite: e.message.usage?.cacheWrite ?? 0, output: e.message.usage?.output ?? 0, model: `${e.message.provider}/${e.message.model}`, stop: e.message.stopReason, error: e.message.errorMessage };
const jsonl = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));

let failed = false;
try {
	if (rpcModel) {
		const [provider, ...rest] = model.split("/");
		const set = await request("model", { type: "set_model", provider, modelId: rest.join("/") });
		if (!set.success) throw new Error(`set_model rejected: ${set.error}`);
	}
	for (let i = 0; i < turns; i++) {
		const before = settles;
		const answer = await request(`turn-${i}`, { type: "prompt", message: i === 0 && uniqueChars > 0 ? firstPrompt : `Reply with exactly OK${i} and nothing else. Do not call any tool.` });
		if (!answer.success) throw new Error(`prompt rejected: ${answer.error}`);
		await until(`turn ${i}`, () => settles > before);
	}
	const parentFile = await until("the parent session file", () => jsonl(sessions)[0]);
	const started = await request("probe", { type: "prompt", message: "/fork-probe" });
	if (!started.success) throw new Error(`/fork-probe rejected: ${started.error}`);
	const settled = await until("the fork to settle", () => notes.find((n) => n.startsWith("FORK-PROBE-SETTLED") || n.startsWith("FORK-PROBE-ERROR")));
	if (settled.startsWith("FORK-PROBE-ERROR")) throw new Error(settled);
	const result = JSON.parse(settled.slice("FORK-PROBE-SETTLED ".length));
	const forkFile = result.sessionFile ?? jsonl(result.sessionDir)[0];
	const parentEntries = read(parentFile);
	const forkEntries = read(forkFile);
	const parentIds = new Set(parentEntries.map((e) => e.id));
	const parentFirst = assistants(parentEntries)[0];
	const parentLast = assistants(parentEntries).at(-1);
	const forkFirst = assistants(forkEntries).find((e) => !parentIds.has(e.id));
	const report = {
		model,
		uniqueChars,
		parent: { sessionId: parentEntries[0].id, first: usage(parentFirst), last: usage(parentLast) },
		fork: { sessionId: forkEntries[0].id, first: usage(forkFirst), outcome: result.outcome, error: result.error, claudeFork: result.claudeFork },
		cacheEntry: forkEntries.find((e) => e.type === "custom" && e.customType === "sova-fork-cache")?.data,
	};
	// The parent's own second turn must have read its unique block back, or there is no warm parent
	// entry to compare against: inconclusive, not a pass.
	report.parentWarm = (report.parent.last?.cacheRead ?? 0) > (report.parent.first?.cacheRead ?? 0);
	const want = (report.parent.last?.cacheRead ?? 0) * min;
	report.pass = report.parentWarm && result.outcome === "success" && !!forkFirst && report.fork.first.cacheRead > 0 && report.fork.first.cacheRead >= want;
	console.log(JSON.stringify(report));
	failed = !report.pass;
	if (!report.parentWarm) console.error("INCONCLUSIVE: the parent's own second turn did not read its first turn back from cache");
} finally {
	child.kill("SIGTERM");
	await sleep(2000);
	if (child.exitCode === null) child.kill("SIGKILL");
	if (keep) console.error(`kept ${work}`);
	else fs.rmSync(work, { recursive: true, force: true });
}
if (failed) {
	console.error("FAIL: the fork's first request did not read the parent's warm prefix from cache");
	process.exit(1);
}
