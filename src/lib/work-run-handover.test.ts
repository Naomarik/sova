// Run: pnpm test -- src/lib/work-run-handover.test.ts
// A row stands in the same place in the Work run (§chat.transcript/work-chain) while its turn streams
// and once it settles: the running turn (LiveEntries) and the settled transcript (HistoryItems) cut
// their runs by one rule, each call's kind (lib/transcript-kinds.ts `outsideWork`), so nothing moves
// at the handover. Both are drawn with Solid's SSR build (src/lib/align-card-ssr.mjs) from the same
// turn, a settings card between two plain calls, and each row's run is read from its markup.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setCompressWork } from "./work-compression";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString, renderToStringAsync } = await import("solid-js/web");
const { LiveEntries, HistoryItems } = await importSsr(new URL("../components/Thread.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
type TranscriptItem = import("../../shared/protocol").TranscriptItem;
type LiveState = import("./live").LiveState;
type LiveTool = import("./live").LiveTool;

const AT = "2026-02-01T10:00:00.000Z";
const settings = {
  kind: "settings-card",
  projectId: "p1",
  card: null,
  appliedNow: [{ id: "h1", at: AT, field: "autonomy", from: "ask", to: "act", by: { kind: "operator" }, label: "Autonomy", fromText: "Ask first", toText: "Act" }],
};
/** The turn: a plain call, a settings call that applied a change, another plain call. */
const CALLS: { id: string; name: string; args: Record<string, unknown>; output: string; details?: unknown }[] = [
  { id: "r1", name: "read", args: { path: "/a.ts" }, output: "a" },
  { id: "st", name: "sova_settings", args: { op: "set" }, output: "ok", details: settings },
  { id: "r2", name: "read", args: { path: "/b.ts" }, output: "b" },
];

const live = (status: "running" | "done"): LiveState => {
  const tools: Record<string, LiveTool> = {};
  for (const c of CALLS) tools[c.id] = { name: c.name, status, output: status === "done" ? c.output : "", images: [], ...(status === "done" && c.details ? { details: c.details } : {}) };
  return {
    entries: [
      { kind: "user", text: "Set it", state: "delivered", images: [], started: true },
      { kind: "assistant", blocks: CALLS.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, argsText: JSON.stringify(c.args), args: c.args })), done: false, model: "anthropic/claude-x" },
    ],
    tools,
    running: true,
    activity: null,
    stopping: false,
  } as LiveState;
};
const settled: TranscriptItem[] = [
  { id: "u1", kind: "user", at: AT, text: "Set it" } as TranscriptItem,
  ...CALLS.flatMap((c) => [
    { id: `call-${c.id}`, kind: "tool-call", at: AT, text: c.name, toolCallId: c.id, tool: { args: c.args } } as never as TranscriptItem,
    { id: `res-${c.id}`, kind: "tool-result", at: AT, toolCallId: c.id, text: c.output, tool: { output: c.output, details: c.details }, facts: { tool: { isError: false } } } as never as TranscriptItem,
  ]),
];

/**
 * Each row the markup draws, in order: the settings card, or a plain call (by its path), with the
 * run it stands in (its `data-chain`, renumbered by first appearance), or none.
 */
function placements(html: string): string[] {
  const out: string[] = [];
  const runs = new Map<string, number>();
  // Every row's own wrapper carries data-chain when it is a step of a run; a card's wrapper carries none.
  const marks = /data-chain="(\d+)"|data-settings-card=|&quot;path&quot;:&quot;(\/[ab]\.ts)|"path":"(\/[ab]\.ts)|>(\/[ab]\.ts)</g;
  let chain: string | undefined;
  const seen = new Set<string>();
  for (const m of html.matchAll(marks)) {
    if (m[1] !== undefined) {
      chain = m[1];
      continue;
    }
    const what = m[0] === "data-settings-card=" ? "settings" : (m[2] ?? m[3] ?? m[4])!;
    if (seen.has(what)) continue;
    seen.add(what);
    const run = chain;
    if (run !== undefined && !runs.has(run)) runs.set(run, runs.size + 1);
    out.push(`${what}${run === undefined ? "" : ` in run ${runs.get(run)}`}`);
    chain = undefined;
  }
  return out;
}

const drawLive = async (state: LiveState) => {
  setCompressWork(true);
  return await renderToStringAsync(() => solid.createComponent(LiveEntries as never, { live: state, author: "Agent" } as never));
};
const drawSettled = () => {
  setCompressWork(true);
  return renderToString(() => solid.createComponent(HistoryItems as never, { items: settled, author: "Agent", streaming: false, whole: true } as never));
};

test("a settings card stands outside the Work run mid-stream and once settled, so it doesn't move at the handover", async () => {
  const done = placements(await drawLive(live("done")));
  const after = placements(drawSettled());
  assert.deepEqual(after, ["/a.ts in run 1", "settings", "/b.ts in run 2"], "settled: the settings card breaks the run");
  assert.deepEqual(done, after, "the running turn draws each row where the settled one does");
});

test("a settings call still running is a step: no card yet, nothing to stand apart", async () => {
  const running = await drawLive(live("running"));
  assert.doesNotMatch(running, /data-settings-card=/);
  assert.match(running, /Work · 3 steps/);
});
