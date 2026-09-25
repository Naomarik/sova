// midflight.mjs — the flip takes effect on the NEXT tool call (spec §chat.sandbox/toggle): a bash
// already running finishes under the rules it started with, un-interrupted; the call after the
// flip runs unconfined. Proven by mount namespace, in line with F3 (no spawn spies).

import { existsSync } from "node:fs";
import { makeSuite, ok, eq } from "./kit.mjs";
import { EXT_ENTRY, cleanupAll, confineProbeFragment, confineProbeReadResult, confinedCheck, makeFixture, openSession, sleep } from "./harness.mjs";

const t = makeSuite("midflight");

if (!existsSync(EXT_ENTRY)) {
	t.pending("MF1-MF2", "pi-config/extensions/sandbox/index.ts does not exist yet");
	t.done();
} else {
	const fx = makeFixture();
	let s;

	await t.test("MF1 a bash started under ON stays confined to completion across an OFF flip", async () => {
		s = await openSession({ cwd: fx.cwd, agentDir: fx.agentDir, withExtension: true });
		eq(s.errors.length, 0, `session loaded clean: ${s.errors.join(" | ")}`);
		await s.command("sandbox", "on");
		const started = Date.now();
		const { command: probe, marker } = confineProbeFragment(fx.escape);
		const running = s.bash(`${probe}; sleep 3; echo COMPLETED`, {});
		await sleep(1000); // the command is now mid-flight inside the sandbox
		await s.command("sandbox", "off");
		const r = await running;
		ok(!r.isError, `the in-flight command must finish normally, not be killed: ${r.text.slice(-200)}`);
		const lines = r.text.trim().split("\n");
		eq(confineProbeReadResult(lines[0].trim(), marker), "confined", `the in-flight command ran confined (ns ${lines[0]})`);
		ok(r.text.includes("COMPLETED"), "the in-flight command ran to completion (3s > 1s flip)");
		ok(Date.now() - started >= 2900, "wall-clock proof the sleep was not cut short");
	});

	await t.test("MF2 the call AFTER the flip is unconfined", async () => {
		const c = await confinedCheck(s.bash, fx.escape);
		eq(c.state, "unconfined", `post-flip bash runs unconfined (${c.detail})`);
	});

	await s?.dispose().catch(() => {});
	cleanupAll();
	t.done();
}
process.exitCode ??= 0;
