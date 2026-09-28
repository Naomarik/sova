import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis, visKindWord } from "./parse";
import { KIND_WORDS, KINDS } from "./registry";

const err = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  assert.equal(r.ok, false, `expected an error for:\n${body}`);
  return r as { ok: false; line: number; message: string };
};

test("visKindWord reads the kind after vis, and nothing for other fences", () => {
  assert.equal(visKindWord("vis flow"), "flow");
  assert.equal(visKindWord("  VIS   Chart "), "chart");
  assert.equal(visKindWord("vis"), "");
  assert.equal(visKindWord("ts"), null);
  assert.equal(visKindWord("visual"), null);
});

test("an unknown or missing kind is an error naming the kinds", () => {
  assert.match(err("mermaid", "a -> b").message, /unknown kind "mermaid".*flow/);
  assert.match(err("", "a -> b").message, /name the kind/);
});

test("every registered kind parses through the entry, and none throws on junk", () => {
  for (const kind of KIND_WORDS) {
    const r = parseVis(kind, "\u0000 ] [ -> \" |||");
    assert.equal(typeof r.ok, "boolean", kind);
  }
});

test("every kind reserves its drawing's height before its View loads", () => {
  for (const [word, entry] of Object.entries(KINDS)) assert.equal(typeof entry.size, "function", `${word} has no size estimate`);
});
