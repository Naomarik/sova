// The landing checks: each kind of real breakage, named precisely; and what must never send a page back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DESIGN_PAGE_CSP } from "../../src/lib/design-frame";
import { lintPage, pageProblem } from "./lint";

const page = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

test("a page that is empty, doesn't start right or was cut off is no page", () => {
  for (const [html, want] of [["", /empty/], ["<div>x</div>", /DOCTYPE/], ["<!doctype html><html><body>cut", /cut off/]] as const) assert.match(pageProblem(html)!, want);
});

const BROKEN: [what: string, html: string, want: RegExp][] = [
  ["classic script", page(`<script>ok();</script><script>\nvar a = 1;\nvar b = ;\n</script>`), /^script 2, line 3: /],
  ["module script", page(`<script type="module">\nawait go(;\n</script>`), /^script 1, line 2: /],
  ["a module's import", page(`<script type="module">\nimport x from "https://cdn.example/x.js";\n</script>`), /^script 1, line 2: imports https:\/\/cdn\.example\/x\.js/],
  ["event handler", page(`\n<button onclick="go(;">x</button>`), /^line 2: the onclick of <button>: /],
  ["unclosed element", page(`\n<div><span>x</div>`), /^line 2: <span> from line 2 isn't closed before <\/div>/],
  ["stray close", page(`<section></section></section>`), /<\/section> closes nothing/],
  ["never closed", page(`\n\n<main>x`), /^line 3: <main> from line 3 isn't closed before <\/body>/],
  ["unended comment", page(`<!-- x`), /a comment never ends/],
  ["unclosed script", page(`<script>var a`).replace("</body></html>", "") + "</html>", /<script> is never closed/],
  ["unended tag", `<!doctype html><html><div class="x></div></html>`, /the <div> tag never ends/],
  ["remote script", page(`<script src="https://cdn.example/x.js"></script>`), /<script> loads https:\/\/cdn\.example\/x\.js/],
  ["remote picture", page(`<img src="https://x.example/a.png">`), /<img> loads https:\/\/x\.example\/a\.png/],
  ["relative picture", page(`<img src="a.png">`), /<img> loads a\.png/],
  ["srcset", page(`<img src="data:image/png;base64,AA" srcset="https://x.example/a.png 2x">`), /<img> loads https:\/\/x\.example\/a\.png/],
  ["stylesheet elsewhere", page("", `<link rel="stylesheet" href="https://cdn.example/a.css">`), /<link> loads/],
  ["css background", page("", `<style>a{background:url(https://x.example/a.png)}</style>`), /a <style> loads https:\/\/x\.example\/a\.png/],
  ["style attribute", page(`<p style="background:url('b.png')">x</p>`), /the style of <p> loads b\.png/],
  ["css import", page("", `<style>@import "https://cdn.example/a.css";</style>`), /a <style> loads https:\/\/cdn\.example\/a\.css/],
  ["font elsewhere", page("", `<style>@font-face{font-family:a;src:url(https://x.example/a.woff2)}</style>`), /a <style> loads https:\/\/x\.example\/a\.woff2/],
];
for (const [what, html, want] of BROKEN)
  test(`sent back: ${what}`, () => {
    assert.match(pageProblem(html) ?? "", want);
  });

const FINE: [what: string, html: string][] = [
  ["void and optional ends", page(`<br><img src="data:image/png;base64,AA"><ul><li>a<li>b</ul><table><tr><td>x</table><p>one<p>two`)],
  ["svg self-closing and case", page(`<svg viewBox="0 0 1 1"><defs><linearGradient id="g"/></defs><path d="M0 0"/><rect fill="url(#g)"/></svg>`)],
  ["a < in text and in strings", page(`<p>1 < 2</p><script>if (1 < 2 && "<div>") { go("</div>"); }</script>`)],
  ["tag-like text in a comment, a textarea, a title", page(`<!-- <div> --><textarea><div></textarea>`, "<title><b></title>")],
  ["a > in an attribute", page(`<a title="a > b" href="https://elsewhere.example/">x</a>`)],
  ["data blocks aren't scripts", page(`<script type="application/json">{ not js</script><script type="text/template"><div></script>`)],
  ["module with top-level await and dynamic import", page(`<script type="module">const a = await Promise.resolve(1); await import("data:text/javascript,1");</script>`)],
  ["handlers with entities and return", page(`<a onclick="go(&quot;x&quot;); return false;">x</a>`)],
  ["what the frame's policy allows", page("", `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=A&amp;display=swap"><style>@font-face{font-family:a;src:url(https://fonts.gstatic.com/a.woff2),url(data:font/woff2;base64,AA)}a{background:url("data:image/svg+xml,<svg fill='rgb(0,0,0)'/>")}</style>`)],
  ["a link to another site is no load", page(`<a href="https://elsewhere.example/">x</a>`)],
  ["style is no breakage", page(`<div style="color:#123;COLOR:red"><center><font>old</font></center></div>`)],
];
for (const [what, html] of FINE)
  test(`left alone: ${what}`, () => {
    assert.deepEqual(lintPage(html), []);
    assert.equal(pageProblem(html), null);
  });

test("the origins are the frame's own policy's: a font host it allows passes, the same host for a picture doesn't", () => {
  const font = /font-src[^;]*(https:\/\/[^\s;]+)/.exec(DESIGN_PAGE_CSP)![1]!;
  assert.deepEqual(lintPage(page("", `<style>@font-face{font-family:a;src:url(${font}/a.woff2)}</style>`)), []);
  assert.equal(lintPage(page(`<img src="${font}/a.png">`)).length, 1);
});

test("compiling never runs the page's code", () => {
  const g = globalThis as { LINT_RAN?: number };
  delete g.LINT_RAN;
  assert.deepEqual(lintPage(page(`<script>globalThis.LINT_RAN = 1;</script><script type="module">globalThis.LINT_RAN = 2;</script><a onclick="globalThis.LINT_RAN = 3">x</a>`)), []);
  assert.equal(g.LINT_RAN, undefined);
});

test("a very broken page reads as a short list", () => {
  const out = pageProblem(page(`</section>`.repeat(40).replace(/section/g, (s, i) => `${s}${i}`)))!;
  assert.match(out, /and \d+ more$/);
  assert.ok(out.split("; ").length <= 13);
});
