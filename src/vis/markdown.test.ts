// The markdown side of `vis` fences (src/lib/markdown.ts): what reaches the DOM before hydration.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../lib/markdown";

const FLOW = "```vis flow\na -> b\n```";

test("a closed vis fence that parses is a keyed placeholder plus its parsed spec", () => {
  const r = renderMarkdown(`Before\n\n${FLOW}\n\nAfter`);
  assert.match(r.html, /<div class="md-vis" data-vis="0" data-vis-key="[0-9a-f]+"><\/div>/);
  assert.equal(r.visuals.length, 1);
  assert.equal(r.visuals[0]!.kind, "flow");
  assert.equal(r.visuals[0]!.fence, FLOW);
  assert.equal(r.visuals[0]!.body, "a -> b\n");
  assert.equal(r.codes.length, 0, "not a code block");
});

test("the key follows the content, so a changed fence never keeps an old drawing", () => {
  const key = (md: string) => /data-vis-key="([0-9a-f]+)"/.exec(renderMarkdown(md).html)![1];
  assert.equal(key(FLOW), key(FLOW));
  assert.notEqual(key(FLOW), key("```vis flow\na -> c\n```"));
});

test("a fence that doesn't parse is the plain code block plus one line naming the error", () => {
  const r = renderMarkdown('```vis flow\na -> b\nA["x" --> b\n```');
  assert.equal(r.visuals.length, 0);
  assert.equal(r.codes.length, 1, "Copy Code still works");
  assert.match(r.html, /class="md-code md-vis-source"><div class="md-code-head"><span class="md-code-lang">vis flow<\/span>/, "the head names the kind");
  assert.match(r.html, /<p class="md-vis-error">Couldn't draw this vis flow block \(line 2: [^<]+\), so here is its source\.<\/p>/);
  assert.match(renderMarkdown("```vis gantt\nx 1\n```").html, /unknown kind &quot;gantt&quot;/);
  // gitgraph was dropped: its fences fall back to a code block like any unknown kind.
  assert.match(renderMarkdown("```vis gitgraph\ncommit A\n```").html, /unknown kind &quot;gitgraph&quot;/);
});

test("while streaming, an open vis fence is a Drawing line, never half a drawing", () => {
  const r = renderMarkdown("Here:\n\n```vis flow\na -> b\nb -> c", true);
  assert.equal(r.visuals.length, 0);
  assert.match(r.html, /class="md-vis-pending".*Drawing flow….*2 lines/s);
  assert.match(r.html, /<div class="md-vis-pending">/, "a block box, so vis.css can give it the reserved height");
  const done = renderMarkdown("Here:\n\n```vis flow\na -> b\nb -> c\n```", true);
  assert.equal(done.visuals.length, 1, "closed mid-stream: drawn");
});

test("model text in a vis fence is escaped everywhere it reaches HTML", () => {
  const r = renderMarkdown('```vis flow\n<img src=x onerror=alert(1)> -> b\n```');
  assert.doesNotMatch(r.html, /<img/);
  const bad = renderMarkdown("```vis <script>\nx\n```");
  assert.doesNotMatch(bad.html, /<script>/);
});
