// Detached workers nobody adopted: the hosted-workers registry as host.ts and hosting.ts write it,
// read by hosted.ts. The real host.ts runs a fake worker for the llm.json writer.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readUnadoptedWorkers } from "./hosted.ts";
import { procStartTime } from "../subagents/workers-dir.ts";

const HOST = fileURLToPath(new URL("../subagents/host.ts", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "llm-inflight-hosted-"));
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;
const counts = (active: number, extra = {}) => ({ v: 1, producer: "worker-a", active, approximate: 0, claudeTurns: 0, degraded: false, folded: [], at: 1, ...extra });

function worker(root: string, owner: string, id: string, meta: Record<string, unknown>) {
	const dir = path.join(root, owner, id);
	fs.mkdirSync(dir, { recursive: true });
	write(path.join(dir, "meta.json"), { v: 1, id, state: "running", hostPid: process.pid, pidStartTime: procStartTime(process.pid), ...meta });
	return dir;
}

test("unadopted, live, reported: counted once from llm.json; adopted (lock live, this process included): skipped; lock of a dead manager: unadopted again", () => {
	const root = tmp();
	const dir = worker(root, "owner1", "ag_01", {});
	write(path.join(dir, "llm.json"), counts(2, { folded: ["grandchild"] }));
	assert.deepEqual(readUnadoptedWorkers(root), [
		{ key: "owner1/ag_01", producer: "worker-a", counts: { active: 2, approximate: 0, claudeTurns: 0, degraded: false }, folded: ["grandchild"] },
	]);
	write(path.join(dir, "adopt.lock"), { pid: process.pid, startTime: procStartTime(process.pid) });
	assert.deepEqual(readUnadoptedWorkers(root), [], "adopted: its manager's own count has it");
	write(path.join(dir, "adopt.lock"), { pid: deadPid() });
	assert.equal(readUnadoptedWorkers(root).length, 1, "the manager died: nobody counts it but this");
	fs.rmSync(root, { recursive: true, force: true });
});

test("no report (a Claude Code worker, an old host): unknown, never 0; dead host, exited worker, junk: nothing", () => {
	const root = tmp();
	worker(root, "o", "claude", { backend: "claude-code" });
	worker(root, "o", "deadhost", { hostPid: deadPid() });
	worker(root, "o", "reused", { pidStartTime: 1 });
	worker(root, "o", "exited", { state: "exited" });
	fs.mkdirSync(path.join(root, "o", "junk"), { recursive: true });
	fs.mkdirSync(path.join(root, "dead", "x"), { recursive: true });
	assert.deepEqual(readUnadoptedWorkers(root), [{ key: "o/claude", counts: null }]);
	assert.deepEqual(readUnadoptedWorkers(path.join(root, "missing")), []);
	fs.rmSync(root, { recursive: true, force: true });
});

test("re-reads only what changed: a new llm.json is seen", () => {
	const root = tmp();
	const dir = worker(root, "o", "w", {});
	write(path.join(dir, "llm.json"), counts(1));
	assert.equal(readUnadoptedWorkers(root)[0]?.counts?.active, 1);
	fs.writeFileSync(path.join(dir, "llm.json"), JSON.stringify(counts(3)) + " ");
	assert.equal(readUnadoptedWorkers(root)[0]?.counts?.active, 3);
	fs.rmSync(root, { recursive: true, force: true });
});

test("host.ts keeps the worker's latest report in llm.json, never a token line, and 0 once the worker exits", { timeout: 20_000 }, async () => {
	const dir = tmp();
	const report = (active: number) =>
		JSON.stringify({ type: "extension_ui_request", id: "x", method: "setStatus", statusKey: "sova-llm-inflight", statusText: JSON.stringify({ v: 1, producer: "pw-1", active, approximate: 0, claudeTurns: 0, degraded: false, folded: ["sub-1"] }) });
	const script = [
		`const w = (s) => process.stdout.write(s + "\\n");`,
		`w(${JSON.stringify(report(0))});`,
		`w(${JSON.stringify(JSON.stringify({ type: "message_update", text: "sova-llm-inflight in a token" }))});`,
		`w(${JSON.stringify(report(2))});`,
		`w(${JSON.stringify(JSON.stringify({ type: "extension_ui_request", id: "y", method: "setStatus", statusKey: "other", statusText: "{\"v\":1,\"active\":9}" }))});`,
		`setTimeout(() => process.exit(0), 700);`,
	].join("\n");
	const spec = {
		v: 1, command: process.execPath, args: ["-e", script], cwd: dir, sock: path.join(dir, "h.sock"),
		outLog: path.join(dir, "out.jsonl"), statusFile: path.join(dir, "status.json"), hostInfoFile: path.join(dir, "host.json"), lingerMs: 0,
	};
	write(path.join(dir, "spawn.json"), spec);
	const host = spawn(process.execPath, [HOST, path.join(dir, "spawn.json")], { stdio: "ignore" });
	const llm = () => {
		try {
			return JSON.parse(fs.readFileSync(path.join(dir, "llm.json"), "utf8"));
		} catch {
			return undefined;
		}
	};
	for (let i = 0; i < 300 && llm()?.active !== 2; i++) await new Promise((r) => setTimeout(r, 10));
	const mid = llm();
	assert.deepEqual({ ...mid, at: 0 }, { v: 1, producer: "pw-1", active: 2, approximate: 0, claudeTurns: 0, degraded: false, folded: ["sub-1"], at: 0 }, "the latest report; token lines and other keys ignored");
	await new Promise((r) => host.on("exit", r));
	assert.equal(llm().active, 0, "the worker exited: its calls ended");
	assert.ok(fs.existsSync(spec.statusFile));
	fs.rmSync(dir, { recursive: true, force: true });
});

test("past the bound, the workers not looked at are one unknown entry, never silently nothing", () => {
	const root = tmp();
	for (let i = 0; i < 513; i++) fs.mkdirSync(path.join(root, `o${i % 3}`, `w${i}`), { recursive: true });
	const out = readUnadoptedWorkers(root);
	assert.deepEqual(out, [{ key: "…overflow", counts: null }]);
	fs.rmSync(root, { recursive: true, force: true });
	const small = tmp();
	worker(small, "o", "w", {});
	assert.equal(readUnadoptedWorkers(small).some((e) => e.key === "…overflow"), false);
	fs.rmSync(small, { recursive: true, force: true });
});
