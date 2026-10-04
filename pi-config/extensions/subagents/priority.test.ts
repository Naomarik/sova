import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { lowerPriority, parseNice, reniceLine, WORKER_NICE, withPriorityPrefix, workerNice } from "./priority.ts";

const unix = process.platform !== "win32";
const g = globalThis as Record<symbol, unknown>;
const withHook = async (hook: unknown, fn: () => unknown | Promise<unknown>) => {
	const before = g[WORKER_NICE];
	g[WORKER_NICE] = hook;
	try {
		await fn();
	} finally {
		if (before === undefined) delete g[WORKER_NICE];
		else g[WORKER_NICE] = before;
	}
};
const sleeper = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });

test("priority.ts imports only node built-ins, so Sova's server can import it", () => {
	const source = fs.readFileSync(fileURLToPath(new URL("./priority.ts", import.meta.url)), "utf8");
	const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
	assert.ok(specifiers.length > 0);
	for (const s of specifiers) assert.match(s, /^node:/, `${s} is not a node built-in`);
});

test("parseNice takes integers 0..19, as numbers or strings, and nothing else", () => {
	assert.equal(parseNice(10), 10);
	assert.equal(parseNice("0"), 0);
	assert.equal(parseNice(" 19 "), 19);
	for (const bad of [-1, 20, 1.5, "", "ten", null, undefined, true, {}]) assert.equal(parseNice(bad), undefined, String(bad));
});

test("workerNice is 0 with no host, the host's value with one, and 0 when the hook is bad", async () => {
	await withHook(undefined, () => assert.equal(workerNice(), 0));
	await withHook(() => 10, () => assert.equal(workerNice(), 10));
	await withHook(() => 42, () => assert.equal(workerNice(), 0));
	await withHook(() => { throw new Error("broken"); }, () => assert.equal(workerNice(), 0));
	await withHook(7, () => assert.equal(workerNice(), 0));
});

// Relative to the runner's own niceness, which a child inherits (a Sova-hosted runner is at 10).
const target = Math.min(19, os.getPriority() + 5);

test("lowerPriority lowers a spawned process to the host's niceness, once", { skip: !unix || os.getPriority() >= 19 }, async () => {
	const child = sleeper();
	try {
		await withHook(undefined, () => assert.equal(lowerPriority(child.pid), false, "no host: untouched"));
		assert.equal(os.getPriority(child.pid!), os.getPriority());
		await withHook(() => target, () => {
			assert.equal(lowerPriority(child.pid), true);
			assert.equal(os.getPriority(child.pid!), target);
			assert.equal(lowerPriority(child.pid), false, "already there");
		});
	} finally {
		child.kill("SIGKILL");
	}
});

test("lowerPriority never raises a priority, and never throws", { skip: !unix }, () => {
	const child = sleeper();
	try {
		// Above the runner (only ever lowering is allowed), then asked for less.
		os.setPriority(child.pid!, target);
		assert.equal(lowerPriority(child.pid, Math.max(os.getPriority(), target - 2)), false);
		assert.equal(os.getPriority(child.pid!), target);
	} finally {
		child.kill("SIGKILL");
	}
	assert.equal(lowerPriority(undefined, 10), false);
	assert.equal(lowerPriority(0, 10), false);
	assert.equal(lowerPriority(2 ** 30, 10), false, "no such process");
	assert.equal(lowerPriority(process.pid, 0), false, "0 is off");
	assert.equal(lowerPriority(process.pid, 10, "win32"), false, "Windows: skipped");
	assert.equal(os.getPriority(), os.getPriority(process.pid), "own priority untouched");
});

test("reniceLine lands on the niceness: util-linux sets it, BSD and POSIXLY_CORRECT add to it", () => {
	assert.equal(reniceLine(10, "linux", 0, false), "renice -n 10 -p $$ >/dev/null 2>&1");
	assert.equal(reniceLine(10, "linux", 3, false), "renice -n 10 -p $$ >/dev/null 2>&1");
	assert.equal(reniceLine(10, "linux", 3, true), "renice -n 7 -p $$ >/dev/null 2>&1");
	assert.equal(reniceLine(10, "darwin", 3, false), "renice -n 7 -p $$ >/dev/null 2>&1");
	assert.equal(reniceLine(10, "darwin", 10, false), undefined, "already there");
	assert.equal(reniceLine(10, "linux", 12, false), undefined, "never raises");
	assert.equal(reniceLine(0, "linux", 0, false), undefined, "off");
	assert.equal(reniceLine(10, "win32", 0, false), undefined, "Windows: skipped");
});

test("withPriorityPrefix puts the line before the user's own prefix", () => {
	const line = "renice -n 10 -p $$ >/dev/null 2>&1";
	assert.equal(withPriorityPrefix(undefined, undefined), undefined);
	assert.equal(withPriorityPrefix("shopt -s expand_aliases", undefined), "shopt -s expand_aliases");
	assert.equal(withPriorityPrefix(undefined, line), line);
	assert.equal(withPriorityPrefix("shopt -s expand_aliases", line), `${line}\nshopt -s expand_aliases`);
});

test("a shell given the prefix runs its command, and the command's children, at the niceness", { skip: !unix }, async () => {
	await withHook(() => 10, () => {
		const prefix = withPriorityPrefix(undefined);
		if (os.getPriority() >= 10) return assert.equal(prefix, undefined);
		const script = `${prefix}\n${JSON.stringify(process.execPath)} -p "require('os').getPriority()"`;
		assert.equal(execFileSync("sh", ["-c", script], { encoding: "utf8" }).trim(), "10");
	});
});
