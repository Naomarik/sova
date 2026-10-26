// Run: pnpm test -- src/vis/kinds/wireframe/wireframe-text.integration.test.ts (a real Chrome or Chromium, as the tour
// tests: nothing is downloaded; a short TMPDIR in a sandbox). §chat.markdown/vis-wireframe-room, "Words, never
// letters": the wireframe View, rendered to HTML with the app's own CSS (tokens, base, vis, wireframe), in a box
// far too narrow for its words. Each label stays one line box at least as wide as its word, cut short with an
// ellipsis; with break-word put back, the same page stacks the letters (so the check can tell).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { launchTourBrowser } from "../../../../server/tours/browser";
import { parseVis } from "../../parse";
import type { WireframeSpec } from "./parse";
// @ts-expect-error the shared SSR test compiler is an untyped .mjs helper
const { importSsr } = await import("../../../lib/align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { default: WireframeView } = await importSsr(new URL("./View.tsx", import.meta.url), (s: string) => import.meta.resolve(s));

const SRC = join(import.meta.dirname, "../../..");
const CSS = ["design/tokens.css", "design/base.css", "vis/vis.css", "vis/kinds/wireframe/wireframe.css"].map((f) => readFileSync(join(SRC, f), "utf8")).join("\n");

/** Four stats in a row, in the first column of a desktop `row 1:4`: each stat about 30px wide, its label about 8px inside. */
const BODY = `device: desktop
row 1:4
  col
    row
      stat "Background" "#FBF4EA"
      stat "Background" "#FBF4EA"
      stat "Background" "#FBF4EA"
      stat "Background" "#FBF4EA"
  text "The page"`;

let browser: Browser;
before(async () => {
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
});

async function page(): Promise<Page> {
  const r = parseVis("wireframe", BODY);
  if (!r.ok) assert.fail(r.message);
  const html = renderToString(() => solid.createComponent(WireframeView, { spec: r.spec as WireframeSpec, label: "Stats" }));
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await p.setContent(`<!doctype html><html data-theme="light"><head><style>${CSS}</style></head><body><figure class="vis vis-kind-wireframe" style="width: 702px"><div class="vis-body">${html}</div></figure></body></html>`);
  return p;
}

/** Per element: its box's width, the word's width in its own font, and its text's lines: the fragments' rects grouped by
    their top (an ellipsized line is the text's visible part and the "…", side by side), each line's width summed. */
const lineBoxes = (p: Page, sel: string) =>
  p.$$eval(sel, (els) =>
    els.map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = getComputedStyle(el).font;
      const text = el.textContent ?? "";
      const lines = new Map<number, number>();
      for (const r of range.getClientRects()) lines.set(Math.round(r.top), (lines.get(Math.round(r.top)) ?? 0) + r.width);
      return { text, box: el.getBoundingClientRect().width, word: ctx.measureText(text).width, lines: [...lines.values()] };
    }),
  );

test("a stat's label and value in a box narrower than their word: one line each, never a letter a line", async () => {
  const p = await page();
  try {
    for (const sel of [".vis-wf-stat-label", ".vis-wf-stat-value"]) {
      const got = await lineBoxes(p, sel);
      assert.equal(got.length, 4, sel);
      for (const g of got) {
        assert.ok(g.box < g.word, `${sel} "${g.text}": the box (${g.box}px) is narrower than its word (${g.word}px), or this proves nothing`);
        assert.equal(g.lines.length, 1, `${sel} "${g.text}": ${g.lines.length} line boxes ${JSON.stringify(g.lines)}`);
        assert.ok(g.lines[0]! > g.box * 4, `${sel} "${g.text}": its one line (${g.lines[0]}px) holds the word, cut short, not a few letters of it`);
      }
      assert.equal(await p.$eval(sel, (el) => getComputedStyle(el).textOverflow), "ellipsis", sel);
    }
    // The same page with the earlier rule back (break-word: words, then letters when one doesn't fit) stacks the letters:
    // the check above can tell the two apart.
    await p.addStyleTag({ content: ".vis-wf-stat-label { overflow-wrap: break-word; }" });
    const old = await lineBoxes(p, ".vis-wf-stat-label");
    assert.ok(old.every((g) => g.lines.length > 3 && g.lines.every((w) => w < g.word / 2)), JSON.stringify(old[0]));
  } finally {
    await p.close();
  }
});
