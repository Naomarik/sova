import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyProjectTightening, loadPolicyFile, validatePolicyFile } from "../../policy.ts";
import {
	acquireLock,
	BUSY_TEXT,
	cachesLine,
	cleanResultText,
	DEFAULT_CACHE_SETTINGS,
	effectiveCap,
	GiB,
	invalidNotice,
	isDue,
	loadCacheSettings,
	lockHeld,
	lockPath,
	measure,
	type PlanEntry,
	planPrune,
	readStamp,
	runPrune,
	scanShadows,
	shadowDir,
	stampPath,
	trashDir,
	validateCacheSettings,
} from "../../shadow-prune.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, "..", "..", "..", "..", "sandbox-policy");
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 2, 12);
/** A disk so big the cap is the setting's 50 GB unless a test says otherwise. */
const BIG = { total: 100_000 * GiB, free: 100_000 * GiB };
const S = DEFAULT_CACHE_SETTINGS;

function scratch(t: { after(fn: () => void): void }): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "sbx-prune-")));
	t.after(() => rmSync(d, { recursive: true, force: true }));
	return d;
}

/** A file of `kb` KB at `path`, last written `writtenAgo` and last read `readAgo` before NOW. */
function file(path: string, kb: number, writtenAgo: number, readAgo: number = writtenAgo): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, Buffer.alloc(kb * 1024, 1));
	utimesSync(path, new Date(NOW - readAgo), new Date(NOW - writtenAgo));
}

const entry = (name: string, o: Partial<PlanEntry> & { usedAgo: number }): PlanEntry => ({
	root: o.root ?? "home-.cache",
	name,
	tier: o.tier ?? "scratch",
	bytes: o.bytes ?? GiB,
	lastWrite: NOW - o.usedAgo,
	lastRead: o.lastRead ?? NOW - o.usedAgo,
});

// ---------------------------------------------------------------------------------------------
// Settings

test("caches.json: missing means the defaults; a partial file takes the rest from them", (t) => {
	const agent = scratch(t);
	assert.deepEqual(loadCacheSettings(agent, "linux"), { ok: true, value: DEFAULT_CACHE_SETTINGS });
	mkdirSync(join(agent, "sandbox-policy", "linux"), { recursive: true });
	writeFileSync(join(agent, "sandbox-policy", "linux", "caches.json"), JSON.stringify({ maxSizeGB: 10, on: false }));
	const r = loadCacheSettings(agent, "linux");
	assert.ok(r.ok);
	assert.equal(r.value.maxSizeGB, 10);
	assert.equal(r.value.on, false);
	assert.equal(r.value.scratchDays, 7);
	assert.deepEqual(r.value.toolCaches, DEFAULT_CACHE_SETTINGS.toolCaches);
});

test("caches.json: invalid turns cleanup off with the notice, whatever is wrong", (t) => {
	const agent = scratch(t);
	const path = join(agent, "sandbox-policy", "linux", "caches.json");
	mkdirSync(dirname(path), { recursive: true });
	for (const [text, error] of [
		["{", "not valid JSON"],
		["[]", "not a JSON object"],
		[`{"maxSizeGb": 5}`, `unknown key "maxSizeGb"`],
		[`{"maxSizeGB": 0}`, "maxSizeGB must be a positive number"],
		[`{"scratchDays": "7"}`, "scratchDays must be a positive number"],
		[`{"on": "yes"}`, "on must be true or false"],
		[`{"toolCaches": ["a/b"]}`, "toolCaches must be a list of folder names"],
	] as const) {
		writeFileSync(path, text);
		assert.deepEqual(loadCacheSettings(agent, "linux"), { ok: false, error }, text);
	}
	assert.equal(invalidNotice("not valid JSON"), "Sandbox: `caches.json` is invalid (not valid JSON); cache cleanup is off. The sandbox is unaffected.");
	assert.equal(cachesLine({ ok: false, error: "x" }, undefined), "Caches: automatic cleanup off");
});

test("the shipped caches.json templates are valid and say exactly the defaults", () => {
	for (const platform of ["linux", "darwin"]) {
		const raw = JSON.parse(readFileSync(join(TEMPLATES, platform, "caches.json"), "utf8"));
		assert.deepEqual(validateCacheSettings(raw), { ok: true, value: DEFAULT_CACHE_SETTINGS }, platform);
	}
});

test("policy.json is untouched: the strict validator accepts the shipped linux and darwin templates as they are", () => {
	for (const platform of ["linux", "darwin"]) {
		const path = join(TEMPLATES, platform, "policy.json");
		assert.equal(validatePolicyFile(JSON.parse(readFileSync(path, "utf8"))).ok, true, platform);
		assert.equal(loadPolicyFile(path).ok, true, platform);
		// And a cleanup key is no key of policy.json's: it stays an error there.
		assert.equal(validatePolicyFile({ ...JSON.parse(readFileSync(path, "utf8")), maxSizeGB: 5 }).ok, false);
	}
});

test("a project's .sova/sandbox.json cannot set the cleanup: its keys are ignored with a notice", () => {
	const base = loadPolicyFile(join(TEMPLATES, "linux", "policy.json"));
	assert.ok(base.ok);
	const r = applyProjectTightening(base.value, { maxSizeGB: 1, scratchDays: 1, on: false });
	assert.deepEqual(r.ignored.sort(), ["maxSizeGB", "on", "scratchDays"]);
	assert.deepEqual(r.policy, base.value);
});

// ---------------------------------------------------------------------------------------------
// The limit

test("the limit: the smallest of the setting, 5% of the disk and 5% of free space, never under 2 GB", () => {
	assert.deepEqual(effectiveCap({ maxSizeGB: 50 }, BIG), { cap: 50 * GiB, reason: "setting" });
	assert.deepEqual(effectiveCap({ maxSizeGB: 50 }, { total: 400 * GiB, free: 300 * GiB }), { cap: 15 * GiB, reason: "free" });
	assert.deepEqual(effectiveCap({ maxSizeGB: 50 }, { total: 200 * GiB, free: 300 * GiB }), { cap: 10 * GiB, reason: "disk" });
	// 5% of 20 GB free is 1 GB: the 2 GB minimum wins.
	assert.deepEqual(effectiveCap({ maxSizeGB: 50 }, { total: 1000 * GiB, free: 20 * GiB }), { cap: 2 * GiB, reason: "floor" });
	assert.deepEqual(effectiveCap({ maxSizeGB: 1 }, BIG), { cap: 2 * GiB, reason: "floor" });
});

// ---------------------------------------------------------------------------------------------
// The planner

const names = (p: { remove: { name: string }[] }) => p.remove.map((e) => e.name);

test("by age: scratch after 7 days unused, tool caches after 30", () => {
	const p = planPrune({
		now: NOW,
		settings: S,
		disk: BIG,
		mode: "auto",
		entries: [
			entry("scratch-6d", { usedAgo: 6 * DAY }),
			entry("scratch-8d", { usedAgo: 8 * DAY }),
			entry("pnpm", { usedAgo: 29 * DAY, tier: "tool" }),
			entry("uv", { usedAgo: 31 * DAY, tier: "tool" }),
		],
	});
	assert.deepEqual(names(p), ["scratch-8d", "uv"]);
	assert.ok(p.remove.every((e) => e.why === "age"));
	assert.equal(p.freed, 2 * GiB);
	assert.equal(p.overCap, false);
});

test("tiers: every entry of ~/.npm and ~/.m2 is a tool cache; in ~/.cache only the listed names", (t) => {
	const root = shadowDir(scratch(t));
	for (const rel of ["home-.cache/pnpm/f", "home-.cache/build-x/f", "home-.npm/_cacache/f", "home-.m2/repository/f", "root-opt%2Fcache/x/f"]) file(join(root, rel), 1, DAY);
	const tiers = Object.fromEntries(scanShadows(root, S).map((e) => [`${e.root}/${e.name}`, e.tier]));
	assert.deepEqual(tiers, { "home-.cache/pnpm": "tool", "home-.cache/build-x": "scratch", "home-.npm/_cacache": "tool", "home-.m2/repository": "tool", "root-opt%2Fcache/x": "scratch" });
});

test("by size: least recently used first, every scratch entry before any tool cache, until under the limit", () => {
	// Limit 2 GB (the floor), 6 GB of entries, all younger than their age limit.
	const p = planPrune({
		now: NOW,
		settings: { ...S, maxSizeGB: 1 },
		disk: BIG,
		mode: "auto",
		entries: [
			entry("tool-old", { usedAgo: 6 * DAY, tier: "tool" }),
			entry("tool-new", { usedAgo: 3 * DAY, tier: "tool" }),
			entry("s-new", { usedAgo: 3 * DAY }),
			entry("s-old", { usedAgo: 5 * DAY }),
			entry("s-mid", { usedAgo: 4 * DAY }),
			entry("tool-mid", { usedAgo: 5 * DAY, tier: "tool" }),
		],
	});
	assert.deepEqual(names(p), ["s-old", "s-mid", "s-new", "tool-old"]);
	assert.ok(p.remove.every((e) => e.why === "size"));
	assert.equal(p.left, 2 * GiB);
	assert.equal(p.overCap, false);
});

test("recent use is protected from both passes: written within 24 h, read within 48 h", () => {
	const p = planPrune({
		now: NOW,
		settings: { ...S, maxSizeGB: 1 },
		disk: BIG,
		mode: "auto",
		entries: [
			// Old writes, read 47 h ago: kept. Read 49 h ago: gone by size (age: 49 h < 7 d).
			entry("read-47h", { usedAgo: 40 * DAY, lastRead: NOW - 47 * HOUR }),
			entry("read-49h", { usedAgo: 40 * DAY, lastRead: NOW - 49 * HOUR }),
			entry("written-23h", { usedAgo: 23 * HOUR }),
			entry("written-25h", { usedAgo: 25 * HOUR, lastRead: NOW - 30 * DAY }),
		],
	});
	assert.deepEqual(names(p).sort(), ["read-49h", "written-25h"]);
	assert.equal(p.left, 2 * GiB);
	assert.equal(p.overCap, false);
});

test("over the limit with only protected entries left: it says so, and removes nothing it may not", () => {
	const p = planPrune({
		now: NOW,
		settings: S,
		disk: BIG,
		mode: "auto",
		entries: [entry("huge", { usedAgo: HOUR, bytes: 80 * GiB }), entry("old", { usedAgo: 9 * DAY })],
	});
	assert.deepEqual(names(p), ["old"]);
	assert.equal(p.overCap, true);
	assert.equal(p.left, 80 * GiB);
});

test("clean all: everything not used in the last hour goes, tool caches included", () => {
	const p = planPrune({
		now: NOW,
		settings: S,
		disk: BIG,
		mode: "all",
		entries: [
			entry("pnpm", { usedAgo: 2 * HOUR, tier: "tool" }),
			entry("s-2h", { usedAgo: 2 * HOUR }),
			entry("s-30m", { usedAgo: HOUR / 2 }),
			entry("read-30m", { usedAgo: 9 * DAY, lastRead: NOW - HOUR / 2 }),
		],
	});
	assert.deepEqual(names(p), ["pnpm", "s-2h"]);
	assert.ok(p.remove.every((e) => e.why === "all"));
});

// ---------------------------------------------------------------------------------------------
// The scan

test("recency: the newest file write and file read; a directory's atime is never use", (t) => {
	const root = shadowDir(scratch(t));
	const e = join(root, "home-.cache", "thing");
	file(join(e, "a", "old"), 4, 20 * DAY, 15 * DAY);
	file(join(e, "b", "newer"), 4, 10 * DAY, 9 * DAY);
	// The walk itself (and anyone's ls) moves directory atimes: forge them to now; they must not count.
	for (const d of [e, join(e, "a"), join(e, "b")]) utimesSync(d, new Date(NOW), new Date(NOW - 30 * DAY));
	const [m] = scanShadows(root, S);
	assert.equal(m!.lastWrite, NOW - 10 * DAY);
	assert.equal(m!.lastRead, NOW - 9 * DAY);
	assert.equal(planPrune({ now: NOW, settings: S, disk: BIG, mode: "auto", entries: [m!] }).remove.length, 1);
});

test("an entry with no file at all takes its folders' times: a folder made just now is not unused", (t) => {
	const root = shadowDir(scratch(t));
	mkdirSync(join(root, "home-.cache", "fresh", "sub"), { recursive: true });
	const [m] = scanShadows(root, S);
	assert.ok(Date.now() - m!.lastWrite < HOUR);
});

test("links are never followed: a link's target is neither measured nor dated, and survives the cleanup", (t) => {
	const agent = scratch(t);
	const root = shadowDir(agent);
	const outside = join(agent, "outside");
	file(join(outside, "big"), 512, HOUR, HOUR);
	file(join(root, "home-.cache", "linky", "own"), 4, 20 * DAY);
	symlinkSync(outside, join(root, "home-.cache", "linky", "to-outside"));
	symlinkSync(join(outside, "big"), join(root, "home-.cache", "toplink"));
	lutimesOld(join(root, "home-.cache", "linky", "to-outside"));
	lutimesOld(join(root, "home-.cache", "toplink"));
	const entries = scanShadows(root, S);
	const linky = entries.find((e) => e.name === "linky")!;
	assert.ok(linky.bytes < 256 * 1024, `the 512 KB target is not counted (${linky.bytes})`);
	assert.equal(linky.lastWrite, NOW - 20 * DAY, "the target's fresh times do not count");
	const r = runPrune({ agentDir: agent, mode: "clean", settings: S, now: NOW, disk: BIG });
	assert.equal(r.kind, "done");
	assert.ok(!existsSync(join(root, "home-.cache", "linky")));
	assert.ok(!existsSync(join(root, "home-.cache", "toplink")));
	assert.equal(readFileSync(join(outside, "big")).length, 512 * 1024, "the target is untouched");
});

/** A symlink's own times, 20 days old (never its target's). */
function lutimesOld(path: string): void {
	const t = new Date(NOW - 20 * DAY);
	lutimesSync(path, t, t);
}

test("a hard-linked file is counted once across all entries, and sizes are the space taken", (t) => {
	const root = shadowDir(scratch(t));
	file(join(root, "home-.cache", "one", "f"), 256, 20 * DAY);
	mkdirSync(join(root, "home-.npm", "two"), { recursive: true });
	linkSync(join(root, "home-.cache", "one", "f"), join(root, "home-.npm", "two", "f"));
	const entries = scanShadows(root, S);
	const blocks = lstatSync(join(root, "home-.cache", "one", "f")).blocks * 512;
	const fileBytes = (e: PlanEntry) => e.bytes - lstatSync(join(root, e.root, e.name)).blocks * 512;
	assert.equal(entries.reduce((n, e) => n + fileBytes(e), 0), blocks, "the shared file once");
	// Both entries still see it as used when it was.
	assert.ok(entries.every((e) => e.lastWrite === NOW - 20 * DAY));
});

test("another filesystem is never entered: an entry on a different device is left out", (t) => {
	const root = shadowDir(scratch(t));
	file(join(root, "home-.cache", "x", "f"), 4, DAY);
	const dev = lstatSync(join(root, "home-.cache")).dev;
	assert.equal(measure(join(root, "home-.cache", "x"), dev + 1, new Set()), undefined);
	assert.ok(measure(join(root, "home-.cache", "x"), dev, new Set()));
});

// ---------------------------------------------------------------------------------------------
// The run

function tree(t: { after(fn: () => void): void }) {
	const agent = scratch(t);
	const root = shadowDir(agent);
	file(join(root, "home-.cache", "old-scratch", "f"), 8, 9 * DAY);
	file(join(root, "home-.cache", "fresh", "f"), 8, HOUR);
	file(join(root, "home-.cache", "pnpm", "f"), 8, 10 * DAY);
	file(join(root, "home-.npm", "_cacache", "f"), 8, 10 * DAY);
	file(join(root, "home-.m2", "repository", "f"), 8, 40 * DAY);
	file(join(root, "home-old%2Flayout", "leftover", "f"), 8, 9 * DAY);
	return { agent, root };
}

const left = (root: string) => readdirSync(root).sort().flatMap((r) => readdirSync(join(root, r)).sort().map((n) => `${r}/${n}`));

test("a run removes whole entries by age, keeps every copy's own folder, writes its record and leaves no trash", (t) => {
	const { agent, root } = tree(t);
	const r = runPrune({ agentDir: agent, mode: "auto", settings: S, now: NOW, disk: { total: 1000 * GiB, free: 400 * GiB } });
	assert.equal(r.kind, "done");
	assert.deepEqual(left(root), ["home-.cache/fresh", "home-.cache/pnpm", "home-.m2/repository", "home-.npm/_cacache"].filter((e) => e !== "home-.m2/repository").sort());
	assert.deepEqual(readdirSync(root).sort(), ["home-.cache", "home-.m2", "home-.npm", "home-old%2Flayout"], "no copy's own folder is removed");
	assert.deepEqual(readdirSync(trashDir(agent)), []);
	const stamp = readStamp(agent)!;
	assert.equal(stamp.lastRun, NOW);
	assert.equal(stamp.mode, "auto");
	assert.equal(stamp.removed, 3);
	assert.equal(stamp.cap, 20 * GiB);
	assert.equal(stamp.capReason, "free");
	assert.equal(stamp.overCap, false);
	assert.equal(stamp.sizeBefore! - stamp.size!, stamp.freed);
	assert.ok(stamp.freed! >= 3 * 8 * 1024);
	assert.ok(!existsSync(lockPath(agent)), "the lock is released");
	assert.equal(cachesLine({ ok: true, value: S }, stamp, NOW + 3 * HOUR), `Caches ${Math.round(stamp.size! / 1024)} KB of 20 GB (5% of free space) · cleaned 3 hours ago, freed up to ${Math.round(stamp.freed! / 1024)} KB`);
});

test("each run first empties what an earlier one left in the trash", (t) => {
	const { agent } = tree(t);
	file(join(trashDir(agent), "123-left-behind", "f"), 8, DAY);
	runPrune({ agentDir: agent, mode: "clean", settings: S, now: NOW, disk: BIG });
	assert.deepEqual(readdirSync(trashDir(agent)), []);
});

test("an entry used between the scan and the move is kept", (t) => {
	const agent = scratch(t);
	const root = shadowDir(agent);
	file(join(root, "home-.cache", "busy", "f"), 8, 9 * DAY);
	const [m] = scanShadows(root, S);
	// A file made at the entry's top after the scan moves its mtime; replay the run's check.
	file(join(root, "home-.cache", "busy", "new"), 1, 0);
	assert.notEqual(lstatSync(join(root, "home-.cache", "busy")).mtimeMs, m!.topMtime);
	const r = runPrune({ agentDir: agent, mode: "clean", settings: S, now: NOW, disk: BIG });
	// The run's own scan now sees the new file as written at NOW: protected.
	assert.equal(r.kind, "done");
	assert.ok(existsSync(join(root, "home-.cache", "busy")));
});

test("the throttle: an automatic run at most once a day; /sandbox clean ignores it", (t) => {
	const { agent, root } = tree(t);
	writeFileSync(stampPath(agent), JSON.stringify({ version: 1, lastRun: NOW - 23 * HOUR, lastAttempt: NOW - 23 * HOUR }));
	assert.equal(isDue(readStamp(agent), NOW), false);
	assert.deepEqual(runPrune({ agentDir: agent, mode: "auto", settings: S, now: NOW, disk: BIG }), { kind: "skipped" });
	assert.ok(existsSync(join(root, "home-.cache", "old-scratch")), "nothing removed");
	assert.equal(isDue(readStamp(agent), NOW + 2 * HOUR), true);
	assert.equal(isDue(undefined, NOW), true);
	// A run that started but never finished counts too.
	assert.equal(isDue({ version: 1, lastAttempt: NOW - HOUR }, NOW), false);
	const r = runPrune({ agentDir: agent, mode: "clean", settings: S, now: NOW, disk: BIG });
	assert.equal(r.kind, "done");
	assert.ok(!existsSync(join(root, "home-.cache", "old-scratch")));
});

test("clean all through a run: only what was used in the last hour is left", (t) => {
	const { agent, root } = tree(t);
	file(join(root, "home-.cache", "pnpm", "g"), 1, 2 * HOUR);
	file(join(root, "home-.cache", "now", "f"), 1, HOUR / 4);
	const r = runPrune({ agentDir: agent, mode: "all", settings: S, now: NOW, disk: BIG });
	assert.equal(r.kind, "done");
	assert.deepEqual(left(root), ["home-.cache/fresh", "home-.cache/now"].filter((e) => e !== "home-.cache/fresh"));
	assert.equal(cleanResultText((r as { kind: "done"; stamp: Parameters<typeof cleanResultText>[0] }).stamp, "all").replace(/[\d.]+ KB/, "N KB"), "Caches cleared: freed up to N KB; kept only what was used in the last hour");
});

// ---------------------------------------------------------------------------------------------
// The lock

test("the lock: a live holder blocks a run (nothing removed); a stale or dead one does not", (t) => {
	const { agent, root } = tree(t);
	const lock = lockPath(agent);
	mkdirSync(dirname(lock), { recursive: true });
	// A live holder: this very process, fresh.
	writeFileSync(lock, `${process.pid}\n`);
	assert.equal(lockHeld(lock), true);
	assert.deepEqual(runPrune({ agentDir: agent, mode: "clean", settings: S, disk: BIG, now: NOW }), { kind: "busy" });
	assert.ok(existsSync(join(root, "home-.cache", "old-scratch")));
	assert.equal(acquireLock(lock), undefined);
	// Older than 2 hours without a heartbeat: stale, even with a live pid.
	const old = new Date(Date.now() - 3 * HOUR);
	utimesSync(lock, old, old);
	assert.equal(lockHeld(lock), false);
	// A dead pid: stale at once.
	// A pid no process can have (above any pid_max): gone, without starting a process to get one.
	const dead = 2 ** 31 - 2;
	writeFileSync(lock, `${dead}\n`);
	assert.equal(lockHeld(lock), false);
	const r = runPrune({ agentDir: agent, mode: "clean", settings: S, disk: BIG, now: NOW });
	assert.equal(r.kind, "done");
	assert.ok(!existsSync(join(root, "home-.cache", "old-scratch")));
	assert.ok(!existsSync(lock));
});

test("acquireLock is exclusive, and release removes only its own lock", (t) => {
	const lock = lockPath(scratch(t));
	const a = acquireLock(lock)!;
	assert.ok(a);
	assert.equal(acquireLock(lock), undefined);
	a.release();
	assert.ok(!existsSync(lock));
	const b = acquireLock(lock)!;
	a.release();
	assert.ok(existsSync(lock), "a second release of the old holder leaves the new lock alone");
	b.release();
});

// ---------------------------------------------------------------------------------------------
// What /sandbox says

test("the caches line: never cleaned, cleaned, over the limit, off", () => {
	const on = { ok: true as const, value: S };
	assert.equal(cachesLine(on, undefined), "Caches: not cleaned yet");
	assert.equal(cachesLine({ ok: true, value: { ...S, on: false } }, undefined), "Caches: automatic cleanup off");
	const stamp = { version: 1 as const, lastRun: NOW - 2 * DAY, size: 3 * GiB, cap: 10 * GiB, capReason: "disk" as const, freed: 512 * 1024 ** 2, overCap: false };
	assert.equal(cachesLine(on, stamp, NOW), "Caches 3 GB of 10 GB (5% of the disk) · cleaned 2 days ago, freed up to 512 MB");
	assert.equal(cachesLine(on, { ...stamp, size: 12.5 * GiB, overCap: true, capReason: "setting" }, NOW), "Caches 13 GB, over the 10 GB limit (your maxSizeGB setting): everything left was used recently");
	assert.equal(cachesLine(on, { ...stamp, cap: 2 * GiB, size: GiB, capReason: "floor" }, NOW), "Caches 1 GB of 2 GB (the 2 GB minimum) · cleaned 2 days ago, freed up to 512 MB");
	assert.equal(cleanResultText({ ...stamp, freed: 1.5 * GiB }, "clean"), "Caches cleaned: freed up to 1.5 GB; 3 GB left of 10 GB");
	assert.equal(BUSY_TEXT, "Caches: a cleanup is already running. Nothing was removed; try again later.");
});
