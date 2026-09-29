// The share and owner pages' replies (§app.baton/outsider-view): the business kinds are drawn, any
// other kind and a broken block are one quiet line, never their source.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { BROKEN_DRAWING, renderShareMarkdown, SHARE_VIS_KINDS } from "../share/markdown";
import { SHARE_VIS_KINDS as TAUGHT } from "../../server/baton-vis-guide";
import { WIREFRAME_ICON_FILES } from "./kinds/wireframe/icons";

const fence = (info: string, body: string) => `Here it is:\n\n\`\`\`${info}\n${body}\n\`\`\`\n\nAfter.`;

test("a business kind becomes a placeholder with its parsed spec", () => {
  const r = renderShareMarkdown(fence("vis chart", 'title: Revenue\ntype: bar\n"Q1" 10\n"Q2" 14'));
  assert.equal(r.visuals.length, 1);
  assert.equal(r.visuals[0]!.kind, "chart");
  assert.match(r.html, /<div class="md-vis" data-vis="0" data-vis-key="[0-9a-f]+"><\/div>/);
  assert.match(r.html, /After\./);
});

test("a wireframe fence becomes a share-page placeholder with its parsed screens (drawing it is the browser check's)", () => {
  const r = renderShareMarkdown(fence("vis wireframe", 'title: Invoices\nscreen "List"\nheader "Invoices"\n  icon "search"\nlist\n  item "Invoice no." "customer" "AED —" -> "Invoice"\nscreen "Invoice"\ncard "Amount due" "AED —"'));
  assert.equal(r.visuals.length, 1);
  assert.equal(r.visuals[0]!.kind, "wireframe");
  assert.equal((r.visuals[0]!.spec as unknown as { screens: unknown[] }).screens.length, 2);
  assert.match(r.html, /<div class="md-vis" data-vis="0"/);
});

test("the share build carries every icon a drawing names: share/vis-icons.ts globs every public/icons svg, and each named file is there", () => {
  // The glob runs only under Vite, so read what it covers.
  const src = readFileSync(new URL("../share/vis-icons.ts", import.meta.url), "utf8");
  assert.match(src, /import\.meta\.glob<string>\("\.\.\/\.\.\/public\/icons\/\*\.svg", \{ query: "\?url", import: "default", eager: true \}\)/);
  const bundled = new Set(readdirSync(new URL("../../public/icons/", import.meta.url)).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)));
  for (const name of [...WIREFRAME_ICON_FILES, "alert-circle", "arrow-right", "check-circle", "info", "x-circle", "chevron-left", "chevron-right", "home", "trash", "filter", "minus"]) {
    assert.ok(bundled.has(name), `public/icons/${name}.svg`);
  }
});

test("html, svg and the technical kinds, and a block that doesn't parse, show one quiet line and never their source", () => {
  for (const [info, body] of [
    ["vis html", "<script>alert(1)</script><p>secret layout</p>"],
    ["vis svg", "<svg><text>secret</text></svg>"],
    ["vis sequence", "a -> b: secret"],
    ["vis code", "lang: js\nconst secret = 1"],
    ["vis chart", "this is not a chart secret"],
    ["vis", "secret"],
  ]) {
    const r = renderShareMarkdown(fence(info!, body!));
    assert.equal(r.visuals.length, 0, info);
    assert.equal(r.html.split("\n")[1], `<p class="share-vis-broken">${BROKEN_DRAWING}</p>`, `${info}: ${r.html}`);
    assert.doesNotMatch(r.html, /secret|<pre|<script/, info);
  }
});

test("while the reply streams, an open fence is the Drawing… box; closed, it is drawn", () => {
  const open = renderShareMarkdown("Look:\n\n```vis flow\na -> b\n", true);
  assert.match(open.html, /md-vis-pending/);
  assert.match(open.html, /Drawing flow… <span class="md-vis-pending-count">1 line<\/span>/);
  assert.equal(open.visuals.length, 0);
  assert.equal(renderShareMarkdown("Look:\n\n```vis flow\na -> b\n```\n", true).visuals.length, 1);
});

test("ordinary code and raw HTML stay escaped text", () => {
  const r = renderShareMarkdown("```js\nconst a = '<b>';\n```\n\n<img src=x onerror=alert(1)>");
  assert.match(r.html, /<pre><code class="language-js">const a = '&lt;b&gt;';/);
  assert.doesNotMatch(r.html, /<img/);
});

test("the share page draws exactly the kinds the gathering guide teaches", () => {
  assert.deepEqual([...SHARE_VIS_KINDS].sort(), [...TAUGHT].sort());
});
