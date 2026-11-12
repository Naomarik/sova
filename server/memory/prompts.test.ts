// Run: bun test server/memory/prompts.test.ts (or pnpm test). Pure: reads no files and no state.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MEMORY_TOOLS } from "../../shared/memory";
import { MEMORY_HOLDS, RECALL_FIRST, RECALL_LISTS, TURN_GUIDE, zoomableSummary } from "./prompts";
import { dateTool, recallTool, zoomTool } from "./tools";

describe("the turn guide (§chat.memory/turn)", () => {
  test("holds no date, time or id, so it stays a stable cache prefix", () => {
    assert.doesNotMatch(TURN_GUIDE, /\d{4}-\d{2}|\d{1,2}:\d{2}|\b[0-9a-f]{8}-[0-9a-f]{4}/i);
    assert.doesNotMatch(TURN_GUIDE, /\$\{/, "every name is substituted");
  });

  test("names exactly the memory tools, each called with its arguments", () => {
    const called = new Set([...TURN_GUIDE.matchAll(/\b([a-z_]+)\((?:id|words)\b/g)].map((m) => m[1]));
    assert.deepEqual([...called].sort(), [...MEMORY_TOOLS].sort());
  });

  test("calls the lines an index over messages kept whole, and sends recall to zoom first", () => {
    const flat = TURN_GUIDE.replace(/\s+/g, " ");
    assert.ok(flat.includes("You see its history as an index"), flat);
    assert.ok(flat.includes("Lines are the index, not the record: every message is kept whole under its line, tool results included"), flat);
    assert.ok(flat.includes("first find its latest mention in the view and zoom, halving n down to the message, or recall it by its words when no line names it, before any other tool"), flat);
    assert.ok(flat.includes("recall(words) lists the messages that hold every word, closest match first, each with its id."), flat);
    assert.ok(flat.includes("Use other tools only for what the view and recall never show, or to check what is true now; never search elsewhere to confirm what memory already holds."), flat);
    assert.ok(flat.includes("Never grep or read this chat's transcript or memory files."), flat);
    assert.ok(!flat.includes("is the truth"), "the old wording is gone");
    assert.ok(flat.includes("while lines at every n shorten names and numbers."), flat);
    assert.ok(!/shorten ids/.test(flat), "ids are shown whole (§chat.memory/full-ids), so the guide never says lines shorten them");
  });
});

describe("the recall tools (§chat.memory/recall)", () => {
  test("zoom's description says it recalls anything said before, and to use it before searching", () => {
    const zoom = zoomTool(() => undefined);
    assert.equal(
      zoom.description,
      "Recall anything from earlier in this chat (a session, its full id, a branch, a number, what was said): every message is kept whole under its memory line. Opens line id+n into its two lines of n/2; n = 1 gives message id whole. Use it before searching.",
    );
    assert.deepEqual(zoom.parameters.required, ["id", "n"]);
    assert.equal(dateTool(() => undefined).description, "The date and time of message id in the memory view.");
  });

  test("recall's description names what it lists and how, and never another chat's tools", () => {
    const recall = recallTool(() => undefined);
    assert.equal(
      recall.description,
      'Find messages of this chat by their words, when no memory line names what you need. Lists the messages that hold every word (case-insensitive), closest match first: the words together, then what you or the user said ahead of tool output, then newest. Each is id|kind: the text around the match, with ids whole; "+N alike" names messages that repeat it. zoom(id, 1) then gives one whole. Use it before looking elsewhere.',
    );
    assert.ok(!/session/i.test(recall.description), "it ships to every memory chat, so it names no Overseer tool");
    assert.deepEqual(recall.parameters.required, ["words"]);
    assert.deepEqual(Object.keys(recall.parameters.properties as object), ["words", "before"]);
  });

  test("a zoomable compaction's summary carries the guide's three recall sentences, word for word", () => {
    const summary = zoomableSummary([], 1);
    for (const sentence of [RECALL_LISTS, RECALL_FIRST, MEMORY_HOLDS]) {
      assert.ok(TURN_GUIDE.includes(sentence), `the UniiChat guide has: ${sentence}`);
      assert.ok(summary.includes(sentence), `the zoomable summary has: ${sentence}`);
    }
    const flat = summary.replace(/\s+/g, " ");
    assert.ok(flat.includes("zoom until you have it whole, or recall it by its words when no line names it, before any other tool"), flat);
    assert.ok(flat.includes("never search elsewhere to confirm what memory already holds."), flat);
  });
});
