// Run: pnpm test -- src/lib/data-cards.test.ts
// Sova's data cards drawn from fixtures (§chat.transcript-cards/data-cards) and a card's own error
// box (§chat.transcript-cards/toolkit), with Solid's SSR build (src/lib/align-card-ssr.mjs). The
// question card is the alignment card's question layout, picked the same way; data that doesn't
// fit draws the error box naming the field, never half a card.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const resolve = (s: string) => import.meta.resolve(s);
const { DataCard } = await importSsr(new URL("../components/DataCards.tsx", import.meta.url), resolve);
const { TranscriptKindRow, CardErrorBox, whyOf } = await importSsr(new URL("../components/TranscriptKind.tsx", import.meta.url), resolve);
const { kindById } = await import("./transcript-kinds");

/** The markup without Solid's hydration keys, markers and the script SSR adds for a caught error. */
const clean = (html: string) => html.replace(/ data-hk="[^"]*"/g, "").replace(/<!--[^>]*-->/g, "").replace(/<script>[\s\S]*?<\/script>/g, "");
const draw = (props: Record<string, unknown>): string => clean(renderToString(() => solid.createComponent(DataCard as never, props as never)));
/** Draws `props` inside an error boundary, as the toolkit's host does: the error's words, or the card. */
const drawOrWhy = (props: Record<string, unknown>): string =>
  clean(
    renderToString(() =>
      solid.createComponent(solid.ErrorBoundary, {
        fallback: (e: unknown) => `ERROR: ${whyOf(e)}`,
        get children() {
          return solid.createComponent(DataCard as never, props as never);
        },
      }),
    ),
  );
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/ ([.,?])/g, "$1").trim();

const question = {
  title: "Storage",
  ask: "Which **format**?",
  context: "Small data.",
  options: [{ label: "JSON", tradeoff: "readable" }, { label: "SQLite", tradeoff: "queries" }, { label: "CSV" }],
  recommendation: { option: "b", why: "we query it" },
};
const picker = (picked: number | undefined, blocked: string | null = null) => ({ blocked: () => blocked, picked: () => picked, pick() {}, ticked: () => picked === 1, tick() {} });

describe("question", () => {
  test("lettered options and the recommendation line, as on an alignment card", () => {
    const html = draw({ draws: "question", data: question, id: "cd_1" });
    assert.match(html, /<ol class="align-q-options" aria-label="Options">/);
    assert.deepEqual([...html.matchAll(/<span class="text-mono align-q-letter">([a-z])<\/span>/g)].map((m) => m[1]), ["a", "b", "c", "b"], "a, b, c, then the recommendation's letter");
    assert.match(text(html), /Recommended b — SQLite we query it/);
    assert.match(html, /Which <strong>format<\/strong>\?/, "bold runs drawn as on an alignment card");
    assert.doesNotMatch(html, /type="radio"/, "read-only without a picker");
  });

  test("with a picker the whole row is the target, named for assistive tech, and the recommendation a checkbox", () => {
    const html = draw({ draws: "question", data: question, id: "cd_1", answer: { picker: picker(1) } });
    assert.equal(html.match(/<label class="align-q-pick"/g)?.length, 3);
    assert.match(html, /aria-label="Answer cd_1 with b: SQLite"/);
    assert.match(html, /<input type="radio" class="visually-hidden" name="align-q-\d+" checked/);
    assert.match(html, /Take the recommendation for cd_1\./);
    const blocked = draw({ draws: "question", data: question, answer: { picker: picker(undefined, "This chat is archived.") } });
    assert.match(blocked, /title="This chat is archived\."/);
    assert.match(blocked, / disabled/);
  });

  test("with no recommendation, no recommendation line", () => {
    const { recommendation: _, ...bare } = question;
    assert.doesNotMatch(draw({ draws: "question", data: bare }), /Recommended/);
  });
});

test("checklist: the ticks as data, and how many are done", () => {
  const html = draw({ draws: "checklist", data: { title: "Release", items: [{ text: "Build", done: true }, { text: "Ship", done: false }] } });
  assert.match(text(html), /Release 1 of 2 done/);
  assert.equal(html.match(/type="checkbox"/g)?.length, 2);
  assert.equal(html.match(/ disabled/g)?.length, 2, "not answerable: drawn as data");
  const live = draw({ draws: "checklist", data: { title: "R", items: [{ text: "Build", done: false }] }, answer: { tick() {}, tickBlocked: () => null } });
  assert.doesNotMatch(live, / disabled/);
});

test("status: the dot and the word, never hue alone", () => {
  const html = draw({ draws: "status", data: { title: "CI", tone: "warn", line: "2 flaky tests", detail: "Retry passed." } });
  assert.match(html, /<span class="chip chip-warn"><i class="chip-dot"><\/i>Warning<\/span>/);
  assert.match(text(html), /CI Warning 2 flaky tests Retry passed\./);
});

test("table: past 10 rows the first 10 and Show All {n} Rows", () => {
  const rows = Array.from({ length: 12 }, (_, i) => [`r${i}`, "x"]);
  const html = draw({ draws: "table", data: { title: "Runs", columns: ["Run", "State"], rows } });
  assert.equal(html.match(/<tr>/g)?.length, 11, "the head and 10 rows");
  assert.match(html, /<th scope="col">Run<\/th>/);
  assert.match(text(html), /Show All 12 Rows/);
  assert.doesNotMatch(draw({ draws: "table", data: { columns: ["a"], rows: [["1"]] } }), /Show All/);
});

test("buttons: the offer card's row with each button's about, or the waiting line where it can't be answered", () => {
  const data = { title: "Next step", note: "Pick one.", buttons: [{ label: "Ship", about: "Merges it", does: { kind: "answer" } }, { label: "Wait", does: { kind: "send", text: "wait" } }] };
  const live = draw({ draws: "buttons", data, answer: { press() {}, canAct: () => true } });
  assert.match(live, /<button type="button" class="button button-sm" data-offer-button="0" title="Merges it">Ship<\/button>/);
  assert.match(live, /data-offer-button="1">Wait<\/button>/);
  const watched = draw({ draws: "buttons", data });
  assert.match(text(watched), /Waiting for an answer: Ship · Wait\./);
  assert.doesNotMatch(watched, /<button/);
});

test("data that doesn't fit its card throws, naming the field, so the card's error box draws instead of half a card", () => {
  const bad = { ...question, options: [...question.options, { label: "x".repeat(121) }] };
  assert.equal(drawOrWhy({ draws: "question", data: bad }), "ERROR: options[3].label is longer than 120 characters");
  assert.equal(drawOrWhy({ draws: "status", data: { title: "CI", tone: "green", line: "x" } }), "ERROR: tone is not one of ok, warn, error, info, muted");
});

describe("the error box", () => {
  test("a view that throws draws the error box with Reload in its own place, and the rows beside it draw", () => {
    const wake = kindById("wake")!;
    const html = clean(
      renderToString(() => [
        solid.createComponent(TranscriptKindRow as never, { hit: { kind: wake, value: undefined }, item: { id: "w1", kind: "wake", at: "2026-02-01T00:00:00.000Z" } } as never),
        solid.createComponent(TranscriptKindRow as never, { hit: { kind: kindById("info")!, value: true }, item: { id: "i1", kind: "info", text: "Still here", at: "2026-02-01T00:00:00.000Z" } } as never),
      ]),
    );
    assert.match(html, /<div class="banner banner-error card-error" role="status">/);
    assert.match(text(html), /^This card couldn't be drawn: .+\. Reload Still here$/);
    assert.match(html, /<button type="button" class="button button-sm">Reload<\/button>/);
  });

  test("the box's words: the error's own, one sentence", () => {
    assert.equal(whyOf(new Error("options[2].label is longer than 120 characters.")), "options[2].label is longer than 120 characters");
    assert.equal(whyOf("bad"), "bad");
    assert.equal(whyOf(42), "it failed while drawing");
    const html = clean(renderToString(() => solid.createComponent(CardErrorBox as never, { why: "it was built for toolkit v2", reload() {} } as never)));
    assert.match(text(html), /This card couldn't be drawn: it was built for toolkit v2\. Reload/);
  });
});
