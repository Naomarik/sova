import assert from "node:assert/strict";
import { test } from "node:test";
import { addPage, OUTPUT_GONE, outputFailed, readWords, sizeWords } from "./shell-output";
import { lastLine } from "./shell-runs";

test("the whole output is read page by page; only the page that starts where the read stopped joins", () => {
  let read = addPage(null, { output: "a\n", from: 0, next: 2, bytes: 4 });
  assert.deepEqual(read, { text: "a\n", next: 2, total: 4 });
  // A repeated answer (a double press of Load More) is dropped, never doubled.
  assert.equal(addPage(read, { output: "a\n", from: 0, next: 2, bytes: 4 }), read);
  read = addPage(read, { output: "b\n", from: 2, next: null, bytes: 4 });
  assert.deepEqual(read, { text: "a\nb\n", next: null, total: 4 });
  // At the end, nothing more joins.
  assert.equal(addPage(read, { output: "c", from: 4, next: null, bytes: 5 }), read);
});

test("while more is left the window says how much it holds, in sizes a person reads", () => {
  assert.equal(sizeWords(820), "820 bytes");
  assert.equal(sizeWords(48 * 1024), "48 KB");
  assert.equal(sizeWords(3.2 * 1024 * 1024), "3.2 MB");
  assert.equal(sizeWords(1200 * 1024 * 1024), "1,200 MB");
  assert.equal(readWords({ text: "x", next: 1024 * 1024, total: 3.2 * 1024 * 1024 }, 1024 * 1024), "Showing 1.0 MB of 3.2 MB");
  assert.equal(readWords({ text: "x", next: null, total: 1 }, 1), null);
});

test("a gone output and a failed page say what happened and what's left", () => {
  assert.match(OUTPUT_GONE, /archived/);
  assert.equal(outputFailed("500 Internal Server Error"), "Couldn't load the output. 500 Internal Server Error. Nothing else changed; try again.");
});

test("the dock shows a running command's newest drawn line", () => {
  assert.equal(lastLine(""), "");
  assert.equal(lastLine("one\ntwo\n\n"), "two");
  assert.equal(lastLine("building\r 10%\r 55%\r"), " 55%");
  assert.equal(lastLine("a  \n   \n"), "a");
});
