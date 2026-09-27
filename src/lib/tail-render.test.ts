import assert from "node:assert/strict";
import { test } from "node:test";
import { carriedStart, chunkStart, imagesEstimate, initialStart, MAX_CHUNK, MIN_CHUNK, nextChunk, rowEstimate, rowIndexFor, TAIL_ROWS, wrapLines } from "./tail-render";

test("a long list opens on its last TAIL_ROWS rows; a short one is built whole", () => {
  assert.equal(initialStart(802), 802 - TAIL_ROWS);
  assert.equal(initialStart(TAIL_ROWS), 0);
  assert.equal(initialStart(3), 0);
  assert.equal(initialStart(0), 0);
});

test("chunks walk the window up to row 0 and stop there", () => {
  let start = initialStart(130);
  const seen: number[] = [];
  while (start > 0) seen.push((start = chunkStart(start, 50)));
  assert.deepEqual(seen, [20, 0]);
});

test("the chunk size follows the budget, at most doubling or halving per step", () => {
  assert.equal(nextChunk(50, 6, 12), 100, "half the budget used: double");
  assert.equal(nextChunk(50, 12, 12), 50, "on budget: unchanged");
  assert.equal(nextChunk(50, 15, 12), 40, "a little over: scaled down");
  assert.equal(nextChunk(50, 400, 12), 25, "one slow chunk only halves the next");
  assert.equal(nextChunk(50, 0, 12), 100, "an untimeable chunk counts as cheap");
});

test("the chunk size stays within its bounds", () => {
  assert.equal(nextChunk(MAX_CHUNK, 1, 12), MAX_CHUNK);
  assert.equal(nextChunk(MIN_CHUNK, 1000, 12), MIN_CHUNK);
});

test("rowIndexFor resolves an entry the way the [data-entry] lookup does", () => {
  const ids = ["u1", "a1:0", "a1:1", null, "t1", "a2:0"];
  assert.equal(rowIndexFor(ids, "u1"), 0);
  assert.equal(rowIndexFor(ids, "a1"), 1, "an entry id finds the first of its blocks");
  assert.equal(rowIndexFor(ids, "a1:1"), 2, "a block id finds its own row");
  assert.equal(rowIndexFor(ids, "a2:7"), 5, "a block that isn't shown falls back to its entry");
  assert.equal(rowIndexFor(ids, "gone"), -1, "not on the branch");
  assert.equal(rowIndexFor(ids, "a"), -1, "a prefix of an id is not that id");
});

test("a link row (null id) is never a jump target", () => {
  assert.equal(rowIndexFor([null, "x"], "x"), 1);
  assert.equal(rowIndexFor([null], "l1"), -1);
});

test("the window survives appends and refetches, and restarts at the tail when its row is gone", () => {
  const ids = Array.from({ length: 200 }, (_, i) => `r${i}`);
  const at = (id: string) => ids.indexOf(id);
  assert.equal(carriedStart("r120", at, ids.length), 120, "kept where it was");
  assert.equal(carriedStart(null, at, ids.length), 0, "fully built stays fully built");
  assert.equal(carriedStart("rewound-away", at, ids.length), initialStart(ids.length), "back to the tail");
});

test("wrapLines counts hard lines and their wraps", () => {
  assert.equal(wrapLines("", 80), 1);
  assert.equal(wrapLines("a\n\nb", 80), 3);
  assert.equal(wrapLines("x".repeat(161), 80), 3);
});

test("a row's estimate grows with its text and is capped", () => {
  const short = rowEstimate({ kind: "assistant-text", text: "hi" });
  const long = rowEstimate({ kind: "assistant-text", text: "word ".repeat(2000) });
  const huge = rowEstimate({ kind: "assistant-text", text: "x\n".repeat(100_000) });
  assert.match(short, /^calc\(24px \+ 1 \* var\(--entry-line-est, 23px\)\)$/);
  assert.match(long, /\+ 125 \*/);
  assert.match(huge, /\+ 200 \*/);
  assert.match(rowEstimate({ kind: "tool-call", text: "bash" }), /^calc\(40px \+ 0 \*/, "a collapsed card is one line of chrome");
});

/** A PNG data URL of this size: the IHDR, then an IEND (the size reader stops at either). */
const pngUrl = (w: number, h: number) => {
  const b = Buffer.alloc(8 + 25 + 12);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b.write("IEND", 33 + 4, "ascii");
  return `data:image/png;base64,${b.toString("base64")}`;
};

test("a row's images count in its estimate: one at its box's height, more as rows of tiles", () => {
  assert.deepEqual(imagesEstimate(undefined, "user"), [0, 0]);
  assert.deepEqual(imagesEstimate([], "tool"), [0, 0]);
  // Wide: 318 × 159 inside its 1px border; tall: 240 high; small: its own 50.
  assert.deepEqual(imagesEstimate([pngUrl(2000, 1000)], "user"), [8 + 161, 8 + 161]);
  assert.deepEqual(imagesEstimate([pngUrl(500, 1000)], "user"), [8 + 242, 8 + 242]);
  assert.deepEqual(imagesEstimate([pngUrl(80, 50)], "tool"), [17 + 52, 17 + 52]);
  const unknown = imagesEstimate(["/api/attachment?path=x.png"], "user");
  assert.ok(unknown[0] > 8 && unknown[0] <= 8 + 242, "an unreadable image still counts, inside the cap");
  const tiles = (n: number) => imagesEstimate(new Array(n).fill(pngUrl(10, 10)), "user");
  assert.deepEqual(tiles(2), [8 + 98, 8 + 98]);
  assert.deepEqual(tiles(4), [8 + 98, 8 + 2 * 98 + 8], "4 tiles: one row wide, two folded");
  assert.deepEqual(tiles(7), [8 + 98, 8 + 3 * 98 + 16]);
  assert.deepEqual(tiles(8), [8 + 2 * 98 + 8, 8 + 3 * 98 + 16]);
});

test("a row without images keeps its text-only estimate; with them, it adds a wide and a folded term", () => {
  const item = { kind: "user", text: "look" };
  assert.equal(rowEstimate(item, []), rowEstimate(item));
  assert.equal(rowEstimate(item, [pngUrl(2000, 1000)]), `calc(48px + 1 * var(--entry-line-est, 23px) + 169px)`);
  assert.equal(
    rowEstimate(item, new Array(4).fill(pngUrl(10, 10))),
    `calc(48px + 1 * var(--entry-line-est, 23px) + 106px + var(--entry-narrow, 0) * 106px)`,
  );
});
