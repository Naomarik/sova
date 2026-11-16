// A drawing's Copy (picture) in a real Chrome or Chromium, as the tour tests (nothing is downloaded; a short TMPDIR in a
// sandbox). The picture is the card's clone laid out again inside an SVG image, at a device scale of 1: on a 125% screen
// its text runs a fraction of a pixel wider or narrower than the card's, and every size in the clone is frozen. The rule:
// the picture's text breaks into the very lines the card shows, whatever that drift. Real figures (Figure with the matrix
// and wireframe Views, SSR-rendered, with the app's CSS); the drift is letter-spacing on the clone's root, since a
// Playwright device scale changes no text metric.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import type { Browser, Page } from "playwright-core";
import { launchTourBrowser } from "../../server/tours/browser";
import { parseVis } from "./parse";
// @ts-expect-error the shared SSR test compiler is an untyped .mjs helper
const { importSsr } = await import("../lib/align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const resolve = (s: string) => import.meta.resolve(s);
const { Figure } = await importSsr(new URL("./Figure.tsx", import.meta.url), resolve);
const VIEWS: Record<string, unknown> = {
  matrix: (await importSsr(new URL("./kinds/matrix/View.tsx", import.meta.url), resolve)).default,
  wireframe: (await importSsr(new URL("./kinds/wireframe/View.tsx", import.meta.url), resolve)).default,
};

const SRC = join(import.meta.dirname, "..");
const CSS = ["design/tokens.css", "design/base.css", "vis/vis.css", "vis/kinds/matrix/matrix.css", "vis/kinds/wireframe/wireframe.css"]
  .map((f) => readFileSync(join(SRC, f), "utf8"))
  .join("\n");
/** snapshot.ts for the page: `window.snap.pictureClone`. */
const BUNDLE = (await build({ entryPoints: [join(SRC, "vis/snapshot.ts")], bundle: true, write: false, format: "iife", globalName: "snap", platform: "browser", target: "es2022" })).outputFiles[0]!.text;

/** Every kind of text box the picture showed broken: a note on one line, a note on two, a note with inline code, a row
    label led by its note's badge and wrapping, a toned chip ("-10%") in a narrow column (and in WIDE, a label that
    starts a line of its own after its badge). */
const MATRIX = `title: Rollout options
columns: Canary, Blue/green, Big bang
Keeps a fast rollback path for every single release we ship | yes | yes | no
Error budget | -10% warn | 4% ok | -30% error
Infra cost | low | double | low
mark "Keeps a fast rollback path for every single release we ship" "rollback stays one click away"
mark "Error budget" "a note long enough to run over two lines of this card, the second holding its last few words"
mark "Infra cost" "set by \`replicas\` in the deploy file, scaled per region when traffic grows past the threshold"`;
/** A stat whose label and value fit their boxes: clipped with "…" only when they don't. */
const WIREFRAME = `device: desktop
row
  stat "Revenue" "$12k"
  stat "Orders" "318"`;
/** Six columns in a 560px card: the table is wider than its box, which scrolls sideways. */
const WIDE = `columns: Alpha option, Beta option, Gamma option, Delta option, Epsilon option, Zeta option
Throughput | high | medium | low | high | medium | low
Latency | 12 ms | 30 ms | 45 ms | 15 ms | 22 ms | 60 ms
mark Latency "p50"`;

const figure = (kind: string, body: string, width: number) => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(r.message);
  const html = renderToString(() => solid.createComponent(Figure, { kind, spec: r.spec, view: VIEWS[kind] }));
  return `<div class="md" style="width:${width}px">${html}</div>`;
};

let browser: Browser;
before(async () => {
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
});

async function page(html: string): Promise<Page> {
  const p = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  await p.setContent(`<!doctype html><html data-theme="light"><head><style>${CSS}</style></head><body>${html}</body></html>`);
  await p.addScriptTag({ content: BUNDLE });
  return p;
}

/** The boxes whose lines the test compares, tagged before the clone (a tag survives it; classes don't). */
const BOXES = ".vis-notes li > span, .vis-matrix th, .vis-cell-text, .vis-wf-stat-label, .vis-wf-stat-value";

type Mode = "fixed" | "unpinned" | "before";
/** Per tagged box, its lines' text on the card and in the clone, the clone mounted beside it in a shadow root (no page
    CSS reaches it, as none reaches the picture) with `drift` px of letter-spacing on its root. "unpinned": the clone's
    `<br>`s taken out; "before": that, and its text wrapping as the card's does (the clone before this fix). */
const compare = (p: Page, mode: Mode, drift: number) =>
  p.evaluate(
    ({ mode, drift, sel }) => {
      const later = (r: DOMRect, prev: DOMRect) => r.top >= prev.bottom - Math.min(r.height, prev.height) / 2;
      // A box's lines: its visible characters, in order, grouped by the line they sit on.
      const lines = (el: Element) => {
        const out: string[] = [];
        let line: DOMRect | null = null;
        const range = document.createRange();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
          // A visually hidden word sits outside the lines.
          let hidden = false;
          for (let a = t.parentElement; a && a !== el.parentElement; a = a.parentElement) if (getComputedStyle(a).position === "absolute") hidden = true;
          if (hidden) continue;
          for (let i = 0; i < t.length; i++) {
            range.setStart(t, i);
            range.setEnd(t, i + 1);
            const r = range.getBoundingClientRect();
            if (!r.width && !r.height) continue;
            if (!line || later(r, line)) {
              out.push("");
              line = r;
            }
            out.push(out.pop()! + t.data.charAt(i));
          }
        }
        return out.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
      };
      document.querySelectorAll("[data-pic-host]").forEach((h) => h.remove());
      const results: { box: string; page: string[]; picture: string[] }[] = [];
      for (const fig of document.querySelectorAll<HTMLElement>("figure.vis")) {
        const boxes = [...fig.querySelectorAll(sel)];
        boxes.forEach((b, i) => b.setAttribute("data-box", String(i)));
        const wrapped = [...fig.querySelectorAll("*")].filter((e) => getComputedStyle(e).getPropertyValue("text-wrap-mode") !== "nowrap");
        wrapped.forEach((e) => e.setAttribute("data-wraps", ""));
        const { wrap } = (window as unknown as { snap: typeof import("./snapshot") }).snap.pictureClone(fig);
        const host = document.createElement("div");
        host.setAttribute("data-pic-host", "");
        document.body.appendChild(host);
        const root = host.attachShadow({ mode: "open" });
        root.appendChild(wrap);
        if (mode !== "fixed") wrap.querySelectorAll("br").forEach((b) => b.remove());
        if (mode === "before") {
          const s = document.createElement("style");
          s.textContent = "[data-wraps] { text-wrap-mode: wrap !important; }";
          root.appendChild(s);
        }
        (wrap.firstElementChild as HTMLElement).style.letterSpacing = `${drift}px`;
        for (const b of boxes) {
          const twin = wrap.querySelector(`[data-box="${b.getAttribute("data-box")}"]`)!;
          results.push({ box: b.textContent!.trim().slice(0, 40), page: lines(b), picture: lines(twin) });
        }
      }
      return results;
    },
    { mode, drift, sel: BOXES },
  );

const mismatches = (got: Awaited<ReturnType<typeof compare>>) => got.filter((g) => JSON.stringify(g.page) !== JSON.stringify(g.picture));

test("the picture's text breaks into the card's own lines, however its metrics drift (each box, each line)", async () => {
  const p = await page(figure("matrix", MATRIX, 560) + figure("matrix", WIDE, 560) + figure("wireframe", WIREFRAME, 702));
  try {
    const at0 = await compare(p, "fixed", 0);
    // The fixture holds what the rule is about, or this proves nothing.
    const lineCount = (start: string) => at0.find((g) => g.box.startsWith(start))?.page.length;
    assert.equal(lineCount("rollback stays"), 1, "a one-line note");
    assert.equal(lineCount("a note long enough"), 2, "a two-line note");
    assert.ok((lineCount("set by replicas") ?? 0) >= 2, "a note with inline code, wrapped");
    assert.ok((lineCount("1Keeps a fast rollback") ?? 0) >= 2, "a row label after its badge, wrapped");
    assert.equal(lineCount("-10%"), 1, "a chip on one line");
    assert.deepEqual(at0.find((g) => g.box.startsWith("1Latency"))?.page, ["1", "Latency"], "a label on the line after its badge");
    for (const drift of [0, 0.3, -0.3]) assert.deepEqual(mismatches(await compare(p, "fixed", drift)), [], `letter-spacing ${drift}px`);

    // A stat label that fits shows no "…" when the picture's text runs a hair wider: it is clipped, and it fits on the card.
    const labels = await p.evaluate(() => {
      const hosts = document.querySelectorAll("[data-pic-host]");
      const host = hosts[hosts.length - 1]!;
      return [...document.querySelectorAll(".vis-wf-stat-label, .vis-wf-stat-value")].map((el) => {
        const twin = host.shadowRoot!.querySelector(`[data-box="${el.getAttribute("data-box")}"]`)!;
        return { page: getComputedStyle(el).textOverflow, fits: el.scrollWidth <= el.clientWidth, picture: getComputedStyle(twin).textOverflow };
      });
    });
    assert.equal(labels.length, 4);
    for (const l of labels) assert.deepEqual(l, { page: "ellipsis", fits: true, picture: "clip" });

    // The check can tell: without the pinned breaks the two-line note runs on one line, and the clone as it was before
    // (its text wrapping in its frozen boxes) breaks the boxes' lines differently once the metrics drift.
    assert.ok(mismatches(await compare(p, "unpinned", 0)).some((g) => g.box.startsWith("a note long enough")), "unpinned");
    const before = mismatches(await compare(p, "before", 0.3)).map((g) => g.box);
    assert.ok(before.some((b) => b.startsWith("rollback stays")) && before.some((b) => b.startsWith("-10%")), `before: ${JSON.stringify(before)}`);
  } finally {
    await p.close();
  }
});

test("a matrix wider than its card is drawn whole: the picture widens to the table, and nothing in it scrolls", async () => {
  const p = await page(figure("matrix", WIDE, 560));
  try {
    const got = await p.evaluate(() => {
      const fig = document.querySelector<HTMLElement>("figure.vis")!;
      const box = fig.querySelector<HTMLElement>(".vis-matrix-wrap")!;
      const table = fig.querySelector("table")!;
      table.setAttribute("data-table", "");
      const hidden = box.scrollWidth - box.clientWidth;
      const { wrap, width } = (window as unknown as { snap: typeof import("./snapshot") }).snap.pictureClone(fig);
      const host = document.body.appendChild(document.createElement("div"));
      host.attachShadow({ mode: "open" }).appendChild(wrap);
      const t = wrap.querySelector("[data-table]")!.getBoundingClientRect();
      const r = wrap.getBoundingClientRect();
      const scrolls = [...wrap.querySelectorAll("*")].filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowX + getComputedStyle(e).overflowY));
      const cs = getComputedStyle(fig);
      const body = getComputedStyle(fig.querySelector(".vis-body")!);
      const frame = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) + parseFloat(body.paddingLeft) + parseFloat(body.paddingRight);
      return { hidden, width, tableWidth: table.getBoundingClientRect().width, frame, inside: t.left >= r.left && t.right <= r.right + 0.5, scrolls: scrolls.length };
    });
    assert.ok(got.hidden > 50, `the table scrolls on the card (${got.hidden}px hidden), or this proves nothing`);
    assert.equal(got.width, Math.ceil(got.tableWidth + got.frame), "the picture is the table's width and the card's frame around it");
    assert.ok(got.inside, "the whole table is inside the picture");
    assert.equal(got.scrolls, 0, "no box in the picture scrolls");
  } finally {
    await p.close();
  }
});
