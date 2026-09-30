// Run: npx tsx --test src/lib/markdown-viewer.test.ts (or npm test)
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { closeMarkdown, markdownViewer, openMarkdown } from "./markdown-viewer";

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
