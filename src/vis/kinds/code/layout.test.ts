import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseVis } from "../../parse";
import { estimateHeight, LINE_PX } from "./layout";
import type { CodeSpec } from "./parse";

const spec = (n: number) => {
  const r = parseVis("code", `lang: ts\n---\n${Array.from({ length: n }, (_, i) => `const x${i} = ${"1 + ".repeat(i * 3)}1;`).join("\n")}`);
  assert.ok(r.ok);
  return r.spec as CodeSpec;
};

test("height: lines × line height plus fixed padding, the same at every width", () => {
  for (const n of [1, 3, 20, 60]) {
    const hs = [296, 322, 390, 600, 900].map((w) => estimateHeight(spec(n), w));
    assert.ok(hs.every((h) => h === hs[0]), `n=${n}: ${hs}`);
    assert.equal(hs[0], Math.ceil(8 + n * LINE_PX + 12 + 1));
  }
  assert.ok(estimateHeight(spec(4), 390) < estimateHeight(spec(5), 390));
});

test("height constants match the tokens the CSS uses", () => {
  const tokens = readFileSync(new URL("../../../design/tokens.css", import.meta.url), "utf8");
  const fs = Number(/--fs-mono:\s*([\d.]+)px/.exec(tokens)![1]);
  const lh = Number(/--lh-mono:\s*([\d.]+)/.exec(tokens)![1]);
  assert.equal(LINE_PX, fs * lh);
  const css = readFileSync(new URL("./code.css", import.meta.url), "utf8");
  assert.match(css, /padding: var\(--space-2\) 0 12px/, "code.css: 8px on top, 12px below (PAD_*_PX)");
});
