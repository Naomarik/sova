// Run: pnpm test -- src/lib/card-view-box-style.test.ts
// A sealed box's frame needs `.card-view-box`: without `color-scheme: normal` the browser paints it
// opaque white, light marks on white, under a dark theme (§chat.transcript-cards/sealed-box). The
// rule sits in a stylesheet a lazy component brings, so each component that draws the box brings it
// itself, or it holds only when something else on the page happened to load first.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("../components/", import.meta.url);

test("each component that draws the sealed box imports the box's stylesheet", () => {
  const drawers = readdirSync(dir).filter((f) => f.endsWith(".tsx") && readFileSync(new URL(f, dir), "utf8").includes('class="card-view-box"'));
  assert.ok(drawers.length >= 2, `found ${drawers.join(", ")}`);
  const direct = (f: string) => /^import "\.\.\/data-cards\.css";$/m.test(readFileSync(new URL(f, dir), "utf8"));
  const missing = drawers.filter((f) => !direct(f));
  assert.deepEqual(missing, []);
});

test("the stylesheet holds the scheme the frame depends on", () => {
  const css = readFileSync(new URL("../data-cards.css", import.meta.url), "utf8");
  assert.match(css, /\.card-view-box \{[^}]*color-scheme: normal;/);
});
