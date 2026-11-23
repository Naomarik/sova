// A shared session's Lookbooks on the recipient page (§app.session-share/content): where each block
// sits, the address that keeps an open design, and what each frame asks for.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionShareDesign, SessionShareLookbook, SessionShareView } from "../../shared/session-share";
import {
  designDirection,
  designHash,
  designKind,
  designPagePath,
  findDesign,
  latestVersion,
  lookbookTitle,
  parseDesignHash,
  parseDesignQuery,
  placeLookbooks,
  runsDesigns,
  shareDesignUrls,
  stepDesign,
  versionOption,
  versionShown,
} from "../share/lookbook-model";
import { mergeEarlier, mergeNewest } from "./share-slice";

const TOKEN = "a".repeat(43);
const design = (label: string, ns: number[], extra: Partial<SessionShareDesign> = {}): SessionShareDesign => ({
  label,
  style: "Quiet",
  layout: "Split",
  modelName: "Model One",
  versions: ns.map((n) => ({ n, at: `2026-11-0${n}T10:00:00.000Z` })),
  ...extra,
});
const lb = (id: string, after: number, designs: SessionShareDesign[] = [design("A", [1])]): SessionShareLookbook => ({ id, after, designs });
const view = (ns: number[], extra: Partial<SessionShareView> = {}): SessionShareView => ({
  title: "t",
  sharedAt: "2026-09-30T00:00:00Z",
  mode: "live",
  through: null,
  items: ns.map((n) => ({ kind: "reply", n, text: `m${n}` })),
  images: 0,
  ...extra,
});

test("the block's title counts its designs", () => {
  assert.equal(lookbookTitle(1), "Lookbook · 1 design");
  assert.equal(lookbookTitle(3), "Lookbook · 3 designs");
});

test("a tile's label is its style and layout, as far as it has them", () => {
  assert.equal(designDirection({ style: "Quiet", layout: "Split" }), "Quiet · Split");
  assert.equal(designDirection({ style: "Quiet" }), "Quiet");
  assert.equal(designDirection({ style: " ", layout: "Split" }), "Split");
});

test("each Lookbook sits after its card's item; one whose item isn't on screen waits for it", () => {
  const v = view([3, 4, 5], { before: 3, lookbooks: [lb("lb1", 1), lb("lb2", 4), lb("lb3", 4), lb("lb4", -1)] });
  const p = placeLookbooks(v);
  assert.deepEqual(p.after.get(4)?.map((l) => l.id), ["lb2", "lb3"]);
  assert.equal(p.after.has(1), false);
  // An earlier page is left to read: what sits above the first item shows with it.
  assert.deepEqual(p.top, []);
  const whole = placeLookbooks(view([0, 1], { lookbooks: [lb("lb1", -1), lb("lb2", 1), lb("lb9", 7)] }));
  assert.deepEqual(whole.top.map((l) => l.id), ["lb1"]);
  assert.deepEqual(whole.after.get(1)?.map((l) => l.id), ["lb2"]);
  // An empty Lookbook, and an older host's view with none, draw nothing.
  assert.deepEqual(placeLookbooks(view([0], { lookbooks: [lb("lb1", 0, [])] })).after.size, 0);
  assert.deepEqual(placeLookbooks(view([0])), { top: [], after: new Map() });
});

test("items are never renumbered by a Lookbook", () => {
  const v = view([0, 1, 2], { lookbooks: [lb("lb1", 0)] });
  placeLookbooks(v);
  assert.deepEqual(v.items.map((i) => i.n), [0, 1, 2]);
});

test("the version on show: the one asked for while it is there, else the newest", () => {
  const d = design("B", [1, 2, 4]);
  assert.equal(latestVersion(d), 4);
  assert.equal(versionShown(d, undefined), 4);
  assert.equal(versionShown(d, 2), 2);
  // version 3 is past the snapshot's cut: not on the wire, so never shown
  assert.equal(versionShown(d, 3), 4);
  assert.match(versionOption(d.versions[1]!), /^Version 2 · Nov 2, /);
  assert.equal(versionOption({ n: 1, at: "nonsense" }), "Version 1");
});

test("the open design's address round-trips and refuses anything else", () => {
  for (const a of [{ label: "A" }, { label: "AB", v: 3 }]) assert.deepEqual(parseDesignHash(designHash(a)), a);
  assert.equal(designHash({ label: "C", v: 2 }), "#design=C/2");
  for (const h of ["", "#design=", "#design=a", "#design=A/0", "#design=A/x", "#design=A/2/3", "#design=ABCDE", "#design=../x", "#/share/x"]) assert.equal(parseDesignHash(h), null, h);
});

test("Open in New Tab is the share link's own page, the design and version in its query", () => {
  assert.equal(designPagePath(TOKEN, { label: "A" }), `/s/${TOKEN}?design=A`);
  assert.equal(designPagePath(TOKEN, { label: "B", v: 2 }), `/s/${TOKEN}?design=B&v=2`);
  assert.deepEqual(parseDesignQuery(`?design=B&v=2`), { label: "B", v: 2 });
  assert.deepEqual(parseDesignQuery(`?design=B&v=0`), { label: "B" });
  for (const q of ["", "?v=2", "?design=b", "?design=%2F..", "?design=A1"]) assert.equal(parseDesignQuery(q), null, q);
});

test("every design is drawn from its token's address, the kind by the browser and the place", () => {
  const urls = shareDesignUrls(TOKEN);
  assert.equal(urls.doc("A", 2, "page"), `/api/s/${TOKEN}/d/A/2/page`);
  assert.equal(urls.page?.({ label: "A" }), `/s/${TOKEN}?design=A`);
  assert.equal(designKind(true, false), "page");
  assert.equal(designKind(false, false), "still");
  assert.equal(designKind(true, true), "tile");
  assert.equal(designKind(false, true), "tile-still");
  // Chrome-family (CSP Embedded Enforcement) runs a design; any other browser draws a still.
  assert.equal(runsDesigns({ csp: "" }), true);
  assert.equal(runsDesigns({}), false);
  assert.equal(runsDesigns(undefined), false);
});

test("Previous and Next step through one Lookbook's designs, wrapping", () => {
  const book = lb("lb1", 0, [design("A", [1]), design("B", [1]), design("C", [1])]);
  assert.equal(stepDesign(book, "A", 1)?.label, "B");
  assert.equal(stepDesign(book, "A", -1)?.label, "C");
  assert.equal(stepDesign(book, "C", 1)?.label, "A");
  assert.equal(stepDesign(lb("lb2", 0), "A", 1), null);
});

test("a design is found by its label in any Lookbook of the view", () => {
  const books = [lb("lb1", 0, [design("A", [1])]), lb("lb2", 3, [design("B", [1]), design("C", [2])])];
  assert.equal(findDesign(books, "C")?.lookbook.id, "lb2");
  assert.equal(findDesign(books, "D"), null);
  assert.equal(findDesign(undefined, "A"), null);
});

test("every answer carries the whole view's Lookbooks: the newest one's stand, an earlier page's never overwrite them", () => {
  const newest = view([200, 201], { before: 200, lineage: "x", lookbooks: [lb("lb1", 1), lb("lb2", 201, [design("A", [1, 2])])] });
  // an earlier page read later was built before the push: its Lookbooks are older
  const both = mergeEarlier(newest, view([0, 1], { lineage: "x", lookbooks: [lb("lb1", 1), lb("lb2", 201)] }))!;
  assert.deepEqual(both.lookbooks?.map((l) => l.id), ["lb1", "lb2"]);
  assert.deepEqual(both.lookbooks?.[1]?.designs[0]?.versions.map((v) => v.n), [1, 2]);
  // a push takes its own: a Lookbook whose designs were all removed is gone, the earlier items stay
  const pushed = mergeNewest(both, view([200, 201], { before: 200, lineage: "x", lookbooks: [lb("lb2", 201)] }));
  assert.deepEqual(pushed.lookbooks?.map((l) => l.id), ["lb2"]);
  assert.deepEqual(pushed.items.map((i) => i.n), [0, 1, 200, 201]);
  assert.deepEqual(placeLookbooks(pushed).after.get(1), undefined);
});
