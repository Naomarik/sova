// worker-inheritance.mjs — plan v2 §11 #13 / v3 §8 #8: a worker starts with the parent's state
// (`--sandbox on`, no UI, no /sandbox command) and never turns itself off.
//
// Levels: the FLAG-level is testable as soon as index.ts exists. The PLUMBING level (the subagents
// runner passing the flag on parent state) is owned by integration and reported PENDING until
// subagents/index.ts references the sandbox.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeSuite, ok, eq } from "./kit.mjs";
import { EXT_ENTRY, PI_CONFIG, cleanupAll, hostMntNs, makeFixture, openSession, rand } from "./harness.mjs";

const t = makeSuite("worker-inheritance");

// Plumbing check without importing anything from subagents: a textual reference to the flag.
let plumbing = false;
try {
	const idx = readFileSync(path.join(PI_CONFIG, "extensions/subagents/index.ts"), "utf8");
	plumbing = /sandbox/.test(idx);
} catch { /* no subagents extension in this layout */ }

if (!existsSync(EXT_ENTRY)) {
	t.pending("W1-W3 flag-level worker shape", "pi-config/extensions/sandbox/index.ts does not exist yet");
} else {
	const fx = makeFixture();
	await t.test("W1 flag session starts ON with no UI: tools confined, no /sandbox command to flip", async () => {
		const s = await openSession({ cwd: fx.cwd, agentDir: fx.agentDir, withExtension: true, flags: { sandbox: "on" }, ui: false });
		try {
			eq(s.errors.length, 0, `worker session loaded clean: ${s.errors.join(" | ")}`);
			const r = await s.bash("readlink /proc/self/ns/mnt");
			ok(!r.isError && r.text.trim() !== hostMntNs(), `worker tools run confined (ns ${r.text.trim()})`);
			// A worker never turns itself off (spec §chat.sandbox/workers): no command at all, or a
			// command that REFUSES in a UI-less session. Both shapes satisfy the guarantee; the
			// behavioral check is that an off attempt does not take.
			const cmd = s.runner().getCommand("sandbox");
			if (!cmd) console.log("       worker shape: command absent");
			else {
				try { await s.command("sandbox", "off"); } catch { /* refusal may throw */ }
				const still = await s.bash("readlink /proc/self/ns/mnt");
				ok(still.text.trim() !== hostMntNs(), "a /sandbox off attempt in a UI-less worker session must NOT take effect");
				const entries = s.entries().filter((e) => e.type === "custom" && e.customType === "sandbox");
				const last = entries.at(-1);
				ok(!last || String(last.data?.on ?? last.on) !== "false", "no sandbox entry records on:false after the refused flip");
			}
		} finally {
			await s.dispose().catch(() => {});
		}
	});

	await t.test("W2 a worker write outside cwd is denied both layers", async () => {
		const s = await openSession({ cwd: fx.cwd, agentDir: fx.agentDir, withExtension: true, flags: { sandbox: "on" }, ui: false });
		try {
			const victim = path.join(fx.escape, `w2-${rand()}`);
			const r1 = await s.call("write", { path: victim, content: "pwned" });
			ok(r1.isError, "write tool refuses");
			const r2 = await s.bash(`touch '${victim}'`);
			ok(r2.isError, "bash is denied");
			ok(!existsSync(victim), "host-side: absent");
		} finally {
			await s.dispose().catch(() => {});
		}
	});

	await t.test("W3 flag OFF stays stock even with the extension loaded", async () => {
		const s = await openSession({ cwd: fx.cwd, agentDir: fx.agentDir, withExtension: true, flags: { sandbox: "off" }, ui: false });
		try {
			const r = await s.bash("readlink /proc/self/ns/mnt");
			eq(r.text.trim(), hostMntNs(), "--sandbox off runs unconfined");
			for (const x of s.registry()) eq(x.source, "builtin", `${x.name} stays builtin under --sandbox off`);
		} finally {
			await s.dispose().catch(() => {});
		}
	});
}

if (plumbing)
	t.pending("W4 parent→worker inheritance end-to-end", "plumbing detected — write the spawn test against the real agent_spawn flow (integration's flag plumbing)");
else
	t.pending("W4 parent→worker inheritance end-to-end", "subagents/index.ts has no sandbox plumbing yet (integration, phase 2)");

cleanupAll();
t.done();
process.exitCode ??= 0;
