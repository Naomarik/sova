// The share and owner pages' replies (§app.baton/outsider-view): the business kinds are drawn, any
// other kind and a broken block are one quiet line, never their source.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { batonKinds, BROKEN_DRAWING, renderShareMarkdown, SHARE_VIS_KINDS } from "../share/markdown";
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

test("code always, html without interactive drawings, and a block that doesn't parse, show one quiet line and never their source", () => {
  for (const html of [false, true])
    for (const [info, body] of [
      ...(html ? [] : [["vis html", "<script>alert(1)</script><p>secret layout</p>"]]),
      ["vis code", "lang: js\nconst secret = 1"],
      ["vis chart", "this is not a chart secret"],
      ["vis svg", "<p>secret: not an svg</p>"],
      ["vis withheld", ""],
      ["vis", "secret"],
    ]) {
      const r = renderShareMarkdown(fence(info!, body!), false, batonKinds(html));
      assert.equal(r.visuals.length, 0, info);
      assert.equal(r.html.split("\n")[1], `<p class="share-vis-broken">${BROKEN_DRAWING}</p>`, `${info}: ${r.html}`);
      assert.doesNotMatch(r.html, /secret|<pre|<script/, info);
    }
});

test("a baton conversation draws state and sequence as figures, svg as an image, and html as a frame only with interactive drawings", () => {
  for (const html of [false, true]) {
    const k = batonKinds(html);
    assert.equal(renderShareMarkdown(fence("vis state", "idle -> busy"), false, k).visuals[0]?.kind, "state");
    assert.equal(renderShareMarkdown(fence("vis sequence", 'actor a "App"\nactor b "Bank"\na -> b "pay"'), false, k).visuals[0]?.kind, "sequence");
    const svg = renderShareMarkdown(fence("vis svg", "title: Sketch\n<svg viewBox=\"0 0 9 9\"><script>alert(1)</script><text>hi</text></svg>"), false, k);
    assert.equal(svg.visuals.length, 0, "an image, never a mounted drawing");
    assert.match(svg.html, /<figure class="share-vis-image"><figcaption class="share-vis-caption">Sketch<\/figcaption><img src="data:image\/svg\+xml;charset=utf-8,[^"]+" alt="Sketch"><\/figure>/);
    assert.doesNotMatch(svg.html, /<script|<svg/, "the svg is only ever inside the image's data URL");
    assert.match(decodeURIComponent(/src="data:image\/svg\+xml;charset=utf-8,([^"]+)"/.exec(svg.html)![1]!), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox=/, "an svg without its namespace gets it, or the image is broken");
    const frame = renderShareMarkdown(fence("vis html", "title: Try it\n<button>Step</button><script>1</script>"), false, k);
    if (html) {
      assert.equal(frame.visuals[0]?.kind, "html");
      assert.match(frame.html, /<div class="md-vis" data-vis="0"/);
      assert.doesNotMatch(frame.html, /<script|<button/, "the document reaches the frame, never the page");
    } else {
      assert.equal(frame.visuals.length, 0);
      assert.match(frame.html, new RegExp(`<p class="share-vis-broken">${BROKEN_DRAWING.replace(/[.']/g, "\\$&")}</p>`));
    }
  }
  assert.deepEqual(renderShareMarkdown(fence("vis html", "<p>x</p>")).visuals, [], "the default is without interactive drawings");
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

// Session shares (§app.session-share/page): the business kinds plus sequence and state drawn, svg
// as an image, code and html as escaped source.
test("a session share draws sequence and state, and shows svg as an image and code and html as their source", async () => {
  const { SESSION_VIS_KINDS } = await import("../share/markdown");
  const seq = renderShareMarkdown(fence("vis sequence", 'actor a "A"\nactor b "B"\na -> b "hi"'), false, SESSION_VIS_KINDS);
  assert.equal(seq.visuals[0]?.kind, "sequence");
  const state = renderShareMarkdown(fence("vis state", "idle -> busy"), false, SESSION_VIS_KINDS);
  assert.equal(state.visuals[0]?.kind, "state");
  const svg = renderShareMarkdown(fence("vis svg", 'title: Sketch\n<svg xmlns="http://www.w3.org/2000/svg"><text>hi & "q"</text></svg>'), false, SESSION_VIS_KINDS);
  assert.equal(svg.visuals.length, 0);
  assert.match(svg.html, /<figure class="share-vis-image"><figcaption class="share-vis-caption">Sketch<\/figcaption><img src="data:image\/svg\+xml;charset=utf-8,%3Csvg[^"]*" alt="Sketch"><\/figure>/);
  const html = renderShareMarkdown(fence("vis html", '<script>alert(1)</script><p onclick="x">hi</p>'), false, SESSION_VIS_KINDS);
  assert.doesNotMatch(html.html, /<script|<p onclick/);
  assert.match(html.html, /<pre><code>&#60;script&#62;alert\(1\)&#60;\/script&#62;/);
  assert.match(html.html, /An interactive drawing, shown as its source\./);
  const code = renderShareMarkdown(fence("vis code", "lang: ts\n---\nconst a = '<b>';"), false, SESSION_VIS_KINDS);
  assert.match(code.html, /<figcaption class="share-vis-caption">Code<\/figcaption><pre><code>const a = &#39;&#60;b&#62;&#39;;<\/code><\/pre>/);
  // The hand-off page never shows source: code is its quiet line, html too without interactive drawings.
  assert.match(renderShareMarkdown(fence("vis code", "lang: ts\n---\nconst a = 1;")).html, /share-vis-broken/);
  assert.match(renderShareMarkdown(fence("vis html", "<p>hi</p>")).html, /share-vis-broken/);
});
