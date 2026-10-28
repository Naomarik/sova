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
  assert.ok(whens.length > 5);
  for (const w of whens) assert.ok(w === "drawn()" || w === "hit()?.kind.drawsNothing" || /^is(<.*>)?\("[a-z-]+"\)$/s.test(w), `a row matched outside the list: <Match when={${w}}>`);
  assert.equal(whens[0], "drawn()", "the toolkit's rows come first, before any branch here");
  assert.doesNotMatch(rowSwitch, /item\.kind ===/, "no kind test in the row Switch");
});

test("a kind the toolkit draws has no branch of its own in Thread.tsx", () => {
  const drawn = toolkitKinds();
  assert.deepEqual(drawn, ["wake", "topic", "compaction", "info", "card"], "the kinds on the toolkit so far: add a moved kind here as it moves");
  for (const id of drawn) assert.ok(!branchIds.includes(id), `${id} is drawn by the toolkit and by a branch in Thread.tsx`);
  for (const view of ["WakeCard", "TopicCard", "Compaction", "InfoRow", "SubagentLimitRow"]) assert.doesNotMatch(rowSwitch, new RegExp(`<${view}[\\s>]`), `${view} drawn in the row Switch`);
});

test("every kind not on the toolkit has exactly one branch, in the list's order, so no row falls to Unknown", () => {
  const legacy = TRANSCRIPT_KINDS.filter((k) => !k.view && !k.drawsNothing).map((k) => k.id);
  assert.deepEqual(branchIds, legacy, "Thread.tsx's branches, one per kind, in the list's order");
});

test("the toolkit's views stay out of the thread's internals", () => {
  assert.doesNotMatch(host, /from "\.\/(Thread|ChatView)"/);
  assert.doesNotMatch(read("../components/DataCards.tsx"), /from "\.\/(Thread|ChatView)"/);
});
