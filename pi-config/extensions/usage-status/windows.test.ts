/**
 * usage-windows.json (Ollama Cloud's declared reset day): the strict parse, the atomic writer,
 * the monthly window it implies and `/usage reset-day` — against a temporary agent dir.
 */
// A zone with daylight saving, before any Date is made: the window is local midnights.
process.env.TZ = "America/New_York";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { monthlyWindow, parseResetDayArgs, parseUsageWindows, readUsageWindows, runResetDay, setOllamaResetDay, usageWindowsPath, writeUsageWindows } from "./windows.ts";

const tmpAgent = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-windows-"));
	process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
};
/** Local wall-clock time as ms (months 1-based, like a calendar). */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const win = (day: number, now: number) => {
	const w = monthlyWindow(day, now);
	return { start: new Date(w.startsAt), end: new Date(w.resetsAt) };
};
const ymd = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;

test("parseUsageWindows accepts exactly {version: 1, ollama?: {resetDay: 1..31}}", () => {
	assert.deepEqual(parseUsageWindows('{"version":1}'), { ok: true, value: { version: 1 } });
	assert.deepEqual(parseUsageWindows({ version: 1, ollama: { resetDay: 14 } }), { ok: true, value: { version: 1, ollama: { resetDay: 14 } } });
	for (const bad of [
		"nope",
		"[]",
		'{"version":2}',
		'{"version":1,"extra":true}',
		'{"version":1,"ollama":{"resetDay":0}}',
		'{"version":1,"ollama":{"resetDay":32}}',
		'{"version":1,"ollama":{"resetDay":14.5}}',
		'{"version":1,"ollama":{"resetDay":"14"}}',
		'{"version":1,"ollama":{"resetDay":14,"tz":"x"}}',
		'{"version":1,"ollama":null}',
	])
		assert.equal(parseUsageWindows(bad).ok, false, bad);
});

test("read: missing or unreadable is unknown; write is atomic and round-trips; set keeps the file's shape", () => {
	const dir = tmpAgent();
	assert.deepEqual(readUsageWindows(dir), { version: 1 });
	fs.writeFileSync(usageWindowsPath(dir), "{broken");
	assert.deepEqual(readUsageWindows(dir), { version: 1 });
	writeUsageWindows({ version: 1, ollama: { resetDay: 31 } }, dir);
	assert.deepEqual(readUsageWindows(dir), { version: 1, ollama: { resetDay: 31 } });
	assert.deepEqual(fs.readdirSync(dir), ["usage-windows.json"], "no temp file left behind");
	assert.throws(() => writeUsageWindows({ version: 1, ollama: { resetDay: 40 } }, dir));
	assert.deepEqual(readUsageWindows(dir), { version: 1, ollama: { resetDay: 31 } }, "a refused write changes nothing");
	setOllamaResetDay(null, dir);
	assert.deepEqual(JSON.parse(fs.readFileSync(usageWindowsPath(dir), "utf8")), { version: 1 });
	assert.throws(() => setOllamaResetDay(0, dir));
});

test("monthlyWindow: from local midnight on the day to the same day next month", () => {
	assert.deepEqual(ymd(win(14, local(2026, 10, 20, 15)).start), "2026-10-14 0:00");
	assert.deepEqual(ymd(win(14, local(2026, 10, 20, 15)).end), "2026-11-14 0:00");
	// Before the day this month: the window began last month.
	assert.equal(ymd(win(14, local(2026, 10, 3)).start), "2026-9-14 0:00");
	assert.equal(ymd(win(14, local(2026, 10, 3)).end), "2026-10-14 0:00");
});

test("monthlyWindow: the reset day itself is the window's first day", () => {
	const w = win(14, local(2026, 10, 14, 0, 0));
	assert.equal(ymd(w.start), "2026-10-14 0:00");
	assert.equal(ymd(win(14, local(2026, 10, 13, 23, 59)).end), "2026-10-14 0:00");
});

test("monthlyWindow: a day past the month's end clamps to its last day", () => {
	// 31 in February (not a leap year) is Feb 28; in 2028 (leap) Feb 29; in April Apr 30.
	assert.deepEqual([ymd(win(31, local(2027, 2, 10)).start), ymd(win(31, local(2027, 2, 10)).end)], ["2027-1-31 0:00", "2027-2-28 0:00"]);
	assert.deepEqual([ymd(win(31, local(2027, 3, 1)).start), ymd(win(31, local(2027, 3, 1)).end)], ["2027-2-28 0:00", "2027-3-31 0:00"]);
	assert.equal(ymd(win(30, local(2028, 2, 29, 12)).start), "2028-2-29 0:00");
	assert.equal(ymd(win(31, local(2026, 4, 30, 9)).start), "2026-4-30 0:00");
	assert.equal(ymd(win(31, local(2026, 4, 30, 9)).end), "2026-5-31 0:00");
});

test("monthlyWindow: the year rolls over both ways", () => {
	assert.deepEqual([ymd(win(5, local(2026, 12, 20)).start), ymd(win(5, local(2026, 12, 20)).end)], ["2026-12-5 0:00", "2027-1-5 0:00"]);
	assert.deepEqual([ymd(win(5, local(2027, 1, 2)).start), ymd(win(5, local(2027, 1, 2)).end)], ["2026-12-5 0:00", "2027-1-5 0:00"]);
});

test("monthlyWindow: across a daylight-saving change both ends stay local midnights", () => {
	// US clocks go back on 2026-11-01: the window is an hour longer than 31 × 24h.
	const w = win(15, local(2026, 10, 20));
	assert.equal(ymd(w.start), "2026-10-15 0:00");
	assert.equal(ymd(w.end), "2026-11-15 0:00");
	assert.equal(w.end.getTime() - w.start.getTime(), 31 * 86_400_000 + 3_600_000);
});

test("/usage reset-day: parses its argument, writes the file, and says what it did", () => {
	assert.deepEqual(parseResetDayArgs("ollama 14"), { day: 14 });
	assert.deepEqual(parseResetDayArgs("  ollama   clear "), { day: null });
	for (const bad of ["", "ollama", "ollama 0", "ollama 32", "ollama 1.5", "ollama x", "openai 3", "ollama 3 4"])
		assert.ok("error" in parseResetDayArgs(bad), bad);
	const dir = tmpAgent();
	assert.deepEqual(runResetDay("ollama 14", dir), { message: "Ollama Cloud resets on day 14 of each month.", level: "info" });
	assert.deepEqual(readUsageWindows(dir), { version: 1, ollama: { resetDay: 14 } });
	assert.deepEqual(runResetDay("ollama 40", dir), { message: "Usage: /usage reset-day ollama <1-31|clear>", level: "warning" });
	assert.deepEqual(readUsageWindows(dir), { version: 1, ollama: { resetDay: 14 } }, "a bad argument writes nothing");
	assert.deepEqual(runResetDay("ollama clear", dir), { message: "Ollama Cloud's reset day is cleared.", level: "info" });
	assert.deepEqual(readUsageWindows(dir), { version: 1 });
});
