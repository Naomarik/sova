// Run: pnpm test -- src/lib/offer-rows-card.test.ts. A card with rows (§chat.offers/card, Rows) and the Merge
// Captain's landing card (§chat.offers/landing-rows), rendered: each row's line, its owner chat as a link of its
// own (the row is never one), its own buttons with no Not Now, Land All with its confirm naming the rows, the
// waiting line, each row state's words and where an answer came from; the read-only view (no controls), and the
// Waiting on you dialog drawing the same rows (§chat.composer/waiting-dialog).
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
  name: "landing",
  title: "Branches ready to land",
  buttons: [],
  at: "2026-10-27T10:00:00.000Z",
  by: "another-chat",
  state: "open",
  rows: [
    { id: "r_1", label: "feat/a", branch: "feat/a", commit: "abc1234", owner: { id: "s-1", title: "Fix the sidebar" }, buttons: [btn("Land It"), btn("Not Yet")], state: "open" },
    { id: "r_2", label: "feat/s", branch: "feat/s", commit: "def5678", owner: { id: "s-2", title: "Specs chat" }, drafts: "left-draft", buttons: [btn("Merge Without Specs…", "Land feat/s without its specs? left-draft stays."), btn("Not Yet")], state: "open" },
    { id: "r_3", label: "feat/c", branch: "feat/c", commit: "1111111", owner: { id: "s-3", title: "Chat C" }, buttons: [btn("Land It"), btn("Not Yet")], state: "chosen", choice: { index: 0, label: "Land It", at: "t", where: "Chat C" } },
    { id: "r_4", label: "feat/d", branch: "feat/d", commit: "2222222", owner: { id: "s-4", title: "Chat D" }, buttons: [btn("Land It"), btn("Not Yet")], state: "chosen", choice: { index: 0, label: "Land It", at: "t" }, progress: "landing" },
    { id: "r_5", label: "feat/e", branch: "feat/e", commit: "3333333", owner: { id: "s-5", title: "Chat E" }, buttons: [btn("Land It"), btn("Not Yet")], state: "chosen", choice: { index: 0, label: "Land It", at: "t" }, progress: "landed" },
    { id: "r_6", label: "feat/f", branch: "feat/f", commit: "4444444", owner: { id: "s-6", title: "Chat F" }, buttons: [btn("Land It"), btn("Not Yet")], state: "superseded" },
  ],
  all: { label: "Land All", about: "Lands them.", confirm: "Land these branches? feat/a@abc1234.", rows: ["r_1"] },
  more: 2,
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

test("each row: branch, short commit, the owner chat as its own link, drafts left, its own buttons and no Not Now", () => {
  const html = draw(card(), true);
  const a = rowHtml(html, "r_1");
  assert.match(a, />feat\/a</);
  assert.match(a, />abc1234</);
  assert.match(a, /<a [^>]*href="#\/sid\/s-1"[^>]*>Fix the sidebar<\/a>/);
  assert.match(a, />Land It</);
  assert.match(a, />Not Yet</);
  assert.doesNotMatch(a, /Not Now/, "no Not Now on a row");
  assert.ok(!/<li[^>]*><a /.test(html) && !/<a [^>]*class="[^"]*offer-card-row"/.test(html), "the row itself is never a link");
  const s = rowHtml(html, "r_2");
  assert.match(s, /Spec drafts left: left-draft/);
  assert.match(s, />Merge Without Specs…</);
  assert.doesNotMatch(s, />Land It</);
});

test("row states: where an answer came from, Landing, Landed, Replaced", () => {
  const html = draw(card(), true);
  assert.match(rowHtml(html, "r_3"), /You chose <strong>Land It<\/strong> in Chat C/);
  assert.match(rowHtml(html, "r_4"), />Landing</);
  assert.match(rowHtml(html, "r_5"), />Landed</);
  assert.match(rowHtml(html, "r_6"), /Replaced by a newer commit/);
  for (const id of ["r_3", "r_4", "r_5", "r_6"]) assert.doesNotMatch(rowHtml(html, id), /<button/, `${id} has no buttons`);
});

test("the card's foot: Land All (its confirm on the button) and Not Now; the waiting line", () => {
  const html = draw(card(), true);
  const foot = html.slice(html.indexOf("card-foot"));
  assert.match(foot, />Land All</);
  assert.match(foot, />Not Now</);
  assert.match(html, /2 more branches wait for this card to be answered\./);
  assert.match(draw(card({ more: 1 }), true), /1 more branch waits for this card to be answered\./);
  assert.doesNotMatch(draw(card({ all: undefined }), true), /Land All/, "only where the file declares it, while a row it answers is open");
});

test("an answered card says so; another place's answer on a plain card says where", () => {
  assert.match(draw(card({ state: "chosen", all: undefined, more: undefined, rows: card().rows!.slice(2) }), true), /Every row is answered\./);
  const own: OfferCard = { id: "of_1", name: "landing", title: "Land feat/a at abc1234?", buttons: [btn("Land It"), btn("Not Yet")], at: "t", by: "another-chat", state: "chosen", choice: { index: 1, label: "Not Yet", at: "t", where: "Merge Captain" } };
  assert.match(draw(own, true), /You chose <strong>Not Yet<\/strong> in Merge Captain/);
});

test("read only: rows with their state and no controls; an open row reads Waiting for an answer", () => {
  const html = draw(card(), false);
  assert.doesNotMatch(html, /<button/);
  assert.match(rowHtml(html, "r_1"), /Waiting for an answer: Land It · Not Yet\./);
  assert.match(rowHtml(html, "r_3"), /in Chat C/);
});

test("the Waiting on you dialog draws the rows with their own buttons, and Land All", () => {
  const c = card();
  const html = renderToString(() =>
    solid.createComponent(WaitingDialog, { source: { aligns: [], offers: controls(c), overseerCards: [], jumpAlign() {}, jumpOverseerCard() {}, jumpOffer() {} }, onClose() {} }),
  ).replaceAll(/<!--[^>]*-->/g, "");
  assert.match(html, /data-waiting-offer="of_4"/);
  assert.match(rowHtml(html, "r_1"), />Land It</);
  assert.match(rowHtml(html, "r_1"), /href="#\/sid\/s-1"/);
  assert.match(html, />Land All</);
  assert.match(html, />Show in Chat</);
});
