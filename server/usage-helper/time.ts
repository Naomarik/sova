import type { TimeSpentRow } from "../../shared/time-spent";
import type { UsageDevice, UsageRange } from "../../shared/usage/wire";
import {
  USAGE_TIME_LABELS,
  USAGE_TIME_TOP_SESSIONS,
  type UsageTime,
  type UsageTimeAgents,
  type UsageTimeDay,
  type UsageTimeLabel,
  type UsageTimeProjectRow,
  type UsageTimeSessionRow,
  type UsageTimeWhat,
  type UsageTimeWho,
  type UsageTimeYou,
} from "../../shared/usage/time";
import type { AttentionStore } from "./attention";
import type { LabelStore } from "./labels";
import type { Ledger } from "./ledger";
import type { PerfStore } from "./perf-store";
import { OTHER_ROW, type Fold, type FoldRow } from "./project-fold";
import { displayModel, validZone, type Queries } from "./query";
import type { ToolRunStore } from "./tool-store";

/**
 * The `time` answer (shared/usage/time.ts): your time from the Time Spent records (living sessions' runs,
 * gone sessions' rollup), agent time from the measured replies ([sentAt, sentAt + endMs], split into
 * waiting, thinking and writing) and the tool runs (a worker wait kept apart, never agent time), each
 * bucketed by local day of the asked zone at query time and folded into the Costs tab's By project rows.
 * Pure over its stores; one answer is kept per ask while no store has changed.
 */

const SLOT_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const WHO: readonly UsageTimeWho[] = ["main", "worker", "overseer"];
const kindOf = (k: string | null | undefined): UsageTimeWho => (k === "worker" || k === "overseer" ? k : "main");

export interface TimeDeps {
  attention: AttentionStore;
  perf: PerfStore;
  tools: ToolRunStore;
  labels: LabelStore;
  ledger: Ledger;
  queries: Queries;
  device: () => string | null;
  now: () => number;
}

export interface TimeAsk {
  range: UsageRange;
  /** A By project row key, or null. */
  project: string | null;
  tz: string;
  fold: Fold;
  /** The message labels switch, as the server reads it (echoed as messages.enabled). */
  labels?: boolean;
}

/** Sorted, merged [start, end) ms spans: is a moment in them, and how much of a span is. */
export class Spans {
  private readonly s: number[] = [];
  private readonly e: number[] = [];

  constructor(spans: [number, number][]) {
    spans.sort((a, b) => a[0] - b[0]);
    for (const [a, b] of spans) {
      if (b <= a) continue;
      const n = this.e.length;
      if (n && a <= this.e[n - 1]!) this.e[n - 1] = Math.max(this.e[n - 1]!, b);
      else {
        this.s.push(a);
        this.e.push(b);
      }
    }
  }

  /** ms of [a, b) inside the spans. */
  overlap(a: number, b: number): number {
    let lo = 0;
    let hi = this.e.length;
    // The first span ending after a.
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.e[mid]! <= a) lo = mid + 1;
      else hi = mid;
    }
    let out = 0;
    for (let i = lo; i < this.s.length && this.s[i]! < b; i++) out += Math.min(b, this.e[i]!) - Math.max(a, this.s[i]!);
    return out;
  }
}

/** Per zone: a 15-minute slot's local day (every zone's offset is a multiple of 15 minutes). */
const zoneDays = new Map<string, { fmt: Intl.DateTimeFormat; slots: Map<number, string> }>();
function slotDay(tz: string): (slot: number) => string {
  let z = zoneDays.get(tz);
  if (!z) {
    if (zoneDays.size >= 4) zoneDays.delete(zoneDays.keys().next().value!);
    z = { fmt: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }), slots: new Map() };
    zoneDays.set(tz, z);
  }
  const { fmt, slots } = z;
  return (slot) => {
    let d = slots.get(slot);
    if (d === undefined) slots.set(slot, (d = fmt.format(slot * SLOT_MS)));
    return d;
  };
}

/** [a, b) ms by local day: calls `fn(day, ms)` once per day it touches. */
function byDay(day: (slot: number) => string, a: number, b: number, fn: (day: string, ms: number) => void): void {
  if (b <= a) return;
  let cur: string | null = null;
  let acc = 0;
  let t = a;
  while (t < b) {
    const slot = Math.floor(t / SLOT_MS);
    const to = Math.min(b, (slot + 1) * SLOT_MS);
    const d = day(slot);
    if (d !== cur) {
      if (cur !== null) fn(cur, acc);
      cur = d;
      acc = 0;
    }
    acc += to - t;
    t = to;
  }
  if (cur !== null) fn(cur, acc);
}

interface DayAcc {
  you: number;
  agents: number;
  wait: number;
}

/** One By project row's figures in the range. */
interface RowAcc {
  row: FoldRow;
  folders: Set<string>;
  days: Map<string, DayAcc>;
  you: Partial<Record<TimeSpentRow, number>>;
  who: Record<UsageTimeWho, number>;
  what: Record<UsageTimeWhat, number>;
  models: Map<string, { provider: string; model: string; seconds: number; replies: number }>;
  away: number;
  messages: Map<UsageTimeLabel, { count: number; seconds: number }>;
  byLabelTime: boolean;
}

interface SessionAcc {
  you: number;
  lastAt: number;
}

const r1 = (n: number) => Math.round(n);

export class TimeQueries {
  private cache: { key: string; fold: Fold; answer: UsageTime }[] = [];
  private union: { v: number; spans: Spans } | null = null;

  constructor(private readonly deps: TimeDeps) {}

  /** Every moment you were at a session on this computer (gone sessions' by their buckets). */
  private yours(): Spans {
    const v = this.deps.attention.version;
    if (this.union?.v === v) return this.union.spans;
    const spans: [number, number][] = [];
    for (const f of this.deps.attention.live().values()) for (const r of f.runs) spans.push([r.s * 1000, r.e * 1000]);
    for (const l of this.deps.attention.gone()) spans.push([l.b, l.b + l.sec * 1000]);
    this.union = { v, spans: new Spans(spans) };
    return this.union.spans;
  }

  time(q: TimeAsk): UsageTime {
    const d = this.deps;
    d.attention.refresh();
    d.perf.refresh();
    d.tools.refresh();
    d.labels.refresh();
    const tz = validZone(q.tz);
    const now = d.now();
    const day = slotDay(tz);
    const today = day(Math.floor(now / SLOT_MS));
    const key = [q.range, tz, q.project ?? "", q.labels === true, today, d.attention.version, d.perf.version, d.tools.version, d.labels.version, JSON.stringify(d.ledger.stats)].join("|");
    const hit = this.cache.find((c) => c.key === key && c.fold === q.fold);
    if (hit) return { ...hit.answer, asOf: now };
    const answer = this.compute(q, tz, today, day, now);
    this.cache.push({ key, fold: q.fold, answer });
    if (this.cache.length > 4) this.cache.shift();
    return answer;
  }

  private compute(q: TimeAsk, tz: string, today: string, day: (slot: number) => string, now: number): UsageTime {
    const d = this.deps;
    const from = q.range === "all" ? null : addDays(today, q.range === "7d" ? -6 : -29);
    const lo = from ? Date.parse(`${addDays(from, -1)}T00:00:00Z`) : -Infinity;
    const hi = Date.parse(`${addDays(today, 2)}T00:00:00Z`);
    const inRange = (ld: string) => (!from || ld >= from) && ld <= today;

    const rows = new Map<string, RowAcc>();
    const rowAcc = (row: FoldRow): RowAcc => {
      let r = rows.get(row.key);
      if (!r) {
        r = {
          row,
          folders: new Set(),
          days: new Map(),
          you: {},
          who: { main: 0, worker: 0, overseer: 0 },
          what: { waiting: 0, thinking: 0, writing: 0, tools: 0 },
          models: new Map(),
          away: 0,
          messages: new Map(),
          byLabelTime: false,
        };
        rows.set(row.key, r);
      }
      return r;
    };
    const dayAcc = (r: RowAcc, ld: string): DayAcc => {
      let x = r.days.get(ld);
      if (!x) r.days.set(ld, (x = { you: 0, agents: 0, wait: 0 }));
      return x;
    };
    // Where each session ran: the ledger's owner (its calls), else what its records say.
    const places = new Map<string, { row: FoldRow; cwd: string | null; kind: UsageTimeWho }>();
    const place = (sid: string, kind?: string | null, kept?: { cwd: string | null; project: string | null; kind: string | null }) => {
      let p = places.get(sid);
      if (!p) {
        const o = d.ledger.owners.get(sid);
        const cwd = o?.cwd ?? kept?.cwd ?? null;
        const k = kindOf(o?.kind ?? kind ?? kept?.kind);
        p = { row: q.fold(cwd, k, o?.project ?? kept?.project ?? null), cwd, kind: k };
        places.set(sid, p);
      }
      return p;
    };
    // Top Sessions by top-level session: a worker's time is its parent chain's top's.
    const sessions = new Map<string, SessionAcc>();
    const rootOf = (sid: string): string => {
      let at = sid;
      const seen = new Set<string>([at]);
      for (let p = d.ledger.owners.get(at)?.parent; p && !seen.has(p); p = d.ledger.owners.get(at)?.parent) {
        seen.add(p);
        at = p;
      }
      return at;
    };

    // Your time.
    for (const [sid, f] of d.attention.live()) {
      let p: ReturnType<typeof place> | null = null;
      for (const run of f.runs) {
        const a = run.s * 1000;
        const b = run.e * 1000;
        if (b <= lo || a >= hi) continue;
        byDay(day, a, b, (ld, ms) => {
          if (!inRange(ld)) return;
          p ??= place(sid);
          const r = rowAcc(p.row);
          if (p.cwd) r.folders.add(p.cwd);
          dayAcc(r, ld).you += ms / 1000;
          r.you[run.r] = (r.you[run.r] ?? 0) + ms / 1000;
          const top = rootOf(sid);
          let s = sessions.get(top);
          if (!s) sessions.set(top, (s = { you: 0, lastAt: 0 }));
          s.you += ms / 1000;
          s.lastAt = Math.max(s.lastAt, b);
        });
      }
    }
    for (const l of d.attention.gone()) {
      if (l.b + SLOT_MS <= lo || l.b >= hi) continue;
      const ld = day(Math.floor(l.b / SLOT_MS));
      if (!inRange(ld)) continue;
      const o = d.ledger.owners.get(l.sid);
      const cwd = o?.cwd ?? l.cwd;
      const row = q.fold(cwd, kindOf(o?.kind ?? l.kind), o?.project ?? l.project);
      const r = rowAcc(row);
      if (cwd) r.folders.add(cwd);
      dayAcc(r, ld).you += l.sec;
      r.you[l.r] = (r.you[l.r] ?? 0) + l.sec;
    }

    // Agent time: replies, then tool runs.
    const yours = this.yours();
    const agentSessions = new Map<string, { agents: number; lastAt: number }>();
    const noteAgent = (sid: string, sec: number, end: number) => {
      let s = agentSessions.get(sid);
      if (!s) agentSessions.set(sid, (s = { agents: 0, lastAt: 0 }));
      s.agents += sec;
      s.lastAt = Math.max(s.lastAt, end);
    };
    for (const rec of d.perf.records()) {
      const a = rec.sentAt;
      const b = rec.sentAt + rec.endMs;
      if (b <= lo || a >= hi || rec.endMs <= 0) continue;
      const t = rec.timing;
      const busy = t.thinkingMs + t.replyMs;
      const scale = busy > rec.endMs ? rec.endMs / busy : 1;
      const thinking = t.thinkingMs * scale;
      const writing = t.replyMs * scale;
      const waiting = rec.endMs - thinking - writing;
      const p = place(rec.sid, rec.kind);
      const shown = displayModel(rec.provider, rec.model, rec.responseModel, rec.ts).model;
      let counted = 0;
      byDay(day, a, b, (ld, ms) => {
        if (!inRange(ld)) return;
        counted += ms;
        const r = rowAcc(p.row);
        const frac = ms / rec.endMs;
        dayAcc(r, ld).agents += ms / 1000;
        r.who[p.kind] += ms / 1000;
        r.what.thinking += (thinking * frac) / 1000;
        r.what.writing += (writing * frac) / 1000;
        r.what.waiting += (waiting * frac) / 1000;
      });
      if (!counted) continue;
      const r = rowAcc(p.row);
      if (p.cwd) r.folders.add(p.cwd);
      const mk = `${rec.provider}/${shown}`;
      let m = r.models.get(mk);
      if (!m) r.models.set(mk, (m = { provider: rec.provider, model: shown, seconds: 0, replies: 0 }));
      m.seconds += counted / 1000;
      m.replies++;
      r.away += this.away(yours, a, b, counted, rec.endMs);
      noteAgent(rec.sid, counted / 1000, b);
    }
    for (const run of d.tools.records()) {
      if (run.end <= lo || run.start >= hi) continue;
      const p = place(run.sid, run.kind);
      let counted = 0;
      byDay(day, run.start, run.end, (ld, ms) => {
        if (!inRange(ld)) return;
        counted += ms;
        const r = rowAcc(p.row);
        if (run.wait) {
          dayAcc(r, ld).wait += ms / 1000;
          return;
        }
        dayAcc(r, ld).agents += ms / 1000;
        r.who[p.kind] += ms / 1000;
        r.what.tools += ms / 1000;
      });
      if (!counted || run.wait) continue;
      const r = rowAcc(p.row);
      if (p.cwd) r.folders.add(p.cwd);
      r.away += this.away(yours, run.start, run.end, counted, run.end - run.start);
      noteAgent(run.sid, counted / 1000, run.end);
    }

    // Your Messages: each labelled message, credited your seconds in its session since the message or action before it.
    for (const [sid, s] of d.labels.sessions()) {
      const runs = d.attention.live().get(sid)?.runs ?? [];
      const spans = new Spans(runs.map((r): [number, number] => [r.s * 1000, r.e * 1000]));
      const marks = [...s.messages.map((m) => ({ t: m.t, m })), ...s.actions.map((t) => ({ t, m: null }))].sort((a, b) => a.t - b.t);
      let prev = -Infinity;
      for (const { t, m } of marks) {
        const after = prev;
        prev = t;
        if (!m || t < lo || t >= hi || !inRange(day(Math.floor(t / SLOT_MS)))) continue;
        const r = rowAcc(place(sid).row);
        const x = r.messages.get(m.label) ?? { count: 0, seconds: 0 };
        x.count++;
        x.seconds += spans.overlap(after, t) / 1000;
        r.messages.set(m.label, x);
        if (m.byLabelTime) r.byLabelTime = true;
      }
    }

    // The range's days: from the first with anything (All) to today.
    let first: string | null = from;
    if (!first) for (const r of rows.values()) for (const ld of r.days.keys()) if (first === null || ld < first) first = ld;
    const picked = [...rows.values()].filter((r) => q.project === null || r.row.key === q.project);
    const spend = d.queries.spendBy({ from, today, tz, fold: q.fold });

    const daysOut: UsageTimeDay[] = [];
    if (first) {
      for (let ld = first; ld <= today; ld = addDays(ld, 1)) {
        const x = { day: ld, you: 0, agents: 0, workerWait: 0 };
        for (const r of picked) {
          const a = r.days.get(ld);
          if (!a) continue;
          x.you += a.you;
          x.agents += a.agents;
          x.workerWait += a.wait;
        }
        daysOut.push({ day: ld, you: r1(x.you), agents: r1(x.agents), workerWait: r1(x.workerWait) });
      }
    }
    // Agent Hours Per Your Hour: over the days your time was recorded.
    const ratioOf = (rs: RowAcc[]) => {
      const you = new Map<string, number>();
      for (const r of rs) for (const [ld, a] of r.days) if (a.you > 0) you.set(ld, (you.get(ld) ?? 0) + a.you);
      let ratioYou = 0;
      let ratioAgents = 0;
      for (const r of rs) for (const [ld, a] of r.days) if (you.has(ld)) ratioAgents += a.agents;
      for (const v of you.values()) ratioYou += v;
      return { ratio: ratioYou > 0 ? ratioAgents / ratioYou : null, ratioYou, ratioAgents, daysYou: you.size };
    };
    const sum = (rs: RowAcc[], f: (r: RowAcc) => number) => rs.reduce((t, r) => t + f(r), 0);
    const dayTotal = (r: RowAcc, k: keyof DayAcc) => [...r.days.values()].reduce((t, a) => t + a[k], 0);

    const youOut: UsageTimeYou = {};
    const agents: UsageTimeAgents = { who: { worker: 0, main: 0, overseer: 0 }, what: { thinking: 0, writing: 0, tools: 0, waiting: 0 }, models: [] };
    const models = new Map<string, { provider: string; model: string; seconds: number; replies: number }>();
    const messages = new Map<UsageTimeLabel, { count: number; seconds: number }>();
    let byLabelTime = false;
    for (const r of picked) {
      for (const [k, v] of Object.entries(r.you) as [TimeSpentRow, number][]) youOut[k] = (youOut[k] ?? 0) + v;
      for (const k of WHO) agents.who[k] += r.who[k];
      for (const k of Object.keys(agents.what) as UsageTimeWhat[]) agents.what[k] += r.what[k];
      for (const [mk, m] of r.models) {
        const x = models.get(mk) ?? { ...m, seconds: 0, replies: 0 };
        x.seconds += m.seconds;
        x.replies += m.replies;
        models.set(mk, x);
      }
      for (const [l, m] of r.messages) {
        const x = messages.get(l) ?? { count: 0, seconds: 0 };
        x.count += m.count;
        x.seconds += m.seconds;
        messages.set(l, x);
      }
      if (r.byLabelTime) byLabelTime = true;
    }
    for (const k of Object.keys(youOut) as TimeSpentRow[]) youOut[k] = r1(youOut[k]!);
    for (const k of WHO) agents.who[k] = r1(agents.who[k]);
    for (const k of Object.keys(agents.what) as UsageTimeWhat[]) agents.what[k] = r1(agents.what[k]);
    agents.models = [...models.values()].map((m) => ({ ...m, seconds: r1(m.seconds) })).sort((a, b) => b.seconds - a.seconds);

    const ratio = ratioOf(picked);
    const totalYou = sum(picked, (r) => dayTotal(r, "you"));
    const totalAgents = sum(picked, (r) => dayTotal(r, "agents"));

    const projects: UsageTimeProjectRow[] = [...rows.values()]
      .filter((r) => dayTotal(r, "you") > 0 || dayTotal(r, "agents") > 0)
      .map((r) => {
        const rr = ratioOf([r]);
        const usd = spend.byRow.get(r.row.key);
        return {
          key: r.row.key,
          kind: r.row.kind,
          name: r.row.name,
          ...(r.row.path ? { path: r.row.path } : {}),
          ...(r.row.project ? { project: r.row.project } : {}),
          ...(r.row.archived ? { archived: true as const } : {}),
          folders: r.folders.size,
          you: r1(dayTotal(r, "you")),
          agents: r1(dayTotal(r, "agents")),
          agentsOnYourDays: r1(rr.ratioAgents),
          ratio: rr.ratio,
          usd: Math.round((usd?.usd ?? 0) * 1e6) / 1e6,
          unpricedTokens: usd?.unpricedTokens ?? 0,
        };
      })
      .sort((a, b) => Number(a.kind === OTHER_ROW.kind) - Number(b.kind === OTHER_ROW.kind) || b.you - a.you || b.agents - a.agents);

    // Top Sessions: top-level sessions with your time; agent time and cost are the session's and its workers' at any depth.
    const top: UsageTimeSessionRow[] = [...sessions.entries()]
      .filter(([sid]) => q.project === null || place(sid).row.key === q.project)
      .sort((a, b) => b[1].you - a[1].you)
      .slice(0, USAGE_TIME_TOP_SESSIONS)
      .map(([sid, s]) => {
        const o = d.ledger.owners.get(sid);
        const p = place(sid);
        let agentSec = 0;
        let usd = 0;
        let lastAt = s.lastAt;
        for (const m of d.queries.family(sid)) {
          const a = agentSessions.get(m);
          if (a) {
            agentSec += a.agents;
            lastAt = Math.max(lastAt, a.lastAt);
          }
          usd += spend.byOwner.get(m)?.usd ?? 0;
        }
        return {
          sid,
          kind: p.kind,
          parent: o?.parent ?? null,
          worker: o?.worker ?? null,
          cwd: o?.cwd ?? null,
          project: o?.project ?? null,
          row: p.row.key,
          you: r1(s.you),
          agents: r1(agentSec),
          usd: Math.round(usd * 1e6) / 1e6,
          lastAt,
        };
      });

    const device: UsageDevice = { id: d.device(), self: true };
    const sinceYou = d.attention.since();
    return {
      device,
      range: q.range,
      from: first,
      to: today,
      asOf: now,
      project: q.project,
      since: { you: sinceYou, agents: d.perf.firstAt, tools: d.tools.firstAt, labels: d.labels.firstSent() },
      days: daysOut,
      totals: {
        you: r1(totalYou),
        agents: r1(totalAgents),
        workerWait: r1(sum(picked, (r) => dayTotal(r, "wait"))),
        away: r1(sum(picked, (r) => r.away)),
        ratio: ratio.ratio,
        ratioAgents: r1(ratio.ratioAgents),
        ratioYou: r1(ratio.ratioYou),
        daysYou: ratio.daysYou,
      },
      you: youOut,
      agents,
      projects,
      sessions: top,
      messages: {
        rows: USAGE_TIME_LABELS.filter((l) => messages.has(l)).map((label) => ({ label, count: messages.get(label)!.count, seconds: r1(messages.get(label)!.seconds) })),
        enabled: q.labels === true,
        byLabelTime,
      },
    };
  }

  /** Seconds of a window [a, b) (of which `counted` ms fall in the range) that fell outside your moments. */
  private away(yours: Spans, a: number, b: number, counted: number, len: number): number {
    const outside = b - a - yours.overlap(a, b);
    // A window cut by the range's edge: its share of the outside.
    return (outside * (len > 0 ? counted / len : 0)) / 1000;
  }
}
