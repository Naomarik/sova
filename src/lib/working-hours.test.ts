// Run: npx tsx --test src/lib/working-hours.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { companyHoursLine, daysWords, hoursLine, hoursWords, offHoursNote, reachWords, sentOffHours, theirClock, validZone, waitingWords, withCompanyHours } from "./working-hours";

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

test("r12: an offer's invitee is reached, waiting until their window (your time), waiting with no window, or paused by a lease", () => {
  const at19 = new Date(2026, 8, 30, 19, 0).toISOString();
  assert.equal(reachWords(undefined, undefined, NOW), "reached", "no reach (an offer from before r12): reached");
  assert.equal(reachWords({ state: "reached", at: at19 }, undefined, NOW), "reached");
  assert.equal(reachWords({ state: "waiting", until: at19 }, undefined, NOW), "waiting until 19:00 your time (in 4h)");
  assert.equal(reachWords({ state: "waiting", until: tomorrow9 }, undefined, NOW), "waiting until Thu 09:00 your time (in 18h)");
  assert.equal(reachWords({ state: "waiting", until: null }, undefined, NOW), "waiting for their working hours");
  assert.equal(reachWords({ state: "waiting", until: "garbage" }, undefined, NOW), "waiting for their working hours");
  assert.equal(reachWords({ state: "waiting", until: at19, paused: true }, "Ana", NOW), "waiting: nobody new is reached while Ana is answering");
  assert.equal(reachWords({ state: "waiting", until: at19, paused: true }, undefined, NOW), "waiting: nobody new is reached while someone is answering");
});

test("r12: Needs you's note lists every invitee not reached yet, or nothing", () => {
  assert.equal(waitingWords(undefined, NOW), null);
  assert.equal(waitingWords([], NOW), null);
  assert.equal(
    waitingWords([{ name: "Bo", until: tomorrow9 }, { name: "Cy", until: null }], NOW),
    "Bo waiting until Thu 09:00 your time (in 18h); Cy waiting for their working hours.",
  );
});

test("r13: company hours are the default: the Hours row says (company hours) and reads the company's zone; their own win; neither, nothing", () => {
  const company = { tz: "Europe/Istanbul", hours: { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" } };
  const inherits = { name: "Bo", tz: "", hours: null, hoursFrom: "company" as const, hoursNow: { open: true } };
  const w = withCompanyHours(inherits, company);
  assert.equal(hoursLine(w, NOW), "Mon–Fri 09:00–17:00 (company hours) · Europe/Istanbul · open now");
  assert.equal(offHoursNote(withCompanyHours({ ...inherits, hoursNow: { open: false, nextOpen: tomorrow9 } }, company), NOW)?.startsWith("Outside Bo's working hours ("), true, "their clock from the company's zone");
  const own = { name: "Ana", tz: "Asia/Dubai", hours: { days: [0], from: "10:00", to: "12:00" }, hoursFrom: "own" as const };
  assert.equal(hoursLine(withCompanyHours(own, company), NOW), "Sun 10:00–12:00 · Asia/Dubai");
  assert.equal(hoursLine(withCompanyHours({ tz: "", hours: null }, company), NOW), null, "neither: no Hours row");
  assert.equal(hoursLine(withCompanyHours(inherits, { tz: "Europe/Istanbul", hours: null }), NOW), null, "the company's gone: nothing to borrow");
});

test("r13: the org page's company hours line", () => {
  assert.equal(companyHoursLine({ tz: "Europe/Istanbul", hours: { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" } }), "Mon–Fri 09:00–17:00 · Europe/Istanbul");
  assert.equal(companyHoursLine({ tz: "Europe/Istanbul" }), "Europe/Istanbul · no hours set");
  assert.equal(companyHoursLine({ hours: { days: [6], from: "22:00", to: "06:00" } }), "Sat 22:00–06:00 (overnight) · time zone not set");
  assert.equal(companyHoursLine({}), null);
});
