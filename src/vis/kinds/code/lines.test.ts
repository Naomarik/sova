import assert from "node:assert/strict";
import { test } from "node:test";
import { highlight } from "../../../lib/markdown";
import { splitHighlighted } from "./lines";

const text = (html: string) => html.replace(/<[^>]+>/g, "");
const balanced = (html: string) => (html.match(/<span/g) ?? []).length === (html.match(/<\/span>/g) ?? []).length;

test("one balanced line per source line, and the text survives", () => {
  const src = "/* a\n   b */\nconst s = `x\ny`;\n\nlet i = 1 < 2;";
  const lines = splitHighlighted(highlight(src, "ts"));
  assert.equal(lines.length, src.split("\n").length);
  for (const l of lines) assert.ok(balanced(l), l);
  const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
  assert.deepEqual(lines.map((l) => unescape(text(l))), src.split("\n"));
  // The comment's second line is still a comment.
  assert.match(lines[1]!, /^<span class="hljs-comment">/);
});

test("plain (unknown language) text is split and stays escaped", () => {
  assert.deepEqual(splitHighlighted(highlight("a<b\nc", "nosuchlang")), ["a&lt;b", "c"]);
});
