// Run: pnpm exec tsx --test src/lib/align-card.test.ts (or pnpm test / pnpm run test:bun). The align card's reading
// order and DOM, rendered: the approach between the summary and the questions and open by
// default, its steps numbered by their stable ids only with the whole inline-rich body in the
// second column, findings and rejected folded below the questions — plus the view-model the card
// renders from, and the card's answer context defaulting to null, so a card outside a chat Sova
// holds composes nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The SSR helper stays plain .mjs (node runs it uncompiled), so it has no types; its one export.
// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { cardSections } = await import("./align");
const { AlignAnswerContext, AlignDocCard, AlignRow } = await importSsr(new URL("../components/AlignDocCard.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
import type { AlignDocInfo, AlignRowInfo } from "../../shared/protocol";

const cardCss = readFileSync(new URL("../design/align-viewer.css", import.meta.url), "utf8").replaceAll(/\/\*[\s\S]*?\*\//g, "");
const baseCss = readFileSync(new URL("../design/base.css", import.meta.url), "utf8").replaceAll(/\/\*[\s\S]*?\*\//g, "");

const doc = (over: Partial<AlignDocInfo> = {}): AlignDocInfo => ({
  id: "al_1",
  title: "Autonomy settings",
  summary: "How far the Overseer may act without asking.",
  findings: [{ id: "f1", text: "Idle runs cost more than they return." }],
  approach: [
    { id: "a1", text: "Measure a week of runs first." },
    { id: "a2", text: "Then cap the rate per **project**, not per session." },
  ],
  rejected: [{ id: "x1", option: "Do nothing", why: "the cost keeps growing" }],
  questions: [
    {
      id: "q3",
      topic: "Pace limit",
      ask: "How often may it start a run on its own?",
      options: [
        { label: "1 per 10 min", tradeoff: "a tight leash" },
        { label: "1 per hour", tradeoff: "looser" },
      ],
      recommendation: { choice: "1 per hour", why: "enough for a small project" },
    },
  ],
  phase: "open",
  next: { f: 2, a: 3, x: 2, q: 4 },
  rev: 5,
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  ...over,
});

const draw = (component: (props: never) => unknown, props: unknown): string =>
  renderToString(() => solid.createComponent(component as never, props as never));

/** The slice of the card between two landmarks, with SSR marker comments left in. */
const between = (html: string, from: string, to: string): string => html.slice(html.indexOf(from), html.indexOf(to));

test("DOM: the approach reads first — after the summary, before the questions, open; the others folded below", () => {
  const html = draw(AlignDocCard, { doc: doc() });
  const at = (needle: string) => html.indexOf(needle);
  assert.ok(at('class="align-doc-summary"') >= 0, "summary");
  assert.ok(at("align-approach") > at('class="align-doc-summary"'), "approach after the summary");
  assert.ok(at('<ol class="align-questions"') > at("align-approach"), "approach before the questions");
  assert.ok(at("Findings") > at('<ol class="align-questions"'), "findings below the questions");
  assert.ok(at("Rejected") > at("Findings"), "rejected below the findings");
  assert.match(html, /<details class="disclosure align-section align-approach"[^>]*\bopen\b/, "the approach details open");
  assert.equal(html.match(/<details class="disclosure align-section">/g)?.length, 2, "findings and rejected, folded");
});

test("DOM: a step's body is one span — the li's two columns are the id and the whole inline-rich body", () => {
  const html = draw(AlignDocCard, {
    doc: doc({ approach: [{ id: "a7", text: "Write `parquet` **first**, then rest." }, { id: "a9", text: "Then `commit`." }] }),
  });
  const list = between(html, 'class="align-list align-approach-list"', "</ul>");
  const items = list.split("<li>").slice(1).map((s) => `<li>${s}`);
  assert.equal(items.length, 2, "one li per step");
  // The regression: with the body unwrapped, each code span and bold run becomes its own grid
  // item after the id, and the li no longer opens with the body span right after the id span.
  assert.match(items[0]!, /^<li>(?:<!--[^>]*-->)?<span class="text-mono align-item-id">a7<\/span>(?:<!--[^>]*-->)*<span class="align-approach-text">/, "id column, then one body span");
  assert.match(items[0]!, /<code>parquet<\/code>[\s\S]*<strong>first<\/strong>/, "code spans and bold runs render");
  assert.match(items[0]!, /<\/span>(?:<!--[^>]*-->)*<\/li>$/, "the body span closes the li");
  assert.match(items[1]!, /<span class="text-mono align-item-id">a9<\/span>/, "the document's own ids, gaps and all");
  assert.ok(!list.includes("<ol"), "no ordered list, no positional numbering");
});

test("DOM: an empty section is absent; an empty approach leaves the questions and the rest", () => {
  const noApproach = draw(AlignDocCard, { doc: doc({ approach: [] }) });
  assert.ok(!noApproach.includes("align-approach"), "no approach section");
  assert.ok(noApproach.includes('<ol class="align-questions"'), "questions remain");
  const noFindings = draw(AlignDocCard, { doc: doc({ findings: [] }) });
  assert.equal(noFindings.match(/<details class="disclosure align-section">/g)?.length, 1, "only the rejected section folds below");
});

test("DOM: an earlier revision stays one closed line that opens to that revision's body", () => {
  const row: AlignRowInfo = { v: 1, doc: doc({ rev: 4 }), changes: [], line: "q3 decided" };
  const html = draw(AlignRow, { row, newest: false });
  assert.match(html, /<details class="disclosure align-rev">/, "the revision disclosure, closed");
  const rev = html.slice(html.indexOf("align-rev"));
  assert.ok(rev.includes(">v4<"), "the revision's own number in the line");
  assert.ok(rev.includes("q3 decided"), "the call's changes in the line");
  assert.ok(rev.includes("align-approach"), "opened, that revision's body — approach included");
});

test("DOM: the fold is per render — a fresh render is open again, nothing persists", () => {
  const first = draw(AlignDocCard, { doc: doc() });
  const second = draw(AlignDocCard, { doc: doc() });
  assert.match(first, /align-approach"[^>]*\bopen\b/, "first render open");
  assert.match(second, /align-approach"[^>]*\bopen\b/, "a fresh render (as after a refresh) is open again");
  assert.ok(!first.includes("<input"), "no tick, radio or any control without an answer context");
  assert.ok(!first.includes("Go With Recommendations"), "no button outside an answerable card");
});

test("the card's answer context defaults to null: outside a chat Sova holds, nothing composes", () => {
  assert.equal(AlignAnswerContext.defaultValue, null);
});

test("the view-model the card renders from: approach open first, then the folded findings and rejected", () => {
  const sections = cardSections(doc());
  assert.deepEqual(
    sections.map((s) => [s.kind, s.label, s.open]),
    [
      ["approach", "Approach", true],
      ["findings", "Findings", false],
      ["rejected", "Rejected", false],
    ],
    "approach first and open; findings and rejected folded, in that order",
  );
  const gapped = cardSections(doc({ approach: [{ id: "a7", text: "Only step." }, { id: "a9", text: "Last." }] }))[0]!;
  assert.deepEqual(gapped.items.map((i) => i.id), ["a7", "a9"], "the document's own ids, gaps and all");
  const rejected = sections[2]!;
  assert.deepEqual(rejected.items, [{ id: "x1", body: "Do nothing — the cost keeps growing" }], "a rejected alternative reads option — why");
  assert.deepEqual(cardSections(doc({ approach: [], findings: [] })).map((s) => s.kind), ["rejected"], "an empty section is absent");
});

test("no disclosure draws a guide rule, and the alignment disclosures keep their indent", () => {
  assert.match(cardCss, /\.align-section > \.disclosure-body,\n\.align-rev > \.disclosure-body \{[^}]*white-space: normal;/, "alignment sections and revisions wrap normally");
  assert.doesNotMatch(baseCss, /\.disclosure-body \{[^}]*border-left:/, "the base disclosure draws no rule");
  assert.match(baseCss, /\.disclosure-body \{[^}]*padding: var\(--space-2\) 0 var\(--space-2\) var\(--space-4\);/, "the base disclosure keeps its indent");
  assert.match(cardCss, /\.align-approach-list \{[^}]*list-style: none;/, "no list markers on the approach");
  assert.match(cardCss, /\.align-approach-list > li \{[^}]*grid-template-columns: var\(--space-5\) 1fr;/, "the id column, wrapped text aligned");
  assert.match(cardCss, /\.align-approach-text \{[^}]*overflow-wrap: anywhere;/, "the body span wraps inside its column");
  assert.match(cardCss, /\.align-approach-summary \{[^}]*font-size: var\(--fs-heading-s\);[^}]*color: var\(--color-ink\);/, "the heading full-ink at heading size");
  assert.match(cardCss, /\.align-approach-label \{[^}]*font-weight: var\(--fw-semibold\);[^}]*color: var\(--color-ink\);/, "the heading semibold");
});

// ── Technical notes, the writing style and visuals (§chat.alignment/card, §chat.alignment/visuals) ──

test("DOM: technical notes sit right under the approach, closed, in the approach's two columns; none without notes", () => {
  const plain = draw(AlignDocCard, { doc: doc() });
  assert.ok(!plain.includes("Technical notes"), "no section without notes");
  const html = draw(AlignDocCard, { doc: doc({ technical: [{ id: "t1", text: "Lives in `server/export.ts`." }, { id: "t2", text: "Stream it." }], next: { f: 1, a: 2, x: 1, q: 3, t: 2 } }) });
  const at = (needle: string) => html.indexOf(needle);
  assert.ok(at("Technical notes") > at("align-approach"), "after the approach");
  assert.ok(at("Technical notes") < at('<ol class="align-questions"'), "before the questions");
  assert.match(html, /<details class="disclosure align-section align-technical">/, "closed: no open attribute");
  assert.doesNotMatch(html, /<details class="disclosure align-section align-technical"[^>]*\bopen\b/);
  const from = html.indexOf("align-technical");
  const section = html.slice(from, html.indexOf("</details>", from));
  assert.match(section, /Technical notes · <span class="text-num">2<\/span>/);
  assert.match(section, /<ul class="align-list align-approach-list">/, "the approach's two-column list");
  assert.match(section, /<span class="text-mono align-item-id">t1<\/span><span class="align-approach-text">Lives in <code>server\/export\.ts<\/code>\.<\/span>/);
  assert.equal(html.match(/<details class="disclosure align-section">/g)?.length, 2, "findings and rejected still fold below the questions");
});

test("DOM: the meta line says a non-Default style; Default says nothing", () => {
  assert.ok(!draw(AlignDocCard, { doc: doc() }).includes("style</span>"));
  assert.match(draw(AlignDocCard, { doc: doc({ style: "pm" }) }), /<span class="align-doc-style"> · <!--\$-->Project manager style<!--\/-->|<span class="align-doc-style"> · Project manager style/);
  assert.match(draw(AlignDocCard, { doc: doc({ style: "simplified" }) }), /Simplified style/);
});

test("DOM: a visual sits under the summary (the document's) or under the question's context, before its options", () => {
  const visual = { kind: "wireframe", source: "screen: phone" };
  const q = doc().questions[0]!;
  const html = draw(AlignDocCard, { doc: doc({ visual, questions: [{ ...q, context: "Runs cost money.", visual }] }) });
  const first = html.indexOf('class="align-visual"');
  const second = html.indexOf('class="align-visual"', first + 1);
  assert.ok(first > html.indexOf('class="align-doc-summary"') && first < html.indexOf("align-approach"), "the document's under its summary");
  assert.ok(second > html.indexOf('class="align-q-context"') && second < html.indexOf('class="align-q-options"'), "the question's after its context, before its options");
  assert.ok(!draw(AlignDocCard, { doc: doc() }).includes("align-visual"), "none without one");
});
