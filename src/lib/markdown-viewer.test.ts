// Run: npx tsx --test src/lib/markdown-viewer.test.ts (or npm test)
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { closeMarkdown, COLOUR_MAX, fileShape, markdownViewer, openMarkdown } from "./markdown-viewer";

const withFocus = (el: unknown, fn: () => void) => {
  const g = globalThis as { document?: unknown };
  g.document = { activeElement: el };
  try {
    fn();
  } finally {
    delete g.document;
  }
};

afterEach(() => closeMarkdown());

test("closed until opened, and closeMarkdown closes it", () => {
  assert.equal(markdownViewer(), null);
  openMarkdown({ title: "Plan", markdown: "# Plan" });
  assert.notEqual(markdownViewer(), null);
  closeMarkdown();
  assert.equal(markdownViewer(), null);
});

test("opens on Rendered unless the caller asks for Source", () => {
  openMarkdown({ title: "a", markdown: "x" });
  assert.equal(markdownViewer()!.view, "rendered");
  closeMarkdown();
  openMarkdown({ title: "a", markdown: "x", view: "source" });
  assert.equal(markdownViewer()!.view, "source");
});

test("keeps the document exactly as given", () => {
  const markdown = "# T\r\n\n<div onclick=\"x\">hi</div>\n\t- [ ] item  \n```vis flow\na -> b\n```\n";
  openMarkdown({ title: "T", subtitle: "from a report", markdown });
  const s = markdownViewer()!;
  assert.equal(s.markdown, markdown);
  assert.equal(s.title, "T");
  assert.equal(s.subtitle, "from a report");
});

test("a second open replaces the document, with a new seq, and keeps the first opener", () => {
  const opener = { id: "opener" };
  const inside = { id: "close-button" };
  withFocus(opener, () => openMarkdown({ title: "one", markdown: "1" }));
  const first = markdownViewer()!;
  withFocus(inside, () => openMarkdown({ title: "two", markdown: "2", view: "source" }));
  const second = markdownViewer()!;
  assert.equal(second.title, "two");
  assert.equal(second.markdown, "2");
  assert.equal(second.view, "source");
  assert.notEqual(second.seq, first.seq);
  assert.equal(second.opener, opener);
});

test("after a close, the next open takes the element focused then", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  withFocus(a, () => openMarkdown({ title: "one", markdown: "1" }));
  closeMarkdown();
  withFocus(b, () => openMarkdown({ title: "two", markdown: "2" }));
  assert.equal(markdownViewer()!.opener, b);
});

test("without a document (server-side), the opener is null", () => {
  openMarkdown({ title: "t", markdown: "m" });
  assert.equal(markdownViewer()!.opener, null);
});

test("a file is shown by its name and contents", () => {
  assert.deepEqual(fileShape("guide.md", "---\na: 1\n---\n# Top"), { kind: "markdown", body: "# Top" });
  assert.deepEqual(fileShape("x:y", "# Top", "markdown"), { kind: "markdown", body: "# Top" });
  assert.deepEqual(fileShape("run.mjs", "let a = 1"), { kind: "code", body: "let a = 1", lang: "javascript" });
  assert.deepEqual(fileShape("a.json", '{"a":1}'), { kind: "code", body: '{\n  "a": 1\n}', lang: "json" });
  assert.deepEqual(fileShape("tool:read", "[1]", "json"), { kind: "code", body: "[\n  1\n]", lang: "json" });
  assert.deepEqual(fileShape("a.json", "{nope"), { kind: "text" }, "invalid JSON stays as it is");
  assert.deepEqual(fileShape("notes.txt", "hi"), { kind: "text" });
  assert.deepEqual(fileShape("LICENSE", "hi"), { kind: "text" });
});

test("over the ceiling a file is plain text, whatever its type; at it, still coloured", () => {
  const at = "x".repeat(COLOUR_MAX);
  assert.equal(fileShape("a.ts", at).kind, "code");
  for (const name of ["a.ts", "a.md", "a.json"]) assert.deepEqual(fileShape(name, `${at}x`), { kind: "text" }, name);
});

test("what can't be shown says so, and a source's word wins", () => {
  const binary = "Not a text file, so it isn't shown.";
  assert.deepEqual(fileShape("a.md", "a\u0000b"), { kind: "note", note: binary });
  assert.deepEqual(fileShape("a.md", "", undefined, "binary"), { kind: "note", note: binary });
  assert.deepEqual(fileShape("a.md", "", undefined, "too-large"), { kind: "note", note: "Too large to show here." });
});

test("a file doc keeps the exact text and hides front matter only from Rendered; the opener it names wins over focus", () => {
  const opener = { id: "row" } as unknown as HTMLElement;
  const text = "---\na: 1\n---\n# Top";
  withFocus({ id: "other" }, () => openMarkdown({ title: "a", markdown: text, name: "a.md", opener }));
  const s = markdownViewer()!;
  assert.equal(s.markdown, text);
  assert.deepEqual(s.shape, { kind: "markdown", body: "# Top" });
  assert.equal(s.opener, opener);
});

test("a doc with no name is markdown, as written, front matter and all", () => {
  openMarkdown({ title: "a", markdown: "---\na: 1\n---\nx" });
  assert.deepEqual(markdownViewer()!.shape, { kind: "markdown", body: "---\na: 1\n---\nx" });
});
