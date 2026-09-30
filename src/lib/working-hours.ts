// A person's working hours (r7, §app.organizations/working-hours): the words the profile, the form
// and the off-hours note say. When their window opens is the server's (the charts' next-window
// rule, `hoursNow`); this file only says it. Pure, for tsx --test.

import type { OfferReach } from "../../shared/baton";
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
export function hoursLine(p: Pick<Person, "tz" | "hours" | "hoursNow"> & { company?: boolean }, now: number): string | null {
  const zone = p.tz?.trim() || "";
  if (!p.hours) return zone ? `${zone} · no hours set` : null;
  const parts = [`${hoursWords(p.hours)}${p.company ? " (company hours)" : ""}`, zone || "time zone not set"];
  const hn = p.hoursNow;
  if (hn?.open) parts.push("open now");
  else if (hn?.nextOpen) parts.push(`opens ${opensWords(hn.nextOpen, now)}`);
  return parts.join(" · ");
}

/**
 * r13: a person with no hours of their own works the company's (`hoursFrom` "company"): the Hours row and
 * the off-hours note read the company's zone and hours then, marked `company`. Their own win; with
 * neither, they're as they are (no hours: always in hours).
 */
export function withCompanyHours<P extends Pick<Person, "tz" | "hours" | "hoursFrom">>(
  p: P,
  org: { tz?: string; hours?: PersonHours | null } | undefined,
): P & { company?: boolean } {
  return p.hoursFrom === "company" && org?.hours ? { ...p, tz: org.tz ?? "", hours: org.hours, company: true } : p;
}

/** The company hours line on the org page: "Mon–Fri 09:00–17:00 · Europe/Istanbul", a zone alone, or null. */
export function companyHoursLine(org: { tz?: string; hours?: PersonHours | null }): string | null {
  const zone = org.tz?.trim() || "";
  if (!org.hours) return zone ? `${zone} · no hours set` : null;
  return `${hoursWords(org.hours)} · ${zone || "time zone not set"}`;
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

/** Said after the operator's own act went to someone off hours (the act's answer carries `offHours`):
    "Sam Okafor's working hours start Tue 09:00 your time (in 18h)." "" when the time is unreadable. */
export function offHoursTail(name: string, offHours: string | undefined, now: number): string {
  const opens = offHours ? opensWords(offHours, now) : "";
  return opens ? `${name}'s working hours start ${opens}.` : "";
}

/** A done line with the off-hours tail when there is one: "Handed to Sam. Sam's working hours start …". */
export const withOffHours = (done: string, name: string, offHours: string | undefined, now: number): string =>
  [done, offHoursTail(name, offHours, now)].filter(Boolean).join(" ");

/** "Sent." with the off-hours tail. */
export const sentOffHours = (name: string, offHours: string, now: number): string => withOffHours("Sent.", name, offHours, now);

/**
 * An offer's invitee (r12): reached (their link made) or waiting for their own working hours. "reached",
 * "waiting until 14:00 your time (in 5h)", "waiting for their working hours" (no window found), or, while
 * the offer is leased, "waiting: nobody new is reached while Ana is answering". Absent reach: reached.
 */
export function reachWords(r: OfferReach | undefined, holder: string | undefined, now: number): string {
  if (!r || r.state === "reached") return "reached";
  if (r.paused) return `waiting: nobody new is reached while ${holder ?? "someone"} is answering`;
  const opens = r.until ? opensWords(r.until, now) : "";
  return opens ? `waiting until ${opens}` : "waiting for their working hours";
}

/** Needs you's note on an open offer's invitees not reached yet: "Bo waiting until 14:00 your time (in 5h); Cy
    waiting for their working hours." Null when nobody waits. */
export function waitingWords(waiting: readonly { name: string; until: string | null }[] | undefined, now: number): string | null {
  if (!waiting?.length) return null;
  return `${waiting.map((w) => `${w.name} ${reachWords({ state: "waiting", until: w.until }, undefined, now)}`).join("; ")}.`;
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
