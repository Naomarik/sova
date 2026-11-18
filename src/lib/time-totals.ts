// The Agents page's Time Spent tab (#/agents/time): its range and project filter, its address,
// and the pure shaping of what the usage helper's `time` answer says. Nothing here touches the
// DOM, so it runs under the unit tests.

import type { TimeSpentRow } from "../../shared/time-spent";
import type { UsageTime, UsageTimeDay, UsageTimeLabel, UsageTimeModelRow, UsageTimeProjectRow, UsageTimeSessionRow, UsageTimeSince, UsageTimeTotals, UsageTimeWhat, UsageTimeWho } from "../../shared/usage/time";
import { type CostRange, DEFAULT_COST_RANGE, dayKey } from "./cost-history";
import { compactModel, shortDate } from "./format";
import { READING_LABELS, wholeSeconds } from "./time-spent-view";

// ---- the address ----

/** What the tab shows: a range, and one project's row (its key), or every project. */
export interface TimeQuery {
  range: CostRange;
  project: string | null;
}
export const DEFAULT_TIME_QUERY: TimeQuery = { range: DEFAULT_COST_RANGE, project: null };

const isRange = (v: string | null): v is CostRange => v === "7d" || v === "30d" || v === "all";

/** The query from the part of the hash after `?` (with or without it). A bad range falls to the default. */
export function parseTimeQuery(search: string): TimeQuery {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const range = p.get("range");
  const project = p.get("project")?.trim() || null;
  return { range: isRange(range) ? range : DEFAULT_COST_RANGE, project };
}

/** The query as URL parameters, defaults left out. */
export function timeSearch(q: TimeQuery): string {
  const p = new URLSearchParams();
  if (q.range !== DEFAULT_COST_RANGE) p.set("range", q.range);
  if (q.project) p.set("project", q.project);
  return p.toString();
}

/** The tab's address: `#/agents/time`, and `?…` when something differs from the defaults. */
export function timeHref(q: TimeQuery = DEFAULT_TIME_QUERY): string {
  const s = timeSearch(q);
  return s ? `#/agents/time?${s}` : "#/agents/time";
}

/** The tab's query if `hash` is its address, else null. `#/agents/time/…` and `#/agents/timex` are not it. */
export function timeRouteFromHash(hash: string): TimeQuery | null {
  const m = /^#\/agents\/time(?:\?(.*))?$/.exec(hash);
  return m ? parseTimeQuery(m[1] ?? "") : null;
}

/** The request's parameters: the address's, the range always said, and the zone whose local days count. */
export function timeApiSearch(q: TimeQuery, tz: string): string {
  const p = new URLSearchParams(timeSearch(q));
  if (!p.has("range")) p.set("range", q.range);
  p.set("tz", tz);
  return p.toString();
}

// ---- words ----

/** Hours and minutes, plainly: `0m`, `45m`, `3h 05m`, `120h 00m`. Seconds under a minute round to the nearest minute. */
export function hoursWords(seconds: number): string {
  const m = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Agent hours per your hour: `4.2×`; `—` when you have no time to divide by. */
export function ratioWords(agents: number, you: number): string {
  // One decimal and ×, as the copy deck says; a row with none of your time has no ratio.
  if (!(you > 0) || !Number.isFinite(agents)) return "—";
  const r = Math.max(0, agents) / you;
  return `${r >= 100 ? Math.round(r) : r.toFixed(1)}×`;
}

/** A share in whole percent: `68%`, with `<1%` and `>99%` where rounding would claim what isn't exact. */
export function percentWords(part: number, of: number): string {
  if (!(of > 0)) return "—";
  const s = Math.max(0, part) / of;
  if (s <= 0) return "0%";
  if (s >= 1) return "100%";
  if (s < 0.005) return "<1%";
  if (s >= 0.995) return ">99%";
  return `${Math.round(s * 100)}%`;
}

// ---- the headline ----

export interface HeadlineStat {
  key: "you" | "agents" | "ratio" | "away";
  label: string;
  value: string;
  note: string;
  title?: string;
}

/** The four figures at the top: You, Agents, Agent Hours Per Your Hour, While You Were Away. */
export function headline(t: UsageTimeTotals, who: Partial<Record<UsageTimeWho, number>>): HeadlineStat[] {
  const days = t.daysYou;
  const perDay = days > 0 ? `${hoursWords(t.you / days)} a day you were here` : "No day of yours recorded";
  const workers = who.worker ?? 0;
  return [
    { key: "you", label: "You", value: hoursWords(t.you), note: perDay },
    { key: "agents", label: "Agents", value: hoursWords(t.agents), note: t.agents > 0 ? `${percentWords(workers, t.agents)} by workers` : "No agent time" },
    {
      key: "ratio",
      label: "Agent Hours Per Your Hour",
      value: ratioWords(t.ratioAgents, t.ratioYou),
      note: "On the days you were here",
      title: `${hoursWords(t.ratioAgents)} of agent time over ${hoursWords(t.ratioYou)} of yours, on the ${days} ${days === 1 ? "day" : "days"} your time was recorded.`,
    },
    { key: "away", label: "While You Were Away", value: hoursWords(t.away), note: t.agents > 0 ? `${percentWords(t.away, t.agents)} of agent time` : "No agent time" },
  ];
}

// ---- the daily chart ----

/** One bar: a day, or a week starting Monday when the range is long. */
export interface TimeBar {
  from: string;
  to: string;
  you: number;
  agents: number;
}

/** Past this many days a bar is a week, as on the Costs tab. */
export const TIME_DAY_BARS_MAX = 62;

const dayDate = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * The chart's bars, oldest first: every day of the range up to `today`, an empty day a zero bar.
 * 7d and 30d count back from today; All starts at the first day with any time. Over
 * TIME_DAY_BARS_MAX days the bars are weeks starting Monday.
 */
export function timeBars(daily: readonly UsageTimeDay[], range: CostRange, today: string): TimeBar[] {
  const by = new Map<string, { you: number; agents: number }>();
  for (const d of daily) {
    const at = by.get(d.day) ?? { you: 0, agents: 0 };
    at.you += Math.max(0, d.you);
    at.agents += Math.max(0, d.agents);
    by.set(d.day, at);
  }
  const end = dayDate(today);
  const first = [...by.entries()].filter(([, v]) => v.you > 0 || v.agents > 0).map(([k]) => k).sort()[0];
  const start = range === "all" ? (first && first <= today ? dayDate(first) : end) : addDays(end, -(range === "7d" ? 7 : 30) + 1);
  const days: TimeBar[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const k = dayKey(d);
    const v = by.get(k);
    days.push({ from: k, to: k, you: v?.you ?? 0, agents: v?.agents ?? 0 });
  }
  if (days.length <= TIME_DAY_BARS_MAX) return days;
  const weeks: TimeBar[] = [];
  for (const d of days) {
    const last = weeks[weeks.length - 1];
    if (last && dayDate(d.from).getDay() !== 1) {
      last.to = d.to;
      last.you += d.you;
      last.agents += d.agents;
    } else weeks.push({ ...d });
  }
  return weeks;
}

/** A bar's two heights, 0..1 of the chart: the taller of its own two figures sets the bar, the chart's tallest figure sets the scale. */
export function barHeights(bar: TimeBar, bars: readonly TimeBar[]): { agents: number; you: number } {
  const max = Math.max(0, ...bars.map((b) => Math.max(b.agents, b.you)));
  if (!(max > 0)) return { agents: 0, you: 0 };
  return { agents: bar.agents / max, you: bar.you / max };
}

/** "Oct 4", or "Sep 29 – Oct 5" for a week bar. */
export function barDays(bar: Pick<TimeBar, "from" | "to">, now: number): string {
  const at = (k: string) => shortDate(new Date(`${k}T12:00:00`).getTime(), now);
  return bar.from === bar.to ? at(bar.from) : `${at(bar.from)} – ${at(bar.to)}`;
}

/** A bar's hover and its words for assistive technology. */
export const barWords = (bar: TimeBar, now: number) => `${barDays(bar, now)} · You ${hoursWords(bar.you)} · Agents ${hoursWords(bar.agents)}`;

// ---- Your Time ----

/** One row of a section's list: its label, its seconds, and what it opens to. */
export interface TimeLine {
  key: string;
  label: string;
  seconds: number;
  parts?: TimeLine[];
}

const YOUR_ROWS: readonly { key: TimeSpentRow; label: string }[] = [
  { key: "typing", label: "Typing" },
  { key: "dictating", label: "Dictating" },
  { key: "scrolling", label: "Scrolling" },
  { key: "changes", label: "Reviewing Changes" },
  { key: "screenshots", label: "Reviewing Screenshots" },
  { key: "tours", label: "Viewing Tours" },
  { key: "other", label: "Other" },
];
const ALL_ROWS: readonly TimeSpentRow[] = [...READING_LABELS.map((r) => r.key), ...YOUR_ROWS.map((r) => r.key)];

/**
 * Your Time's rows, the session tab's own, summed: Reading first (opening to Main Thread,
 * Alignments, Workers), then the rest, most first. Whole seconds that add up to the total; rows
 * with no time left out.
 */
export function yourLines(rows: Partial<Record<TimeSpentRow, number>>): TimeLine[] {
  const whole = wholeSeconds<TimeSpentRow>(rows, ALL_ROWS);
  const parts = READING_LABELS.map((r) => ({ key: r.key as string, label: r.label as string, seconds: whole[r.key] })).filter((r) => r.seconds > 0);
  const reading = parts.reduce((n, p) => n + p.seconds, 0);
  const rest = YOUR_ROWS.map((r) => ({ key: r.key as string, label: r.label, seconds: whole[r.key] }))
    .filter((r) => r.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
  return [...(reading > 0 ? [{ key: "reading", label: "Reading", seconds: reading, parts }] : []), ...rest];
}

// ---- Agent Time ----

const WHO: readonly { key: UsageTimeWho; label: string }[] = [
  { key: "worker", label: "Workers" },
  { key: "main", label: "Main Threads" },
  { key: "overseer", label: "Overseer" },
];
const WHAT: readonly { key: UsageTimeWhat; label: string }[] = [
  { key: "waiting", label: "Waiting For The Model" },
  { key: "thinking", label: "Thinking" },
  { key: "writing", label: "Writing" },
  { key: "tools", label: "Running Tools" },
];

/** Who worked: Workers, Main Threads, Overseer, most first, empty rows left out. */
export const whoLines = (who: Partial<Record<UsageTimeWho, number>>): TimeLine[] =>
  WHO.map((w) => ({ key: w.key as string, label: w.label, seconds: Math.max(0, who[w.key] ?? 0) }))
    .filter((r) => r.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);

/** On what: the four kinds, most first, empty rows left out. */
export const whatLines = (what: Partial<Record<UsageTimeWhat, number>>): TimeLine[] =>
  WHAT.map((w) => ({ key: w.key as string, label: w.label, seconds: Math.max(0, what[w.key] ?? 0) }))
    .filter((r) => r.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);

/** Hours per model, most first; a model's name shortened as the other tabs do. */
export const modelLines = (rows: readonly UsageTimeModelRow[]): TimeLine[] =>
  rows
    .filter((r) => r.seconds > 0)
    .map((r) => ({ key: `${r.provider}/${r.model}`, label: compactModel(r.model) ?? r.model, seconds: r.seconds }))
    .sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));

/** The ratio cell of a By Project row: `—` with none of your time. */
export const rowRatioWords = (r: Pick<UsageTimeProjectRow, "you" | "ratio">) => (r.you > 0 && r.ratio !== null && Number.isFinite(r.ratio) ? ratioWords(r.ratio, 1) : "—");

/** A row's bar length, 0..1 of the longest row in its list. */
export function lineShare(line: TimeLine, lines: readonly TimeLine[]): number {
  const max = Math.max(0, ...lines.map((l) => l.seconds));
  return max > 0 ? line.seconds / max : 0;
}

// ---- By Project and Top Sessions ----

/** By Project in its order: your time first, then agent time, then name; Other folders always last.
    With a project picked, only its row: the filter applies to everything on the tab. */
export function timeProjectRows<T extends Pick<UsageTimeProjectRow, "key" | "you" | "agents" | "name" | "kind">>(rows: readonly T[], picked: string | null = null): T[] {
  if (picked) return rows.filter((r) => r.key === picked);
  const sorted = [...rows].sort((a, b) => b.you - a.you || b.agents - a.agents || a.name.localeCompare(b.name));
  return [...sorted.filter((r) => r.kind !== "other"), ...sorted.filter((r) => r.kind === "other")];
}

/** Top Sessions in order: your time first, then agent time. A row's agents and cost are its family's (its workers' included). */
export const timeSessionRows = (rows: readonly UsageTimeSessionRow[]): UsageTimeSessionRow[] =>
  [...rows].sort((a, b) => b.you - a.you || b.agents - a.agents || a.sid.localeCompare(b.sid));

// ---- Your Messages ----

const MESSAGE_ROWS: readonly { key: UsageTimeLabel; label: string }[] = [
  { key: "specifying", label: "Specifying" },
  { key: "directing", label: "Directing" },
  { key: "reworking", label: "Reworking" },
  { key: "asking", label: "Asking" },
  { key: "unsorted", label: "Unsorted" },
];

export interface MessageLine extends TimeLine {
  count: number;
}

/** Your Messages' rows in the session tab's order, rows with no message left out. */
export function messageRows(rows: UsageTime["messages"]["rows"]): MessageLine[] {
  const by = new Map(rows.map((r) => [r.label, r]));
  return MESSAGE_ROWS.flatMap(({ key, label }) => {
    const r = by.get(key);
    return r && (r.count > 0 || r.seconds > 0) ? [{ key: key as string, label, count: r.count, seconds: Math.max(0, r.seconds) }] : [];
  });
}

/** "12 messages": a count's accessible words. */
export const messageCount = (n: number) => `${n} ${n === 1 ? "message" : "messages"}`;

/** Your Messages is offered only while message labels are on (a missing switch, from an older answer: on). */
export const messagesOffered = (m: Pick<UsageTime["messages"], "enabled">) => m.enabled !== false;

// ---- the states ----

/** The answer has nothing at all to show in its range. */
export const isEmptyAnswer = (t: Pick<UsageTimeTotals, "you" | "agents" | "workerWait">) => !(t.you > 0) && !(t.agents > 0) && !(t.workerWait > 0);

/** The empty state's title for the range: "No time recorded in the last 30 days." */
export function timeEmptyTitle(q: Pick<TimeQuery, "range">): string {
  return `No time recorded ${q.range === "7d" ? "in the last 7 days" : q.range === "30d" ? "in the last 30 days" : "yet"}.`;
}

const sinceDate = (t: number | null, now: number) => (t !== null && Number.isFinite(t) ? shortDate(t, now) : null);

/**
 * The foot's sentence: this computer only, and since when each kind of time is counted.
 * "This computer only. Your time is counted since Nov 7, agent time since Oct 13, tool time since Nov 18."
 */
export function sinceWords(since: Pick<UsageTimeSince, "you" | "agents" | "tools">, now: number): string {
  const parts: string[] = [];
  const you = sinceDate(since.you, now);
  const agents = sinceDate(since.agents, now);
  const tools = sinceDate(since.tools, now);
  if (you) parts.push(`Your time is counted since ${you}`);
  if (agents) parts.push(`${parts.length ? "agent" : "Agent"} time since ${agents}`);
  if (tools) parts.push(`${parts.length ? "tool" : "Tool"} time since ${tools}`);
  return parts.length ? `This computer only. ${parts.join(", ")}.` : "This computer only.";
}

/** Agent Time's note on tool time: days before tool runs were recorded count reply time only. Null once every day of the range has it. */
export function toolsNote(since: Pick<UsageTimeSince, "tools">, from: string | null, now: number): string | null {
  const t = since.tools;
  if (t === null || !Number.isFinite(t)) return "Running Tools isn't recorded yet: agent time is reply time only.";
  if (from && dayKey(new Date(t)) <= from) return null;
  return `Running Tools is counted from ${shortDate(t, now)}; earlier days count reply time only.`;
}

/** Your Messages' note: older labels count on the day they were labelled, not sent. Null when none do. */
export function messagesNote(messages: Pick<UsageTime["messages"], "byLabelTime">, since: Pick<UsageTimeSince, "labels">, now: number): string | null {
  if (!messages.byLabelTime) return null;
  const at = sinceDate(since.labels, now);
  return at ? `Messages labelled before ${at} count on the day they were labelled.` : "These messages count on the day they were labelled.";
}

/** The project filter's choices by name, Other folders last; a picked key the answer no longer lists stays, so it can be cleared. */
export function projectChoices(rows: readonly Pick<UsageTimeProjectRow, "key" | "name" | "kind">[] | undefined, picked: string | null): { key: string; name: string }[] {
  const list = (rows ?? []).map((p) => ({ key: p.key, name: p.name, other: p.kind === "other" }));
  if (picked && !list.some((p) => p.key === picked)) list.push({ key: picked, name: projectKeyName(picked), other: false });
  list.sort((a, b) => Number(a.other) - Number(b.other) || a.name.localeCompare(b.name));
  return list.map(({ key, name }) => ({ key, name }));
}

/** A row key's words when no answer names it: a folder's last part, else the key. */
export function projectKeyName(key: string): string {
  if (key === "o") return "Overseer";
  if (key === "x") return "Other folders";
  if (key.startsWith("f:")) return key.slice(2).split("/").filter(Boolean).pop() ?? key;
  return key;
}
