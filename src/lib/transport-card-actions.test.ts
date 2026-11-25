// The Transport agent card's one action row (§app.transport/agent, words in §design.copy-deck): its order, its words,
// and its one primary, over every state the card has.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { transportCardActions } from "./transport-card-actions";

type At = Parameters<typeof transportCardActions>[0];
const none: At = { downloads: null, commands: [], hostValues: false, href: null };
const row = (a: Partial<At>) =>
  transportCardActions({ ...none, ...a }).map((x) => `${x.label}${x.primary ? "*" : ""}`);

describe("the action row", () => {
  test("working or ready: Open Agent Chat alone, never primary; nothing at all without its chat", () => {
    assert.deepEqual(row({ href: "/s/x" }), ["Open Agent Chat"]);
    assert.deepEqual(row({}), []);
  });

  test("every answer comes before Open Agent Chat, in one row, and only the first is primary", () => {
    assert.deepEqual(row({ downloads: "dl_1", commands: ["ad_1"], hostValues: true, href: "/s/x" }), ["Allow Downloads*", "Done", "Save Values", "Open Agent Chat"]);
    assert.deepEqual(row({ commands: ["ad_1"], href: "/s/x" }), ["Done*", "Open Agent Chat"]);
    assert.deepEqual(row({ hostValues: true }), ["Save Values*"]);
  });

  test("with more than one command, each Done names its command, so no two buttons read the same", () => {
    const labels = row({ commands: ["ad_1", "ad_2"] });
    assert.deepEqual(labels, ["Done With Command 1*", "Done With Command 2"]);
    assert.equal(new Set(labels).size, labels.length);
  });

  test("each answer carries the id it answers", () => {
    const acts = transportCardActions({ ...none, downloads: "dl_1", commands: ["ad_1", "ad_2"] });
    assert.deepEqual(acts.map((a) => ("id" in a ? a.id : null)), ["dl_1", "ad_1", "ad_2"]);
  });
});
