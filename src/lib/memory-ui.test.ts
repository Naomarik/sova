import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryOutline, MemoryStatus } from "../../shared/protocol";
import { MEMORY_TYPE_INFO } from "../../shared/memory";
import {
  kbOf,
  lineRange,
  memoryRowText,
  memoryRowWords,
  memoryTurnWords,
  openLineLabel,
  outlineHeading,
  outlineNote,
  outlineShown,
  sameMemoryChoice,
  sizeChoices,
  sizeLabel,
  UPDATING_WORDS,
} from "./memory-ui";
import { memoryDraftProblem, sameMemorySettings, toMemoryDraft, toMemorySettings } from "./memory-settings-draft";

const outline = (o: Partial<MemoryOutline>): MemoryOutline => ({
  on: true,
  type: "uniichat",
  size: 128,
  status: { state: "ready", messages: 10, background: 0 },
  messages: 10,
  bytes: 0,
  lines: [],
  ...o,
});
const line = (id: number, n: number, text: string | null = "x") => ({ id, n, text, entryId: null, lastEntryId: null });

test("a size reads as UniiChat's kept range, or zoomable compaction's one size", () => {
  assert.equal(sizeLabel("uniichat", 128), "64–128 KB");
  assert.equal(sizeLabel("uniichat", 9), "4.5–9 KB");
  assert.equal(sizeLabel("zoomable", 32), "32 KB");
  // The chat's own size joins the suggested ones, in order; a listed one isn't doubled.
  assert.deepEqual(sizeChoices([16, 64], 40), [16, 40, 64]);
  assert.deepEqual(sizeChoices([16, 64], 64), [16, 64]);
  assert.ok(sizeChoices(undefined, undefined).includes(128));
});

test("the turn says Updating memory… only while it waits, never in another state", () => {
  const states: MemoryStatus[] = [
    { state: "off" },
    { state: "preparing", done: 1, total: 4 },
    { state: "ready", messages: 4, background: 2 },
  ];
  for (const s of states) assert.equal(memoryTurnWords(s), null, s.state);
  assert.equal(memoryTurnWords(null), null);
  assert.equal(memoryTurnWords({ state: "updating", pending: 3 }), UPDATING_WORDS);
});

test("the row's memory piece: preparing's count, a problem first, nothing when ready, updating or off", () => {
  assert.deepEqual(memoryRowWords({ state: "preparing", done: 120, total: 480 }), { text: "Preparing memory: 120 of 480 messages", problem: false });
  assert.deepEqual(memoryRowWords({ state: "preparing", done: 0, total: 1 }), { text: "Preparing memory: 0 of 1 message", problem: false });
  assert.deepEqual(memoryRowWords({ state: "preparing", done: 1, total: 4, problem: "No model can summarize." }), {
    text: "Memory: No model can summarize.",
    problem: true,
  });
  assert.deepEqual(memoryRowWords({ state: "ready", messages: 1, background: 0, problem: "Login failed." })?.problem, true);
  // A sentence that already names memory isn't named twice.
  assert.equal(memoryRowWords({ state: "ready", messages: 1, background: 0, problem: "Memory summaries are failing." })?.text, "Memory summaries are failing.");
  assert.equal(memoryRowWords({ state: "ready", messages: 9, background: 3 }), null);
  assert.equal(memoryRowWords({ state: "updating", pending: 1 }), null);
  assert.equal(memoryRowWords({ state: "off" }), null);
  assert.equal(memoryRowWords(null), null);
});

test("a line names its messages, one or a range", () => {
  assert.equal(lineRange(line(40, 8)), "40–47");
  assert.equal(lineRange(line(12, 1)), "12");
  assert.equal(openLineLabel(line(40, 8)), "Open messages 40–47");
  assert.equal(openLineLabel(line(12, 1)), "Open message 12");
});

test("the Session tab shows Memory only while on, or off with lines kept", () => {
  assert.equal(outlineShown(null), false);
  assert.equal(outlineShown(outline({ on: false, lines: [] })), false);
  assert.equal(outlineShown(outline({ on: false, lines: [line(0, 1)] })), true);
  assert.equal(outlineShown(outline({ on: true, lines: [] })), true);
});

test("the outline's heading and its sentence for each state", () => {
  assert.equal(outlineHeading(outline({ lines: [line(0, 2), line(2, 1)], bytes: 98_304 })), "UniiChat · 2 lines · 96 KB of 128 KB");
  assert.equal(outlineHeading(outline({ on: false, lines: [line(0, 1)], bytes: 300 })), "UniiChat, off · 1 line · under 1 KB of 128 KB");
  assert.equal(kbOf(0), "0 KB");
  assert.equal(kbOf(1536), "1.5 KB");
  assert.match(outlineNote(outline({ on: false, lines: [line(0, 1)] }))!, /^Memory is off/);
  assert.equal(outlineNote(outline({ status: { state: "preparing", done: 120, total: 480 } })), "Preparing memory: 120 of 480 messages. Until it's ready the model sees the chat as usual.");
  assert.equal(outlineNote(outline({ type: "zoomable", messages: 30 })), "30 messages summarized so far. Nothing has compacted yet, so the model sees the chat as usual.");
  assert.equal(outlineNote(outline({ messages: 0 })), "No messages yet.");
  // Lines on screen speak for themselves.
  assert.equal(outlineNote(outline({ lines: [line(0, 1)] })), null);
});

test("the mode row: the type's description, its detail line only while on", () => {
  const uc = MEMORY_TYPE_INFO.find((t) => t.id === "uniichat")!;
  const zc = MEMORY_TYPE_INFO.find((t) => t.id === "zoomable")!;
  assert.deepEqual(memoryRowText(undefined, { type: "uniichat", size: 128 }, true), { description: uc.rowDescription, detail: "UniiChat — by Victor Taelin" });
  assert.deepEqual(memoryRowText(undefined, { type: "zoomable", size: 32 }, false), { description: zc.rowDescription, detail: null });
});

test("a memory choice is the default only when both are known and equal", () => {
  assert.equal(sameMemoryChoice({ type: "uniichat", size: 128 }, { type: "uniichat", size: 128 }), true);
  assert.equal(sameMemoryChoice({ type: "uniichat", size: 128 }, { type: "uniichat", size: 64 }), false);
  assert.equal(sameMemoryChoice({ type: "uniichat", size: 128 }, { type: "zoomable", size: 128 }), false);
  assert.equal(sameMemoryChoice(null, { type: "uniichat", size: 128 }), false);
});

test("Settings → Memory's draft: complete rows only, the PUT never carries the default", () => {
  const saved = {
    version: 1 as const,
    summarizer: { primary: { backend: "claude-code" as const, model: "claude-haiku-5-5", effort: "low" }, fallback: null },
    default: { type: "zoomable" as const, size: 32 },
  };
  const d = toMemoryDraft(saved);
  assert.equal(sameMemorySettings(d, saved), true);
  assert.equal(memoryDraftProblem(d), null);
  assert.equal(memoryDraftProblem({ ...d, primary: { ...d.primary, model: "" } }), "Memory needs a primary model.");
  assert.equal(memoryDraftProblem({ ...d, fallback: { ...d.primary } }), "Memory has a fallback that's the same model as its primary.");
  assert.equal(memoryDraftProblem({ ...d, fallback: { backend: "pi", model: "zai/glm-5.3", effort: "" } }), "Memory needs an effort for its fallback model.");
  const body = toMemorySettings(d);
  assert.equal("default" in body, false);
  assert.deepEqual(body.summarizer, saved.summarizer);
});
