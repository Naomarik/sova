// off-equals-stock.mjs — BRIEF F3/F1 plus plan v3 §8 #1-#3: the OFF path must be byte-for-byte
// today's runtime, and toggling must never leak into what the model sees. Everything is asserted
// through two real pi runtimes (with-extension vs without), opened the way Sova opens them.
//
// Needs pi-config/extensions/sandbox/index.ts; while absent every case is PENDING.

import { existsSync } from "node:fs";
import path from "node:path";
import { makeSuite, ok, eq } from "./kit.mjs";
import { EXT_ENTRY, cleanupAll, envKeys, hostMntNs, makeFixture, openSession, stable } from "./harness.mjs";

const t = makeSuite("off-equals-stock");
const SEVEN = ["read", "bash", "edit", "write", "grep", "find", "ls"];

if (!existsSync(EXT_ENTRY)) {
	t.pending("OS1-OS5", "pi-config/extensions/sandbox/index.ts does not exist yet");
	t.done();
	process.exitCode = 0;
} else {
	const fx = makeFixture();
	const stockCmp = (a, b) => stable({ ...a, source: undefined }) === stable({ ...b, source: undefined });
	let extS, bareS;

	await t.test("OS0 both runtimes open; the extension one exposes /sandbox, the stock one does not", async () => {
		extS = await openSessionGuarded(fx, true);
		bareS = await openSessionGuarded(fx, false);
		eq(extS.errors.length, 0, `with-extension session loaded clean: ${extS.errors.join(" | ")}`);
		eq(bareS.errors.length, 0, `stock session loaded clean: ${bareS.errors.join(" | ")}`);
		ok(extS.runner().getCommand("sandbox"), "the extension registers the sandbox command");
		ok(!bareS.runner().getCommand("sandbox"), "control: stock runtime has no sandbox command");
	});

	await t.test("OS1 never-ON registry identity: deep-equal tools, all seven builtin", async () => {
		const a = extS.registry();
		const b = bareS.registry();
		for (const name of SEVEN) {
			const ta = a.find((x) => x.name === name);
			const tb = b.find((x) => x.name === name);
			ok(ta && tb, `tool ${name} exists in both`);
			eq(ta.source, "builtin", `never-ON ${name} must be builtin-sourced`);
			eq(stockCmp(ta, tb), true, `never-ON ${name} deep-equal to stock (label/description/parameters/snippet/guidelines/executionMode)`);
		}
		eq(a.length, b.length, "the extension adds no extra tools while OFF");
	});

	await t.test("OS2 execution identity: same mount namespace as the host, identical env keys", async () => {
		const ra = await extS.bash("readlink /proc/self/ns/mnt");
		const rb = await bareS.bash("readlink /proc/self/ns/mnt");
		eq(ra.isError, false, "bash works (ext, OFF)");
		eq(ra.text.trim(), hostMntNs(), "never-ON bash runs in the host mount namespace");
		eq(rb.text.trim(), hostMntNs(), "stock bash runs in the host mount namespace");
		const ea = await extS.bash("env -0");
		const eb = await bareS.bash("env -0");
		eq(stable(envKeys(ea.text)), stable(envKeys(eb.text)), "env key sets identical OFF vs no-extension");
	});

	let promptBeforeOn;
	await t.test("OS3 ON: namespace changes; prompt and tool faces stay byte-identical (F1)", async () => {
		promptBeforeOn = extS.systemPrompt();
		const stockFace = new Map(bareS.registry().map((x) => [x.name, x]));
		const handler = extS.hasHandler("before_agent_start");
		if (handler === true) throw new Error("F1: a before_agent_start handler is registered (prompt section would change on toggle)");
		// handler === {unknown:true}: introspection unsupported; the byte-compare below is the real guard.
		await extS.command("sandbox", "on");
		const r = await extS.bash("readlink /proc/self/ns/mnt");
		eq(r.isError, false, "confined bash runs");
		ok(r.text.trim() !== hostMntNs(), `ON must run in a different mount namespace (got ${r.text.trim()})`);
		eq(extS.systemPrompt(), promptBeforeOn, "system prompt must be byte-identical before/after ON");
		for (const name of SEVEN) {
			const now = extS.registry().find((x) => x.name === name);
			eq(stockCmp(now, stockFace.get(name)), true, `F1: ON ${name} keeps the EXACT stock description/parameters`);
		}
		const entries = extS.entries().filter((e) => e.type === "custom" && e.customType === "sandbox");
		ok(entries.length >= 1, "a sandbox custom entry was appended");
		eq(JSON.stringify(entries.at(-1).data?.on ?? entries.at(-1).on).includes("true"), true, "entry records on:true");
	});

	await t.test("OS4 OFF after ON: namespace and env back to stock; only sourceInfo differs (accepted residue)", async () => {
		await extS.command("sandbox", "off");
		const r = await extS.bash("readlink /proc/self/ns/mnt");
		eq(r.isError, false, "bash runs after OFF");
		eq(r.text.trim(), hostMntNs(), "OFF-after-ON runs in the host mount namespace again");
		const eb = await bareS.bash("env -0");
		const ea = await extS.bash("env -0");
		eq(stable(envKeys(ea.text)), stable(envKeys(eb.text)), "env key sets identical to stock after OFF");
		eq(extS.systemPrompt(), promptBeforeOn, "system prompt byte-identical after OFF");
		for (const name of SEVEN) {
			const now = extS.registry().find((x) => x.name === name);
			const stock = bareS.registry().find((x) => x.name === name);
			ok(now.source && now.source !== "builtin", `${name} residue: served from a non-builtin slot (got ${JSON.stringify(now.source)}; pi cannot unregister until reopen)`);
			eq(stockCmp(now, stock), true, `${name} is byte-equal to stock apart from sourceInfo`);
		}
		const entries = extS.entries().filter((e) => e.type === "custom" && e.customType === "sandbox");
		eq(String(entries.at(-1).data?.on ?? entries.at(-1).on), "false", "latest entry records on:false");
	});

	await t.test("OS5 a fresh OPEN of a toggled session is stock-shaped again when restored OFF", async () => {
		// The accepted residue ends at reopen. The in-memory session keeps its branch, so we re-open
		// the same runtime factory pattern on a new in-memory manager with the entry history replayed:
		// restore from the entries the extension wrote (state.ts restoreActive reads the branch).
		const entries = extS.entries();
		const reopened = await openSessionGuarded(fx, true, entries);
		eq(reopened.errors.length, 0, `reopened session loaded clean: ${reopened.errors.join(" | ")}`);
		const r = await reopened.bash("readlink /proc/self/ns/mnt");
		eq(r.text.trim(), hostMntNs(), "restored-OFF session runs in the host mount namespace");
		for (const name of SEVEN) {
			const now = reopened.registry().find((x) => x.name === name);
			eq(now.source, "builtin", `restored-OFF ${name} is builtin again`);
		}
		await reopened.dispose();
	});

	await extS.dispose().catch(() => {});
	await bareS.dispose().catch(() => {});
	cleanupAll();
	t.done();
	if (process.exitCode !== 1) process.exitCode = 0;

	async function openSessionGuarded(fixture, withExtension, entries) {
		return await openSession({ cwd: fixture.cwd, agentDir: fixture.agentDir, withExtension, entries });
	}
}
