/**
 * A playbook's schedule (§chat/schedules): the `when:` line's grammar, its words, the pin an
 * approval covers, and the next fire in a time zone, daylight saving included. Pure and shared (the
 * server's keeper and catalog; the client only reads what the server computed). Imports nothing.
 *
 *   when    := trigger (';' trigger)*            at most 3 triggers
 *   trigger := daily T | weekdays T | weekends T | <day>,<day>… T | every 30m | every Nh | claude-limit-reset
 *   T       := HH:MM (',' HH:MM)*                24-hour, at most 4
 *
 * `every` is aligned to local midnight (every 2h = 00:00, 02:00, …), so a restart never drifts it.
 */

export type TimesTrigger = { kind: "times"; days: number[]; minutes: number[]; src: string };
export type EveryTrigger = { kind: "every"; minutes: number; src: string };
export type LimitTrigger = { kind: "limit-reset"; src: "claude-limit-reset" };
export type Trigger = TimesTrigger | EveryTrigger | LimitTrigger;

export const MAX_TRIGGERS = 3;
export const MAX_TIMES = 4;
export const MAX_FIRES_PER_DAY = 48;
export const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12] as const;
export const LIMIT_RESET = "claude-limit-reset";
export const DEFAULT_TASK = "Run this playbook";

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_WORDS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKENDS = [0, 6];

export type ParsedWhen = { ok: true; triggers: Trigger[] } | { ok: false; error: string };

function parseTimes(raw: string, trigger: string): number[] | string {
  const parts = raw.split(",").map((t) => t.trim());
  if (!raw.trim() || parts.some((t) => !t)) return `"${trigger}" needs its times, like ${trigger.split(/\s+/)[0]} 09:00`;
  if (parts.length > MAX_TIMES) return `At most ${MAX_TIMES} times per trigger; "${trigger}" has ${parts.length}`;
  const out: number[] = [];
  for (const t of parts) {
    const m = /^(\d{2}):(\d{2})$/.exec(t);
    const h = m ? Number(m[1]) : NaN;
    const mi = m ? Number(m[2]) : NaN;
    if (!m || h > 23 || mi > 59) return `"${t}" is not a 24-hour time like 09:00`;
    const at = h * 60 + mi;
    if (!out.includes(at)) out.push(at);
  }
  return out.sort((a, b) => a - b);
}

function parseTrigger(src: string): Trigger | string {
  const t = src.trim().replace(/\s+/g, " ");
  const lower = t.toLowerCase();
  if (lower === LIMIT_RESET) return { kind: "limit-reset", src: LIMIT_RESET };
  const every = /^every (\S+)$/.exec(lower);
  if (every) {
    const v = every[1]!;
    if (v === "30m") return { kind: "every", minutes: 30, src: "every 30m" };
    const h = /^(\d+)h$/.exec(v);
    if (h && (EVERY_HOURS as readonly number[]).includes(Number(h[1]))) return { kind: "every", minutes: Number(h[1]) * 60, src: `every ${Number(h[1])}h` };
    return `"${t}": every takes 30m or ${EVERY_HOURS.map((n) => `${n}h`).join(", ")} (30 minutes is the shortest)`;
  }
  const sp = t.indexOf(" ");
  const head = (sp < 0 ? t : t.slice(0, sp)).toLowerCase();
  const rest = sp < 0 ? "" : t.slice(sp + 1);
  let days: number[] | null = null;
  if (head === "daily") days = [0, 1, 2, 3, 4, 5, 6];
  else if (head === "weekdays") days = WEEKDAYS;
  else if (head === "weekends") days = WEEKENDS;
  else if (/^[a-z]{3}(,[a-z]{3})*$/.test(head)) {
    days = [];
    for (const d of head.split(",")) {
      const i = (DAY_NAMES as readonly string[]).indexOf(d);
      if (i < 0) return `"${d}" is not a day; use mon, tue, wed, thu, fri, sat or sun`;
      if (!days.includes(i)) days.push(i);
    }
    days.sort((a, b) => a - b);
  }
  if (!days) return `"${t}" is not a trigger. Use daily, weekdays, weekends, a day list like mon,wed,fri, every 30m, every Nh or ${LIMIT_RESET}`;
  const minutes = parseTimes(rest, t);
  if (typeof minutes === "string") return minutes;
  return { kind: "times", days, minutes, src: `${head} ${minutes.map(hhmm).join(",")}` };
}

/** The minutes of a local day a trigger fires at, on weekday `day` (0 = Sunday). */
export function minutesOn(tr: Trigger, day: number): number[] {
  if (tr.kind === "times") return tr.days.includes(day) ? tr.minutes : [];
  if (tr.kind === "every") return Array.from({ length: Math.floor(1440 / tr.minutes) }, (_, i) => i * tr.minutes);
  return [];
}

/** The most fires any one weekday could have (triggers landing on the same minute fire once). */
export function maxFiresPerDay(triggers: readonly Trigger[]): { n: number; day: number } {
  let best = { n: 0, day: 0 };
  for (let day = 0; day < 7; day++) {
    const all = new Set<number>();
    for (const tr of triggers) for (const m of minutesOn(tr, day)) all.add(m);
    if (all.size > best.n) best = { n: all.size, day };
  }
  return best;
}

/** Parse a `when:` line: every trigger or none (the whole line is invalid on one error). */
export function parseWhen(line: string): ParsedWhen {
  const parts = line.split(";").map((p) => p.trim());
  if (!line.trim()) return { ok: false, error: "when: is empty" };
  if (parts.some((p) => !p)) return { ok: false, error: "when: has an empty trigger between two ;" };
  if (parts.length > MAX_TRIGGERS) return { ok: false, error: `At most ${MAX_TRIGGERS} triggers per line; this one has ${parts.length}` };
  const triggers: Trigger[] = [];
  for (const p of parts) {
    const tr = parseTrigger(p);
    if (typeof tr === "string") return { ok: false, error: tr };
    if (!triggers.some((x) => x.src === tr.src)) triggers.push(tr);
  }
  const max = maxFiresPerDay(triggers);
  if (max.n > MAX_FIRES_PER_DAY) return { ok: false, error: `It could fire ${max.n} times on ${DAY_WORDS[max.day]}; a schedule fires at most ${MAX_FIRES_PER_DAY} times a day` };
  return { ok: true, triggers };
}

/** Whether `tz` is a zone this runtime knows. */
export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The host's own zone now (the default when a schedule names none). */
export const hostZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** A schedule as its header declares it: the four keys, parsed. `error` makes it invalid, whole. */
export interface ScheduleHeader {
  when: string;
  profile?: string;
  tz?: string;
  task?: string;
  triggers?: Trigger[];
  error?: string;
}

/** The schedule a playbook's frontmatter declares, or null when it has no `when:`. */
export function scheduleOf(fields: Readonly<Record<string, string>>): ScheduleHeader | null {
  if (fields.when === undefined) return null;
  const h: ScheduleHeader = { when: fields.when };
  if (fields.profile?.trim()) h.profile = fields.profile.trim();
  if (fields.tz?.trim()) h.tz = fields.tz.trim();
  if (fields.task?.trim()) h.task = fields.task.trim();
  const w = parseWhen(fields.when);
  if (!w.ok) return { ...h, error: w.error };
  if (!h.profile) return { ...h, error: "A schedule needs profile: too, the profile its runs use" };
  if (h.tz && !validZone(h.tz)) return { ...h, error: `"${h.tz}" is not a time zone Sova knows; use an IANA name like Europe/Berlin` };
  return { ...h, triggers: w.triggers };
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** One trigger in words: "Weekdays at 09:00", "Every 30 min", "When a Claude limit resets". */
export function triggerText(tr: Trigger): string {
  if (tr.kind === "limit-reset") return "When a Claude limit resets";
  if (tr.kind === "every") return tr.minutes === 30 ? "Every 30 min" : tr.minutes === 60 ? "Every hour" : `Every ${tr.minutes / 60} hours`;
  const at = tr.minutes.map(hhmm).join(", ");
  const d = tr.days.join(",");
  const days = d === "0,1,2,3,4,5,6" ? "Daily" : d === WEEKDAYS.join(",") ? "Weekdays" : d === WEEKENDS.join(",") ? "Weekends" : tr.days.map((i) => DAY_WORDS[i]).join(", ");
  return `${days} at ${at}`;
}

/** The whole schedule in words, "Every 30 min · When a Claude limit resets". */
export const scheduleText = (triggers: readonly Trigger[]): string => triggers.map(triggerText).join(" · ");

/** The canonical `when:` line (case, spacing): what the pin compares, so reformatting never re-asks. */
export const canonicalWhen = (triggers: readonly Trigger[]): string => triggers.map((t) => t.src).join("; ");

/**
 * What an approval covers (§chat.schedules/approval), as one canonical string: the `when:` and `tz:`
 * lines, the linked profile's identity and its powers. The instructions and `task:` are not in it.
 */
export function pinSource(h: Pick<ScheduleHeader, "tz"> & { triggers: readonly Trigger[] }, profile: { key: string; remove: readonly string[]; grant: readonly string[]; singleton: boolean; overseerMayStart: boolean }): string {
  return JSON.stringify({
    when: canonicalWhen(h.triggers),
    tz: h.tz ?? null,
    profile: profile.key,
    remove: [...profile.remove].sort(),
    grant: [...profile.grant].sort(),
    singleton: profile.singleton,
    overseerMayStart: profile.overseerMayStart,
  });
}

// ── Time zones ──────────────────────────────────────────────────────────────────────────────────

export interface Wall {
  y: number;
  m: number; // 1..12
  d: number;
  h: number;
  mi: number;
  wd: number; // 0 = Sunday
}

const fmts = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    fmts.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at epoch `t`. */
export function wallOf(t: number, tz: string): Wall & { s: number } {
  const parts: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(t))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  const h = parts.hour === 24 ? 0 : parts.hour!;
  const wd = new Date(Date.UTC(parts.year!, parts.month! - 1, parts.day!)).getUTCDay();
  return { y: parts.year!, m: parts.month!, d: parts.day!, h, mi: parts.minute!, s: parts.second!, wd };
}

/** `tz`'s offset from UTC at `t`, in ms (local = UTC + offset). */
function offsetAt(t: number, tz: string): number {
  const w = wallOf(t, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
}

const sameWall = (a: Wall, y: number, m: number, d: number, h: number, mi: number) => a.y === y && a.m === m && a.d === d && a.h === h && a.mi === mi;

/**
 * The epoch of a local wall time in `tz`. A time that happens twice (the hour a clock goes back)
 * is its first occurrence; one that doesn't exist (the hour a clock skips) is the next minute that
 * does.
 */
export function zonedTime(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  for (let k = 0; k <= 24 * 60; k++) {
    const n = new Date(Date.UTC(y, m - 1, d, h, mi + k));
    const [Y, M, D, H, MI] = [n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), n.getUTCHours(), n.getUTCMinutes()];
    const guess = n.getTime();
    const found = new Set<number>();
    for (const probe of [guess - 14 * 3600_000, guess, guess + 14 * 3600_000]) {
      const t = guess - offsetAt(probe, tz);
      if (sameWall(wallOf(t, tz), Y, M, D, H, MI)) found.add(t);
    }
    if (found.size) return Math.min(...found);
  }
  return Date.UTC(y, m - 1, d, h, mi); // unreachable for real zones
}

/** The local date `k` days after `w`'s. */
function addDays(w: Pick<Wall, "y" | "m" | "d">, k: number): { y: number; m: number; d: number; wd: number } {
  const n = new Date(Date.UTC(w.y, w.m - 1, w.d + k));
  return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate(), wd: n.getUTCDay() };
}

/** The first time any trigger fires strictly after `after`, in `tz`, with the trigger that fires then; null for none (only claude-limit-reset). */
export function nextFire(triggers: readonly Trigger[], after: number, tz: string): { at: number; trigger: string } | null {
  const today = wallOf(after, tz);
  let best: { at: number; trigger: string } | null = null;
  for (let k = -1; k <= 8; k++) {
    const day = addDays(today, k);
    for (const tr of triggers) {
      for (const min of minutesOn(tr, day.wd)) {
        const at = zonedTime(day.y, day.m, day.d, Math.floor(min / 60), min % 60, tz);
        if (at > after && (!best || at < best.at)) best = { at, trigger: tr.src };
      }
    }
    if (best && k >= 1) break;
  }
  return best;
}

/** The local day key "2026-09-30" of `t` in `tz`: the 48-a-day count's day. */
export function dayKey(t: number, tz: string): string {
  const w = wallOf(t, tz);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** "12m", "1h 5m": how late a fire is. */
export function lateText(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

// ── The fired message ───────────────────────────────────────────────────────────────────────────

/** The fire line, the optional late line and the reason, as a wake card parses them (shared/wake.ts). */
export function fireHead(id: string, trigger: string, playbook: string, reason: string, lateMs?: number): string {
  const lines = [`[schedule ${id}] Scheduled run fired (${trigger}, playbook ${playbook}).`];
  if (lateMs !== undefined) lines.push(`Late by ${lateText(lateMs)} (Sova was not running).`);
  lines.push(`Reason: ${reason}`);
  return lines.join("\n");
}

/** A wake's instruction: run the playbook again, re-reading its entry file (PLAYBOOK.md or SKILL.md, as read at this fire). */
export const wakeInstruction = (title: string, dir: string, entry: string): string => `Run the playbook "${title}" again: read ${dir}/${entry} first, since it may have changed.`;

export const LIMIT_RESET_INSTRUCTION = "Your last turn stopped at that Claude login's usage limit, which has now reset. Continue where you left off.";
