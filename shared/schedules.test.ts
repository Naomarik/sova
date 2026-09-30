// Run: npx tsx --test shared/schedules.test.ts (or pnpm test)
// A playbook schedule's `when:` line (§chat.schedules/header): the grammar and its errors, the
// 30-minute floor and the 48-a-day cap, the next fire, and daylight saving's gap and repeat.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fireHead, maxFiresPerDay, nextFire, parseWhen, pinSource, scheduleOf, scheduleText, zonedTime, type Trigger } from "./schedules";
import { parseWakeNudge, wakeTitle } from "./wake";

const ok = (line: string): Trigger[] => {
  const r = parseWhen(line);
  assert.ok(r.ok, `${line}: ${r.ok ? "" : r.error}`);
  return r.triggers;
};
const err = (line: string): string => {
  const r = parseWhen(line);
  assert.ok(!r.ok, `${line} should not parse`);
  return r.error;
};
const NY = "America/New_York";
const z = (s: string) => Date.parse(s);

test("the grammar: every trigger kind, case and spacing free", () => {
  const t = ok("Weekdays 09:00, 18:30; every 30m;  CLAUDE-LIMIT-RESET ");
  assert.deepEqual(
    t.map((x) => x.src),
    ["weekdays 09:00,18:30", "every 30m", "claude-limit-reset"],
  );
  assert.equal(scheduleText(t), "Weekdays at 09:00, 18:30 · Every 30 min · When a Claude limit resets");
  assert.equal(scheduleText(ok("daily 07:00")), "Daily at 07:00");
  assert.equal(scheduleText(ok("weekends 10:00")), "Weekends at 10:00");
  assert.equal(scheduleText(ok("fri,mon,wed 09:00")), "Mon, Wed, Fri at 09:00");
  assert.equal(scheduleText(ok("every 1h")), "Every hour");
  assert.equal(scheduleText(ok("every 12h")), "Every 12 hours");
});

test("one bad trigger makes the whole line invalid, with the exact error", () => {
  assert.match(err("daily 9:00"), /"9:00" is not a 24-hour time like 09:00/);
  assert.match(err("daily 24:00"), /"24:00" is not a 24-hour time/);
  assert.match(err("daily 09:00; hourly"), /"hourly" is not a trigger/);
  assert.match(err("mon,xyz 09:00"), /"xyz" is not a day/);
  assert.match(err("daily"), /needs its times/);
  assert.match(err("daily 01:00,02:00,03:00,04:00,05:00"), /At most 4 times per trigger/);
  assert.match(err("daily 01:00; weekdays 02:00; weekends 03:00; claude-limit-reset"), /At most 3 triggers per line; this one has 4/);
  assert.match(err(""), /empty/);
  assert.match(err("daily 09:00;;every 2h"), /empty trigger/);
});

test("30 minutes is the floor: every 10m, 45m or 5h are refused", () => {
  for (const line of ["every 10m", "every 45m", "every 5h", "every 0h", "every 24h"]) assert.match(err(line), /every takes 30m or 1h, 2h, 3h, 4h, 6h, 8h, 12h/);
  assert.equal(ok("every 30m")[0]!.kind, "every");
});

test("at most 48 fires on any day: every 30m fits, one more time does not", () => {
  assert.equal(maxFiresPerDay(ok("every 30m")).n, 48);
  // 09:00 lands on a half hour, so it adds nothing; 09:15 would be a 49th fire.
  assert.equal(maxFiresPerDay(ok("every 30m; daily 09:00")).n, 48);
  assert.match(err("every 30m; weekdays 09:15"), /It could fire 49 times on Mon; a schedule fires at most 48 times a day/);
  // Weekend-only extras count on those days only.
  assert.match(err("every 30m; sat 09:15"), /49 times on Sat/);
});

test("the header: profile is required, tz must be a zone, task is optional", () => {
  assert.equal(scheduleOf({ title: "x" }), null);
  assert.match(scheduleOf({ when: "daily 09:00" })!.error!, /needs profile:/);
  assert.match(scheduleOf({ when: "daily 09:00", profile: "p", tz: "Mars/Olympus" })!.error!, /"Mars\/Olympus" is not a time zone/);
  const h = scheduleOf({ when: "daily 09:00", profile: "merge-captain", tz: "Asia/Dubai", task: "Triage." })!;
  assert.equal(h.error, undefined);
  assert.equal(h.task, "Triage.");
});

test("next fire: the first one strictly after, in the schedule's zone", () => {
  const t = ok("weekdays 09:00");
  // Friday 2026-10-02 10:00 in Dubai (UTC+4): the next is Monday 09:00 Dubai = 05:00Z.
  assert.deepEqual(nextFire(t, z("2026-10-02T06:00:00Z"), "Asia/Dubai"), { at: z("2026-10-05T05:00:00Z"), trigger: "weekdays 09:00" });
  // Exactly at a fire time: strictly after, so the next day's.
  assert.equal(nextFire(t, z("2026-10-05T05:00:00Z"), "Asia/Dubai")!.at, z("2026-10-06T05:00:00Z"));
  // every 2h is aligned to local midnight, not to when it was approved.
  assert.equal(nextFire(ok("every 2h"), z("2026-10-05T05:13:00Z"), "UTC")!.at, z("2026-10-05T06:00:00Z"));
  assert.equal(nextFire(ok("every 30m"), z("2026-10-05T05:13:00Z"), "UTC")!.at, z("2026-10-05T05:30:00Z"));
  // claude-limit-reset alone has no time fires.
  assert.equal(nextFire(ok("claude-limit-reset"), Date.now(), "UTC"), null);
});

test("daylight saving: a skipped local time fires at the next minute that exists", () => {
  // New York springs forward 2026-03-08 02:00 EST → 03:00 EDT; 02:30 doesn't exist that night.
  assert.equal(zonedTime(2026, 3, 8, 2, 30, NY), z("2026-03-08T07:00:00Z")); // 03:00 EDT
  assert.equal(nextFire(ok("daily 02:30"), z("2026-03-07T17:00:00Z"), NY)!.at, z("2026-03-08T07:00:00Z"));
  // every 30m through the gap: 02:00 and 02:30 both land on 03:00, which fires once, then 03:30.
  const t = ok("every 30m");
  const first = nextFire(t, z("2026-03-08T06:45:00Z"), NY)!.at; // 01:45 EST
  assert.equal(first, z("2026-03-08T07:00:00Z"));
  assert.equal(nextFire(t, first, NY)!.at, z("2026-03-08T07:30:00Z"));
});

test("daylight saving: a repeated local time fires once, at its first occurrence", () => {
  // New York falls back 2026-11-01 02:00 EDT → 01:00 EST; 01:30 happens twice.
  assert.equal(zonedTime(2026, 11, 1, 1, 30, NY), z("2026-11-01T05:30:00Z")); // 01:30 EDT
  const daily = ok("daily 01:30");
  const first = nextFire(daily, z("2026-10-31T16:00:00Z"), NY)!.at;
  assert.equal(first, z("2026-11-01T05:30:00Z"));
  assert.equal(nextFire(daily, first, NY)!.at, z("2026-11-02T06:30:00Z"), "not again at 01:30 EST the same night");
  // every 1h: 01:00 fires once (EDT), then 02:00 EST.
  const hourly = ok("every 1h");
  const one = nextFire(hourly, z("2026-11-01T04:30:00Z"), NY)!.at;
  assert.equal(one, z("2026-11-01T05:00:00Z"));
  assert.equal(nextFire(hourly, one, NY)!.at, z("2026-11-01T07:00:00Z"));
});

test("the pin covers when, tz and the profile's identity and powers; not the task or spacing", () => {
  const profile = { key: "project:/r#merge-captain", remove: ["web"], grant: ["sessions.read"], singleton: true, overseerMayStart: false };
  const base = pinSource({ triggers: ok("every 30m; claude-limit-reset") }, profile);
  assert.equal(pinSource({ triggers: ok("Every 30m ;claude-limit-reset") }, profile), base, "reformatting is not a change");
  assert.notEqual(pinSource({ triggers: ok("every 1h; claude-limit-reset") }, profile), base);
  assert.notEqual(pinSource({ tz: "UTC", triggers: ok("every 30m; claude-limit-reset") }, profile), base);
  assert.notEqual(pinSource({ triggers: ok("every 30m; claude-limit-reset") }, { ...profile, grant: ["sessions.read", "sessions.message"] }), base);
  assert.notEqual(pinSource({ triggers: ok("every 30m; claude-limit-reset") }, { ...profile, key: "user:merge-captain" }), base);
  assert.notEqual(pinSource({ triggers: ok("every 30m; claude-limit-reset") }, { ...profile, singleton: false }), base);
});

test("a fire's message parses as a wake card named Scheduled run, reading only its head", () => {
  const text = `${fireHead("s3", "every 30m", "merge-round", "Run this playbook", 12 * 60_000)}\n\nPlaybook: Merge round — /r\nReason: a line in the body`;
  const w = parseWakeNudge(text)!;
  assert.deepEqual(w, { id: "s3", schedule: true, late: "12m", reason: "Run this playbook" });
  assert.equal(wakeTitle(w), "Scheduled run s3");
  assert.deepEqual(parseWakeNudge(fireHead("s1", "claude-limit-reset", "p", "Claude login A is ready again.")), { id: "s1", schedule: true, reason: "Claude login A is ready again." });
  // A message merely quoting the tag later is not a fire.
  assert.equal(parseWakeNudge(`Look at this:\n${fireHead("s1", "every 1h", "p", "x")}`), null);
});
