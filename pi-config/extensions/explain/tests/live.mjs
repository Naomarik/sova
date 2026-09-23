// OPT-IN LIVE TEST — this one really does spend model calls.
//
// It drives a real /explain end to end: a throwaway persisted pi session in a
// temp directory and a temp session directory (never an existing session),
// one forked child, and the real store at ~/.pi/agent/explanations. The page it
// produces is left behind on purpose — that artifact is the point.
//
//   node tests/live.mjs                                   default model, topic "exponential backoff"
//   node tests/live.mjs --model zai/glm-5.2 --topic "..."
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { cli, jiti, root } from "./runtime.mjs";

const { explanationsRoot, slugify } = await jiti.import(path.join(root, "store.ts"));

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : fallback;
}

const topic = arg("--topic", "exponential backoff");
/** Keep the throwaway session file instead of deleting it, so the appended entry can be inspected. */
const keepSession = process.argv.includes("--keep-session");
const model = arg("--model", undefined);
const timeoutMs = Number(arg("--timeout", "900")) * 1000;

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "explain-live-"));
const sessionDir = path.join(workdir, "sessions");
fs.mkdirSync(sessionDir);
const store = explanationsRoot();
const before = new Set(fs.existsSync(store) ? fs.readdirSync(store) : []);

const args = [cli, "--mode", "rpc", "--no-extensions", "-e", path.join(root, "index.ts"), "--session-dir", sessionDir];
if (model) args.push("--model", model);
// The parent takes --session-dir, but its forked CHILDREN inherit this process's
// environment and would otherwise write their own sessions into the real
// ~/.pi/agent/sessions (keyed by a /tmp cwd that is deleted below). The env var
// isolates them into the same throwaway directory; --session-dir still wins for
// the parent, so both land here.
const child = spawn(process.execPath, args, {
	cwd: workdir,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: sessionDir },
});
const closed = once(child, "close");
let stderr = "";
child.stderr.on("data", (b) => {
	stderr += b.toString();
});

const pending = new Map();
const events = [];
const assistantTexts = [];
let buffer = "";
const decoder = new StringDecoder("utf8");
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
			continue;
		}
		events.push(line);
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = typeof event.message.content === "string" ? event.message.content : (event.message.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("");
			if (text.trim()) assistantTexts.push(text.trim());
		}
		if (event.type === "response" && pending.has(event.id)) {
			pending.get(event.id)(event);
			pending.delete(event.id);
		}
	}
});

function request(id, body, ms = 60000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${body.type} timed out`)), ms);
		pending.set(id, (event) => {
			clearTimeout(timer);
			resolve(event);
		});
		child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, check) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		if (child.exitCode !== null) throw new Error(`pi exited while waiting for ${label}: ${stderr}`);
		await sleep(1000);
	}
	throw new Error(`timed out waiting for ${label}`);
}

const entryLines = (file) =>
	fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.includes('"explain-doc"'));

try {
	const state = await request("state", { type: "get_state" });
	assert.equal(state.success, true);
	console.log(`parent model   : ${state.data.model?.provider}/${state.data.model?.id}\ncwd            : ${workdir}`);

	// A slash command persists nothing on its own, so a brand-new session has no
	// file to fork. One tiny real turn first, so this exercises the FORKED path.
	const seeded = await request("seed", { type: "prompt", message: "Reply with exactly OK and nothing else." }, 120000);
	assert.equal(seeded.success, true, `seed prompt rejected: ${seeded.error}`);
	const sessionFile = await waitFor("the parent session file", () => {
		const files = fs.readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(sessionDir, name));
		return files.find((file) => fs.statSync(file).size > 0);
	});
	console.log(`parent session : ${sessionFile}`);

	const started = Date.now();
	const accepted = await request("explain", { type: "prompt", message: `/explain ${topic}` });
	assert.equal(accepted.success, true, `/explain was rejected: ${accepted.error}`);

	const dir = await waitFor("the store directory", () => {
		const fresh = fs.readdirSync(store).filter((name) => !before.has(name) && name.startsWith(slugify(topic)));
		return fresh.length ? path.join(store, fresh[0]) : undefined;
	});
	console.log(`store dir      : ${dir}`);

	const forkMarker = events.find((line) => line.includes("Explaining") && line.includes("forked"));
	assert.ok(forkMarker, "the command should report how the child was started");
	assert.ok(!forkMarker.includes("not on disk yet"), `the child should have forked a persisted parent: ${forkMarker}`);
	console.log(`child start    : ${/\((forked|fresh)[^)]*\)/.exec(forkMarker)?.[0] ?? "?"}`);

	await waitFor("index.html", () => fs.existsSync(path.join(dir, "index.html")) && fs.statSync(path.join(dir, "index.html")).size > 0);
	await waitFor("meta.json", () => fs.existsSync(path.join(dir, "meta.json")));
	// The running entry lands at spawn; wait for the final one (same id, no status).
	const lines = await waitFor("the final explain-doc entry", () => {
		const found = entryLines(sessionFile);
		return found.some((line) => !line.includes('"status":"running"')) ? found : undefined;
	});
	assert.ok(lines.some((line) => line.includes('"status":"running"')), "the running entry should precede the final one");

	const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
	const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
	console.log(`elapsed        : ${Math.round((Date.now() - started) / 1000)}s`);
	// Bytes, not string length: multi-byte characters made an earlier report undercount.
	console.log(`index.html     : ${Buffer.byteLength(html, "utf8")} bytes (${html.length} chars), ${[...html.matchAll(/<script\b/gi)].length} script(s), ${[...html.matchAll(/<svg\b/gi)].length} svg(s)`);
	console.log(`\n--- meta.json ---\n${JSON.stringify(meta, null, 2)}`);
	console.log(`\n--- explain-doc entries in the parent session ---\n${lines.join("\n")}`);
	console.log(`\n--- files in the store dir ---\n${fs.readdirSync(dir).join("\n")}`);
	const reply = await waitFor("the parent's wake reply", () => assistantTexts.find((text) => text.includes(dir)));
	console.log(`\n--- the parent's wake reply ---\n${reply}`);
	console.log(`\nPASS: live /explain wrote a page and recorded it. Artifact kept at ${dir}`);
	if (keepSession) {
		const kept = path.join(os.homedir(), `explain-live-session-${path.basename(dir)}.jsonl`);
		fs.copyFileSync(sessionFile, kept);
		console.log(`parent session JSONL kept at ${kept} (${entryLines(kept).length} explain-doc entr(y|ies))`);
	}
} finally {
	child.kill("SIGTERM");
	await Promise.race([closed, sleep(5000)]);
	if (child.exitCode === null) child.kill("SIGKILL");
	// The session lives in the temp workdir; --keep-session copies it out above.
	fs.rmSync(workdir, { recursive: true, force: true });
}
