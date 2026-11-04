// shadow-prune.ts with real processes: the low-priority child (startPrune, shadow-prune-run.ts) and
// the lookup of nice/ionice. Everything in-process is in shadow-prune.unit.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CACHE_SETTINGS, lockPath, lowPriorityPrefix, readStamp, shadowDir, startPrune, trashDir } from "../../shadow-prune.ts";

const DAY = 24 * 3600_000;
const S = DEFAULT_CACHE_SETTINGS;

function scratch(t: { after(fn: () => void): void }): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "sbx-prune-int-")));
	t.after(() => rmSync(d, { recursive: true, force: true }));
	return d;
}

/** A 1 KB file at `path`, last used `ago` before now. */
function file(path: string, ago: number): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, Buffer.alloc(1024, 1));
	const t = new Date(Date.now() - ago);
	utimesSync(path, t, t);
}

/** Wait for a condition, never a fixed sleep. */
async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

function tree(t: { after(fn: () => void): void }) {
	const agent = scratch(t);
	const root = shadowDir(agent);
	file(join(root, "home-.cache", "old-scratch", "f"), 9 * DAY);
	file(join(root, "home-.cache", "fresh", "f"), 0);
	return { agent, root };
}

test("the run goes in a low-priority child: nice 19 (and idle disk class on Linux) where found", () => {
	const p = lowPriorityPrefix("linux");
	if (spawnSync("sh", ["-c", "command -v nice"]).status === 0) assert.deepEqual(p.slice(1, 3), ["-n", "19"]);
	if (spawnSync("sh", ["-c", "command -v ionice"]).status === 0) assert.equal(p.at(-1), "-c3");
	assert.ok(!lowPriorityPrefix("darwin").some((a) => a.endsWith("ionice")));
});

test("startPrune: a waited run reports its result, then deletes the trash and releases the lock on its own", async (t) => {
	const { agent, root } = tree(t);
	const r = await startPrune({ agentDir: agent, mode: "clean", settings: S, wait: true });
	assert.equal(r.kind, "done", JSON.stringify(r));
	assert.ok(!existsSync(join(root, "home-.cache", "old-scratch")));
	await until("the child to finish", () => !existsSync(lockPath(agent)));
	assert.deepEqual(readdirSync(trashDir(agent)), []);
	// A second one while a lock is held is refused, with nothing removed.
	file(join(root, "home-.cache", "another-old", "f"), 9 * DAY);
	writeFileSync(lockPath(agent), `${process.pid}\n`);
	assert.deepEqual(await startPrune({ agentDir: agent, mode: "all", settings: S, wait: true }), { kind: "busy" });
	assert.ok(existsSync(join(root, "home-.cache", "another-old")));
	rmSync(lockPath(agent));
});

test("startPrune unwaited: the automatic run is detached and writes its record", async (t) => {
	const { agent } = tree(t);
	await startPrune({ agentDir: agent, mode: "auto", settings: S });
	await until("the record", () => readStamp(agent)?.lastRun !== undefined);
	await until("the lock released", () => !existsSync(lockPath(agent)));
});

test("a child given bad arguments reports an error and never throws", async () => {
	const r = await startPrune({ agentDir: "relative", mode: "clean", settings: S, wait: true });
	assert.deepEqual(r, { kind: "error", error: "bad arguments" });
});
