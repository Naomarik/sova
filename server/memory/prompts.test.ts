// Run: bun test server/memory/prompts.test.ts (or pnpm test). Pure: reads no files and no state.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MEMORY_TOOLS } from "../../shared/memory";
import { COMPACTION_GUIDE, idRetry, TURN_GUIDE } from "./prompts";
import { dateTool, zoomTool } from "./tools";

describe("the turn guide (§chat.memory/turn)", () => {
  test("holds no date, time or id, so it stays a stable cache prefix", () => {
    assert.doesNotMatch(TURN_GUIDE, /\d{4}-\d{2}|\d{1,2}:\d{2}|\b[0-9a-f]{8}-[0-9a-f]{4}/i);
    assert.doesNotMatch(TURN_GUIDE, /\$\{/, "every name is substituted");
  });

  test("names exactly the memory tools, each called with its arguments", () => {
    const called = new Set([...TURN_GUIDE.matchAll(/\b([a-z_]+)\(id\b/g)].map((m) => m[1]));
    assert.deepEqual([...called].sort(), [...MEMORY_TOOLS].sort());
  });

  test("calls the lines an index over messages kept whole, and sends recall to zoom first", () => {
    const flat = TURN_GUIDE.replace(/\s+/g, " ");
    assert.ok(flat.includes("You see its history as an index"), flat);
    assert.ok(flat.includes("Lines are the index, not the record: every message is kept whole under its line, tool results included"), flat);
    assert.ok(flat.includes("first find its latest mention in the view and zoom, halving n down to the message, before any other tool"), flat);
    assert.ok(flat.includes("Never grep or read this chat's transcript or memory files."), flat);
    assert.ok(!flat.includes("is the truth"), "the old wording is gone");
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
});

describe("the compaction guide (§chat.memory/summarizer)", () => {
  test("says ids are copied whole, never shortened, and holds no id or date of its own", () => {
    const flat = COMPACTION_GUIDE.replace(/\s+/g, " ");
    assert.ok(flat.includes("Copy names, numbers, ids, paths and errors exactly: session ids and other UUIDs and hashes whole, never shortened to a prefix."), flat);
    assert.doesNotMatch(COMPACTION_GUIDE, /\d{4}-\d{2}|\b[0-9a-f]{8}\b/i);
  });

  test("the retry names the ids to copy whole", () => {
    const id = "5c5c5c5c-2222-7333-8444-555566667777";
    assert.equal(idRetry([id]), `\n\nYour last line shortened this id; copy it whole: ${id}`);
    assert.match(idRetry([id, id]), /these ids; copy each whole: /);
  });
});
