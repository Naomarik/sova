import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateWidth } from "../../core/text";
import { parseVis } from "../../parse";
import { axisTitle, catBox, CHART_CSS, chartMode, chartWidth, estimateHeight, FONT, layoutChart, legendBreaks, overlaps, textBox, type ChartLayout } from "./layout";
import type { ChartSpec } from "./parse";
import { partsHeight } from "./parts";
import { chartViews, drawAs, settle, shownToggles } from "./switch";

const chart = (body: string) => {
  const r = parseVis("chart", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as ChartSpec;
};

const SAMPLES: Record<string, string> = {
  bar: '"Quicksort" 120\n"Merge sort" 150\n"Heap sort" 210\n"Bubble sort" 9800\nmark "Bubble sort" warn "quadratic"',
  long: '"parent cacheRead" 138175\n"fork cacheRead (first turn)" 0 error\n"fork cacheRead (second turn)" 91204\n"subagent cacheRead" 40210 muted\nmark "fork cacheRead (first turn)" "misses"',
  neg: "unit: %\nQ1 12%\nQ2 4.5%\nQ3 -8%\nQ4 -2.25%\nmark Q3 error \"outage\"",
  grouped: "series: p50, p99\nHTTP/1.1 42 180\nHTTP/2 30 95\nHTTP/3 28 61\nmark HTTP/3 ok \"tail halves\"",
  stacked: "type: stacked\nseries: DNS, TLS, TTFB, Download\nCold 40 90 120 30\nWarm 0 0 110 30\nmark Cold \"handshakes\"",
  line: 'type: line\nseries: "Merge sort", Quicksort\nscale: log\n1k 0.1 0.08\n10k 1.3 1\n100k 15 -\n1M 150 130\nmark 100k "gap"',
  lineOne: "type: line\nW1 1200\nW2 1350\nW3 1310\nW4 1580\nW5 1720\nW6 1690\nW7 2010\nW8 2240\nmark W7 ok \"launch\"",
  many: `type: line\n${Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00 ${10 + Math.sin(h / 4) * 6}`).join("\n")}\nmark 14:00 "peak"`,
  scatter: 'type: scatter\n"tiny" 0.5 40\n"small" 3 85\n"medium" 8 140\n"large" 34 390\n"xl" 70 820\n"xl-quant" 70 460\nmark "xl-quant" ok "quantised"',
  web: "type: line\nseries: web, phone\nW1 120 80\nW2 130 110\nW3 135 140\nW4 140 190\nW5 150 230\nmark W4 \"phone passes web\"",
  editor: 'type: scatter\n"home" 120 300\n"settings" 80 220\n"chat" 300 700\n"editor" 450 1600\n"login" 40 150\nmark editor error "monaco"',
  scatterLog: 'type: scatter\nscale: log\n"n=10" 10 33\n"n=100" 100 664\n"n=1k" 1000 9966\n"n=10k" 10000 132877\nmark "n=10k" "n log n"',
};
const WIDTHS = [260, 330, 560, 720];

const inside = (g: ChartLayout, x: number, y: number, what: string) => {
  assert.ok(x >= -0.5 && x <= g.W + 0.5 && y >= -0.5 && y <= g.H + 0.5, `${what} at ${x.toFixed(1)},${y.toFixed(1)} leaves ${g.W}×${g.H}`);
};

test("chart layout: everything stays inside the frame, at every width", () => {
  for (const [name, body] of Object.entries(SAMPLES)) {
    for (const W of WIDTHS) {
      const g = layoutChart(chart(body), W, estimateWidth);
      const at = `${name}@${W} (${g.mode})`;
      for (const b of g.bars) {
        inside(g, b.x, b.y, `${at} bar`);
        inside(g, b.x + b.w, b.y + b.h, `${at} bar`);
      }
      for (const p of g.points) inside(g, p.x, p.y, `${at} point`);
      for (const b of g.badges) inside(g, b.x, b.y, `${at} badge`);
      for (const v of g.values) {
        const box = textBox(v, estimateWidth);
        inside(g, box.x, box.y, `${at} value ${v.text}`);
        inside(g, box.x + box.w, box.y + box.h, `${at} value ${v.text}`);
      }
      for (const t of [...g.xTicks, ...g.yTicks]) assert.ok(Number.isFinite(t.pos), `${at} tick`);
    }
  }
});

test("chart layout: value labels never overlap each other, and category labels never collide", () => {
  for (const [name, body] of Object.entries(SAMPLES)) {
    for (const W of WIDTHS) {
      const g = layoutChart(chart(body), W, estimateWidth);
      const boxes = g.values.map((v) => ({ v, box: textBox(v, estimateWidth) }));
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
          if (!boxes[i]!.v.inside && !boxes[j]!.v.inside) assert.ok(!overlaps(boxes[i]!.box, boxes[j]!.box), `${name}@${W}: "${boxes[i]!.v.text}" overlaps "${boxes[j]!.v.text}"`);
      if (g.mode === "column" || g.mode === "line") {
        const spans = g.cats.map((c) => {
          const w = Math.max(...c.lines.map((l) => estimateWidth(l, FONT.cat)));
          return [c.x - w / 2, c.x + w / 2] as const;
        });
        for (let i = 1; i < spans.length; i++) assert.ok(spans[i]![0] >= spans[i - 1]![1], `${name}@${W}: category labels ${i - 1} and ${i} collide`);
      }
    }
  }
});

test("chart layout: bars sit on zero, negative ones hang below it", () => {
  const g = layoutChart(chart(SAMPLES.neg!), 560, estimateWidth);
  assert.equal(g.mode, "column");
  const zero = g.yTicks.find((t) => t.zero)!;
  assert.ok(zero, "a mixed-sign axis draws its zero line");
  for (const b of g.bars) {
    const v = chart(SAMPLES.neg!).rows[b.row]!.values[0]!;
    if (v >= 0) assert.ok(Math.abs(b.y + b.h - zero.pos) < 0.01, `bar ${b.row} stands on zero`);
    else assert.ok(Math.abs(b.y - zero.pos) < 0.01, `bar ${b.row} hangs from zero`);
  }
  const hb = layoutChart(chart(`${SAMPLES.neg!}\n"a very long quarter name indeed" 3`), 330, estimateWidth);
  assert.equal(hb.mode, "hbar");
  const hz = hb.xTicks.find((t) => t.zero)!;
  for (const b of hb.bars) assert.ok(Math.abs(b.x - hz.pos) < 0.01 || Math.abs(b.x + b.w - hz.pos) < 0.01, `hbar ${b.row} starts at zero`);
});

test("chart layout: long labels turn bars sideways on a phone; lines thin their labels instead", () => {
  assert.equal(chartMode(chart(SAMPLES.bar!), 560, estimateWidth), "column");
  assert.equal(chartMode(chart(SAMPLES.long!), 330, estimateWidth), "hbar");
  const many = layoutChart(chart(SAMPLES.many!), 330, estimateWidth);
  assert.equal(many.mode, "line");
  assert.ok(many.cats.length < 24 && many.cats.length >= 4, `${many.cats.length} labels`);
  assert.ok(many.cats.every((c) => !c.lines[0]!.endsWith("…")), "a thinned label is whole");
});

test("chart layout: a mark gets a band (a ring for points) and a badge; stacks are one bar tall", () => {
  for (const [name, body] of Object.entries(SAMPLES)) {
    const spec = chart(body);
    const g = layoutChart(spec, 560, estimateWidth);
    const marked = (spec.emphasis ?? []).map((e) => Number(e.key));
    const drawn = g.mode === "scatter" || g.mode === "line" ? g.rings.map((r) => r.row) : g.bands.map((b) => b.row);
    assert.deepEqual([...new Set(drawn)], marked, `${name}: emphasis drawn`);
    assert.deepEqual(g.badges.map((b) => b.row), marked, `${name}: badges`);
  }
  const s = layoutChart(chart(SAMPLES.stacked!), 560, estimateWidth);
  const cold = s.bars.filter((b) => b.row === 0).sort((a, b) => b.y - a.y);
  for (let i = 1; i < cold.length; i++) assert.ok(Math.abs(cold[i]!.y + cold[i]!.h - cold[i - 1]!.y) < 0.01, "segments touch");
});

test("chart layout: same input, same picture", () => {
  for (const body of Object.values(SAMPLES)) assert.deepEqual(JSON.stringify(layoutChart(chart(body), 480, estimateWidth)), JSON.stringify(layoutChart(chart(body), 480, estimateWidth)));
});

test("chart layout: a marked line row rings every series; a scatter keeps headroom above its highest point", () => {
  const g = layoutChart(chart(SAMPLES.web!), 330, estimateWidth);
  assert.deepEqual(g.rings.map((r) => r.row), [3, 3]);
  const b = g.badges[0]!;
  assert.ok(b.y + 9 <= g.plot.y0, "the badge sits above the plot, off the lines");
  const s = layoutChart(chart(SAMPLES.editor!), 560, estimateWidth);
  const top = Math.min(...s.points.map((p) => p.y));
  assert.ok(top - s.plot.y0 >= 8, `highest point ${top - s.plot.y0}px below the frame`);
});

test("chart layout: a small scatter labels every point on a phone, clear of the rings", () => {
  for (const W of [300, 314, 330, 560]) {
    const g = layoutChart(chart(SAMPLES.editor!), W, estimateWidth);
    assert.deepEqual(g.values.map((v) => v.row).sort(), [0, 1, 2, 3, 4], `all five labelled at ${W}`);
    for (const r of g.rings)
      for (const v of g.values) assert.ok(!overlaps({ x: r.x - 10, y: r.y - 10, w: 20, h: 20 }, textBox(v, estimateWidth)), `"${v.text}" touches a ring at ${W}`);
  }
});

test("chart estimateHeight: the layout's own height plus the legend and axis names, the same every time", () => {
  for (const [name, body] of Object.entries(SAMPLES)) {
    const spec = chart(body);
    for (let w = 296; w <= 900; w += 26) {
      const h = estimateHeight(spec, w, estimateWidth);
      assert.equal(h, estimateHeight(spec, w, estimateWidth), `${name}@${w} deterministic`);
      const W = chartWidth(w);
      const svg = layoutChart(spec, W, estimateWidth).H * Math.min(1, w / W);
      const legend = spec.series.length > 1 ? (legendBreaks(spec, w, estimateWidth).length + 1) * CHART_CSS.legendLine + legendBreaks(spec, w, estimateWidth).length * CHART_CSS.legendGapY + CHART_CSS.legendBelow : 0;
      const titles = (axisTitle(spec) ? CHART_CSS.axisLine + CHART_CSS.axisGap : 0) + (spec.x ? CHART_CSS.axisLine + CHART_CSS.axisGap : 0);
      assert.ok(Math.abs(h - (svg + legend + titles)) < 1e-9, `${name}@${w}: ${h} is the layout's ${svg} + ${legend} + ${titles}`);
      assert.ok(h > 100 && h < 700, `${name}@${w}: ${h}px is sane`);
    }
  }
  // Below the minimum layout width the drawing scales down with the width.
  const small = chart(SAMPLES.bar!);
  assert.ok(estimateHeight(small, 200, estimateWidth) < estimateHeight(small, 260, estimateWidth));
});

/** Every chart a reader can switch to from SAMPLES (and a parts sample): each offered view, with and without Log, Sort and %. */
const SWITCHED = (): [string, ChartSpec][] => {
  const bodies = { ...SAMPLES, parts: 'type: parts\nunit: tokens\n"System prompt" 9000\n"Tools" 14000 warn\n"Messages" 61000\nmark Tools "big"', over: "type: parts\nof: 10\na 30\nb 20" };
  const out: [string, ChartSpec][] = [];
  for (const [name, body] of Object.entries(bodies)) {
    const spec = chart(body);
    const { views } = chartViews(spec);
    for (const view of views.length ? views : [spec.type])
      for (const log of [false, true])
        for (const sort of [false, true])
          for (const pct of [false, true]) {
            const c = settle(spec, { view, log, sort, pct });
            // Only the combinations a reader can reach, each once.
            if (c.view !== view || c.log !== log || c.sort !== sort || c.pct !== pct) continue;
            const shown = shownToggles(spec, c);
            if ((log && !shown.log && view !== "stacked" && view !== "parts") || (sort && !shown.sort) || (pct && !shown.pct)) continue;
            out.push([`${name} as ${view}${log ? " log" : ""}${sort ? " sorted" : ""}${pct ? " %" : ""}`, drawAs(spec, c)]);
          }
  }
  return out;
};

test("chart views: every view a reader can pick lays out inside the frame, and its height is estimated", () => {
  const all = SWITCHED();
  assert.ok(all.length > 60, `${all.length} switched charts`);
  for (const [name, spec] of all) {
    for (const W of WIDTHS) {
      const h = estimateHeight(spec, W, estimateWidth);
      if (spec.type === "parts") {
        assert.equal(h, partsHeight(spec, W), `${name}@${W}: the parts height`);
        assert.ok(h > 40 && h < 700, `${name}@${W}: ${h}px`);
        continue;
      }
      const g = layoutChart(spec, chartWidth(W), estimateWidth);
      const at = `${name}@${W} (${g.mode})`;
      for (const b of g.bars) {
        inside(g, b.x, b.y, `${at} bar`);
        inside(g, b.x + b.w, b.y + b.h, `${at} bar`);
      }
      for (const p of g.points) inside(g, p.x, p.y, `${at} point`);
      for (const b of g.badges) inside(g, b.x, b.y, `${at} badge`);
      for (const v of g.values) {
        const box = textBox(v, estimateWidth);
        inside(g, box.x, box.y, `${at} value ${v.text}`);
        inside(g, box.x + box.w, box.y + box.h, `${at} value ${v.text}`);
      }
      for (const t of [...g.xTicks, ...g.yTicks]) assert.ok(Number.isFinite(t.pos), `${at} tick`);
      const legend = spec.series.length > 1 ? (legendBreaks(spec, W, estimateWidth).length + 1) * CHART_CSS.legendLine + legendBreaks(spec, W, estimateWidth).length * CHART_CSS.legendGapY + CHART_CSS.legendBelow : 0;
      const titles = (axisTitle(spec) ? CHART_CSS.axisLine + CHART_CSS.axisGap : 0) + (spec.x ? CHART_CSS.axisLine + CHART_CSS.axisGap : 0);
      assert.ok(Math.abs(h - (g.H * Math.min(1, W / chartWidth(W)) + legend + titles)) < 1e-9, `${at}: estimateHeight matches the layout`);
      // Sideways bars grow 30px a row (a 24-row line as bars runs past 700px).
      assert.ok(h > 100 && h < Math.max(700, 100 + spec.rows.length * 40), `${at}: ${h}px is sane`);
      // Each marked row is still drawn as marked, in its new place.
      const marked = (spec.emphasis ?? []).map((e) => Number(e.key)).sort();
      const drawn = g.mode === "scatter" || g.mode === "line" ? g.rings.map((r) => r.row) : g.bands.map((b) => b.row);
      assert.deepEqual([...new Set(drawn)].sort(), marked, `${at}: emphasis drawn`);
    }
  }
});

/** Charts that once drew badly on a phone: two marks side by side after Sort, a crowded group, long labels on a line. */
const CROWDED: Record<string, string> = {
  adjacentMarks: 'unit: ms\n"11-01" 40\n"11-02" 52\n"11-03" 61\n"11-04" 48\n"11-05" 70\n"11-06" 73.3\n"11-07" 90\nmark "11-07" warn "deploy"\nmark "11-06" error "spike"',
  closeMarks: '"a" 100\n"b" 99\n"c" 98\n"d" 40\nmark "a" "one"\nmark "b" "two"\nmark "c" "three"',
  threeSeries: "series: web, phone, tablet\nW1 120 135 142\nW2 130 128 150\nW3 135 140 138\nW4 140 190 160\nW5 150 230 170\nmark W3 \"flat\"",
  twoSeries: "series: web, phone\nMon 120 135\nTue 130 128\nWed 135 140\nThu 140 190\nFri 150 230\nSat 120 110\nmark Tue \"dip\"",
  longLine: 'type: line\n"Week of 3 November" 12\n"Week of 10 November" 15\n"Week of 17 November" 11\n"Week of 24 November" 19\n"Week of 1 December" 22\n"Week of 8 December" 18\n"Week of 15 December" 25\nmark "Week of 24 November" ok "launch"',
  manyMarked: `type: line\n${Array.from({ length: 30 }, (_, d) => `"Nov ${d + 1}" ${20 + ((d * 7) % 11)}`).join("\n")}\nmark "Nov 13" "a"\nmark "Nov 29" "b"`,
};
const PHONE_WIDTHS = [260, 330, 390, 560, 720];

/** Every reachable view of SAMPLES and CROWDED, each laid out at every width. */
function* everyLayout(): Generator<[string, ChartSpec, ChartLayout]> {
  for (const [name, body] of Object.entries({ ...SAMPLES, ...CROWDED })) {
    const spec = chart(body);
    const { views } = chartViews(spec);
    for (const view of views.length ? views : [spec.type])
      for (const sort of [false, true])
        for (const pct of [false, true]) {
          const c = settle(spec, { view, sort, pct, log: spec.scale === "log" });
          if (c.view !== view || c.sort !== sort || c.pct !== pct) continue;
          const drawn = drawAs(spec, c);
          if (drawn.type === "parts") continue;
          for (const W of PHONE_WIDTHS) {
            const g = layoutChart(drawn, W, estimateWidth);
            yield [`${name} as ${view}${sort ? " sorted" : ""}${pct ? " %" : ""}@${W} (${g.mode})`, drawn, g];
          }
        }
  }
}

const BADGE = 9;
const disc = (b: { x: number; y: number }) => ({ x: b.x - BADGE, y: b.y - BADGE, w: BADGE * 2, h: BADGE * 2 });
/** How far apart two boxes are (0 when they touch or overlap). */
const apart = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));

test("chart labels, every view at every width: value labels stand apart, category labels stay in the frame", () => {
  let n = 0;
  for (const [at, , g] of everyLayout()) {
    n++;
    const boxes = g.values.filter((v) => !v.inside).map((v) => ({ v, box: textBox(v, estimateWidth) }));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        // Side by side they keep a gap, so two numbers never read as one. (A 13px line box holds
        // 11px digits: one stacked 12px under another, as grouped sideways bars draw them, is clear.)
        const a = { x: boxes[i]!.box.x - 1.5, w: boxes[i]!.box.w + 3, y: boxes[i]!.box.y + 0.5, h: boxes[i]!.box.h - 1 };
        assert.ok(!overlaps(a, { ...boxes[j]!.box, y: boxes[j]!.box.y + 0.5, h: boxes[j]!.box.h - 1 }), `${at}: "${boxes[i]!.v.text}" runs into "${boxes[j]!.v.text}"`);
      }
    for (const c of g.cats) {
      const b = catBox(c, g.mode, estimateWidth);
      assert.ok(b.x >= 0 && b.x + b.w <= g.W && b.y >= 0 && b.y + b.h <= g.H, `${at}: category "${c.lines.join(" ")}" is cut by the frame (${b.x.toFixed(1)}..${(b.x + b.w).toFixed(1)} of ${g.W})`);
    }
    for (let i = 0; i < g.cats.length; i++)
      for (let j = i + 1; j < g.cats.length; j++) assert.ok(!overlaps(catBox(g.cats[i]!, g.mode, estimateWidth), catBox(g.cats[j]!, g.mode, estimateWidth)), `${at}: categories ${g.cats[i]!.row} and ${g.cats[j]!.row} collide`);
  }
  assert.ok(n > 300, `${n} layouts`);
});

test("chart labels, every view at every width: a marked row keeps its value and category labels, and its badge stays by it", () => {
  for (const [at, spec, g] of everyLayout()) {
    if (g.mode === "scatter") continue;
    const marked = (spec.emphasis ?? []).map((e) => Number(e.key));
    const lineSeries = g.mode === "line" && spec.series.length > 1;
    for (const row of marked) {
      assert.ok(g.cats.some((c) => c.row === row), `${at}: marked row ${row} lost its category label`);
      // Several lines label no points; every other marked bar or point names its value.
      if (lineSeries) continue;
      const own = g.values.filter((v) => v.row === row && !v.inside);
      const items: number = g.mode === "line" ? g.points.filter((p) => p.row === row).length : spec.type === "stacked" ? 1 : g.bars.filter((b) => b.row === row).length;
      assert.equal(own.length, items, `${at}: marked row ${row} shows ${own.length} of its ${items} value labels`);
    }
    const shown = new Set(g.values.map((v) => v.row));
    for (const b of g.badges) {
      const d = disc(b);
      for (const o of g.badges) if (o !== b) assert.ok(!overlaps(d, disc(o)), `${at}: badges ${b.row} and ${o.row} overlap`);
      for (const v of g.values) if (v.row !== b.row && marked.includes(v.row)) assert.ok(!overlaps(d, textBox(v, estimateWidth)), `${at}: badge ${b.row} covers marked "${v.text}"`);
      if (lineSeries) continue;
      // By its own bar or point: touching (within a few px of) its row's bars, points or labels.
      const mine = [...g.bars.filter((x) => x.row === b.row), ...g.points.filter((p) => p.row === b.row).map((p) => ({ x: p.x - 4, y: p.y - 4, w: 8, h: 8 })), ...g.values.filter((v) => v.row === b.row).map((v) => textBox(v, estimateWidth))];
      assert.ok(shown.has(b.row), `${at}: badge ${b.row} has no label beside it`);
      assert.ok(Math.min(...mine.map((m) => apart(d, m))) <= 6, `${at}: badge ${b.row} floats away from its row`);
    }
  }
});

test("chart labels: a line chart thins its category labels evenly, keeping its ends where they fit", () => {
  for (const [at, spec, g] of everyLayout()) {
    if (g.mode !== "line") continue;
    const marked = new Set((spec.emphasis ?? []).map((e) => Number(e.key)));
    const last = spec.rows.length - 1;
    const grid = g.cats.map((c) => c.row).filter((r) => !marked.has(r) && r !== 0 && r !== last);
    const step = g.cats.map((c) => c.row).filter((r) => !marked.has(r) && r !== last);
    // The labels between the ends sit on one even step from the first.
    if (grid.length >= 2) {
      const k = Math.min(...step.slice(1).map((r, i) => r - step[i]!));
      for (const r of grid) assert.equal(r % k, 0, `${at}: label ${r} is off the step of ${k} (${g.cats.map((c) => c.row).join(",")})`);
    }
    for (const end of [0, last]) {
      if (g.cats.some((c) => c.row === end)) continue;
      // An end is dropped only for a neighbour it would touch.
      assert.ok(g.cats.some((c) => Math.abs(c.row - end) <= Math.ceil(spec.rows.length / 2)), `${at}: end ${end} dropped for nothing`);
    }
  }
  const long = layoutChart(chart(CROWDED.longLine!), 330, estimateWidth);
  assert.ok(long.cats.length >= 2 && long.cats.some((c) => c.row === 0), `${long.cats.map((c) => c.row)}`);
});
