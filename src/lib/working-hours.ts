// A person's working hours (r7, §app.organizations/working-hours): the words the profile, the form
// and the off-hours note say. When their window opens is the server's (the charts' next-window
// rule, `hoursNow`); this file only says it. Pure, for tsx --test.

import type { Person, PersonHours } from "../../shared/orgs";
import { sendAt } from "./pipeline-view";
import { duration } from "./format";

/** The week as the form lists it: Monday first. Values are the wire's (0 = Sunday … 6 = Saturday). */
export const WEEK: readonly { day: number; short: string; long: string }[] = [
  { day: 1, short: "Mon", long: "Monday" },
  { day: 2, short: "Tue", long: "Tuesday" },
  { day: 3, short: "Wed", long: "Wednesday" },
  { day: 4, short: "Thu", long: "Thursday" },
  { day: 5, short: "Fri", long: "Friday" },
  { day: 6, short: "Sat", long: "Saturday" },
  { day: 0, short: "Sun", long: "Sunday" },
];

/** A new person's hours when the operator first turns them on. */
export const DEFAULT_HOURS: PersonHours = { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };

/** Days in words, runs joined: "Mon–Fri", "Mon, Wed, Fri", "Sat–Mon"… "Every day". */
export function daysWords(days: readonly number[]): string {
  const on = new Set(days);
  if (on.size === 0) return "No days";
  if (on.size === 7) return "Every day";
  // Monday first; when a run crosses Sunday into Monday, walk from the first day off instead, so it stays whole.
  const order = WEEK.map((w) => w.day);
  const start = on.has(0) && on.has(1) ? order.findIndex((d) => !on.has(d)) : 0;
  const cycle = [...order.slice(start), ...order.slice(0, start)];
  const runs: number[][] = [];
  for (const d of cycle) {
    if (!on.has(d)) continue;
    const last = runs[runs.length - 1];
    const prev = cycle[cycle.indexOf(d) - 1];
    if (last && prev !== undefined && last[last.length - 1] === prev) last.push(d);
    else runs.push([d]);
  }
  const name = (d: number) => WEEK.find((w) => w.day === d)!.short;
  return runs.map((r) => (r.length >= 3 ? `${name(r[0]!)}–${name(r[r.length - 1]!)}` : r.map(name).join(", "))).join(", ");
}

/** "Mon–Fri 09:00–17:00", "overnight" said when the window crosses midnight. */
export function hoursWords(h: PersonHours): string {
  const overnight = h.to <= h.from;
  return `${daysWords(h.days)} ${h.from}–${h.to}${overnight ? " (overnight)" : ""}`;
}

/** Whether the browser knows this IANA zone. "" is fine (unknown). */
export function validZone(tz: string): boolean {
  if (!tz.trim()) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/** Their clock now, "14:06", or "" when the zone is unknown. */
export function theirClock(tz: string | undefined, now: number): string {
  if (!tz || !validZone(tz)) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(now));
}

/** When a window opens, on the operator's clock, said so beside their own: "Tue 09:00 your time (in 18h)". */
function opensWords(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const ms = t - now;
  return ms > 60_000 ? `${sendAt(t, now)} your time (in ${duration(ms)})` : `${sendAt(t, now)} your time`;
}

/**
 * The profile's Hours line: "Mon–Fri 09:00–17:00 · Europe/Istanbul · open now", or "… · opens Tue 09:00
 * (in 18h)"; with a zone and no hours, "Europe/Istanbul · no hours set"; with neither, null.
 */
export function hoursLine(p: Pick<Person, "tz" | "hours" | "hoursNow">, now: number): string | null {
  const zone = p.tz?.trim() || "";
  if (!p.hours) return zone ? `${zone} · no hours set` : null;
  const parts = [hoursWords(p.hours), zone || "time zone not set"];
  const hn = p.hoursNow;
  if (hn?.open) parts.push("open now");
  else if (hn?.nextOpen) parts.push(`opens ${opensWords(hn.nextOpen, now)}`);
  return parts.join(" · ");
}

/**
 * The note beside the operator's own act that reaches them while they're off hours (r7: it goes at
 * once): "Outside Sam Okafor's working hours (23:10 for them). It goes now; their hours start Tue 09:00
 * (in 9h)." Null inside their hours, or with none set.
 */
export function offHoursNote(p: Pick<Person, "name" | "tz" | "hoursNow">, now: number): string | null {
  const hn = p.hoursNow;
  if (!hn || hn.open) return null;
  const clock = theirClock(p.tz, now);
  const head = `Outside ${p.name}'s working hours${clock ? ` (${clock} for them)` : ""}.`;
  const opens = hn.nextOpen ? opensWords(hn.nextOpen, now) : "";
  return opens ? `${head} It goes now; their hours start ${opens}.` : `${head} It goes now.`;
}

/** Said after the operator's own act went to someone off hours (the act's answer carries `offHours`). */
export function sentOffHours(name: string, offHours: string, now: number): string {
  const opens = opensWords(offHours, now);
  return opens ? `Sent. ${name}'s working hours start ${opens}.` : "Sent.";
}

/** The zones the browser knows, for the form's suggestions; [] where it can't list them. */
export function knownZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}
