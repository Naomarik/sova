import assert from "node:assert/strict";
import { test } from "node:test";
import { linearScale, logScale, niceStep, shortNumber } from "./scale";
import { wrap } from "./text";
import { clip, collectWarnings, commaList, fields, MAX_TEXT, setting, text, tokenize, warn } from "./grammar";
import { parseVis } from "../parse";

test("wrap breaks at words, then at path separators, and ellipsizes past maxLines", () => {
  const w = (s: string) => s.length; // 1px per char
  const measure = (s: string) => w(s);
  assert.deepEqual(wrap("aa bb cc", 5, 3, 1, measure), ["aa bb", "cc"]);
  assert.deepEqual(wrap("src/lib/vis/parse.ts", 8, 3, 1, measure), ["src/lib/", "vis/", "parse.ts"]);
  assert.deepEqual(wrap("one two three four", 4, 2, 1, measure), ["one", "two…"]);
});

test("scales: nice steps, zero included, decades for log", () => {
  assert.equal(niceStep(0.3), 0.5);
  assert.equal(niceStep(23), 25);
  const s = linearScale(12, 97, 0, 100);
  assert.equal(s.min, 0);
  assert.equal(s.max, 100);
  assert.deepEqual(s.ticks, [0, 20, 40, 60, 80, 100]);
  const lg = logScale(3, 4200, 0, 100);
  assert.deepEqual(lg.ticks, [1, 10, 100, 1000, 10000]);
  assert.equal(lg.at(100), 50);
  assert.equal(shortNumber(138175), "138k");
  assert.equal(shortNumber(0.0042), "0.0042");
  assert.equal(shortNumber(2_500_000), "2.5M");
});

test("a setting unquotes one quoted string, and leaves a quoted list as written", () => {
  const line = (text: string) => ({ n: 1, raw: text, text });
  assert.deepEqual(setting(line('title: "Say \\"hi\\""')), { key: "title", value: 'Say "hi"', raw: '"Say \\"hi\\""' });
  const list = setting(line('series: "A b", C, "D e"'))!;
  assert.equal(list.value, '"A b", C, "D e"');
  assert.deepEqual(commaList(list.raw, 1), ["A b", "C", "D e"]);
  assert.deepEqual(commaList(setting(line('series: "A, b"'))!.raw, 1), ["A, b"]);
});

test("wrap never strands a one- or two-character tail of a split word", () => {
  for (const w of [60, 80, 100]) {
    const lines = wrap("GET /callback?code=…", w, 4, 12);
    assert.ok(lines.every((l) => l.length > 2), `${w}: ${JSON.stringify(lines)}`);
    assert.equal(lines.join("").replace(/\s/g, ""), "GET/callback?code=…");
  }
});

test("fields unquote only a field that is one whole quoted string", () => {
  const line = (text: string) => ({ n: 1, raw: text, text });
  assert.deepEqual(fields(line('"a \\| b" | "React" vs "Vue" | "x", "y"')), ["a | b", '"React" vs "Vue"', '"x", "y"']);
});

test("text over 200 characters is cut with an ellipsis and a warning, never an error", () => {
  const long = "a".repeat(MAX_TEXT + 50);
  const { value, warnings } = collectWarnings(() => text(long, 3));
  assert.equal(value.length, MAX_TEXT);
  assert.ok(value.endsWith("…"));
  assert.deepEqual(warnings, [{ line: 3, message: "text over 200 characters, shortened" }]);
  assert.equal(text("short", 1), "short");
  // Never half a surrogate pair.
  assert.equal(clip(`${"x".repeat(8)}😀tail`, 10), `${"x".repeat(8)}…`);
  // A quoted token is text too.
  const toks = collectWarnings(() => tokenize({ n: 2, raw: "", text: `a -> b "${long}"` }));
  assert.equal((toks.value[3] as { v: string }).v.length, MAX_TEXT);
  // Outside a parse, a warning goes nowhere.
  assert.doesNotThrow(() => warn(1, "x"));
});

test("an overlong title, caption or label still draws: the figure lists the warnings, sorted and once each", () => {
  const long = "b".repeat(250);
  const r = parseVis("flow", `title: ${long}\ncaption: ${long}\na "${long}" -> c`);
  assert.ok(r.ok);
  assert.equal(r.spec.title!.length, MAX_TEXT);
  assert.equal((r.spec as { nodes: { label: string }[] }).nodes[0]!.label.length, MAX_TEXT);
  assert.deepEqual(r.warnings.map((w) => w.line), [1, 2, 3], "line 3 is read twice (the label-style pre-pass) but listed once");
  // An html caption over 200 characters: the most common worker failure.
  const html = parseVis("html", `caption: ${long}\n<p>hi</p>`);
  assert.ok(html.ok);
  assert.equal(html.spec.caption!.length, MAX_TEXT);
  assert.deepEqual(html.warnings, [{ line: 1, message: "text over 200 characters, shortened" }]);
  // No warnings: an empty list, and no warnings key on the spec.
  const clean = parseVis("flow", "a -> b");
  assert.ok(clean.ok);
  assert.deepEqual(clean.warnings, []);
  assert.equal("warnings" in clean.spec, false);
  // Hard errors stay hard.
  const bad = parseVis("flow", "a b c");
  assert.equal(bad.ok, false);
});
