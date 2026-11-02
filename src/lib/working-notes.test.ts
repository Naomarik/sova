// Run: pnpm exec tsx --test src/lib/working-notes.test.ts (or pnpm test). An assistant reply's working
// notes (§chat.markdown/working-notes): where the reply splits, and the fold the assistant-text row
// draws, rendered (closed, the disclosure's own classes), while every other markdown place keeps the
// heading as an ordinary h3.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderMarkdown, splitWorkingNotes } from "./markdown";

// Markdown cancels its pending frame on cleanup; the server build renders with no window.
const g = globalThis as { cancelAnimationFrame?: (id: number) => void; requestAnimationFrame?: (fn: () => void) => number };
g.cancelAnimationFrame ??= () => {};
g.requestAnimationFrame ??= () => 0;

// The SSR helper stays plain .mjs (node runs it uncompiled), so it has no types; its one export.
// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const { renderToString } = await import("solid-js/web");
const { ReplyMarkdown } = await importSsr(new URL("../components/ReplyMarkdown.tsx", import.meta.url), (s: string) => import.meta.resolve(s));

test("splitWorkingNotes: the first exact `### Working notes` line outside code splits the reply", () => {
  assert.deepEqual(splitWorkingNotes("Done: it works.\n\n### Working notes\nRead a.ts.\nRan the tests."), { top: "Done: it works.\n", notes: "Read a.ts.\nRan the tests." });
  assert.deepEqual(splitWorkingNotes("Just an answer."), { top: "Just an answer." }, "no heading: all of it is the top");
  assert.deepEqual(splitWorkingNotes("Top.\n### WORKING NOTES  \nx").notes, "x", "any case, trailing spaces");
  assert.deepEqual(splitWorkingNotes("Top.\r\n### Working notes\r\nx\r\n").notes, "x\r\n", "CRLF lines");
  // A later heading of the same words inside the fold is the fold's own text.
  assert.deepEqual(splitWorkingNotes("Top.\n### Working notes\na\n### Working notes\nb"), { top: "Top.", notes: "a\n### Working notes\nb" });
  // Nothing after it: the heading renders as nothing.
  assert.deepEqual(splitWorkingNotes("Top.\n\n### Working notes\n  \n"), { top: "Top.\n" });
});

test("splitWorkingNotes: never a lookalike, nor a heading in code, a list or a quote", () => {
  for (const text of [
    "Top.\n### Working notes: detail\nx",
    "Top.\n## Working notes\nx",
    "Top.\n#### Working notes\nx",
    "Top.\n**Working notes**\nx",
    " ### Working notes\nx",
    "Top.\n```md\n### Working notes\nx\n```",
    "Top.\n~~~\n### Working notes\n~~~",
    "Top.\n\n    ### Working notes\n",
    "- item\n  ### Working notes\n  x",
    "> ### Working notes\n> x",
  ]) assert.deepEqual(splitWorkingNotes(text), { top: text }, JSON.stringify(text));
  // A fence above it closes first; the heading after the fence splits.
  assert.deepEqual(splitWorkingNotes("```\n### Working notes\n```\n### Working notes\nx"), { top: "```\n### Working notes\n```", notes: "x" });
  // Mid-stream, an unclosed fence holds the heading: it is code until the fence closes.
  assert.deepEqual(splitWorkingNotes("Top.\n```\n### Working notes\nstill code"), { top: "Top.\n```\n### Working notes\nstill code" });
});

test("ReplyMarkdown: the notes are one closed disclosure after the top; no heading, no disclosure", () => {
  const html = renderToString(() => ReplyMarkdown({ text: "Done.\n\n### Working notes\nRead a.ts." }));
  const details = /<details class="disclosure md-working-notes"([^>]*)>/.exec(html);
  assert.ok(details, "the fold, with the disclosure's classes");
  assert.doesNotMatch(details![1]!, /\bopen\b/, "closed whenever it renders");
  assert.match(html, /<summary class="disclosure-summary"><span class="icon icon-sm icon-twist"[^>]*><\/span>Working notes<\/summary>/, "a twist and Working notes as its summary");
  assert.match(html, /<div class="disclosure-body"><div class="message-body md"/, "the body is markdown, drawn like the rest");
  assert.ok(html.indexOf('class="message-body md"') < html.indexOf("<details"), "the top renders first");
  for (const text of ["Just an answer.", "Top.\n\n### Working notes\n", "Top.\n### Working notes: detail\nx"]) {
    assert.doesNotMatch(renderToString(() => ReplyMarkdown({ text })), /<details/, JSON.stringify(text));
  }
});

test("everywhere else the heading is an ordinary h3", () => {
  assert.match(renderMarkdown("Top.\n\n### Working notes\nx").html, /<h3>Working notes<\/h3>/);
});

test("the fold's body wraps as prose", () => {
  const css = readFileSync(new URL("../design/base.css", import.meta.url), "utf8");
  assert.match(css, /\.md-working-notes > \.disclosure-body \{ white-space: normal; \}/);
});
