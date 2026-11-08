import assert from "node:assert/strict";
import { test } from "node:test";
import { emphasisMap, emphasisNotes } from "../../core/emphasis";
import { parseVis } from "../../parse";
import { MAX_PARTS, type ChartSpec } from "./parse";
import { partsOf } from "./parts";
import { appliesIn, chartViews, drawAs, inEffect, isModel, modelChoice, offeredToggles, orderedLabels, pickView, settle, shownToggles, sortOrder, toggle, toggleStates, VIEW_ORDER, type ChartChoice, type ChartView, type Toggle } from "./switch";

const parse = (body: string) => parseVis("chart", body);
const chart = (body: string) => {
  const r = parse(body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}\n${body}`);
  return r.spec as ChartSpec;
};
const views = (body: string) => chartViews(chart(body)).views;
const choice = (c: Partial<ChartChoice> & { view: ChartChoice["view"] }): ChartChoice => ({ log: false, sort: false, pct: false, ...c });
const TOGGLES = ["log", "sort", "pct"] as const;
const rows = (n: number, v: (i: number) => string = (i) => String(i + 1)) => Array.from({ length: n }, (_, i) => `r${i} ${v(i)}`).join("\n");

/** Bodies without `type:`: each test sets the type it reads them as. */
const BODIES: Record<string, string> = {
  one: "Jan 5\nFeb 3\nMar 90\nmark Feb warn \"low\"",
  oneRow: "Jan 5",
  neg: "Jan 5\nFeb -3\nMar 9",
  gap: "Jan 5\nFeb -\nMar 9",
  zero: "Jan 0\nFeb 0\nMar 0",
  thirteen: rows(13),
  twelve: rows(12),
  multi: "series: x, y\nQ1 1 2\nQ2 3 4\nQ3 0 9\nmark Q3 \"big\"",
  multiGap: "series: x, y\nQ1 1 -\nQ2 3 4",
  multiNeg: "series: x, y\nQ1 1 -2\nQ2 3 4",
  multiOneRow: "series: x, y\nQ1 1 2",
  tones: "a 5 ok\nb 3\nc 9 error\nd 4",
  regions: "us-east 5\neu-west 3\nap-south 9",
  percent: "Jan 12%\nFeb 30%\nMar 45%",
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
    // Rows that don't read as an order get no Line.
    tones: ["bar", "parts"],
    regions: ["bar", "parts"],
    // Numbers already in percent get no Parts.
    percent: ["bar", "line"],
  };
  for (const [name, body] of Object.entries(BODIES)) assert.deepEqual(views(body), expect[name], name);
  // A scatter and a capacity parts chart offer no switch.
  assert.deepEqual(views("type: scatter\na 1 2\nb 3 4"), []);
  assert.deepEqual(views("type: parts\nof: 100\na 30\nb 20"), []);
  // Parts past their capacity draw without of:, and then switch as a one-series chart does.
  const over = chart("type: parts\nof: 10\nStep 1 30\nStep 2 20");
  assert.equal(over.of, undefined);
  assert.deepEqual(chartViews(over).views, ["bar", "line", "parts"]);
  // The model's own view is always one of them, even where it alone would not fit.
  assert.deepEqual(views("type: line\na 5"), ["bar", "line"]);
  assert.deepEqual(views("type: line\nus-east 5\neu-west 3"), ["bar", "line", "parts"], "the model's Line on unordered rows");
  assert.deepEqual(views("type: parts\na 12%\nb 30%"), ["bar", "parts"], "the model's Parts on percents");
  assert.deepEqual(views("unit: %\na 12\nb 30"), ["bar"]);
  assert.deepEqual(views("unit: pct\na 12\nb 30"), ["bar"]);
  assert.deepEqual(views("unit: ms\na 12\nb 30"), ["bar", "parts"]);
  assert.deepEqual(views("type: stacked\nJan 5\nFeb 6"), ["bar", "stacked", "line", "parts"]);
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
  const log = chart("scale: log\nseries: x, y\nQ1 1 10\nQ2 100 1000");
  const c = modelChoice(log);
  assert.equal(c.log, true);
  assert.deepEqual(shownToggles(log, c), { log: true, sort: true, pct: false });
  assert.equal(drawAs(log, c).scale, "log");
  const stacked = pickView(log, c, "stacked");
  assert.equal(stacked.log, true, "kept while visiting Stacked");
  assert.equal(drawAs(log, stacked).scale, "linear");
  assert.deepEqual(shownToggles(log, stacked), { log: false, sort: true, pct: true }, "a kept Log not in effect leaves % free");
  const back = pickView(log, stacked, "line");
  assert.equal(drawAs(log, back).scale, "log", "applies again on return");
  // Not with a zero, a negative; gaps are fine.
  assert.equal(shownToggles(chart("a 0\nb 30"), choice({ view: "bar" })).log, false);
  assert.equal(shownToggles(chart("a -1\nb 30"), choice({ view: "bar" })).log, false);
  assert.equal(shownToggles(chart("a -\nb 3\nc 30"), choice({ view: "bar" })).log, true);
  // Only where the numbers span a wide range: the largest at least 10 times the smallest.
  const logOk = (body: string) => chartViews(chart(body)).logOk;
  const SPAN: [string, boolean][] = [
    ["a 5\nb 3\nc 9", false],
    ["a 1\nb 9.9", false],
    ["a 1\nb 10", true],
    ["a 2\nb 3\nc 2000", true],
    ["a -\nb 3\nc 29", false],
    ["a 5", false],
    ["series: x, y\na 1 2\nb 3 4", false],
    ["series: x, y\na 1 2\nb 3 40", true],
    ["series: x, y\na 1 -\nb 3 40", true],
    // The model's scale: log is always offered.
    ["scale: log\na 5\nb 6", true],
  ];
  for (const [body, want] of SPAN) assert.equal(logOk(body), want, body);
  assert.deepEqual(offeredToggles(chart("scale: log\na 5\nb 6")), ["log", "sort", "pct"]);
  assert.deepEqual(offeredToggles(chart("a 5\nb 6")), ["sort", "pct"]);
  // Parts never shows it.
  assert.equal(shownToggles(chart(BODIES.one!), choice({ view: "parts" })).log, false);
  // A Log restored where it can't apply is dropped.
  assert.equal(settle(chart("a 0\nb 3"), choice({ view: "bar", log: true })).log, false);
});

test("chart views: a scatter shows Log only when every x and y is above 0 and x or y spans a wide range, and no views", () => {
  const s = chart("type: scatter\na 1 2\nb 30 4");
  assert.deepEqual(shownToggles(s, modelChoice(s)), { log: true, sort: false, pct: false });
  const on = toggle(s, modelChoice(s), "log");
  assert.equal(drawAs(s, on).scale, "log");
  assert.equal(drawAs(s, on).type, "scatter");
  assert.equal(shownToggles(chart("type: scatter\na 0 2\nb 30 4"), choice({ view: "scatter" })).log, false);
  assert.equal(shownToggles(chart("type: scatter\na 1 -2\nb 30 4"), choice({ view: "scatter" })).log, false);
  const logOk = (body: string) => chartViews(chart(`type: scatter\n${body}`)).logOk;
  assert.equal(logOk("a 1 2\nb 3 4"), false, "neither axis spans");
  assert.equal(logOk("a 1 2\nb 3 40"), true, "y spans");
  assert.equal(logOk("a 1 2\nb 10 3"), true, "x spans");
  assert.equal(chartViews(chart("type: scatter\nscale: log\na 1 2\nb 3 4")).logOk, true, "the model's scale: log");
  assert.equal(settle(s, choice({ view: "bar" })).view, "scatter");
});

test("chart views: a capacity parts chart offers nothing and draws as written", () => {
  const p = chart("type: parts\nof: 100\na 30\nb 20");
  const c = modelChoice(p);
  assert.deepEqual(shownToggles(p, c), { log: false, sort: false, pct: false });
  assert.equal(toggle(p, c, "sort"), c);
  assert.equal(drawAs(p, settle(p, { view: "bar", sort: true })), p);
});

test("chart views: % and Log exclude each other while in effect; Sort and % stay set where a view can't use them", () => {
  const s = chart(BODIES.one!);
  let c = modelChoice(s);
  assert.deepEqual(shownToggles(s, c), { log: true, sort: true, pct: true });
  c = toggle(s, c, "pct");
  assert.deepEqual(shownToggles(s, c), { log: false, sort: true, pct: true });
  assert.equal(toggle(s, c, "log"), c, "a greyed toggle can't flip");
  c = toggle(s, c, "sort");
  const sortedBar = drawAs(s, c).rows.map((r) => r.label);
  const line = pickView(s, c, "line");
  assert.deepEqual(line, choice({ view: "line", sort: true, pct: true, recent: "pct" }), "Sort kept on Line");
  assert.deepEqual(inEffect(s, line), { log: false, sort: false, pct: true });
  assert.deepEqual(drawAs(s, line).rows.map((r) => r.label), ["Jan", "Feb", "Mar"], "Line draws in source order");
  assert.equal(toggle(s, line, "sort"), line, "a kept Sort can't flip where greyed");
  const parts = pickView(s, c, "parts");
  assert.deepEqual(parts, choice({ view: "parts", sort: true, pct: true, recent: "pct" }), "% kept on Parts");
  assert.equal(drawAs(s, parts).unit, undefined, "Parts draws values, not shares");
  assert.deepEqual(shownToggles(s, parts), { log: false, sort: true, pct: false }, "Log stays greyed on Parts");
  const back = pickView(s, pickView(s, parts, "line"), "bar");
  assert.deepEqual(back, c, "both apply again back on Bar");
  assert.equal(drawAs(s, back).unit, "%");
  assert.deepEqual(drawAs(s, back).rows.map((r) => r.label), sortedBar);
  // Both on (a stored choice): Log wins.
  assert.deepEqual(settle(s, choice({ view: "bar", log: true, pct: true })), choice({ view: "bar", log: true }));
  // No % with a negative value, nor for an all-zero chart.
  assert.equal(shownToggles(chart(BODIES.neg!), choice({ view: "bar" })).pct, false);
  assert.equal(shownToggles(chart(BODIES.zero!), choice({ view: "bar" })).pct, false);
  assert.equal(shownToggles(chart(BODIES.multiGap!), choice({ view: "stacked" })).pct, true);
  // No % where the values already are percents: `unit: %`, or rows written `12%`.
  for (const body of ["unit: %\na 12\nb 30", "a 12%\nb 30%", "unit: percent\na 12\nb 30", "unit: pct\na 12\nb 30", "series: x, y\na 12% 4%\nb 30% 9%"]) {
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
  assert.ok(Math.abs(one.rows[0]!.values[0]! - (5 / 98) * 100) < 1e-9);
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

test("chart toggles: the head's set is fixed per chart, greyed where this choice can't use one", () => {
  const types = ["bar", "line", "parts", "stacked"] as const;
  const specs: [string, ChartSpec][] = [];
  for (const [name, body] of Object.entries(BODIES)) for (const t of types) {
    const r = parse(`type: ${t}\n${body}`);
    if (r.ok) specs.push([`${t}/${name}`, r.spec as ChartSpec]);
  }
  specs.push(
    ["scatter", chart("type: scatter\na 1 2\nb 30 4")],
    ["scatter narrow", chart("type: scatter\na 1 2\nb 3 4")],
    ["capacity", chart("type: parts\nof: 100\na 30\nb 20")],
    ["pct", chart("unit: %\na 30\nb 20")],
    ["pct wide", chart("unit: %\nJan 3\nFeb 30")],
    ["percent rows", chart("Jan 3%\nFeb 30%")],
    ["log narrow", chart("scale: log\na 5\nb 6")],
  );
  for (const [name, spec] of specs) {
    const offered = offeredToggles(spec);
    const views: ChartChoice["view"][] = chartViews(spec).views.length ? chartViews(spec).views : [spec.type];
    // Every reachable choice: each view with each toggle combination, settled as the head would.
    const raw = views.flatMap((view) => [false, true].flatMap((log) => [false, true].flatMap((sort) => [false, true].map((pct) => ({ view, log, sort, pct })))));
    const choices = raw.map((c) => settle(spec, c));
    // Settling keeps every toggle set that the chart can use somewhere, except the losing one of
    // Log and % where both apply.
    raw.forEach((r, i) => {
      const c = choices[i]!;
      const a = appliesIn(spec, c.view);
      for (const t of TOGGLES) {
        const lost = t === "pct" && r.log && r.pct && a.log && a.pct && offered.includes("log");
        assert.equal(c[t], r[t] && offered.includes(t) && !lost, `${name} ${JSON.stringify(r)} keeps ${t}`);
      }
      // What draws is exactly what is in effect.
      const d = drawAs(spec, c);
      if (spec.type !== "scatter" && !(spec.type === "parts" && spec.of !== undefined)) {
        const on = inEffect(spec, c);
        assert.equal(d.scale === "log", on.log, `${name} ${JSON.stringify(c)} log`);
        assert.equal(d.unit === "%" && !spec.percent && spec.unit !== "%", on.pct, `${name} ${JSON.stringify(c)} pct`);
      }
    });
    const union = new Set<Toggle>();
    for (const c of choices) {
      const states = toggleStates(spec, c);
      // The same toggles in the same order whatever the choice: nothing in the head moves.
      assert.deepEqual(states.map((s) => s.toggle), offered, `${name} ${JSON.stringify(c)}`);
      const shown = shownToggles(spec, c);
      for (const s of states) {
        assert.equal(s.enabled, shown[s.toggle], `${name} ${s.toggle}`);
        // Pressed whenever set, greyed or not.
        assert.equal(s.on, c[s.toggle]);
        assert.equal(!!s.hint, !s.enabled);
        // Only a toggle in effect blocks another: a usable one greyed means the other is in effect.
        const applies = appliesIn(spec, c.view);
        const other = s.toggle === "log" ? "pct" : s.toggle === "pct" ? "log" : null;
        if (!s.enabled && applies[s.toggle]) assert.ok(other && inEffect(spec, c)[other], `${name} ${s.toggle} blocked by nothing in effect`);
        if (other && inEffect(spec, c)[other]) assert.equal(s.enabled, false, `${name} ${s.toggle} beside ${other} in effect`);
        if (s.enabled) union.add(s.toggle);
      }
    }
    // Exactly the toggles some choice can use: none it can never use.
    assert.deepEqual([...union].sort(), [...offered].sort(), name);
  }
});

test("chart toggles: what each chart offers, and the greyed hints", () => {
  const one = chart("Jan 5\nFeb 3\nMar 90");
  assert.deepEqual(offeredToggles(one), ["log", "sort", "pct"]);
  assert.deepEqual(offeredToggles(chart("a 5\nb -3\nc 90")), ["sort"]);
  assert.deepEqual(offeredToggles(chart("unit: %\na 3\nb 30")), ["log", "sort"]);
  assert.deepEqual(offeredToggles(chart("unit: %\na 30\nb 20")), ["sort"]);
  assert.deepEqual(offeredToggles(chart("type: scatter\na 1 2\nb 30 4")), ["log"]);
  assert.deepEqual(offeredToggles(chart("type: scatter\na 1 2\nb 3 4")), []);
  assert.deepEqual(offeredToggles(chart("type: parts\nof: 100\na 30\nb 20")), []);
  const hint = (c: ChartChoice) => Object.fromEntries(toggleStates(one, c).map((s) => [s.toggle, s.hint ?? null]));
  assert.deepEqual(hint(choice({ view: "bar" })), { log: null, sort: null, pct: null });
  assert.deepEqual(hint(choice({ view: "line" })), { log: null, sort: "Sort doesn't apply to Line", pct: null });
  assert.deepEqual(hint(choice({ view: "parts" })), { log: "Log doesn't apply to Parts", sort: null, pct: "% doesn't apply to Parts" });
  assert.deepEqual(hint(choice({ view: "bar", pct: true })), { log: "Turn % off to use Log", sort: null, pct: null });
  assert.deepEqual(hint(choice({ view: "line", log: true })), { log: null, sort: "Sort doesn't apply to Line", pct: "Turn Log off to use %" });
  // Log kept while Parts ignores it: greyed and still pressed; back on Bar it is usable again.
  const kept = pickView(one, toggle(one, choice({ view: "bar" }), "log"), "parts");
  assert.equal(kept.log, true);
  assert.deepEqual(toggleStates(one, kept).find((s) => s.toggle === "log"), { toggle: "log", enabled: false, on: true, hint: "Log doesn't apply to Parts" });
  assert.deepEqual(toggleStates(one, pickView(one, kept, "bar")).find((s) => s.toggle === "log"), { toggle: "log", enabled: true, on: true });
  // Sort and % likewise: greyed, pressed, with the reason.
  const both = toggle(one, toggle(one, choice({ view: "bar" }), "sort"), "pct");
  const states = (c: ChartChoice) => Object.fromEntries(toggleStates(one, c).map((s) => [s.toggle, [s.enabled, s.on]]));
  assert.deepEqual(states(pickView(one, both, "line")), { log: [false, false], sort: [false, true], pct: [true, true] });
  assert.deepEqual(states(pickView(one, both, "parts")), { log: [false, false], sort: [true, true], pct: [false, true] });
});

test("chart toggles: Log kept through Stacked leaves % free; turned on there, the newer of the two wins back on Bar", () => {
  const m = chart("series: x, y\nQ1 1 2\nQ2 30 4");
  let c = toggle(m, choice({ view: "bar" }), "log");
  c = pickView(m, c, "stacked");
  const st = (x: ChartChoice) => Object.fromEntries(toggleStates(m, x).map((s) => [s.toggle, [s.enabled, s.on, s.hint ?? null]]));
  assert.deepEqual(st(c), { log: [false, true, "Log doesn't apply to Stacked"], sort: [true, false, null], pct: [true, false, null] });
  c = toggle(m, c, "pct");
  assert.deepEqual(c, choice({ view: "stacked", log: true, pct: true, recent: "pct" }), "both set on Stacked");
  assert.deepEqual(st(c), { log: [false, true, "Log doesn't apply to Stacked"], sort: [true, false, null], pct: [true, true, null] });
  assert.equal(drawAs(m, c).unit, "%");
  // Bar can use both: % was turned on last, so Log switches off.
  const bar = pickView(m, c, "bar");
  assert.deepEqual(bar, choice({ view: "bar", pct: true, recent: "pct" }));
  assert.equal(drawAs(m, bar).scale, "linear");
  assert.equal(pickView(m, pickView(m, bar, "stacked"), "line").log, false, "Log stays off after");
  // The other order (a stored choice says Log was last): Log wins. No record of which: Log wins.
  assert.deepEqual(settle(m, choice({ view: "line", log: true, pct: true, recent: "log" })), choice({ view: "line", log: true, recent: "log" }));
  assert.deepEqual(settle(m, choice({ view: "bar", log: true, pct: true })), choice({ view: "bar", log: true }));
  // Turning % off again on Stacked leaves Log, which applies on Line again.
  const off = toggle(m, c, "pct");
  assert.deepEqual(off, choice({ view: "stacked", log: true }));
  assert.equal(drawAs(m, pickView(m, off, "line")).scale, "log");
});

test("chart views: Line is offered only for rows that read as an order", () => {
  const ORDERED: string[][] = [
    ["2024-01-05", "2024-01-06", "2024-01-07"],
    ["01/05", "01/06"],
    ["2024-01-05T10:00", "2024-01-05T11:00"],
    ["2024-01-05 10:00", "2024-01-05 11:00"],
    ["10:30", "11:00", "11:30"],
    ["9am", "10am", "11 am", "12 pm"],
    ["2022", "2023", "2024"],
    ["FY23", "FY24"],
    ["1", "2", "4", "8"],
    ["0.5", "1.5k", "64GB"],
    ["0-10", "10-20", "20+"],
    ["Jan", "Feb", "March"],
    ["Jan 2024", "Feb 2024"],
    ["Sep 24", "Oct 24"],
    ["5 Jan", "6 Jan"],
    ["Jan 5, 2024", "Jan 6, 2024"],
    ["Mon", "Tue", "Wednesday"],
    ["Q1", "Q2", "Q3", "Q4"],
    ["Q1 2024", "2024-Q2", "Q3'24"],
    ["H1", "H2"],
    ["W43", "W44", "2024-W45"],
    ["Turn 1", "Turn 2", "Turn 10"],
    ["Step 1", "step 2"],
    ["v3", "v4", "v5"],
    ["v1.2", "v1.10"],
    ["Build #41", "Build #42"],
    ["Week 43", "Week 44"],
    ["iPhone 15", "iPhone 16"],
  ];
  const NOT: string[][] = [
    ["iPhone 16", "Pixel 9"],
    ["Turn 1", "Step 2"],
    ["us-east", "eu-west", "ap-south"],
    ["src", "tests", "docs"],
    ["unit", "integration", "e2e"],
    ["a", "b", "c"],
    ["Model 3", "Model Y"],
    ["v3", "v4", "beta"],
    ["Marketing", "Sales"],
    ["Mayo", "Junee"],
    ["Galaxy S24", "Pixel 9"],
    ["Jan", "Other"],
    ["Merge sort", "Quicksort"],
    [],
  ];
  for (const ls of ORDERED) assert.equal(orderedLabels(ls), true, ls.join(" / "));
  for (const ls of NOT) assert.equal(orderedLabels(ls), false, ls.join(" / "));
  // As a chart offers it.
  assert.ok(views("Turn 1 5\nTurn 2 3\nTurn 3 9").includes("line"));
  assert.ok(!views('"iPhone 16" 5\n"Pixel 9" 3').includes("line"));
  assert.ok(!views("unit 120\nintegration 40\ne2e 9").includes("line"));
  // The model's own Line is always offered.
  assert.ok(views("type: line\nunit 120\nintegration 40\ne2e 9").includes("line"));
});

test("chart views: rows written like 92% keep their % sign in every view, the model's included", () => {
  const s = chart("Jan 92%\nFeb 88%\nMar 95%");
  assert.equal(s.unit, undefined, "the parser sets no unit");
  for (const view of chartViews(s).views) {
    assert.equal(drawAs(s, choice({ view })).unit, "%", view);
    assert.equal(drawAs(s, choice({ view, sort: true })).unit, "%", `${view} sorted`);
  }
  assert.equal(drawAs(s, modelChoice(s)).unit, "%");
  // The model's Parts, and a capacity parts chart.
  assert.equal(drawAs(chart("type: parts\na 12%\nb 30%"), choice({ view: "parts" })).unit, "%");
  assert.equal(drawAs(chart("type: parts\nof: 100\na 12%\nb 30%"), choice({ view: "parts" })).unit, "%");
  // A unit the model wrote stays.
  assert.equal(drawAs(chart("unit: pts\nJan 12%\nFeb 30%"), choice({ view: "bar" })).unit, "pts");
  assert.equal(drawAs(chart("Jan 12\nFeb 30"), choice({ view: "bar" })).unit, undefined);
});

test("chart views: Sort ranks by what is drawn; with % on several series by the first series' share", () => {
  // One series: shares keep the values' order.
  const one = chart("a 5\nb 9\nc 1\nd 9");
  assert.deepEqual(sortOrder(one, true), sortOrder(one));
  assert.deepEqual(drawAs(one, choice({ view: "bar", sort: true, pct: true })).rows.map((r) => r.label), ["b", "d", "a", "c"]);
  // Several: by totals without %, by the first series' share with it.
  const m = chart("series: x, y\na 1 9\nb 6 4\nc 30 70\nd 3 1\ne 6 4");
  assert.deepEqual(sortOrder(m).map((i) => m.rows[i]!.label), ["c", "a", "b", "e", "d"], "ties keep source order");
  assert.deepEqual(sortOrder(m, true).map((i) => m.rows[i]!.label), ["d", "b", "e", "c", "a"], "ties keep source order with % too");
  for (const view of ["bar", "stacked"] as const) {
    const d = drawAs(m, choice({ view, sort: true, pct: true }));
    assert.deepEqual(d.rows.map((r) => r.label), ["d", "b", "e", "c", "a"], view);
    const firsts = d.rows.map((r) => r.values[0]!);
    assert.deepEqual([...firsts].sort((x, y) => y - x), firsts, `${view}: the drawn first shares fall`);
  }
  // A row with no values last; a gap in the first series ranks as none of it; an all-zero row as 0.
  const g = chart("series: x, y\na - -\nb - 4\nc 1 1\nd 0 0");
  assert.deepEqual(sortOrder(g, true).map((i) => g.rows[i]!.label), ["c", "b", "d", "a"]);
  // Marks follow their rows under % too.
  const mk = chart('series: x, y\na 1 9\nb 3 1\nmark a "small"');
  assert.equal(emphasisMap(drawAs(mk, choice({ view: "stacked", sort: true, pct: true }))).get("1")?.note, "small");
});

test("chart views: the over-capacity Parts warning shows only in the model's view", () => {
  const over = chart("type: parts\nof: 10\nStep 1 30\nStep 2 20\nmark Step 9 \"x\"");
  const msgs = (spec: ChartSpec) => (spec.warnings ?? []).map((w) => w.message);
  assert.ok(msgs(over).some((m) => /drawn without of:$/.test(m)));
  assert.ok(msgs(over).length >= 2, "another warning to keep");
  assert.deepEqual(msgs(drawAs(over, choice({ view: "parts" }))), msgs(over));
  assert.deepEqual(msgs(drawAs(over, choice({ view: "parts", sort: true }))), msgs(over));
  for (const view of ["bar", "line"] as const) {
    const drawn = msgs(drawAs(over, choice({ view })));
    assert.deepEqual(drawn, msgs(over).filter((m) => !/drawn without of:$/.test(m)), view);
  }
  // Its only warning: other views carry none.
  const alone = chart("type: parts\nof: 10\nStep 1 30\nStep 2 20");
  assert.equal(drawAs(alone, choice({ view: "bar" })).warnings, undefined);
  assert.equal(drawAs(alone, choice({ view: "parts" })).warnings?.length, 1);
  // The model's spec is untouched.
  assert.equal(alone.warnings?.length, 1);
});
