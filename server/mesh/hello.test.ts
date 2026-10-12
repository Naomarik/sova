// Run: pnpm test -- server/mesh/hello.test.ts
// The page's own build stamp (§mesh.front-door/stale-tab): the server stamps index.html with the build its hello
// reports, and the tab reads that stamp back as the build it runs — so a page the service worker served from its
// cache, older than the host's, is still seen as older on the first hello.
import assert from "node:assert/strict";
import { test } from "node:test";
import { firstBaseline, helloStep, pageBuild } from "../../src/lib/mesh";
import { pageBuildOf, stampBuild } from "./hello";

const page = (asset: string) =>
  `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <script type="module" crossorigin src="/assets/${asset}.js"></script>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n`;

/** A document as far as pageBuild reads one: the stamp's meta, found in the page's text. */
const docOf = (html: string) => ({
  querySelector: (sel: string) => {
    assert.equal(sel, 'meta[name="sova-build"]');
    const m = /<meta name="sova-build" content="([^"]*)">/.exec(html);
    return m ? ({ getAttribute: (name: string) => (name === "content" ? m[1]! : null) } as unknown as Element) : null;
  },
});

test("a served page carries, in its head, the build the hello reports for it", () => {
  const html = page("index-old");
  const build = pageBuildOf(html);
  const stamped = stampBuild(html, build);
  assert.ok(stamped.indexOf('<meta name="sova-build"') < stamped.indexOf("</head>"), "inside the head");
  assert.equal(pageBuild(docOf(stamped)), build);
  assert.equal(stamped.replace(`<meta name="sova-build" content="${build}">`, ""), html, "nothing else changes");
  // No head to stamp: the page goes out as built, and the tab falls back to the first hello.
  assert.equal(stampBuild("<p>hi</p>", build), "<p>hi</p>");
  assert.equal(pageBuild(docOf(html)), undefined);
});

test("a tab running a cached older page offers the reload on its first hello from a newer host", () => {
  const older = stampBuild(page("index-old"), pageBuildOf(page("index-old")));
  const hello = { id: "a", label: "Host A", protocol: "p1", build: pageBuildOf(page("index-new")) };
  const base = firstBaseline({ id: "a", label: "Host A" }, hello, pageBuild(docOf(older)));
  assert.deepEqual(helloStep(base, hello, null, 0).change, { protocol: false, build: true, host: null });
  // The page that host serves now: nothing to offer.
  const current = stampBuild(page("index-new"), hello.build);
  assert.equal(helloStep(firstBaseline({ id: "a", label: "Host A" }, hello, pageBuild(docOf(current))), hello, null, 0).change, null);
});
