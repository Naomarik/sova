import assert from "node:assert/strict";
import { test } from "node:test";
import { agoTime, clockTime, relativeTime, stampAgo, stampTime } from "./format.ts";

// Local times, so the tests hold in any time zone.
const at = (month: number, day: number, h: number, m: number, year = 2026) => new Date(year, month - 1, day, h, m).getTime();
const now = at(9, 20, 13, 48);

test("clockTime: 12-hour h:mm with AM/PM, from an ISO string or ms", () => {
	assert.equal(clockTime(at(9, 20, 13, 43)), "1:43 PM");
	assert.equal(clockTime(new Date(at(9, 20, 9, 5)).toISOString()), "9:05 AM");
	assert.equal(clockTime(at(9, 20, 0, 5)), "12:05 AM");
	assert.equal(clockTime(at(9, 20, 12, 0)), "12:00 PM");
	assert.equal(clockTime(at(9, 20, 23, 59)), "11:59 PM");
	assert.equal(clockTime("not a date"), "");
	assert.equal(clockTime(Number.NaN), "");
});

test("stampTime: the clock alone today, with a `Mar 4 ` prefix on any other day", () => {
	assert.equal(stampTime(at(9, 20, 13, 43), now), "1:43 PM");
	assert.equal(stampTime(at(9, 19, 23, 10), now), "Sep 19 11:10 PM");
	assert.equal(stampTime(at(3, 4, 8, 0), now), "Mar 4 8:00 AM");
	assert.equal(stampTime("", now), "");
});

test("relativeTime: just now, minutes, hours, yesterday, days, then the date", () => {
	assert.equal(relativeTime(now - 20_000, now), "just now");
	assert.equal(relativeTime(now + 60_000, now), "just now");
	assert.equal(relativeTime(now - 5 * 60_000, now), "5m ago");
	assert.equal(relativeTime(now - 2 * 3_600_000, now), "2h ago");
	assert.equal(relativeTime(now - 26 * 3_600_000, now), "yesterday");
	assert.equal(relativeTime(now - 3 * 86_400_000, now), "3d ago");
	assert.equal(relativeTime(at(3, 4, 12, 0), now), "Mar 4");
	assert.equal(relativeTime(at(3, 4, 12, 0, 2024), now), "Mar 4, 2024");
	assert.equal(relativeTime(new Date(now - 5 * 60_000).toISOString(), now), "5m ago");
	assert.equal(relativeTime("nope", now), "");
});

test("agoTime is relativeTime while it is an age, and nothing once it is a date", () => {
	for (let h = 0; h < 24 * 10; h += 1) {
		const t = now - h * 3_600_000 - 17 * 60_000;
		const rel = relativeTime(t, now);
		const isDate = !/ago$|^just now$|^yesterday$/.test(rel);
		assert.equal(agoTime(t, now), isDate ? "" : rel, `at ${h}h: ${rel}`);
	}
	assert.equal(agoTime("nope", now), "");
});

test("stampAgo: the stamp and the age, and the stamp alone once the age is a date", () => {
	assert.equal(stampAgo(at(9, 20, 13, 43), now), "1:43 PM · 5m ago");
	assert.equal(stampAgo(at(9, 17, 13, 43), now), "Sep 17 1:43 PM · 3d ago");
	assert.equal(stampAgo(at(3, 4, 8, 0), now), "Mar 4 8:00 AM");
	assert.equal(stampAgo("nope", now), "");
});
