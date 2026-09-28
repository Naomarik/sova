import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateWidth } from "../../core/text";
import { parseVis } from "../../parse";
import { axisTitle, CHART_CSS, chartMode, chartWidth, estimateHeight, FONT, layoutChart, legendBreaks, overlaps, textBox, type ChartLayout } from "./layout";
import type { ChartSpec } from "./parse";

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
