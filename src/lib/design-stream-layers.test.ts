// The live frame's layers: a page drawn again replaces the picture in place, never with a blank moment (q1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { noStreamLayers, streamKey, streamLayerList, streamLayers, streamNoteShown, streamTopHidden, type StreamLayerEvent, type StreamLayers } from "./design-stream-layers";

const run = (events: StreamLayerEvent[], from: StreamLayers = noStreamLayers) => events.reduce(streamLayers, from);
const urls = (s: StreamLayers) => streamLayerList(s).map((l) => l.url);

test("a first page: the note shows until it has painted, then the page alone", () => {
  const s = run([{ t: "reconnect" }, { t: "connected", url: "/one" }]);
  assert.deepEqual(urls(s), ["/one"]);
  assert.equal(streamNoteShown(s, false), true);
  assert.equal(streamTopHidden(s, false), false);
  const p = streamLayers(s, { t: "painted" });
  assert.equal(streamNoteShown(p, false), false);
  assert.deepEqual(urls(p), ["/one"]);
});

test("drawn again: the old picture stays mounted, the same element, until the new one has painted", () => {
  const first = run([{ t: "reconnect" }, { t: "connected", url: "/one" }, { t: "painted" }]);
  const old = first.top!;
  const waiting = streamLayers(first, { t: "reconnect" });
  assert.deepEqual(urls(waiting), ["/one"], "nothing blank while the new link comes");
  assert.equal(waiting.under, old, "the very layer, so its element and document stay");
  assert.equal(streamNoteShown(waiting, false), false, "no note over the old picture");
  const coming = streamLayers(waiting, { t: "connected", url: "/two" });
  assert.deepEqual(urls(coming), ["/one", "/two"], "the new one above the old");
  assert.equal(streamTopHidden(coming, false), true, "and see-through until it paints");
  const done = streamLayers(coming, { t: "painted" });
  assert.deepEqual(urls(done), ["/two"]);
  assert.equal(streamTopHidden(done, false), false);
});

test("drawn again twice before painting: the last painted picture is the one that holds", () => {
  const s = run([{ t: "reconnect" }, { t: "connected", url: "/one" }, { t: "painted" }, { t: "reconnect" }, { t: "connected", url: "/two" }, { t: "reconnect" }, { t: "connected", url: "/three" }]);
  assert.deepEqual(urls(s), ["/one", "/three"]);
});

test("a slot taken by another tile drops the open document; a finished one beneath stays", () => {
  const s = run([{ t: "reconnect" }, { t: "connected", url: "/one" }, { t: "painted" }, { t: "reconnect" }, { t: "connected", url: "/two" }, { t: "revoked" }]);
  assert.deepEqual(urls(s), ["/one"]);
  assert.deepEqual(urls(run([{ t: "connected", url: "/a" }, { t: "painted" }, { t: "revoked" }])), [], "an open document is let go");
});

test("over an earlier version, the new page is see-through and no note shows until it paints", () => {
  const s = run([{ t: "reconnect" }, { t: "connected", url: "/v2" }]);
  assert.equal(streamTopHidden(s, true), true);
  assert.equal(streamNoteShown(s, true), false);
});

test("the frame's key changes with the version or the draw, and not otherwise", () => {
  assert.equal(streamKey(undefined, 3), undefined);
  assert.equal(streamKey(1, undefined), streamKey(1, undefined));
  assert.notEqual(streamKey(1, 5), streamKey(1, 6));
  assert.notEqual(streamKey(1, 5), streamKey(2, 5));
});
