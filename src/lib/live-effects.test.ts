// Run: pnpm test -- src/lib/live-effects.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "solid-js/store";
import { applyEvent, emptyLive, type LiveState } from "./live";
import type { LiveEffectsContext } from "./live-effects";

const PLAIN: LiveEffectsContext = { overseer: false, mine: false };
const OVERSEER_MINE: LiveEffectsContext = { overseer: true, mine: true };

/** The effects of each event, applied in order to one fresh store. */
function effects(events: unknown[], view: LiveEffectsContext = PLAIN) {
  const [, set] = createStore<LiveState>(emptyLive());
  return events.map((ev) => applyEvent(set, ev, view));
}

const reply = (extra: Record<string, unknown>) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", ...extra },
});
const navigate = (extra: Record<string, unknown> = {}) => ({
  type: "tool_execution_end",
  toolCallId: "n1",
  toolName: "sova_navigate",
  result: { content: [], details: { href: "#/usage", label: "Usage" } },
  ...extra,
});

test("a turn's start clears the last turn's error and announces work; its settle is the settle", () => {
  assert.deepEqual(effects([{ type: "agent_start" }, { type: "agent_settled" }]), [["clearTurnError", "announceWorking"], ["settled"]]);
});

test("a finished reply reports its context fill; one that measured nothing reports none", () => {
  assert.deepEqual(effects([reply({ usage: { input: 100, cacheRead: 20, cacheWrite: 3, output: 9 } })]), [[{ context: 123 }]]);
  assert.deepEqual(effects([reply({ usage: { input: 0, cacheRead: 0, cacheWrite: 0 } })]), [[]]);
  assert.deepEqual(effects([reply({})]), [[]]);
  assert.deepEqual(effects([reply({ stopReason: "error", usage: { input: 5 } })]), [[]]);
  assert.deepEqual(effects([reply({ stopReason: "aborted", usage: { input: 5 } })]), [[]]);
});

test("only an assistant message_end can report a fill", () => {
  assert.deepEqual(effects([{ type: "message_end", message: { role: "user", content: "x", usage: { input: 5 } } }]), [[]]);
  assert.deepEqual(effects([{ type: "message_end", message: { role: "toolResult", usage: { input: 5 } } }]), [[]]);
  assert.deepEqual(effects([{ type: "message_end" }]), [[]]);
});

test("a compaction turns the indicator on and off; only one that wrote a result makes the fill stale", () => {
  assert.deepEqual(effects([{ type: "compaction_start", reason: "manual" }, { type: "compaction_end", reason: "manual", result: { summary: "s" } }]), [
    ["compacting"],
    ["compactingDone", "compacted"],
  ]);
  assert.deepEqual(effects([{ type: "compaction_end", reason: "manual", aborted: true }]), [["compactingDone"]]);
});

test("the Overseer's navigate applies only in its own view, in the tab that started the turn, on success", () => {
  assert.deepEqual(effects([navigate()], OVERSEER_MINE), [[{ navigate: "#/usage" }]]);
  assert.deepEqual(effects([navigate({ toolCallId: undefined })], OVERSEER_MINE), [[{ navigate: "#/usage" }]], "no call id: still navigates");
  assert.deepEqual(effects([navigate()], { overseer: true, mine: false }), [[]]);
  assert.deepEqual(effects([navigate()], { overseer: false, mine: true }), [[]]);
  assert.deepEqual(effects([navigate({ isError: true })], OVERSEER_MINE), [[]]);
  assert.deepEqual(effects([navigate({ toolName: "sova_other" })], OVERSEER_MINE), [[]]);
  assert.deepEqual(effects([navigate({ result: { details: { href: "https://example.com" } } })], OVERSEER_MINE), [[]]);
  assert.deepEqual(effects([navigate({ result: { details: { href: "settings:models" } } })], OVERSEER_MINE), [[{ navigate: "settings:models" }]]);
});

test("every other event, and a non-object, has no effect", () => {
  const quiet = [
    { type: "turn_start" },
    { type: "turn_end" },
    { type: "agent_end" },
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } },
    { type: "tool_execution_start", toolCallId: "t", toolName: "bash" },
    { type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: { content: [] } },
    { type: "auto_retry_start" },
    { type: "auto_retry_end" },
    { type: "queue_update", steering: [], followUp: [] },
    { type: "sova_baton_sent", by: "operator" },
    null,
    "agent_start",
  ];
  assert.deepEqual(effects(quiet, OVERSEER_MINE), quiet.map(() => []));
});

test("applyEvent without a view decides as no one's: no navigate", () => {
  const [, set] = createStore<LiveState>(emptyLive());
  assert.deepEqual(applyEvent(set, navigate()), []);
});
