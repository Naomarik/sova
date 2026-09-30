// Run: npx tsx --test src/lib/working-hours.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { daysWords, hoursLine, hoursWords, offHoursNote, sentOffHours, theirClock, validZone } from "./working-hours";

const NOW = new Date(2026, 8, 30, 15, 0).getTime(); // a Wednesday, the operator's clock
const tomorrow9 = new Date(2026, 9, 1, 9, 0).toISOString();

test("daysWords: runs of 3 or more joined with a dash, a run across Sunday kept whole, the extremes in words", () => {
  assert.equal(daysWords([1, 2, 3, 4, 5]), "Mon–Fri");
  assert.equal(daysWords([1, 3, 5]), "Mon, Wed, Fri");
  assert.equal(daysWords([6, 0]), "Sat, Sun");
  assert.equal(daysWords([5, 6, 0, 1]), "Fri–Mon");
  assert.equal(daysWords([0, 1, 2, 3, 4, 5, 6]), "Every day");
  assert.equal(daysWords([]), "No days");
  assert.equal(daysWords([1, 2, 4, 5]), "Mon, Tue, Thu, Fri");
});

test("hoursWords: an overnight window says so", () => {
  assert.equal(hoursWords({ days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" }), "Mon–Fri 09:00–17:00");
  assert.equal(hoursWords({ days: [5, 6], from: "22:00", to: "06:00" }), "Fri, Sat 22:00–06:00 (overnight)");
});

test("validZone and theirClock: an IANA zone or empty; their clock in 24 hours", () => {
  assert.equal(validZone(""), true);
  assert.equal(validZone("Europe/Istanbul"), true);
  assert.equal(validZone("Mars/Olympus"), false);
  assert.equal(theirClock("UTC", Date.UTC(2026, 8, 30, 23, 10)), "23:10");
  assert.equal(theirClock(undefined, NOW), "");
  assert.equal(theirClock("Mars/Olympus", NOW), "");
});

test("hoursLine: hours, zone and whether they're open; a zone alone; nothing when neither is set", () => {
  const hours = { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };
  assert.equal(hoursLine({ tz: "Europe/Istanbul", hours, hoursNow: { open: true } }, NOW), "Mon–Fri 09:00–17:00 · Europe/Istanbul · open now");
  assert.equal(
    hoursLine({ tz: "Europe/Istanbul", hours, hoursNow: { open: false, nextOpen: tomorrow9 } }, NOW),
    "Mon–Fri 09:00–17:00 · Europe/Istanbul · opens Thu 09:00 your time (in 18h)",
  );
  assert.equal(hoursLine({ tz: "Europe/Istanbul" }, NOW), "Europe/Istanbul · no hours set");
  assert.equal(hoursLine({ hours, hoursNow: { open: true } }, NOW), "Mon–Fri 09:00–17:00 · time zone not set · open now");
  assert.equal(hoursLine({}, NOW), null);
});

test("offHoursNote: only while they're off hours; their clock when the zone is known; when their hours start", () => {
  const sam = { name: "Sam Okafor", tz: "UTC" };
  assert.equal(offHoursNote({ ...sam, hoursNow: { open: true } }, NOW), null);
  assert.equal(offHoursNote({ ...sam }, NOW), null);
  const note = offHoursNote({ ...sam, hoursNow: { open: false, nextOpen: tomorrow9 } }, NOW)!;
  assert.match(note, /^Outside Sam Okafor's working hours \(\d\d:\d\d for them\)\. It goes now; their hours start Thu 09:00 your time \(in 18h\)\.$/);
  assert.equal(offHoursNote({ name: "Sam", hoursNow: { open: false } }, NOW), "Outside Sam's working hours. It goes now.");
});

test("withOffHours: a done line gains the tail only when the answer says off hours", async () => {
  const { withOffHours } = await import("./working-hours");
  assert.equal(withOffHours("Handed to Sam Okafor.", "Sam Okafor", tomorrow9, NOW), "Handed to Sam Okafor. Sam Okafor's working hours start Thu 09:00 your time (in 18h).");
  assert.equal(withOffHours("Handed to Sam Okafor.", "Sam Okafor", undefined, NOW), "Handed to Sam Okafor.");
});

test("sentOffHours: said after the operator's own act reached someone off hours", () => {
  assert.equal(sentOffHours("Sam Okafor", tomorrow9, NOW), "Sent. Sam Okafor's working hours start Thu 09:00 your time (in 18h).");
  assert.equal(sentOffHours("Sam Okafor", "nope", NOW), "Sent.");
});
