import assert from "node:assert/strict";
import { test } from "node:test";
import { emphasisMap, emphasisNotes } from "../../core/emphasis";
import { parseVis } from "../../parse";
import { MAX_PARTS, type ChartSpec } from "./parse";
import { partsOf } from "./parts";
import { chartViews, drawAs, isModel, modelChoice, pickView, settle, shownToggles, sortOrder, toggle, VIEW_ORDER, type ChartChoice, type ChartView } from "./switch";

const parse = (body: string) => parseVis("chart", body);
const chart = (body: string) => {
  const r = parse(body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}\n${body}`);
  return r.spec as ChartSpec;
};
const views = (body: string) => chartViews(chart(body)).views;
const choice = (c: Partial<ChartChoice> & { view: ChartChoice["view"] }): ChartChoice => ({ log: false, sort: false, pct: false, ...c });
const rows = (n: number, v: (i: number) => string = (i) => String(i + 1)) => Array.from({ length: n }, (_, i) => `r${i} ${v(i)}`).join("\n");

/** Bodies without `type:`: each test sets the type it reads them as. */
const BODIES: Record<string, string> = {
  one: "a 5\nb 3\nc 9\nmark b warn \"low\"",
  oneRow: "a 5",
  neg: "a 5\nb -3\nc 9",
  gap: "a 5\nb -\nc 9",
  zero: "a 0\nb 0\nc 0",
  thirteen: rows(13),
  twelve: rows(12),
  multi: "series: x, y\na 1 2\nb 3 4\nc 0 9\nmark c \"big\"",
  multiGap: "series: x, y\na 1 -\nb 3 4",
  multiNeg: "series: x, y\na 1 -2\nb 3 4",
  multiOneRow: "series: x, y\na 1 2",
  tones: "a 5 ok\nb 3\nc 9 error\nd 4",
};

test("chart views: what each kind of chart offers", () => {
  const expect: Record<string, ChartView[]> = {
    one: ["bar", "line", "parts"],
    oneRow: ["bar"],
    neg: ["bar", "line"],
    gap: ["bar", "line"],
    zero: ["bar", "line"],
    thirteen: ["bar", "line"],
    twelve: ["bar", "line", "parts"],
    multi: ["bar", "stacked", "line"],
    multiGap: ["bar", "stacked", "line"],
    multiNeg: ["bar", "line"],
    multiOneRow: ["bar", "stacked"],
    tones: ["bar", "line", "parts"],
  };
  for (const [name, body] of Object.entries(BODIES)) assert.deepEqual(views(body), expect[name], name);
  // A scatter and a capacity parts chart offer no switch.
  assert.deepEqual(views("type: scatter\na 1 2\nb 3 4"), []);
  assert.deepEqual(views("type: parts\nof: 100\na 30\nb 20"), []);
  // Parts past their capacity draw without of:, and then switch as a one-series chart does.
  const over = chart("type: parts\nof: 10\na 30\nb 20");
  assert.equal(over.of, undefined);
  assert.deepEqual(chartViews(over).views, ["bar", "line", "parts"]);
  // The model's own view is always one of them, even where it alone would not fit.
  assert.deepEqual(views("type: line\na 5"), ["bar", "line"]);
  assert.deepEqual(views("type: stacked\na 5\nb 6"), ["bar", "stacked", "line", "parts"]);
  assert.equal(MAX_PARTS, 12);
});

test("chart views: the views offered draw what the parser draws for that type (collision)", () => {
  const typed = (body: string, type: string) => `type: ${type}\n${body}`;
  for (const [name, body] of Object.entries(BODIES)) {
    const spec = chart(body);
    const offered = chartViews(spec).views;
    for (const view of VIEW_ORDER) {
      const re = parse(typed(body, view));
      // Whatever the parser refuses as this type is never offered.
      if (!re.ok) {
        assert.ok(!offered.includes(view), `${name}: ${view} offered though the parser refuses it (${re.message})`);
        continue;
      }
      if (!offered.includes(view)) continue;
      const drawn = drawAs(spec, choice({ view }));
      const want = re.spec as ChartSpec;
      assert.equal(drawn.type, want.type, `${name} as ${view}`);
      assert.deepEqual(drawn.rows, want.rows, `${name} as ${view}: rows`);
      assert.deepEqual(drawn.series, want.series, `${name} as ${view}: series`);
      assert.deepEqual(drawn.emphasis, want.emphasis, `${name} as ${view}: marks`);
      assert.equal(drawn.scale, want.scale, `${name} as ${view}: scale`);
    }
  }
});

test("chart views: Log shows on Bar and Line when every value is above 0, starts on from scale: log, and is kept across views", () => {
  const log = chart("scale: log\nseries: x, y\na 1 10\nb 100 1000");
  const c = modelChoice(log);
  assert.equal(c.log, true);
  assert.deepEqual(shownToggles(log, c), { log: true, sort: true, pct: false });
  assert.equal(drawAs(log, c).scale, "log");
  const stacked = pickView(log, c, "stacked");
  assert.equal(stacked.log, true, "kept while visiting Stacked");
  assert.equal(drawAs(log, stacked).scale, "linear");
  assert.deepEqual(shownToggles(log, stacked), { log: false, sort: true, pct: false }, "a kept Log still hides %");
  const back = pickView(log, stacked, "line");
  assert.equal(drawAs(log, back).scale, "log", "applies again on return");
  // Not with a zero, a negative; gaps are fine.
  assert.equal(shownToggles(chart("a 0\nb 3"), choice({ view: "bar" })).log, false);
  assert.equal(shownToggles(chart("a -1\nb 3"), choice({ view: "bar" })).log, false);
  assert.equal(shownToggles(chart("a -\nb 3"), choice({ view: "bar" })).log, true);
  // Parts never shows it.
  assert.equal(shownToggles(chart(BODIES.one!), choice({ view: "parts" })).log, false);
  // A Log restored where it can't apply is dropped.
  assert.equal(settle(chart("a 0\nb 3"), choice({ view: "bar", log: true })).log, false);
});

test("chart views: a scatter shows Log only when every x and y is above 0, and no views", () => {
  const s = chart("type: scatter\na 1 2\nb 3 4");
  assert.deepEqual(shownToggles(s, modelChoice(s)), { log: true, sort: false, pct: false });
  const on = toggle(s, modelChoice(s), "log");
  assert.equal(drawAs(s, on).scale, "log");
  assert.equal(drawAs(s, on).type, "scatter");
  assert.equal(shownToggles(chart("type: scatter\na 0 2\nb 3 4"), choice({ view: "scatter" })).log, false);
  assert.equal(shownToggles(chart("type: scatter\na 1 -2\nb 3 4"), choice({ view: "scatter" })).log, false);
  assert.equal(settle(s, choice({ view: "bar" })).view, "scatter");
});

test("chart views: a capacity parts chart offers nothing and draws as written", () => {
  const p = chart("type: parts\nof: 100\na 30\nb 20");
  const c = modelChoice(p);
  assert.deepEqual(shownToggles(p, c), { log: false, sort: false, pct: false });
  assert.equal(toggle(p, c, "sort"), c);
  assert.equal(drawAs(p, settle(p, { view: "bar", sort: true })), p);
});

test("chart views: % and Log exclude each other; Sort and % switch off where hidden", () => {
  const s = chart(BODIES.one!);
  let c = modelChoice(s);
  assert.deepEqual(shownToggles(s, c), { log: true, sort: true, pct: true });
  c = toggle(s, c, "pct");
  assert.deepEqual(shownToggles(s, c), { log: false, sort: true, pct: true });
  assert.equal(toggle(s, c, "log"), c, "a hidden toggle can't flip");
  c = toggle(s, c, "sort");
  const line = pickView(s, c, "line");
  assert.deepEqual(line, choice({ view: "line", pct: true }), "Line hides Sort");
  const parts = pickView(s, c, "parts");
  assert.deepEqual(parts, choice({ view: "parts", sort: true }), "Parts hides %");
  assert.equal(pickView(s, parts, "bar").pct, false, "% stays off after Parts");
  // Both on (a stored choice): Log wins.
  assert.deepEqual(settle(s, choice({ view: "bar", log: true, pct: true })), choice({ view: "bar", log: true }));
  // No % with a negative value, nor for an all-zero chart.
  assert.equal(shownToggles(chart(BODIES.neg!), choice({ view: "bar" })).pct, false);
  assert.equal(shownToggles(chart(BODIES.zero!), choice({ view: "bar" })).pct, false);
  assert.equal(shownToggles(chart(BODIES.multiGap!), choice({ view: "stacked" })).pct, true);
  // No % where the values already are percents: `unit: %`, or rows written `12%`.
  for (const body of ["unit: %\na 12\nb 30", "a 12%\nb 30%", "unit: percent\na 12\nb 30", "series: x, y\na 12% 4%\nb 30% 9%"]) {
    const c = chart(body);
    assert.equal(chartViews(c).pctOk, false, body);
    for (const view of chartViews(c).views) assert.equal(shownToggles(c, choice({ view })).pct, false, `${body} as ${view}`);
    assert.equal(settle(c, choice({ view: "bar", pct: true })).pct, false, "a stored % switches off");
  }
  // Any other unit keeps it.
  assert.equal(shownToggles(chart("unit: ms\na 12\nb 30"), choice({ view: "bar" })).pct, true);
  // An unfit stored view falls back to the model's.
  assert.equal(settle(chart(BODIES.neg!), choice({ view: "parts" })).view, "bar");
  assert.ok(isModel(s, choice({ view: "bar" })));
  assert.ok(!isModel(s, choice({ view: "bar", sort: true })));
});

test("chart views: % is each value's share: of the sum with one series, of its row with several", () => {
  const one = drawAs(chart(BODIES.one!), choice({ view: "bar", pct: true }));
  assert.equal(one.unit, "%");
  const total = one.rows.reduce((a, r) => a + r.values[0]!, 0);
  assert.ok(Math.abs(total - 100) < 1e-9, `${total}`);
  assert.ok(Math.abs(one.rows[0]!.values[0]! - (5 / 17) * 100) < 1e-9);
  for (const view of ["bar", "stacked", "line"] as const) {
    const m = drawAs(chart(BODIES.multiGap!), choice({ view, pct: true }));
    for (const r of m.rows) assert.ok(Math.abs(r.values.reduce<number>((a, v) => a + (v ?? 0), 0) - 100) < 1e-9, `${view} ${r.label}`);
    assert.equal(m.rows[0]!.values[1], null, "a gap stays a gap");
  }
  const zeroRow = drawAs(chart("series: x, y\na 0 0\nb 1 3"), choice({ view: "stacked", pct: true }));
  assert.deepEqual(zeroRow.rows[0]!.values, [0, 0]);
  // The model's spec is untouched.
  assert.deepEqual(chart(BODIES.one!).rows[0]!.values, [5]);
});

test("chart views: Sort is largest first, stable for ties, and marks, tones and notes follow their rows", () => {
  const s = chart('a 5\nb 9\nc 5\nd 1 ok\ne 9\nmark c warn "third"\nmark d "fourth"');
  assert.deepEqual(sortOrder(s), [1, 4, 0, 2, 3]);
  const sorted = drawAs(s, choice({ view: "bar", sort: true }));
  assert.deepEqual(sorted.rows.map((r) => r.label), ["b", "e", "a", "c", "d"]);
  assert.equal(sorted.rows[4]!.tone, "ok");
  const em = emphasisMap(sorted);
  assert.equal(em.get("3")?.note, "third");
  assert.equal(em.get("4")?.note, "fourth");
  assert.deepEqual(emphasisNotes(sorted), emphasisNotes(s), "the notes read the same");
  // Several series sort by the row's total; a toned multi-series row's mark moves with it.
  const m = chart("series: x, y\na 1 1\nb 5 -\nc 2 4 warn\nmark a \"small\"");
  const ms = drawAs(m, choice({ view: "bar", sort: true }));
  assert.deepEqual(ms.rows.map((r) => r.label), ["c", "b", "a"]);
  assert.equal(emphasisMap(ms).get("2")?.note, "small");
  assert.equal(emphasisMap(ms).get("0")?.tone, "warn");
  const st = drawAs(m, choice({ view: "stacked", sort: true }));
  assert.deepEqual(st.rows.map((r) => r.label), ["c", "b", "a"]);
  // Gaps last.
  assert.deepEqual(sortOrder(chart("a -\nb 1\nc 0")), [1, 2, 0]);
});

test("chart views: sorted parts keep each part's colour", () => {
  const s = chart(BODIES.tones!);
  const colour = (spec: ChartSpec) => new Map(partsOf(spec).parts.map((p) => [p.label, p.color.replace(/^vis-chart-toned vis-tone-/, "")]));
  const SERIES_TONE = ["accent", "warn", "ok", "error", "info", "muted"];
  const plain = colour(drawAs(s, choice({ view: "parts" })));
  const sorted = colour(drawAs(s, choice({ view: "parts", sort: true })));
  for (const [label, c] of plain) {
    const m = /^vis-chart-s(\d)$/.exec(c);
    assert.equal(sorted.get(label), m ? SERIES_TONE[Number(m[1])] : c, label);
  }
  assert.deepEqual(drawAs(s, choice({ view: "parts", sort: true })).rows.map((r) => r.label), ["c", "a", "d", "b"]);
});
