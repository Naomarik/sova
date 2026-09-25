// The session pane's Timeline tab: one time axis for a whole session. Every decision lives here —
// which rows there are, what each says, where the idle gaps fall — so SessionTimeline.tsx only maps
// rows to markup. Nothing here touches the DOM, so it is unit-tested in timeline.test.ts.
//
// The axis is built from the transcript itself: the user's messages (each with a density line),
// the outline's topics as chapters at their anchored message's time, and the markers a session
// leaves behind — compactions, subagents spawned and retired, model/thinking/mode changes, and
// every past outline summary. The rewind rules (which row may act, the boundary and the rows a
// rewind left behind) stay in inputs.ts; this module only places their rows on the axis.

import type { OutlineSnapshot, RewindInfo, SessionOutline, TranscriptItem } from "../../shared/protocol";
import { duration, relativeTime, thousands } from "./format";
import { inputPreview, type RowState, type ViewRow } from "./inputs";
import { isObj, timestampOf, toolCallArgs } from "./message";
import { absoluteTime, firstLine, timelineEntries } from "./spend";
import { isTurnStart } from "./turn";
import { wakeTitle } from "../../shared/wake";

/** A row's shape on the axis; the `data-kind` the stylesheet keys off. */
export type TimelineKind = "input" | "chapter" | "marker" | "density" | "gap";

/**
 * What a marker row marks. A `rewind` doesn't come from the transcript — Sova's rewind entries
 * are hidden there — so `markerRows` reads it from the insight's own `rewinds` list instead, and
 * emits one only when that list is passed in. An `outline` is a past summary of the session, from
 * the insight's `outlines`: a marker, because it is the axis reporting, not the session speaking.
 */
export type MarkerKind = "compaction" | "spawn" | "retire" | "change" | "rewind" | "outline";

/** The default title of a marker kind, when the row has nothing more specific to say. */
export const MARKER_TITLE: Record<MarkerKind, string> = {
  compaction: "Compacted",
  spawn: "A subagent started",
  retire: "A subagent finished",
  change: "Changed the session's settings",
  rewind: "Rewound to an earlier message",
  outline: "Goal",
};

/** One row of the axis. `at` is absent only on a gap, which marks the space between two rows. */
export interface TimelineRow {
  /** Stable within one build, for keyed rendering and for tests to name a row. */
  key: string;
  kind: TimelineKind;
  /** ISO event time. */
  at?: string;
  /** The transcript entry the row's body jumps to; absent when the row is about no single
      message — a rewind, a past-summary or a settings-change marker — which the renderer draws
      as text rather than a jump. */
  entryId?: string;
  title: string;
  /** The line under the title: an input's density, a marker's detail. */
  meta?: string;
  /** The whole text behind a cut title, for the row's `title` attribute. */
  full?: string;
  /** marker rows only. */
  marker?: MarkerKind;
  /** chapter rows only: a manually pinned topic, drawn with a `#`. */
  manual?: boolean;
  /** chapter rows only: the anchor was gone, so the time is the summary's own — not the event's. */
  flagged?: boolean;
  /** input rows only, and only when the axis was built with a `view`: where the message stands
      against the latest rewind (inputs.ts `viewRows`). "active" is on the branch and may rewind. */
  state?: RowState;
}

/** Idle longer than this between two rows and the axis says so rather than pretending continuity. */
export const GAP_MS = 10 * 60 * 1000;

// ---- Anchors ------------------------------------------------------------------------------------

/**
 * The transcript row an entry id names, resolved the way a jump resolves it (src/lib/jump.ts):
 * the row's own id, else the first row of the entry it came from, since an assistant entry becomes
 * one row per content block (`<id>:<i>`).
 */
function anchorIndex(items: readonly TranscriptItem[], entryId: string | null | undefined): number {
  if (!entryId) return -1;
  const exact = items.findIndex((it) => it.id === entryId);
  if (exact >= 0) return exact;
  const prefix = `${entryId}:`;
  return items.findIndex((it) => it.id.startsWith(prefix));
}

/** When an entry id happened, off the raw JSONL entry, or null when the transcript doesn't hold it. */
export function anchorTime(items: readonly TranscriptItem[], entryId: string | null | undefined): string | null {
  const i = anchorIndex(items, entryId);
  return i < 0 ? null : timestampOf(items[i]!.raw) ?? null;
}

// ---- Inputs -------------------------------------------------------------------------------------

/** One user message and what followed it, up to the next user message. */
export interface InputTurn {
  id: string;
  at: string | undefined;
  /** Index of the message in the transcript: the axis's tie-break. */
  index: number;
  /** The first line, whitespace collapsed; "" when the message is images only. */
  preview: string;
  /** The whole text, for the row's title attribute. */
  text: string;
  images: number;
  replies: number;
  tools: number;
  /** Input → the last stamped row of the turn; 0 when nothing stamped followed. */
  elapsedMs: number;
}

/** The session's turns, oldest first: each user message with the work it drew. */
export function inputTurns(items: readonly TranscriptItem[]): InputTurn[] {
  const out: InputTurn[] = [];
  items.forEach((it, index) => {
    if (!isTurnStart(it)) return;
    const text = it.text ?? "";
    const at = timestampOf(it.raw);
    const preview =
      it.kind === "wake" && it.wake
        ? (it.wake.reason ?? wakeTitle(it.wake))
        : (text.trim().split("\n", 1)[0] ?? "").replace(/\s+/g, " ").trim();
    const turn: InputTurn = {
      id: it.id,
      at,
      index,
      preview,
      text,
      images: it.images?.length ?? 0,
      replies: 0,
      tools: 0,
      elapsedMs: 0,
    };
    const start = at ? Date.parse(at) : NaN;
    let last = NaN;
    for (let i = index + 1; i < items.length; i++) {
      const next = items[i]!;
      if (isTurnStart(next)) break;
      if (next.kind === "assistant-text") turn.replies++;
      else if (next.kind === "tool-call") turn.tools++;
      const stamp = timestampOf(next.raw);
      const t = stamp ? Date.parse(stamp) : NaN;
      if (!Number.isNaN(t)) last = t;
    }
    if (!Number.isNaN(start) && !Number.isNaN(last) && last > start) turn.elapsedMs = last - start;
    out.push(turn);
  });
  return out;
}

/** What a turn shows besides its text: an images-only message says so. */
export function turnPreview(turn: InputTurn): string {
  if (turn.preview) return turn.preview;
  if (turn.images > 0) return turn.images === 1 ? "1 image" : `${turn.images} images`;
  return "Empty message";
}

/** "3 replies · 14 tools · 6m" — a clause only when it has a number to report; "" when none do. */
export function densityLine(turn: InputTurn): string {
  const parts: string[] = [];
  if (turn.replies > 0) parts.push(`${turn.replies} ${turn.replies === 1 ? "reply" : "replies"}`);
  if (turn.tools > 0) parts.push(`${turn.tools} ${turn.tools === 1 ? "tool" : "tools"}`);
  if (turn.elapsedMs > 0) parts.push(duration(turn.elapsedMs));
  return parts.join(" · ");
}

/** The input rows of the axis, oldest first. A message with no timestamp can't be placed, so it
    doesn't get a row — it is still in the transcript. */
export function inputRowsOf(items: readonly TranscriptItem[]): TimelineRow[] {
  return inputTurns(items)
    .filter((t) => t.at)
    .map((t) => {
      const row: TimelineRow = { key: `input:${t.id}`, kind: "input", at: t.at!, entryId: t.id, title: turnPreview(t) };
      if (t.text.trim() && t.text.trim() !== row.title) row.full = t.text;
      const density = densityLine(t);
      if (density) row.meta = density;
      return row;
    });
}

/**
 * The input rows with their standing against the latest rewind, from inputs.ts `viewRows` — the
 * same rows and states the Inputs tab used to list. A row the view calls boundary or abandoned
 * keeps its place and its density while the transcript still holds it (a fetch from before the
 * rewind); once the reload drops it, it is rebuilt from the view at its own time, with no density,
 * since the turns it drew are off the branch too. A view row with no time can't be placed.
 */
export function withRewindState(rows: readonly TimelineRow[], view: readonly ViewRow[]): TimelineRow[] {
  const byId = new Map(view.map((v) => [v.id, v]));
  const out = rows.map((row): TimelineRow => ({ ...row, state: byId.get(row.entryId ?? "")?.state ?? "active" }));
  const present = new Set(rows.map((r) => r.entryId));
  for (const v of view) {
    if (v.state === "active" || present.has(v.id) || !v.at) continue;
    const row: TimelineRow = { key: `input:${v.id}`, kind: "input", at: v.at, entryId: v.id, title: inputPreview(v), state: v.state };
    if (v.text.trim() && v.text.trim() !== row.title) row.full = v.text;
    out.push(row);
  }
  return out;
}

// ---- Chapters -----------------------------------------------------------------------------------

/**
 * The outline's topics as chapter markers, at the time of the message each is anchored to.
 * `topic.at` is NOT event time — the summarizer stamps `Date.now()` on every update, so a topic
 * from an hour ago reads as "just now" the moment it is re-summarized. The anchor's own timestamp
 * is the truth; when the anchor has been compacted away the row falls back to `topic.at` and is
 * flagged, so a summary clock never passes for an event clock.
 */
export function chapterRows(outline: SessionOutline | null | undefined, items: readonly TranscriptItem[]): TimelineRow[] {
  return (outline?.topics ?? []).flatMap((topic): TimelineRow[] => {
    // The snapshot's own stamp first: it survives the anchor being compacted off the branch,
    // which is exactly when the transcript can no longer answer for it.
    const anchored = (topic.anchorAt && topic.anchorAt > 0 ? new Date(topic.anchorAt).toISOString() : null) ?? anchorTime(items, topic.entryId);
    const at = anchored ?? (topic.at > 0 ? new Date(topic.at).toISOString() : null);
    if (!at) return [];
    const row: TimelineRow = { key: `chapter:${topic.id}`, kind: "chapter", at, title: topic.heading, manual: topic.manual };
    if (topic.entryId) row.entryId = topic.entryId;
    if (!anchored) {
      row.flagged = true;
      row.meta = "summary time";
    }
    if (topic.bullets.length > 0) row.full = topic.bullets.join("\n");
    return [row];
  });
}

// ---- Markers ------------------------------------------------------------------------------------

/** A worker outcome or status that ended the work rather than completing it. */
const STOPPED = new Set(["error", "aborted", "killed"]);

/** The tools that put a new agent on the board. */
const SPAWN_TOOLS = new Set(["agent_spawn", "team_create"]);

/** The name a spawn call gave its agent or team, when the arguments carried one. */
function spawnName(args: unknown): string {
  if (!isObj(args)) return "";
  for (const key of ["name", "team", "agent", "id"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** "Model: anthropic/claude-opus-5" → "Model → anthropic/claude-opus-5"; "Mode → plan" is already
    written that way, and "Strict mode on" is a sentence, not a change of value. */
function changeTitle(text: string): string {
  return text.replace(/^(Model|Thinking|Minor mode): /, "$1 → ");
}

/**
 * The session's markers, oldest first: compactions, subagents spawned and retired, and the
 * model/thinking/mode changes the Session tab lists under Changes. Compactions are already
 * transcript rows, so they are read from there rather than from the insight's own list — one
 * event, one row. Rewinds are the exception: their marker entries are hidden from the transcript,
 * so they arrive as `rewinds` from the insight, oldest first.
 */
export function markerRows(items: readonly TranscriptItem[], rewinds: readonly RewindInfo[] = []): TimelineRow[] {
  const out: TimelineRow[] = [];
  for (const it of items) {
    const at = timestampOf(it.raw);
    if (!at) continue;
    if (it.kind === "info" && isObj(it.raw) && it.raw.type === "compaction") {
      const tokens = typeof it.raw.tokensBefore === "number" ? it.raw.tokensBefore : null;
      const row: TimelineRow = {
        key: `marker:compaction:${it.id}`,
        kind: "marker",
        marker: "compaction",
        at,
        entryId: it.id,
        title: tokens ? `Compacted · ${thousands(tokens)} tokens summarized` : MARKER_TITLE.compaction,
      };
      // The summary itself stays in the tooltip: a marker reports, the transcript tells.
      const summary = firstLine(typeof it.raw.summary === "string" ? it.raw.summary : "", 200);
      if (summary) row.full = summary;
      out.push(row);
    } else if (it.kind === "tool-call" && SPAWN_TOOLS.has(it.text ?? "")) {
      const team = it.text === "team_create";
      const name = spawnName(toolCallArgs(it.raw, it.toolCallId));
      out.push({
        key: `marker:spawn:${it.id}`,
        kind: "marker",
        marker: "spawn",
        at,
        entryId: it.id,
        title: team ? (name ? `Team ${name} started` : "A team started") : name ? `${name} started` : MARKER_TITLE.spawn,
      });
    } else if (it.kind === "report" && it.report?.agent) {
      const agent = it.report.agent;
      // "finished" is the default; a worker that errored, aborted or was killed only stopped.
      const stopped = STOPPED.has(agent.outcome ?? "") || STOPPED.has(agent.status);
      out.push({
        key: `marker:retire:${it.id}`,
        kind: "marker",
        marker: "retire",
        at,
        entryId: it.id,
        title: agent.name ? `${agent.name} ${stopped ? "stopped" : "finished"}` : MARKER_TITLE.retire,
      });
    }
  }
  // Model, thinking and mode changes, with their consecutive repeats already collapsed. The
  // transcript writes them as "Model: x"; on the axis every change reads the same way, "X → y".
  // No `entryId`: their row renders nothing in the thread (lib/change-rows), so there is nothing
  // to jump to, and the renderer draws the marker as static text instead.
  for (const entry of timelineEntries(items)) {
    if (!entry.at) continue;
    out.push({ key: `marker:change:${entry.id}`, kind: "marker", marker: "change", at: entry.at, title: changeTitle(entry.text) });
  }
  // The rewinds, in the order they arrive. A rewind marker carries no `entryId` on purpose: its
  // `targetId` is the message the chat rewound *away* from, which by construction is no longer on
  // the branch (server/chat-rewind.test.ts), so a jump could only ever end in "isn't in the
  // transcript". A rewind with no stamp can't be placed on an axis, so it gets no row.
  for (const r of rewinds) {
    if (!r.timestamp) continue;
    out.push({ key: `marker:rewind:${r.id}`, kind: "marker", marker: "rewind", at: r.timestamp, title: MARKER_TITLE.rewind });
  }
  return out;
}

/**
 * The past outline summaries as markers, one line each at the time the summary was written:
 * "Goal · {now}", with the whole line in the tooltip (the row wraps and the CSS clamps it at two
 * lines, so a long summary needs one). `overall` is a different fact, not a longer version of
 * `now` — it only becomes the tooltip for a snapshot that has no `now` at all, where the row shows
 * a cut of it. The newest snapshot is left out on purpose — it is the current goal, and the strip
 * above the chat already says it. None of them jumps: a `topic-outline` entry renders nothing in
 * the thread, so there is nothing to land on.
 */
export function outlineRows(outlines: readonly OutlineSnapshot[] = []): TimelineRow[] {
  return outlines.slice(0, -1).flatMap((o): TimelineRow[] => {
    const now = o.now.trim();
    const shown = now || firstLine(o.overall, 200);
    if (!o.timestamp || !shown) return [];
    const row: TimelineRow = { key: `marker:outline:${o.id}`, kind: "marker", marker: "outline", at: o.timestamp, title: `${MARKER_TITLE.outline} · ${shown}` };
    const full = now || o.overall.trim();
    if (full && full !== shown) row.full = full;
    return [row];
  });
}

// ---- Merging ------------------------------------------------------------------------------------

const time = (row: TimelineRow): number => {
  const t = row.at ? Date.parse(row.at) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Idle lines between consecutive rows further apart than `thresholdMs`. They carry no time of
 * their own: a gap is the space between two events, not an event.
 */
export function withGaps(rows: readonly TimelineRow[], thresholdMs = GAP_MS): TimelineRow[] {
  const out: TimelineRow[] = [];
  let previous: number | null = null;
  rows.forEach((row, i) => {
    const t = time(row);
    if (previous !== null && t - previous > thresholdMs) {
      out.push({ key: `gap:${i}`, kind: "gap", title: `idle ${duration(t - previous)}` });
    }
    out.push(row);
    previous = t;
  });
  return out;
}

/** What the axis takes besides the transcript, the outline and the rewinds. */
export interface AxisOptions {
  /** The insight's past summaries, oldest first; the newest is left off (see `outlineRows`). */
  outlines?: readonly OutlineSnapshot[];
  /** inputs.ts `viewRows` for this transcript: gives every input row its `state`, and brings back
      the rows a fresh rewind left behind. Absent, input rows carry no state. */
  view?: readonly ViewRow[];
  /** The "Inputs Only" filter: your own messages, their density lines, and the idle gaps
      between them — nothing else. The gaps are measured between the rows that remain. */
  inputsOnly?: boolean;
}

/**
 * The whole axis, oldest first: inputs, chapters and markers merged by time, idle gaps between
 * rows far apart, and each input's density line as its own row beneath it. Ties keep the order
 * the transcript put them in — a chapter anchored to a message sits beside that message, not
 * before it — and rows built from the same source keep the order they were built in.
 */
export function timelineRows(
  items: readonly TranscriptItem[],
  outline: SessionOutline | null | undefined,
  rewinds: readonly RewindInfo[] = [],
  thresholdMs = GAP_MS,
  opts: AxisOptions = {},
): TimelineRow[] {
  const inputs = opts.view ? withRewindState(inputRowsOf(items), opts.view) : inputRowsOf(items);
  const merged = opts.inputsOnly
    ? inputs
    : [...inputs, ...chapterRows(outline, items), ...markerRows(items, rewinds), ...outlineRows(opts.outlines)];
  const rank = (row: TimelineRow) => {
    const i = anchorIndex(items, row.entryId);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = merged
    .map((row, i) => ({ row, i }))
    .sort((a, b) => time(a.row) - time(b.row) || rank(a.row) - rank(b.row) || a.i - b.i)
    .map((x) => x.row);
  return withGaps(sorted, thresholdMs).flatMap((row) =>
    row.kind === "input" && row.meta ? [{ ...row, meta: undefined }, { key: `density:${row.key}`, kind: "density" as const, title: row.meta }] : [row],
  );
}

/**
 * What the Timeline renders: the axis newest first, so the latest event is at the top. A separate
 * function, not a flag on `timelineRows`: the chronological list stays this module's truth — the
 * gaps, the ties and the rewind standings are all reasoned in it — and this is display order only,
 * the same split inputs.ts makes between `viewRows` and `displayRows`.
 *
 * It reverses groups, not rows. A density line describes the work the input above it caused, so
 * an input and the density row after it turn over as one and the line stays beneath its message;
 * a plain reverse would float each one above the message it is about. Every other row — a gap,
 * a chapter, a marker — is a group of one, so a gap still sits between the two rows it separates.
 */
export function newestFirst(rows: readonly TimelineRow[]): TimelineRow[] {
  const groups: TimelineRow[][] = [];
  rows.forEach((row, i) => {
    if (row.kind === "density" && i > 0 && rows[i - 1]!.kind === "input") groups[groups.length - 1]!.push(row);
    else groups.push([row]);
  });
  return groups.reverse().flat();
}

// ---- The state line -----------------------------------------------------------------------------

/** The Current goal strip's own clauses (InsightStrip.STATE_CLAUSE), so both lines read alike. */
const STATE_CLAUSE: Partial<Record<SessionOutline["state"], string>> = {
  fresh: "current",
  stale: "behind the latest messages",
  "failed-keeping-last": "the last update failed, so this is the previous summary",
};

/**
 * The line above the axis: when the outline that supplied the chapters was made, and whether it
 * has fallen behind. Null when there is no outline, or it has never been generated — a summary
 * with no time of its own is never presented as current.
 */
export function timelineState(outline: SessionOutline | null | undefined, now: number): { text: string; title: string } | null {
  if (!outline) return null;
  if (outline.state === "updating" || outline.state === "drafting") return { text: "Updating", title: "A summarizer is running now." };
  if (!(outline.generatedAt > 0)) return null;
  const at = new Date(outline.generatedAt).toISOString();
  const clause = STATE_CLAUSE[outline.state];
  return { text: `Updated ${relativeTime(at, now)}${clause ? ` · ${clause}` : ""}`, title: absoluteTime(at, now) };
}

// ---- Doors in ---------------------------------------------------------------------------------

/** The composer's "7 inputs" trigger's accessible name: it opens the Timeline with Inputs Only on,
    and says so. Singular throughout at one. */
export const showInputsOnTimelineLabel = (n: number): string =>
  `${n} ${n === 1 ? "input" : "inputs"} in this chat — show ${n === 1 ? "it" : "them"} on the Timeline`;
