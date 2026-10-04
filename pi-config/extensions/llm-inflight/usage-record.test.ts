// The usage ledger's record: the writer files one line per call under its UTC day and producer,
// and the strict parse takes back exactly what the writer writes and nothing malformed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	appendUsageRecord,
	formatUsageRecord,
	normalizeUsageRecord,
	parseUsageLine,
	usageDay,
	usageFilePath,
	type UsageRecord,
} from "./usage-record.ts";

const record = (over: Partial<UsageRecord> = {}): UsageRecord => ({
	v: 1,
	key: "pi:s1:1791140109000:zai/glm-5.3",
	ts: Date.UTC(2026, 9, 4, 23, 59, 59, 900),
	device: "h_abcd1234",
	producer: "0b0c6c7e-2f7e-4d43-9a43-6f1f6a6b1c2d",
	src: "pi",
	provider: "zai",
	model: "glm-5.3",
	responseModel: "glm-5.3-0901",
	input: 12,
	output: 345,
	cacheRead: 120000,
	cacheWrite: 2000,
	owner: "s1",
	parent: null,
	kind: "main",
	cwd: "/work/repo",
	stop: "stop",
	...over,
});

test("a record round-trips through its line in canonical order, unknown fields dropped", () => {
	const line = formatUsageRecord(record());
	assert.ok(line?.endsWith("\n"));
	assert.deepEqual(parseUsageLine(line!), record());
	assert.deepEqual(normalizeUsageRecord({ ...record(), later: 1 }), record());
	// Key order is the writer's, whatever order the object came in.
	const shuffled = Object.fromEntries(Object.entries(record()).reverse()) as unknown as UsageRecord;
	assert.equal(formatUsageRecord(shuffled), line);
});

test("the strict parse refuses any wrong known field, a partial line and a non-record", () => {
	const bad: Record<string, unknown>[] = [
		{ v: 2 },
		{ ts: 1.5 },
		{ input: -1 },
		{ output: "3" },
		{ cacheWrite1h: 2001 },
		{ kind: "fork" },
		{ src: "import" },
		{ producer: "../x" },
		{ purpose: "Title" },
		{ owner: undefined },
		{ device: 3 },
		{ key: "" },
		{ starter: "you" },
	];
	for (const over of bad) assert.equal(normalizeUsageRecord({ ...record(), ...over }), null, JSON.stringify(over));
	const line = formatUsageRecord(record())!;
	assert.equal(parseUsageLine(line.slice(0, -10)), null);
	assert.equal(parseUsageLine("[]"), null);
	assert.equal(parseUsageLine(""), null);
	assert.deepEqual(parseUsageLine(formatUsageRecord(record({ cacheWrite1h: 2000, purpose: "cache-warm" }))!)?.cacheWrite1h, 2000);
	assert.equal(parseUsageLine(formatUsageRecord(record({ project: "prj_abc", starter: "overseer", kind: "oneshot", purpose: "reconcile" }))!)?.starter, "overseer");
});

test("the writer appends one line per call to <usage>/<UTC day>/<producer>.jsonl, and none for zero tokens", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-record-"));
	try {
		const r = record();
		assert.equal(usageDay(r.ts), "2026-10-04");
		const file = usageFilePath(dir, r.ts, r.producer);
		assert.equal(file, path.join(dir, "usage", "v1", "2026-10-04", `${r.producer}.jsonl`));
		assert.equal(appendUsageRecord(r, dir), true);
		assert.equal(appendUsageRecord(record({ key: "k2", ts: r.ts + 50 }), dir), true);
		assert.equal(appendUsageRecord(record({ key: "k3", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), dir), false);
		assert.equal(appendUsageRecord(record({ key: "k4", kind: "nope" as never }), dir), false);
		// The next UTC day starts a new directory.
		assert.equal(appendUsageRecord(record({ key: "k5", ts: r.ts + 200 }), dir), true);
		const lines = fs.readFileSync(file, "utf8").split("\n");
		assert.deepEqual(lines.map((l) => parseUsageLine(l)?.key ?? null), [r.key, "k2", null]);
		assert.equal(parseUsageLine(fs.readFileSync(usageFilePath(dir, r.ts + 200, r.producer), "utf8"))?.key, "k5");
		// A day directory removed under the writer's cache is made again.
		fs.rmSync(path.dirname(file), { recursive: true });
		assert.equal(appendUsageRecord(record({ key: "k6" }), dir), true);
		assert.equal(parseUsageLine(fs.readFileSync(file, "utf8"))?.key, "k6");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
