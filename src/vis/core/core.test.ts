import assert from "node:assert/strict";
import { test } from "node:test";
import { linearScale, logScale, niceStep, shortNumber } from "./scale";
import { wrap } from "./text";
import { commaList, fields, setting } from "./grammar";

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
