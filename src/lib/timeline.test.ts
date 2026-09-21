// Run: npx tsx --test src/lib/timeline.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RewindInfo, SessionOutline, TranscriptItem } from "../../shared/protocol";
import {
  anchorTime,
  chapterRows,
  densityLine,
  inputTurns,
  MARKER_TITLE,
  markerRows,
  timelineRows,
  timelineState,
  turnPreview,
  withGaps,
  type TimelineRow,
} from "./timeline";

/** Minutes past a fixed hour, as the ISO stamp every fixture entry carries. */
const at = (min: number, sec = 0) => `2026-09-21T10:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000Z`;

const user = (id: string, min: number, text = id, images = 0): TranscriptItem => ({
  id,
  kind: "user",
  text,
  images: images ? Array.from({ length: images }, () => "data:image/png;base64,") : undefined,
  raw: { type: "message", timestamp: at(min) },
});
const say = (id: string, min: number, text = "ok"): TranscriptItem => ({ id, kind: "assistant-text", text, raw: { type: "message", timestamp: at(min) } });
const tool = (id: string, min: number, name = "read_file", toolCallId = id): TranscriptItem => ({
  id,
  kind: "tool-call",
  text: name,
  toolCallId,
  raw: { type: "message", timestamp: at(min), message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name, arguments: { name: "scout" } }] } },
});
const compaction = (id: string, min: number, summary = "Read the pane, wrote the tab.\nMore.", tokensBefore = 67401): TranscriptItem => ({
  id,
  kind: "info",
  text: `Compacted (${tokensBefore} tokens): ${summary}`,
  raw: { type: "compaction", timestamp: at(min), summary, tokensBefore },
});
const change = (id: string, min: number, text: string): TranscriptItem => ({ id, kind: "info", text, raw: { type: "model_change", timestamp: at(min) } });
const report = (id: string, min: number, name: string, outcome: string): TranscriptItem => ({
  id,
  kind: "report",
  text: "done",
  report: { source: "subagent-complete", agent: { id: "ag_01", name, status: "done", outcome }, body: "done", preview: "shipped it", truncated: false },
  raw: { type: "custom_message", timestamp: at(min) },
});

const outline = (topics: SessionOutline["topics"], over: Partial<SessionOutline> = {}): SessionOutline => ({
  now: "writing the tab",
  overall: "",
  lastHeading: null,
  state: "fresh",
  generatedAt: Date.parse(at(30)),
  topics,
  ...over,
});
const topic = (id: string, heading: string, entryId: string | null, atMs: number, manual = false, anchorAt?: number) => ({ id, heading, bullets: [], at: atMs, manual, entryId, anchorAt });
const rewind = (id: string, min: number, targetId = "u1", fromLeafId = "a9"): RewindInfo => ({ id, timestamp: at(min), targetId, fromLeafId });

const kinds = (rows: TimelineRow[]) => rows.map((r) => r.kind);

// ---- Anchors ------------------------------------------------------------------------------------

test("anchorTime resolves an exact id, an assistant block prefix, and nothing else", () => {
  const items = [user("u1", 1), say("a1:0", 2)];
  assert.equal(anchorTime(items, "u1"), at(1));
  assert.equal(anchorTime(items, "a1"), at(2), "an entry id resolves to its first block row");
  assert.equal(anchorTime(items, "a1:0"), at(2));
  assert.equal(anchorTime(items, "gone"), null);
  assert.equal(anchorTime(items, null), null);
});

// ---- Inputs -------------------------------------------------------------------------------------

test("inputTurns counts the replies and tools of each turn, up to the next message", () => {
  const turns = inputTurns([user("u1", 0), say("a1:0", 1), tool("a1:1", 2), tool("a1:2", 3), say("a1:3", 6), user("u2", 8), say("a2:0", 9)]);
  assert.deepEqual(turns.map((t) => t.id), ["u1", "u2"]);
  assert.equal(turns[0]!.replies, 2);
  assert.equal(turns[0]!.tools, 2);
  assert.equal(turns[0]!.elapsedMs, 6 * 60_000, "input → the turn's last stamped row");
  assert.equal(turns[1]!.replies, 1);
  assert.equal(turns[1]!.tools, 0);
});

test("inputTurns previews the first line, collapsed; images and empties say what they are", () => {
  const [a, b, c] = inputTurns([user("u1", 0, "  fix   the\tbug\nand more"), user("u2", 1, "", 2), user("u3", 2, "")]);
  assert.equal(turnPreview(a!), "fix the bug");
  assert.equal(turnPreview(b!), "2 images");
  assert.equal(turnPreview(c!), "Empty message");
});

test("densityLine drops the clauses that are zero, and is empty when all of them are", () => {
  const [turn] = inputTurns([user("u1", 0), say("a1:0", 1), say("a1:1", 2), tool("a1:2", 6)]);
  assert.equal(densityLine(turn!), "2 replies · 1 tool · 6m");
  const [alone] = inputTurns([user("u1", 0)]);
  assert.equal(densityLine(alone!), "");
  const [quiet] = inputTurns([user("u1", 0), say("a1:0", 0)]);
  assert.equal(densityLine(quiet!), "1 reply", "same second: no elapsed clause");
});

// ---- Chapters -----------------------------------------------------------------------------------

test("chapterRows take the anchored message's time, not the summary's", () => {
  const items = [user("u1", 5), say("a1:0", 6)];
  const [row] = chapterRows(outline([topic("t1", "The pane", "a1", Date.parse(at(59)))]), items);
  assert.equal(row!.at, at(6));
  assert.equal(row!.flagged, undefined);
  assert.equal(row!.entryId, "a1");
});

test("a chapter with neither a stamp nor an anchor falls back to the summary's time, flagged", () => {
  const [row] = chapterRows(outline([topic("t1", "Compacted away", "gone", Date.parse(at(40)))]), [user("u1", 5)]);
  assert.equal(row!.at, at(40));
  assert.equal(row!.flagged, true, "summary clock, not the event's");
  assert.equal(row!.meta, "summary time", "the flag is in words, not only in dimmed ink");
});

test("a chapter whose anchor is gone lands on the snapshot's own stamp, unflagged", () => {
  const [row] = chapterRows(outline([topic("t1", "Compacted away", "gone", Date.parse(at(40)), false, Date.parse(at(6)))]), [user("u1", 5)]);
  assert.equal(row!.at, at(6), "the stamp survives the anchor being compacted off the branch");
  assert.equal(row!.flagged, undefined);
  assert.equal(row!.entryId, "gone", "the jump is still offered — the toast is the spec's answer");
});

test("a chapter with neither an anchor nor a time gets no row", () => {
  assert.deepEqual(chapterRows(outline([topic("t1", "Nowhere", null, 0)]), []), []);
  assert.deepEqual(chapterRows(null, []), []);
});

test("chapterRows keeps a manual topic's flag, for the # the strip draws", () => {
  const [row] = chapterRows(outline([topic("t1", "Pinned", null, Date.parse(at(9)), true)]), []);
  assert.equal(row!.manual, true);
});

// ---- Markers ------------------------------------------------------------------------------------

test("markerRows reads compactions, spawns, retires and setting changes", () => {
  const rows = markerRows([
    user("u1", 0),
    tool("s1", 1, "agent_spawn"),
    tool("t1", 2, "team_create"),
    tool("r1", 3, "read_file"),
    report("rep1", 4, "scout", "success"),
    compaction("c1", 5),
    change("m1", 6, "Model: anthropic/claude-opus-5"),
  ]);
  assert.deepEqual(rows.map((r) => r.marker), ["spawn", "spawn", "retire", "compaction", "change"]);
  assert.equal(rows[0]!.title, "scout started", "the spawn's named agent");
  assert.equal(rows[1]!.title, "Team scout started");
  assert.equal(rows[2]!.title, "scout finished");
  assert.equal(rows[3]!.title, "Compacted · 67,401 tokens summarized");
  assert.equal(rows[3]!.full, "Read the pane, wrote the tab.", "the summary is the tooltip, not a second row");
  assert.equal(rows[4]!.title, "Model → anthropic/claude-opus-5");
});

test("a subagent that errored stopped; one that finished, finished", () => {
  const rows = markerRows([report("r1", 1, "scout", "error"), report("r2", 2, "guide", "success")]);
  assert.deepEqual(rows.map((r) => r.title), ["scout stopped", "guide finished"]);
});

test("a compaction with no token count still reads as one", () => {
  const [row] = markerRows([{ id: "c1", kind: "info", text: "Compacted", raw: { type: "compaction", timestamp: at(1) } }]);
  assert.equal(row!.title, MARKER_TITLE.compaction);
});

test("markerRows invents no rewind of its own: they come from the insight, not the transcript", () => {
  assert.equal(MARKER_TITLE.rewind, "Rewound to an earlier message");
  assert.deepEqual(markerRows([user("u1", 0), say("a1:0", 1)]), []);
});

test("a rewind becomes a marker at its own time, with nothing to jump to", () => {
  const [row] = markerRows([user("u1", 0)], [rewind("rw1", 7)]);
  assert.equal(row!.marker, "rewind");
  assert.equal(row!.at, at(7));
  assert.equal(row!.title, MARKER_TITLE.rewind);
  assert.equal(row!.entryId, undefined, "its target left the branch, so a jump could only toast");
  assert.equal(row!.key, "marker:rewind:rw1");
});

test("a rewind with no timestamp gets no row: it cannot be placed on an axis", () => {
  assert.deepEqual(markerRows([], [{ id: "rw1", timestamp: "", targetId: "u1", fromLeafId: "a9" }]), []);
});

test("markerRows skips an entry with no timestamp: it cannot be placed on an axis", () => {
  assert.deepEqual(markerRows([{ id: "c1", kind: "info", text: "Compacted", raw: { type: "compaction" } }]), []);
});

// ---- Gaps ---------------------------------------------------------------------------------------

test("withGaps puts a dotless idle line between rows further apart than the threshold", () => {
  const rows: TimelineRow[] = [
    { key: "a", kind: "input", at: at(0), title: "one" },
    { key: "b", kind: "input", at: at(5), title: "two" },
    { key: "c", kind: "input", at: at(43), title: "three" },
  ];
  const got = withGaps(rows, 10 * 60_000);
  assert.deepEqual(kinds(got), ["input", "input", "gap", "input"]);
  assert.equal(got[2]!.title, "idle 38m");
  assert.equal(got[2]!.at, undefined, "a gap is the space between events, not an event");
});

// ---- The whole axis -----------------------------------------------------------------------------

test("timelineRows merges by time and follows each input with its density row", () => {
  const items = [user("u1", 0, "start the tab"), say("a1:0", 1), tool("a1:1", 2), compaction("c1", 3), user("u2", 4, "now the tests")];
  const rows = timelineRows(items, null);
  assert.deepEqual(kinds(rows), ["input", "density", "marker", "input"]);
  assert.equal(rows[0]!.title, "start the tab");
  assert.equal(rows[1]!.title, "1 reply · 1 tool · 3m", "the span runs to the turn's last stamped row, compaction included");
  assert.equal(rows[0]!.meta, undefined, "the density moved to its own row");
  assert.equal(rows[3]!.meta, undefined, "a turn with nothing after it gets no density row");
});

test("timelineRows sits a chapter beside its anchor, in transcript order", () => {
  const items = [user("u1", 0), say("a1:0", 0), user("u2", 0)];
  const rows = timelineRows(items, outline([topic("t1", "The chapter", "a1", Date.parse(at(59)))]));
  assert.deepEqual(rows.map((r) => r.title), ["u1", "1 reply", "The chapter", "u2"]);
});

test("timelineRows gaps the quiet stretches of a whole session", () => {
  const rows = timelineRows([user("u1", 0), say("a1:0", 1), user("u2", 40)], null, [], 10 * 60_000);
  assert.deepEqual(kinds(rows), ["input", "density", "gap", "input"]);
});

test("timelineRows keeps two rewinds in order among the rows around them", () => {
  const items = [user("u1", 0), say("a1:0", 1), user("u2", 4), say("a2:0", 5)];
  const rows = timelineRows(items, null, [rewind("rw1", 2), rewind("rw2", 6)]);
  assert.deepEqual(rows.map((r) => r.title), ["u1", "1 reply · 1m", MARKER_TITLE.rewind, "u2", "1 reply · 1m", MARKER_TITLE.rewind]);
  assert.deepEqual(rows.map((r) => r.key).filter((k) => k.startsWith("marker:")), ["marker:rewind:rw1", "marker:rewind:rw2"]);
});

test("timelineRows of an empty transcript is empty", () => {
  assert.deepEqual(timelineRows([], null), []);
});

// ---- The state line -----------------------------------------------------------------------------

test("timelineState mirrors the outline strip: when it was made, and whether it has fallen behind", () => {
  const now = Date.parse(at(33));
  assert.equal(timelineState(outline([]), now)!.text, "Updated 3m ago · current");
  assert.equal(timelineState(outline([], { state: "stale" }), now)!.text, "Updated 3m ago · behind the latest messages");
  assert.match(timelineState(outline([], { state: "failed-keeping-last" }), now)!.text, /the last update failed/);
  assert.equal(timelineState(outline([], { state: "updating" }), now)!.text, "Updating");
  assert.equal(timelineState(outline([], { generatedAt: 0 }), now), null, "never generated: no claim about freshness");
  assert.equal(timelineState(null, now), null);
});
