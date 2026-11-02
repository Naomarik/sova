// Run: pnpm test -- src/lib/offer-rows-card.test.ts. A card with rows (§chat.offers/card, Rows), rendered: each
// row's label, its own buttons with no Not Now, the all button with its confirm naming the rows, each row state's
// words; the read-only view (no controls), and the Waiting on you dialog drawing the same rows
// (§chat.composer/waiting-dialog). No row is about landing a branch: branches land through the merge queue.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OfferCard } from "../../shared/session-offers";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const resolve = (s: string) => import.meta.resolve(s);
const { OfferCardView, OfferContext } = await importSsr(new URL("../components/OfferCard.tsx", import.meta.url), resolve);
const { WaitingDialog } = await importSsr(new URL("../components/WaitingDialog.tsx", import.meta.url), resolve);

const btn = (label: string, confirm?: string) => ({ label, about: `${label}.`, kind: "send" as const, ...(confirm ? { confirm } : {}) });
const card = (over: Partial<OfferCard> = {}): OfferCard => ({
  id: "of_4",
  name: "tidy",
  title: "Folders to tidy",
  buttons: [],
  at: "2026-10-27T10:00:00.000Z",
  by: "another-chat",
  state: "open",
  rows: [
    { id: "r_1", label: "notes/", buttons: [btn("Tidy"), btn("Keep")], state: "open" },
    { id: "r_2", label: "scratch/", buttons: [btn("Delete…", "Delete scratch/? It can't be undone."), btn("Keep")], state: "open" },
    { id: "r_3", label: "logs/", buttons: [btn("Tidy"), btn("Keep")], state: "chosen", choice: { index: 0, label: "Tidy", at: "t" } },
    { id: "r_4", label: "old/", buttons: [btn("Tidy"), btn("Keep")], state: "superseded" },
    { id: "r_5", label: "gone/", buttons: [btn("Tidy"), btn("Keep")], state: "withdrawn" },
  ],
  all: { label: "Tidy All", about: "Tidies them.", confirm: "Tidy these folders? notes/.", rows: ["r_1"] },
  ...over,
});
const controls = (c: OfferCard) => ({ card: () => c, tray: () => [c], open: () => [c], busy: () => false, choose() {}, chooseAll() {}, notNow() {}, refresh() {} });
const draw = (c: OfferCard, withControls: boolean) =>
  renderToString(() =>
    withControls ? solid.createComponent(OfferContext.Provider, { value: controls(c), get children() { return solid.createComponent(OfferCardView, { card: c }); } }) : solid.createComponent(OfferCardView, { card: c }),
  ).replaceAll(/<!--[^>]*-->/g, "");
const rowHtml = (html: string, id: string) => {
  const at = html.indexOf(`data-offer-row="${id}"`);
  return html.slice(at, html.indexOf("</li>", at));
};

test("each row: its label, its own buttons and no Not Now; the row is never a link", () => {
  const html = draw(card(), true);
  const a = rowHtml(html, "r_1");
  assert.match(a, />notes\/</);
  assert.match(a, />Tidy</);
  assert.match(a, />Keep</);
  assert.doesNotMatch(a, /Not Now/, "no Not Now on a row");
  assert.ok(!/<li[^>]*><a /.test(html) && !/<a [^>]*class="[^"]*offer-card-row"/.test(html), "the row itself is never a link");
  assert.match(rowHtml(html, "r_2"), />Delete…</);
});

test("row states: the choice, Replaced, No longer offered", () => {
  const html = draw(card(), true);
  assert.match(rowHtml(html, "r_3"), /You chose <strong>Tidy<\/strong>/);
  assert.match(rowHtml(html, "r_4"), /Replaced by a newer commit/);
  assert.match(rowHtml(html, "r_5"), /No longer offered/);
  for (const id of ["r_3", "r_4", "r_5"]) assert.doesNotMatch(rowHtml(html, id), /<button/, `${id} has no buttons`);
});

test("the card's foot: the all button (its confirm on the button) and Not Now", () => {
  const html = draw(card(), true);
  const foot = html.slice(html.indexOf("card-foot"));
  assert.match(foot, />Tidy All</);
  assert.match(foot, />Not Now</);
  assert.doesNotMatch(draw(card({ all: undefined }), true), /Tidy All/, "only where the file declares it, while a row it answers is open");
});

test("an answered card says so", () => {
  assert.match(draw(card({ state: "chosen", all: undefined, rows: card().rows!.slice(2) }), true), /Every row is answered\./);
  const own: OfferCard = { id: "of_1", name: "tidy", title: "Tidy notes/?", buttons: [btn("Tidy"), btn("Keep")], at: "t", by: "another-chat", state: "chosen", choice: { index: 1, label: "Keep", at: "t" } };
  assert.match(draw(own, true), /You chose <strong>Keep<\/strong>/);
});

test("read only: rows with their state and no controls; an open row reads Waiting for an answer", () => {
  const html = draw(card(), false);
  assert.doesNotMatch(html, /<button/);
  assert.match(rowHtml(html, "r_1"), /Waiting for an answer: Tidy · Keep\./);
});

test("the Waiting on you dialog draws the rows with their own buttons, and the all button", () => {
  const c = card();
  const html = renderToString(() =>
    solid.createComponent(WaitingDialog, { source: { aligns: [], offers: controls(c), overseerCards: [], jumpAlign() {}, jumpOverseerCard() {}, jumpOffer() {} }, onClose() {} }),
  ).replaceAll(/<!--[^>]*-->/g, "");
  assert.match(html, /data-waiting-offer="of_4"/);
  assert.match(rowHtml(html, "r_1"), />Tidy</);
  assert.match(html, />Tidy All</);
  assert.match(html, />Show in Chat</);
});
