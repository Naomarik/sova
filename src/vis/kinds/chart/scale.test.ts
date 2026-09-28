import assert from "node:assert/strict";
import { test } from "node:test";
import { decimalsOf, linearAxis, logAxis, logLabel, tickFormat, valueLabel } from "./scale";

test("linear axis: nice whole steps that cover the data; zero kept for bars", () => {
  const a = linearAxis(3, 97, 0, 100, { zero: true });
  assert.deepEqual(a.ticks, [0, 20, 40, 60, 80, 100]);
  assert.equal(a.at(0), 0);
  assert.equal(a.at(100), 100);
  const neg = linearAxis(-8, 12, 200, 0, { zero: true, count: 4 });
  assert.ok(neg.min <= -8 && neg.max >= 12 && neg.ticks.includes(0));
  assert.ok(neg.at(0) < 200 && neg.at(0) > 0, "0 sits inside a mixed-sign axis");
  for (let i = 1; i < neg.ticks.length; i++) assert.ok(neg.ticks[i]! > neg.ticks[i - 1]!);
});

test("linear axis: data far from zero isn't squashed against it (lines, points)", () => {
  const a = linearAxis(1200, 2240, 0, 100);
  assert.ok(a.min >= 1000 && a.min <= 1200, `min ${a.min}`);
  const b = linearAxis(20, 100, 0, 100);
  assert.equal(b.min, 0, "0 is kept when it's close to the data");
  assert.deepEqual(linearAxis(5, 5, 0, 1).ticks.at(0), 0, "a flat series still gets an axis");
});

test("linear axis: ticks carry no float noise and read alike", () => {
  const a = linearAxis(0, 0.7, 0, 100, { count: 7 });
  assert.deepEqual(a.ticks, [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
  assert.deepEqual(a.ticks.map(a.fmt), ["0", "0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7"]);
  const k = linearAxis(0, 138175, 0, 100, { count: 3 });
  assert.deepEqual(k.ticks.map(k.fmt), ["0", "50k", "100k", "150k"]);
  const q = linearAxis(0, 10, 0, 100, { count: 4 });
  assert.deepEqual(q.ticks.map(q.fmt), ["0", "2.5", "5.0", "7.5", "10.0"]);
  assert.equal(tickFormat(5, 10)(-5), "−5", "a real minus sign");
});

test("log axis: whole decades, minor ticks between, 1-2-5 inside one decade", () => {
  const a = logAxis(0.08, 1900, 100, 0, 8);
  assert.deepEqual(a.ticks, [0.01, 0.1, 1, 10, 100, 1000, 10000]);
  assert.deepEqual(logAxis(0.08, 1900, 100, 0, 5).ticks, [0.01, 1, 100, 10000], "short axes label every other decade");
  assert.equal(a.at(0.01), 100);
  assert.equal(a.at(10000), 0);
  assert.equal(a.minor.length, 0, "six decades: no minor lines");
  const b = logAxis(150, 1900, 0, 100);
  assert.deepEqual(b.ticks, [100, 1000, 10000]);
  assert.ok(b.minor.includes(200) && b.minor.includes(5000));
  const c = logAxis(12, 80, 0, 100);
  assert.deepEqual(c.ticks, [10, 20, 50, 100]);
  const wide = logAxis(1, 1e12, 0, 100, 5);
  assert.ok(wide.ticks.length <= 5 && wide.ticks.at(-1) === 1e12, `${wide.ticks}`);
  assert.deepEqual([0.01, 1, 1000, 1e5, 1e6].map(logLabel), ["0.01", "1", "1k", "100k", "1M"]);
});

test("value labels: 3 significant digits, suffixes from 10k, whole numbers kept below", () => {
  assert.deepEqual([0, 0.1234, 42.5, 1234, 9800, 12345, 138175, 2.5e6, -8].map(valueLabel), ["0", "0.123", "42.5", "1234", "9800", "12.3k", "138k", "2.5M", "−8"]);
  assert.equal(decimalsOf(0.25), 2);
  assert.equal(decimalsOf(2.5), 1);
  assert.equal(decimalsOf(1e-7), 7);
});
