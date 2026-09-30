// Many processes, one provider: at most the limit run at once, and every request completes.
// Each child claims a slot through gate.ts for several requests, logs start/end while holding it,
// and releases; one child is SIGKILLed while holding a slot, which must be reclaimed as stale
// (its pid is dead) rather than block the rest. Run by tests/run.mjs, or alone with node.
import "../../claude-code/tests/hermetic-env.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const gate = fileURLToPath(new URL("../gate.ts", import.meta.url));
const CHILD = `
import fs from "node:fs";
const { acquireSlot } = await import(process.env.GATE);
const log = (s) => fs.appendFileSync(process.env.LOG, s + "\\n");
const t = () => performance.timeOrigin + performance.now();
const n = Number(process.env.REQUESTS);
for (let i = 0; i < n; i++) {
  const kind = i % 2 ? "background" : "interactive";
  const slot = await acquireSlot("zai", { agentDir: process.env.AGENT, kind, sessionId: "s-" + process.pid, pollMs: 25 });
  log("start " + process.pid + " " + t());
  if (process.env.HANG) { fs.writeFileSync(process.env.HANG, "held"); await new Promise(() => setInterval(() => {}, 1000)); }
  await new Promise((r) => setTimeout(r, 20 + Math.random() * 40));
  log("end " + process.pid + " " + t());
  slot.release();
}
log("exit " + process.pid);
`;

function child(env) {
	const p = spawn(process.execPath, ["--input-type=module", "-e", CHILD], { env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"] });
	return { p, exited: new Promise((resolve) => p.on("exit", (code, signal) => resolve({ code, signal }))) };
}

test("N processes over one provider: never more than the limit in flight, none fails, a killed holder is reclaimed", async () => {
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "provider-limits-mp-"));
	const log = path.join(agent, "log.txt");
	const LIMIT = 3;
	const PROCS = 8;
	const REQUESTS = 4;
	fs.writeFileSync(path.join(agent, "provider-limits.json"), JSON.stringify({ version: 1, limits: { zai: LIMIT } }));
	// The holder: takes a slot and is killed while holding it.
	const hang = path.join(agent, "hang");
	const holder = child({ GATE: gate, AGENT: agent, LOG: path.join(agent, "holder.txt"), REQUESTS: "1", HANG: hang });
	while (!fs.existsSync(hang)) await new Promise((r) => setTimeout(r, 10));
	holder.p.kill("SIGKILL");
	await holder.exited;
	const slotsDir = path.join(agent, "provider-limits", "zai", "slots");
	assert.equal(fs.readdirSync(slotsDir).filter((f) => f.endsWith(".json")).length, 1, "the killed holder left its slot behind");

	const kids = Array.from({ length: PROCS }, () => child({ GATE: gate, AGENT: agent, LOG: log, REQUESTS: String(REQUESTS) }));
	const results = await Promise.all(kids.map((k) => k.exited));
	assert.deepEqual(results.map((r) => r.code), Array(PROCS).fill(0), "every process finished cleanly");

	const lines = fs.readFileSync(log, "utf8").trim().split("\n");
	assert.equal(lines.filter((l) => l.startsWith("exit")).length, PROCS);
	const events = lines
		.filter((l) => !l.startsWith("exit"))
		.map((l) => {
			const [what, pid, at] = l.split(" ");
			return { what, pid, at: Number(at) };
		})
		// At equal times an end sorts first: the interval closed before the next opened.
		.sort((a, b) => a.at - b.at || (a.what === "end" ? -1 : 1));
	assert.equal(events.filter((e) => e.what === "start").length, PROCS * REQUESTS, "every request ran");
	let now = 0;
	let peak = 0;
	for (const e of events) {
		now += e.what === "start" ? 1 : -1;
		peak = Math.max(peak, now);
	}
	assert.ok(peak <= LIMIT, `peak ${peak} in flight, limit ${LIMIT}`);
	assert.ok(peak >= 2, `the requests did overlap (peak ${peak})`);
	assert.equal(fs.readdirSync(slotsDir).filter((f) => f.endsWith(".json")).length, 0, "no slot left behind, the killed holder's included");
	fs.rmSync(agent, { recursive: true, force: true });
});
