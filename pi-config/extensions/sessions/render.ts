/**
 * Pure, themed line builders for the sessions overlay. No state, no Input, no
 * pi-coding-agent imports: every function maps (data, width, theme) to lines
 * whose visible width never exceeds the requested width.
 */
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { workerState, type SessionState, type WorkerEntry } from "./schema.ts";
import type { SessionView, ViewGroup } from "./state.ts";

export type Color = "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text" | "border" | "borderAccent" | "borderMuted";
/** The subset of pi's Theme the renderers use. */
export interface RenderTokens {
  fg(color: Color, text: string): string;
  bg(color: "selectedBg", text: string): string;
}
export type DetailMode = "detail" | "preview";
export interface RowOptions { selected?: boolean; expanded?: boolean; twoLine?: boolean; now?: number }
export interface WorkerLineOptions { selected?: boolean; indent?: string; now?: number }
export interface DetailOptions { worker?: WorkerEntry; now?: number }

// Never permit remote terminal commands, C0/C1 controls, or bidi overrides.
// Preserve only explicit preview newlines; labels must remain single-line.
export function clean(value: string, multiline = false): string {
  return String(value ?? "").slice(0, 32768)
    .replace(/\r\n/g, "\n").replace(/\t/g, " ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\n\u2028\u2029]/g, multiline ? "\n" : " ");
}

/** Plain-text clip with an ellipsis; never emits escape sequences. */
export function cut(text: string, width: number): string {
  width = Math.floor(width);
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  return sliceByColumn(text, 0, width - 1, true) + "…";
}
const spaces = (n: number) => " ".repeat(Math.max(0, Math.floor(n)));
const padTo = (text: string, width: number) => text + spaces(width - visibleWidth(text));

type Seg = readonly [text: string, color?: Color];
/** Lay plain segments left to right, clipping at width, then theme each. */
function segs(parts: readonly Seg[], width: number, theme: RenderTokens, fill = false): string {
  let room = Math.max(0, Math.floor(width));
  let out = "";
  for (const [text, color] of parts) {
    if (room <= 0) break;
    const piece = cut(text, room);
    room -= visibleWidth(piece);
    out += color && piece ? theme.fg(color, piece) : piece;
  }
  return fill ? out + spaces(room) : out;
}
const highlight = (line: string, selected: boolean | undefined, theme: RenderTokens) => selected ? theme.bg("selectedBg", line) : line;

const BARS = "▁▂▃▄▅▆▇";
/** Newest bucket last; zero buckets render as "─". */
export function sparkline(buckets: readonly number[], width?: number): string {
  let values = buckets.map(n => Number.isFinite(n) && n > 0 ? n : 0);
  if (width !== undefined) values = width >= 1 ? values.slice(-Math.floor(width)) : [];
  const max = values.reduce((a, b) => Math.max(a, b), 0);
  return values.map(n => n <= 0 ? "─" : BARS[Math.max(0, Math.min(6, Math.ceil(n / max * 7) - 1))]).join("");
}

const STATE_GLYPH: Record<SessionState, string> = { working: "●", idle: "○", "needs-input": "⚑", error: "✗" };
const STATE_COLOR: Record<SessionState, Color> = { working: "accent", idle: "muted", "needs-input": "warning", error: "error" };
const STATE_TITLE: Record<SessionState, string> = { working: "Working", idle: "Idle", "needs-input": "Needs input", error: "Errored" };
export function stateGlyph(state: SessionState, opts: { stale?: boolean } = {}): string {
  return opts.stale ? "◌" : STATE_GLYPH[state] ?? "○";
}
const stateColor = (state: SessionState, stale?: boolean): Color => stale ? "dim" : STATE_COLOR[state] ?? "muted";

export function workerGlyph(status: string): string {
  const s = String(status ?? "").trim().toLowerCase();
  const state = workerState(s);
  // workerState() maps unknown text to "running"; only real running words get ●.
  if (state === "running" && !/^(running|busy|working|active)$/.test(s)) return "·";
  // Restored after a restart: no process, so never the running dot.
  if (state === "restored") return "○";
  return state === "waiting" ? "◇" : state === "done" ? "✓" : state === "error" || state === "killed" ? "✗" : "●";
}
const WORKER_COLOR: Record<string, Color> = { "●": "accent", "◇": "warning", "✓": "success", "✗": "error", "·": "dim", "○": "dim" };

/** Running first, then waiting, then finished newest first; ties keep input order. */
export function sortWorkers(workers: readonly WorkerEntry[]): WorkerEntry[] {
  const rank = (w: WorkerEntry) => { const g = workerGlyph(w.status); return g === "◇" || g === "○" ? 1 : g === "✓" || g === "✗" ? 2 : 0; };
  const at = (w: WorkerEntry) => w.lastActivity ?? w.endedAt ?? w.startedAt ?? 0;
  return workers.map((w, i) => ({ w, i })).sort((a, b) => rank(a.w) - rank(b.w)
    || (rank(a.w) === 2 ? at(b.w) - at(a.w) : 0) || a.i - b.i).map(x => x.w);
}

const GROUP_LABEL: Record<ViewGroup, string> = { "needs-input": "NEEDS INPUT", working: "WORKING", idle: "IDLE", unreachable: "UNREACHABLE" };
const GROUP_COLOR: Record<ViewGroup, Color> = { "needs-input": "warning", working: "accent", idle: "muted", unreachable: "dim" };
export function groupHeader(group: ViewGroup, views: readonly SessionView[], width: number, theme: RenderTokens): string {
  const label = `${GROUP_LABEL[group]} ${views.filter(v => v.group === group).length} `;
  return segs([[label, GROUP_COLOR[group]], ["─".repeat(Math.max(0, Math.floor(width) - visibleWidth(label))), "borderMuted"]], width, theme);
}

export function ageLabel(sinceMs: number, now = Date.now()): string {
  const s = Math.floor((now - sinceMs) / 1000);
  if (!Number.isFinite(s) || s < 1) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** One or two list lines for a session. Line 2 carries the outline "now" or status. */
export function rowLines(view: SessionView, opts: RowOptions, width: number, theme: RenderTokens): string[] {
  width = Math.max(0, Math.floor(width));
  const now = opts.now ?? Date.now();
  const dim = view.stale || view.legacy;
  const c = (color: Color): Color => dim ? "dim" : color;
  const name = clean(view.name);
  const you = view.self ? " · you" : "";
  const dot = !view.self && view.unseen ? " •" : "";
  const counts = view.workerCounts;
  // Fixed-width slots on roomy rows keep the columns aligned across rows.
  const slots = width >= 80;
  const model = cut(clean(view.model), 20);
  const workers = counts.total ? `◆${counts.working}/${counts.total}${opts.expanded ? "▾" : "▸"}` : "";
  const right: { text: string; color: Color; drop: number }[] = [
    { text: ageLabel(view.since, now).padStart(3), color: c("dim"), drop: 3 },
    { text: slots ? padTo(model, 20) : model, color: c("muted"), drop: 1 },
    { text: slots ? padTo(workers, 7) : workers, color: c(counts.working ? "accent" : "muted"), drop: 2 },
  ].filter(r => r.text.trim() || (slots && r.drop === 2));
  const fixed = 3 + visibleWidth(you) + visibleWidth(dot);
  const minName = Math.min(visibleWidth(name), 12);
  const rightWidth = () => right.length ? right.reduce((n, r) => n + visibleWidth(r.text), 0) + 2 * right.length : 0;
  while (right.length && fixed + minName + rightWidth() > width) {
    right.splice(right.indexOf(right.reduce((a, b) => b.drop < a.drop ? b : a)), 1);
  }
  const shownName = cut(name, width - fixed - rightWidth());
  const gap = width - fixed - visibleWidth(shownName) - rightWidth() + 2;
  const parts: Seg[] = [
    [opts.selected ? ">" : " ", opts.selected ? "accent" : c("dim")], [stateGlyph(view.state, { stale: view.stale }), stateColor(view.state, view.stale)], [" "],
    [shownName, opts.selected && !dim ? "accent" : c("text")], [you, c("muted")], [dot, "accent"],
    ...right.flatMap((r, i): Seg[] => [[spaces(i ? 2 : gap)], [r.text, r.color]]),
  ];
  const lines = [highlight(segs(parts, width, theme, !!opts.selected), opts.selected, theme)];
  if (!(opts.twoLine ?? width >= 100)) return lines;

  const indent = "   ▶ ";
  let second: string;
  if (view.legacy || view.stale) {
    const base = `${indent}${clean(view.statusLabel)}`;
    const hint = view.legacy ? "  (reload to enrich)" : "";
    second = segs([[base, "dim"], [visibleWidth(base + hint) <= width ? hint : "", "dim"]], width, theme);
  } else {
    const main = `${indent}${clean(view.outline?.now || view.statusLabel)}`;
    const heading = view.outline?.lastHeading ? ` · # ${clean(view.outline.lastHeading)}` : "";
    // Reserve room for the heading: it is the text that identifies the session.
    const reserve = heading ? Math.min(visibleWidth(heading), Math.max(16, Math.floor(width * 0.45))) : 0;
    const shown = cut(main, Math.max(0, width - reserve));
    second = segs([[shown, "muted"], [heading, "dim"]], width, theme);
  }
  lines.push(highlight(opts.selected ? padTo(second, width) : second, opts.selected, theme));
  return lines;
}

export function workerLine(worker: WorkerEntry, width: number, theme: RenderTokens, opts: WorkerLineOptions = {}): string {
  width = Math.max(0, Math.floor(width));
  const glyph = workerGlyph(worker.status);
  const indent = clean(opts.indent ?? "");
  const at = worker.lastActivity ?? worker.endedAt ?? worker.startedAt;
  const extras: Seg[] = [[clean(worker.status), "muted"], ...(worker.model ? [[cut(clean(worker.model), 24), "dim"] as Seg] : []),
    ...(at !== undefined ? [[ageLabel(at, opts.now), "dim"] as Seg] : [])];
  const name = clean(worker.name);
  const head = visibleWidth(indent) + 2;
  // Drop the model, then the age, before squeezing the name below 12 columns.
  while (extras.length > 1 && head + Math.min(visibleWidth(name), 12) + extras.reduce((n, [t]) => n + 2 + visibleWidth(t), 0) > width) {
    extras.splice(extras.length === 3 ? 1 : extras.length - 1, 1);
  }
  const tail = extras.reduce((n, [t]) => n + 2 + visibleWidth(t), 0);
  const parts: Seg[] = [[indent, opts.selected ? "accent" : "dim"], [glyph, WORKER_COLOR[glyph]], [" "],
    [cut(name, width - head - tail), opts.selected ? "accent" : "text"], ...extras.flatMap(([t, color]): Seg[] => [["  "], [t, color]])];
  return highlight(segs(parts, width, theme, !!opts.selected), opts.selected, theme);
}

function wrap(text: string, width: number, limit: number, indent = ""): string[] {
  if (limit <= 0 || width - indent.length <= 0) return [];
  const lines = wrapTextWithAnsi(text, width - indent.length).slice(0, limit);
  return lines.map(line => cut(indent + line, width));
}

function identity(view: SessionView, width: number, theme: RenderTokens): string[] {
  const head: Seg[] = [[clean(view.name), view.stale ? "dim" : "accent"], [view.self ? " · you" : "", "muted"],
    [` · pid ${view.pid} · ${clean(view.model)}`, "muted"], [view.host !== undefined ? ` · ${clean(view.host)}` : "", "dim"]];
  const cwd = clean(view.cwd);
  const full = head.reduce((n, [t]) => n + visibleWidth(t), 0) + 3 + visibleWidth(cwd);
  if (full <= width) return [segs([...head, [` · ${cwd}`, "dim"]], width, theme)];
  return [segs(head, width, theme), segs([[cwd, "dim"]], width, theme)];
}

function stateSection(view: SessionView, width: number, theme: RenderTokens, now: number): string[] {
  const age = ageLabel(view.since, now);
  const title = view.stale ? "Unreachable" : STATE_TITLE[view.state] ?? "Idle";
  const color = stateColor(view.state, view.stale);
  const extras: Seg[] = [];
  if (view.stale || view.legacy) extras.push([` · ${clean(view.statusLabel)}`, "dim"]);
  if (view.legacy) extras.push([" · reload to enrich", "dim"]);
  if (view.tools?.length) extras.push([` · ${view.tools.map(t => clean(t)).join(", ")}`, "muted"]);
  if (view.toolDetail) extras.push([` · ${clean(view.toolDetail)}`, "dim"]);
  const lines = [segs([[`${stateGlyph(view.state, { stale: view.stale })} `, color], [title, color],
    [age === "now" ? " · just now" : ` for ${age}`, "muted"], ...extras], width, theme)];
  if (view.state === "error" && view.activity?.error) lines.push(segs([[`  ${clean(view.activity.error)}`, "error"]], width, theme));
  if (!view.canFocus && !view.self) {
    lines.push(segs([["preview only", "warning"], [view.focusReason ? ` · ${clean(view.focusReason)}` : "", "dim"]], width, theme));
  }
  return lines;
}

function summarySection(view: SessionView, width: number, height: number, theme: RenderTokens): string[] {
  const o = view.outline;
  if (!o) return [];
  const state = o.state && o.state !== "fresh" && o.state !== "none" ? ` · ${o.state}` : "";
  const lines = [segs([["Summary", "text"], [state, "dim"]], width, theme)];
  if (o.now) lines.push(segs([[`  ▶ ${clean(o.now)}`, "muted"]], width, theme));
  if (o.overall) lines.push(...wrap(clean(o.overall), width, 2, "  ").map(l => theme.fg("muted", l)));
  const budget = Math.max(1, Math.floor(height / 4));
  if (o.detail?.length && height >= 24) {
    const detail: string[] = [];
    for (const d of o.detail.slice(0, 4)) {
      detail.push(segs([[`  # ${clean(d.heading)}`, "accent"]], width, theme));
      for (const b of d.bullets.slice(0, 2)) detail.push(segs([[`      • ${clean(b)}`, "dim"]], width, theme));
    }
    lines.push(...detail.slice(0, budget));
  } else if (o.topics?.length) {
    const chips = o.topics.slice(0, 4).map(t => `# ${clean(t)}`).join("  ");
    lines.push(segs([[`  ${chips}`, "accent"]], width, theme));
  }
  return lines;
}

function workersSection(view: SessionView, width: number, height: number, theme: RenderTokens, now: number, selected?: WorkerEntry): string[] {
  if (!view.workers.length) return [];
  const counts = view.workerCounts;
  const limit = Math.max(1, Math.min(8, Math.floor(height / 5)));
  const sorted = sortWorkers(view.workers);
  let shown = sorted.slice(0, limit);
  if (selected && !shown.some(w => w.id === selected.id)) {
    const match = sorted.find(w => w.id === selected.id);
    if (match) shown = [...shown.slice(0, limit - 1), match];
  }
  const lines = [segs([["Workers ", "text"], [`${counts.working}/${counts.total}`, counts.working ? "accent" : "muted"]], width, theme)];
  for (const w of shown) {
    const on = !!selected && w.id === selected.id;
    lines.push(workerLine(w, width, theme, { indent: on ? "> " : "  ", selected: on, now }));
  }
  if (sorted.length > shown.length) lines.push(segs([[`  +${sorted.length - shown.length} more`, "dim"]], width, theme));
  return lines;
}

function activitySection(view: SessionView, width: number, theme: RenderTokens, now: number): string[] {
  const a = view.activity;
  if (!a) return [];
  const parts: Seg[] = [["Activity", "text"]];
  if (a.buckets?.length) parts.push([" "], [sparkline(a.buckets, 16), "accent"]);
  if (a.lastToolAt) parts.push([` · last tool ${ageLabel(a.lastToolAt, now)}`, "muted"]);
  if (a.turns !== undefined) parts.push([` · ${a.turns} turn${a.turns === 1 ? "" : "s"}`, "muted"]);
  return parts.length > 1 ? [segs(parts, width, theme)] : [];
}

/**
 * Detail pane body. "detail": identity, state, summary, workers, activity,
 * latest reply. "preview": identity, the wrapped reply (session or worker),
 * activity. Fixed sections are clipped to budget; the reply fills the rest.
 */
export function detailLines(view: SessionView, width: number, height: number, theme: RenderTokens,
  mode: DetailMode = "detail", opts: DetailOptions = {}): string[] {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  if (!width || !height) return [];
  const now = opts.now ?? Date.now();
  const worker = opts.worker;
  const REPLY: string[] = [];
  const sections: string[][] = [identity(view, width, theme)];
  if (mode === "detail") {
    sections.push(stateSection(view, width, theme, now), summarySection(view, width, height, theme),
      workersSection(view, width, height, theme, now, worker));
  } else if (worker) sections.push([workerLine(worker, width, theme, { now })]);
  if (mode === "detail") sections.push(activitySection(view, width, theme, now), REPLY);
  else sections.push(REPLY, worker ? [] : activitySection(view, width, theme, now));
  const present = sections.filter(s => s === REPLY || s.length);
  const fixed = present.reduce((n, s) => n + s.length, 0);
  let gaps = present.length - 1;
  if (height - fixed - gaps < 3) gaps = 0;
  const room = height - fixed - gaps;
  if (room >= 2) {
    const text = worker && mode === "preview" ? clean(worker.preview ?? "", true) || "No worker output yet." : clean(view.preview, true);
    const title = worker && mode === "preview" ? `Worker output · ${clean(worker.name)}`
      : `Latest reply${view.previewAt ? ` · ${ageLabel(view.previewAt, now)}` : ""}`;
    REPLY.push(segs([[title, "text"]], width, theme),
      ...wrap(text, width, room - 1).map(l => theme.fg(view.stale ? "dim" : "muted", l)));
  }
  const out: string[] = [];
  for (const s of present) {
    if (!s.length) continue;
    if (out.length && gaps) out.push("");
    out.push(...s);
  }
  return out.slice(0, height);
}

/** Box-draw a pane. Below width 24 only a title rule is drawn (no side borders). */
export function frame(lines: string[], width: number, title: string, theme: RenderTokens, opts: { accent?: boolean } = {}): string[] {
  width = Math.max(0, Math.floor(width));
  const border = (s: string) => theme.fg(opts.accent ? "borderAccent" : "border", s);
  const label = clean(title);
  if (width < 24) {
    const rule = sliceByColumn(`─ ${cut(label, Math.max(0, width - 3))} ${"─".repeat(width)}`, 0, width, true);
    return [border(rule), ...lines.map(line => truncateToWidth(line, width, ""))];
  }
  const t = cut(label, width - 6);
  const top = border("┌─") + (t ? ` ${theme.fg("accent", t)} ` : "") + border("─".repeat(width - 3 - (t ? visibleWidth(t) + 2 : 0)) + "┐");
  const body = lines.map(line => border("│") + " " + truncateToWidth(line, width - 4, "", true) + " " + border("│"));
  return [top, ...body, border(`└${"─".repeat(width - 2)}┘`)];
}
/** Rows consumed by frame() decoration at this width. */
export const frameOverhead = (width: number) => width >= 24 ? 2 : 1;
/** Content width inside frame() at this width. */
export const frameInner = (width: number) => width >= 24 ? width - 4 : Math.max(0, width);
