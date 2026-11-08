// A drawing card's Copy: what it copies, where a picture goes, and what follows a failure.
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { COPY_LABEL, copyRoute, copyWhat, crc32, nextRoute, solidColor, withPngScale, type PictureSupport } from "./copy-plan";

const full: PictureSupport = { secure: true, clipboardItem: true, png: true };

test("Copy follows the card: the drawing as a picture, Source open or an interactive drawing as text", () => {
  assert.equal(copyWhat({ sourceOpen: false, kind: "chart" }), "picture");
  assert.equal(copyWhat({ sourceOpen: false, kind: "svg" }), "picture");
  assert.equal(copyWhat({ sourceOpen: true, kind: "chart" }), "source");
  assert.equal(copyWhat({ sourceOpen: false, kind: "html" }), "source");
  assert.equal(COPY_LABEL.picture, "Copy picture");
  assert.equal(COPY_LABEL.source, "Copy source");
});

test("a picture goes on the clipboard only where the page and browser take one, else to the viewer", () => {
  assert.equal(copyRoute("source", full), "text");
  assert.equal(copyRoute("picture", full), "clipboard");
  assert.equal(copyRoute("picture", { ...full, png: undefined }), "clipboard", "a browser that can't say is tried");
  assert.equal(copyRoute("picture", { ...full, png: false }), "viewer");
  assert.equal(copyRoute("picture", { ...full, secure: false }), "viewer", "a plain http address");
  assert.equal(copyRoute("picture", { ...full, clipboardItem: false }), "viewer", "an older browser");
});

test("no picture at all copies the text; a clipboard refusing a picture opens the viewer", () => {
  assert.equal(nextRoute("clipboard", "no-picture"), "text");
  assert.equal(nextRoute("viewer", "no-picture"), "text");
  assert.equal(nextRoute("clipboard", "clipboard-refused"), "viewer");
  assert.equal(nextRoute("viewer", "clipboard-refused"), null);
  assert.equal(nextRoute("text", "no-picture"), null);
});

test("only a solid colour is the picture's backdrop", () => {
  for (const c of ["rgb(30, 30, 40)", "#fff", "oklch(0.2 0.01 260)", "rgba(1, 2, 3, 1)", "color(srgb 1 1 1 / 1)"]) assert.equal(solidColor(c), true, c);
  for (const c of ["transparent", "", "rgba(0, 0, 0, 0)", "rgba(1, 2, 3, 0.5)", "oklch(0.2 0.01 260 / 0.4)", "rgb(1 2 3 / 50%)"]) assert.equal(solidColor(c), false, c);
});

/** A minimal valid 1×1 PNG, built here so the test reads its own chunks. */
function png(extra: Uint8Array[] = []): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), ...extra.map((d) => chunk("pHYs", d)), chunk("IDAT", deflateSync(new Uint8Array([0, 255, 0, 0]))), chunk("IEND", new Uint8Array())];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (all.set(p, o), (o += p.length));
  return all;
}

function chunks(bytes: Uint8Array): { type: string; data: Uint8Array; crcOk: boolean }[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let at = 8; at < bytes.length; ) {
    const len = v.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    out.push({ type, data: bytes.subarray(at + 8, at + 8 + len), crcOk: v.getUint32(at + 8 + len) === crc32(bytes.subarray(at + 4, at + 8 + len)) });
    at += 12 + len;
  }
  return out;
}

test("the picture says its density, so an app that reads it shows it at the card's size", () => {
  const out = chunks(withPngScale(png(), 2));
  assert.deepEqual(out.map((c) => c.type), ["IHDR", "pHYs", "IDAT", "IEND"]);
  assert.ok(out.every((c) => c.crcOk));
  const phys = new DataView(out[1]!.data.buffer, out[1]!.data.byteOffset, 9);
  assert.equal(phys.getUint32(0), 5669, "144 dpi in pixels per metre");
  assert.equal(phys.getUint32(4), 5669);
  assert.equal(out[1]!.data[8], 1, "metres");
});

test("a pHYs already there is replaced, and bytes that aren't a PNG are left alone", () => {
  const out = chunks(withPngScale(png([new Uint8Array(9)]), 3));
  assert.deepEqual(out.map((c) => c.type), ["IHDR", "pHYs", "IDAT", "IEND"]);
  assert.equal(new DataView(out[1]!.data.buffer, out[1]!.data.byteOffset, 9).getUint32(0), 8504);
  const junk = new Uint8Array([1, 2, 3]);
  assert.equal(withPngScale(junk, 2), junk);
});
