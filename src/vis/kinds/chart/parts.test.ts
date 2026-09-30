import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import { unweighted } from "../tree/measure";
import { estimateHeight } from "./layout";
import type { ChartSpec } from "./parse";
import { partsHeight, partsOf, pctText } from "./parts";

const ok = (body: string): ChartSpec => {
  const r = parseVis("chart", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as ChartSpec;
};
const err = (body: string) => {
  const r = parseVis("chart", body);
  assert.equal(r.ok, false, `expected an error for:\n${body}`);
  return r as { ok: false; line: number; message: string };
};
/** A fence that still draws: its first warning (parse.ts). */
const warning = (body: string) => {
  const r = parseVis("chart", body);
  if (!r.ok) assert.fail(`expected a drawing with a warning, got line ${r.line}: ${r.message}`);
  assert.ok(r.warnings.length, `expected a warning for:\n${body}`);
  assert.deepEqual(r.spec.warnings, r.warnings, "the spec carries the same warnings");
  return r.warnings[0]!;
};

const WINDOW = `type: parts
unit: tokens
of: 200000
"System prompt" 9000 muted
"Tools" 14000 muted
"Earlier turns (cached)" 60000 info
"New input" 6000
"Reply" 300
mark "Tools" warn "remove one and everything after is re-sent"`;

test("parts: rows, capacity, tones, and a mark on a part by its label", () => {
  const s = ok(WINDOW);
  assert.equal(s.type, "parts");
  assert.equal(s.of, 200000);
  assert.deepEqual(s.rows.map((r) => [r.label, r.values[0], r.tone ?? null]), [
    ["System prompt", 9000, "muted"],
    ["Tools", 14000, "muted"],
    ["Earlier turns (cached)", 60000, "info"],
    ["New input", 6000, null],
    ["Reply", 300, null],
  ]);
  assert.deepEqual(s.emphasis, [{ key: "1", tone: "warn", note: "remove one and everything after is re-sent", n: 1 }]);
});

test("parts: the free rest, shares, one number style, distinct colours for untoned parts", () => {
  const { parts, total, head } = partsOf(ok(WINDOW));
  assert.equal(total, 89300);
  assert.deepEqual(parts.map((p) => [p.label, p.valueText, p.pctText]), [
    ["System prompt", "9k", "4.5%"],
    ["Tools", "14k", "7%"],
    ["Earlier turns (cached)", "60k", "30%"],
    ["New input", "6k", "3%"],
    ["Reply", "300", "<1%"],
    ["Free", "111k", "55%"],
  ]);
  assert.deepEqual(head, { value: "89.3k", rest: " of 200k tokens · 45%" });
  // Toned parts take their tone; the untoned ones the series colours in turn; the free rest none.
  assert.deepEqual(parts.map((p) => p.color), ["vis-chart-toned vis-tone-muted", "vis-chart-toned vis-tone-muted", "vis-chart-toned vis-tone-info", "vis-chart-s0", "vis-chart-s1", ""]);
  // An untoned part never wears a colour a toned one already shows (accent is series 0, warn 1).
  const mixed = partsOf(ok("type: parts\na 1 accent\nb 1\nc 1 warn\nd 1"));
  assert.deepEqual(mixed.parts.map((p) => p.color), ["vis-chart-toned vis-tone-accent", "vis-chart-s2", "vis-chart-toned vis-tone-warn", "vis-chart-s3"]);
  // Without of: the shares are of the total, and there is no free part.
  const plain = partsOf(ok('type: parts\n"Grep the code" 26\n"Spec slice" 882\nunit: KB'));
  assert.deepEqual(plain.parts.map((p) => p.pctText), ["2.9%", "97%"]);
  assert.deepEqual(plain.head, { value: "908 KB", rest: " in total" });
  // A full capacity has no free part.
  assert.equal(partsOf(ok("type: parts\nof: 10\na 4\nb 6")).parts.length, 2);
});

test("pctText: tiny, small and whole shares", () => {
  assert.deepEqual([0, 0.004, 0.045, 0.0999, 0.5, 1].map(pctText), ["0%", "<1%", "4.5%", "10%", "50%", "100%"]);
});

test("parts past of: draw exactly as without of:, with a warning", () => {
  const over = 'type: parts\nunit: MB\nof: 4.19\n"Screenshots" 4.18 warn\n"Text + JSON" 0.23\nmark "Screenshots"';
  const r = parseVis("chart", over);
  if (!r.ok) assert.fail(r.message);
  assert.deepEqual(r.warnings, [{ line: 3, message: "the parts add up to 4.41, more than of: 4.19: drawn without of:" }]);
  // The same spec as the fence with its of: line dropped (but for the warning it carries).
  const without = parseVis("chart", over.replace("of: 4.19\n", ""));
  assert.ok(without.ok);
  const { warnings, ...drawn } = r.spec;
  assert.deepEqual(drawn, without.spec);
  assert.equal(warnings!.length, 1);
  // So: no capacity, no free rest, shares of the total, "in total" in the head.
  const d = partsOf(r.spec as ChartSpec);
  assert.deepEqual(d.parts.map((p) => [p.label, p.valueText, p.pctText]), [["Screenshots", "4.18", "95%"], ["Text + JSON", "0.23", "5.2%"]]);
  assert.deepEqual(d.head, { value: "4.41 MB", rest: " in total" });
  const flat = unweighted((t, px) => t.length * px * 0.6);
  assert.equal(partsHeight(r.spec as ChartSpec, 600, flat), partsHeight(without.spec as ChartSpec, 600, flat));
  // At or under the capacity nothing changes: of: kept, no warning.
  const full = parseVis("chart", "type: parts\nof: 10\na 4\nb 6");
  assert.ok(full.ok && (full.spec as ChartSpec).of === 10 && full.warnings.length === 0);
});

test("parts: each error says what to write", () => {
  const neg = err("type: parts\na 5\nb -2");
  assert.match(neg.message, /can't be negative/);
  assert.equal(neg.line, 3);
  assert.match(err("type: parts\na -").message, /a part needs a number/);
  assert.match(err("type: parts\na 0\nb 0").message, /add up to 0/);
  assert.match(err("type: parts\nseries: x, y\na 1 2").message, /parts takes no series/);
  assert.match(err("type: parts\nscale: log\na 1").message, /can't use scale: log/);
  assert.match(err("type: parts\nx: time\na 1").message, /no axes/);
  assert.match(err("of: 100\na 1").message, /of: is the capacity of a type: parts chart/);
  assert.match(err("type: parts\nof: 1,000\na 1").message, /number above 0 \(no thousands commas\)/);
  assert.match(err("type: parts\nof: 0\na 1").message, /number above 0/);
  assert.match(err("type: parts\nof: 100").message, /add parts like/);
  assert.match(err(`type: parts\n${Array.from({ length: 13 }, (_, i) => `p${i} 1`).join("\n")}`).message, /13 parts; at most 12/);
  assert.match(warning('type: parts\na 1\nmark "b"').message, /no row "b", dropped/);
});

test("parts height: head, bar and legend rows, as parts.css lays them out", () => {
  const flat = unweighted((t, px) => t.length * px * 0.6);
  // One short part, no capacity: head 18 + 8 + bar 20 + 8 + one row (18 + 6).
  assert.equal(partsHeight(ok("type: parts\na 1"), 600, flat), 18 + 8 + 20 + 8 + 24);
  // With a capacity the free rest is a legend row too.
  assert.equal(partsHeight(ok("type: parts\nof: 2\na 1"), 600, flat), 18 + 8 + 20 + 8 + 2 * 24);
  // A long label wraps on a phone, so the figure grows as the body narrows, and never as it widens.
  const s = ok(WINDOW);
  let last = Infinity;
  for (let w = 296; w <= 900; w += 4) {
    const h = estimateHeight(s, w);
    assert.equal(h, estimateHeight(s, w));
    assert.ok(h > 0 && h <= last, `${w}: ${h} after ${last}`);
    last = h;
  }
  const long = ok(`type: parts\n"${"word ".repeat(30).trim()}" 1`);
  assert.ok(partsHeight(long, 300, flat) > partsHeight(long, 900, flat));
});
