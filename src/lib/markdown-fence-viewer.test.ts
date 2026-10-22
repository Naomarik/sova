// View Rendered on a markdown code block (src/lib/markdown.ts): which blocks carry it, and that it
// points at the block's own raw source, the text the viewer opens.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "./markdown";

const DOC = "# Plan\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";
const VIEW = /<button class="button button-sm button-ghost md-code-view" type="button" data-code-index="(\d+)">/g;
const views = (html: string) => [...html.matchAll(VIEW)].map((m) => Number(m[1]));

test("a closed markdown or md fence, any case, gets View Rendered before Copy Code", () => {
  for (const word of ["markdown", "md", "Markdown", "MD"]) {
    const r = renderMarkdown("```" + word + "\n" + DOC + "```");
    assert.deepEqual(views(r.html), [0], word);
    assert.ok(r.html.indexOf("md-code-view") < r.html.indexOf("md-code-copy"), "before Copy Code");
    assert.match(r.html, /View Rendered<\/button>/);
  }
});

test("its index names that block's raw source, among other blocks", () => {
  const r = renderMarkdown("```ts\nconst a = 1;\n```\n\n```md\n" + DOC + "```\n\n```md\nsecond\n```");
  const at = views(r.html);
  assert.deepEqual(at, [1, 2]);
  assert.equal(r.codes[at[0]!], DOC);
  assert.equal(r.codes[at[1]!], "second\n");
});

test("other fence words, indented code, and no word get none", () => {
  for (const md of ["```ts\nx\n```", "```\nx\n```", "```markdownish\nx\n```", "    # indented\n", "```text\n# x\n```"]) {
    assert.deepEqual(views(renderMarkdown(md).html), [], md);
  }
});

test("a markdown fence still open mid-stream has none until it closes", () => {
  const open = "Here:\n\n```markdown\n# Plan\n";
  assert.deepEqual(views(renderMarkdown(open, true).html), []);
  assert.deepEqual(views(renderMarkdown(open + "```\n", true).html), [0]);
});
