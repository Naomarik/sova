// The Rendered toggle on a markdown code block (src/lib/markdown.ts, §chat.markdown/view-rendered):
// which blocks carry it, its starting state, and that it points at the block's own raw source, the
// text drawn in place.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "./markdown";

const DOC = "# Plan\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";
const TOGGLE = /<button class="button button-sm button-ghost md-code-render" type="button" aria-pressed="false" data-code-index="(\d+)">/g;
const toggles = (html: string) => [...html.matchAll(TOGGLE)].map((m) => Number(m[1]));

test("a closed markdown or md fence, any case, gets the toggle before Copy Code, unpressed, reading Rendered", () => {
  for (const word of ["markdown", "md", "Markdown", "MD"]) {
    const r = renderMarkdown("```" + word + "\n" + DOC + "```");
    assert.deepEqual(toggles(r.html), [0], word);
    assert.ok(r.html.indexOf("md-code-render") < r.html.indexOf("md-code-copy"), "before Copy Code");
    assert.match(r.html, /<span class="md-code-render-label">Rendered<\/span><\/button>/);
    assert.match(r.html, /<pre><code[^>]*>/, "the block opens on its source");
  }
});

test("its index names that block's raw source, among other blocks", () => {
  const r = renderMarkdown("```ts\nconst a = 1;\n```\n\n```md\n" + DOC + "```\n\n```md\nsecond\n```");
  const at = toggles(r.html);
  assert.deepEqual(at, [1, 2]);
  assert.equal(r.codes[at[0]!], DOC);
  assert.equal(r.codes[at[1]!], "second\n");
});

test("other fence words, indented code, and no word get none", () => {
  for (const md of ["```ts\nx\n```", "```\nx\n```", "```markdownish\nx\n```", "    # indented\n", "```text\n# x\n```"]) {
    assert.deepEqual(toggles(renderMarkdown(md).html), [], md);
  }
});

test("a markdown fence still open mid-stream has none until it closes", () => {
  const open = "Here:\n\n```markdown\n# Plan\n";
  assert.deepEqual(toggles(renderMarkdown(open, true).html), []);
  assert.deepEqual(toggles(renderMarkdown(open + "```\n", true).html), [0]);
});
