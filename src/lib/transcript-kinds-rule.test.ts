// Run: pnpm test -- src/lib/transcript-kinds-rule.test.ts
// The rule (§chat.transcript-cards/toolkit: "no card is drawn by a path of its own"): the settled
// transcript's rows are drawn by looking their kind up in lib/transcript-kinds.ts. Read from the
// source, so a kind that moved onto the toolkit getting a branch of its own back in Thread.tsx, a row
// matched in Thread.tsx instead of in the list, or a list kind with no way to draw, fails here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { toolkitKinds, TRANSCRIPT_KINDS } from "./transcript-kinds";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const thread = read("../components/Thread.tsx");
const host = read("../components/TranscriptKind.tsx");

/** HistoryItems' row Switch: from its Unknown fallback to the Switch's end (it holds no other Switch). */
const rowSwitch = (() => {
  const open = '<Switch fallback={<Unknown raw={item.entry} />}>';
  const from = thread.indexOf(open);
  assert.ok(from > 0, "the row Switch is where the rule expects it");
  assert.equal(thread.indexOf(open, from + 1), -1, "one row Switch");
  const to = thread.indexOf("</Switch>", from);
  const body = thread.slice(from + open.length, to);
  assert.equal(body.includes("<Switch"), false, "no Switch nested in the row Switch");
  return body;
})();
/** Each `<Match when={…}>` condition, read to its balancing brace (a type argument may hold braces). */
const whens = (() => {
  const out: string[] = [];
  const open = "<Match when={";
  for (let i = rowSwitch.indexOf(open); i >= 0; i = rowSwitch.indexOf(open, i + 1)) {
    let depth = 1;
    let j = i + open.length;
    for (; j < rowSwitch.length && depth > 0; j++) depth += rowSwitch[j] === "{" ? 1 : rowSwitch[j] === "}" ? -1 : 0;
    out.push(rowSwitch.slice(i + open.length, j - 1));
  }
  return out;
})();
const branchIds = whens.flatMap((w) => /^is(?:<.*>)?\("([^"]+)"\)$/s.exec(w)?.[1] ?? []);

test("Thread.tsx matches no row itself: every branch is the toolkit's, the draw-nothing kinds', or one kind's by its id", () => {
  assert.ok(whens.length >= 2, "the row Switch is read: the toolkit's branch and the draw-nothing kinds' at least");
  for (const w of whens) assert.ok(w === "drawn()" || w === "hit()?.kind.drawsNothing" || /^is(<.*>)?\("[a-z-]+"\)$/s.test(w), `a row matched outside the list: <Match when={${w}}>`);
  assert.equal(whens[0], "drawn()", "the toolkit's rows come first, before any branch here");
  assert.doesNotMatch(rowSwitch, /item\.kind ===/, "no kind test in the row Switch");
});

/** Each kind on the toolkit, with the components its old branch drew: none may be drawn in the row Switch again. */
const MOVED: Record<string, string[]> = {
  "worktree-merge": ["WorktreeMergeCard"],
  wake: ["WakeCard"],
  topic: ["TopicCard"],
  compaction: ["Compaction"],
  info: ["InfoRow", "SubagentLimitRow"],
  card: [],
  settings: ["SettingsToolCard"],
  offer: ["OfferCardView"],
  "show-changes": ["ShowChangesCard"],
  tour: ["TourCard"],
  "owner-request": ["OwnerRequestNote"],
  "handoff-run": ["HandoffRunRow"],
  "overseer-answer": ["OverseerChoiceRow"],
  "profile-mark": [],
  brief: ["BriefRow"],
  explain: ["ExplainCard"],
  "team-report": ["TeamMessageCard"],
  report: ["ReportRow"],
  baton: ["BatonCard"],
  user: ["UserTurn"],
  "assistant-text": ["AssistantText"],
  thinking: ["Thinking"],
  "tool-result": [],
  tool: ["ToolCard", "DeckCard", "CardRevision", "ConfirmCard", "LinkCard", "ProfileToolCardView", "NavigateGo"],
  "align-report": ["AlignCard"],
  align: ["AlignRow"],
};

test("a kind the toolkit draws has no branch of its own in Thread.tsx", () => {
  const drawn = toolkitKinds();
  assert.deepEqual([...drawn].sort(), Object.keys(MOVED).sort(), "the kinds on the toolkit so far: add a moved kind to MOVED as it moves");
  for (const id of drawn) assert.ok(!branchIds.includes(id), `${id} is drawn by the toolkit and by a branch in Thread.tsx`);
  for (const view of Object.values(MOVED).flat()) assert.doesNotMatch(rowSwitch, new RegExp(`<${view}[\\s>/]`), `${view} drawn in the row Switch`);
  for (const id of drawn) assert.doesNotMatch(rowSwitch, new RegExp(`\\("${id}"\\)`), `the row Switch asks for ${id}, a kind the toolkit draws`);
});

test("every kind not on the toolkit has exactly one branch, in the list's order, so no row falls to Unknown", () => {
  const legacy = TRANSCRIPT_KINDS.filter((k) => !k.view && !k.drawsNothing).map((k) => k.id);
  assert.deepEqual(branchIds, legacy, "Thread.tsx's branches, one per kind, in the list's order");
});

test("no card is left on the old path: every kind is drawn by the toolkit or draws nothing, and the row Switch holds those two branches only", () => {
  for (const k of TRANSCRIPT_KINDS) assert.ok(k.view || k.drawsNothing, `${k.id} has neither a view nor drawsNothing`);
  assert.deepEqual(whens, ["drawn()", "hit()?.kind.drawsNothing"]);
  assert.deepEqual(branchIds, []);
});

test("the toolkit's views stay out of the thread's internals", () => {
  for (const file of ["TranscriptKind.tsx", "DataCards.tsx", "BuiltinKinds.tsx", "LiveKinds.tsx", "MessageRows.tsx", "thread-rows.ts"])
    assert.doesNotMatch(read(`../components/${file}`), /from "\.\/(Thread|ChatView)"/, file);
});

/** A top-level function of Thread.tsx, read from its declaration to the closing brace at column 0. */
const fn = (name: string): string => {
  const from = thread.search(new RegExp(`^(export )?function ${name}\\(`, "m"));
  assert.ok(from >= 0, `${name} is where the rule expects it`);
  const to = thread.indexOf("\n}\n", from);
  return thread.slice(from, to + 2);
};
/** Every component a piece of source draws: `<Name` and `<Name.Member` tags. */
const tags = (src: string) => new Set([...src.matchAll(/<([A-Z][A-Za-z0-9]*(?:\.[A-Za-z]+)?)[\s>/]/g)].map((m) => m[1]!));
/** What tells one kind from another: a kind's own match belongs in lib/transcript-kinds.ts, never in the thread. */
const KIND_TESTS = /\b(parseWakeNudge|parseTopicBatch|isBriefText|alignRowFromDetails|normalizeCardDetails|normalizeRaisedCard|isSettingsToolDetails|linkDetails|normalizeTourCardDetails)\b|\.name === "|RAISE_CARD_TOOL|SETTINGS_TOOL/;

test("the running turn is drawn through the same list and host: no live branch of its own in Thread.tsx", () => {
  assert.doesNotMatch(thread, /LiveBlockView/, "the old live chain is gone");
  const liveRow = fn("LiveRow");
  const liveEntries = fn("LiveEntries");
  // LiveRow: the live lookup, then the toolkit's host; nothing else draws.
  assert.match(liveRow, /liveKindOf\(input, rows\)/);
  assert.deepEqual([...tags(liveRow)].sort(), ["Show", "TranscriptKindRow"], "LiveRow draws the host and nothing else");
  // LiveEntries lays the run out (entries, the work chain, the hidden rows) and draws each piece as a LiveRow.
  const allowed = new Set(["For", "Show", "Switch", "Match", "LiveRow", "ChainFold", "HiddenRows", "LiveRowsContext.Provider"]);
  for (const t of tags(liveEntries)) assert.ok(allowed.has(t), `LiveEntries draws <${t}> itself: a live card goes on its kind's live view (components/LiveKinds.tsx)`);
  assert.match(liveEntries, /<LiveRow input=\{\{ kind: "user", entry: e\(\) \}\} \/>/, "a message going in is a LiveRow");
  assert.match(liveEntries, /liveBlockInput\(block,/, "a streamed block is a LiveRow");
  assert.match(liveEntries, /liveEndsOf\(e\(\)\)/, "the reply's end is a LiveRow");
  for (const src of [liveRow, liveEntries]) assert.doesNotMatch(src.replace(/const liveChains = createMemo[\s\S]*?\n  \}\);\n/, ""), KIND_TESTS, "a kind told apart in the thread's live path");
});

test("Thread.tsx imports no card or message view: every one is drawn by a kind's view or live view", () => {
  const imports = [...thread.matchAll(/^import [^;]* from "\.\/([A-Za-z]+)";$/gm)].map((m) => m[1]!);
  const VIEWS = ["AlignDocCard", "AlignCard", "ToolCard", "TourCard", "OfferCard", "ChangesViewer", "SettingsChangeCard", "OverseerCards", "WakeCard", "TopicCard", "SubagentLimitRow", "TranscriptCard", "WorktreeMergeCard", "ExplainCard", "TeamMessageCard", "ReportRow", "ProfileCards", "BuiltinKinds", "LiveKinds"];
  for (const v of VIEWS) assert.ok(!imports.includes(v), `Thread.tsx imports ./${v}`);
  assert.doesNotMatch(thread, /import\(\s*["']\.\/TranscriptCard["']\s*\)/, "no card module loaded by the thread itself");
  // The message rows file is the views' own: the thread takes only the error banner it re-exports.
  assert.match(thread, /^import \{ TurnError \} from "\.\/MessageRows";$/m);
});

test("every live view is some kind's, and a kind with a live form names one", () => {
  const union = /export type LiveView = ([^;]+);/.exec(read("./transcript-kinds.ts"))?.[1] ?? "";
  const views = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
  const used = TRANSCRIPT_KINDS.flatMap((k) => (k.live ? [k.live.view] : []));
  assert.deepEqual([...new Set(used)].sort(), [...views].sort(), "the live views are exactly the kinds' live forms'");
  for (const k of TRANSCRIPT_KINDS) if (k.live) assert.ok(k.view, `${k.id} draws live but has no settled view`);
});
