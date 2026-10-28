// Run: pnpm test -- src/lib/align-question-dom.test.ts
// The alignment card's questions draw exactly as they did before their options and recommendation
// became the shared question layout the question data card also draws with
// (§chat.transcript-cards/data-cards: "drawn by the same code"; §chat.alignment/card unchanged).
// Each case renders a whole card with Solid's SSR build (src/lib/align-card-ssr.mjs), read-only and
// answerable (picks, a tick, a block), and is compared with align-question-dom.snapshot.json, taken
// before the change. Hydration keys and marker comments are left out. Regenerate only for a change
// you mean: WRITE_ALIGN_Q_SNAPSHOT=1 pnpm test -- src/lib/align-question-dom.test.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { AlignAnswerContext, AlignDocCard } = await importSsr(new URL("../components/AlignDocCard.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
type AlignDocInfo = import("../../shared/protocol").AlignDocInfo;

const SNAPSHOT = new URL("./align-question-dom.snapshot.json", import.meta.url);
const AT = "2026-02-01T00:00:00.000Z";

const doc: AlignDocInfo = {
  id: "al_1",
  title: "Autonomy settings",
  summary: "How far the Overseer may act.",
  findings: [],
  approach: [{ id: "a1", text: "Measure first." }],
  rejected: [],
  questions: [
    {
      id: "q1",
      topic: "Pace limit",
      ask: "How often may it start a run **on its own**?",
      context: "Runs cost `money`.",
      options: [
        { label: "1 per 10 min", tradeoff: "a tight leash" },
        { label: "1 per hour", tradeoff: "looser" },
        { label: "Never", tradeoff: "safe" },
      ],
      recommendation: { choice: "1 per hour", why: "enough for a small project" },
    },
    { id: "q2", topic: "Free text", ask: "What name?", recommendation: { choice: "Sova", why: "short" } },
    {
      id: "q3",
      topic: "Decided one",
      ask: "Which?",
      options: [{ label: "A", tradeoff: "x" }, { label: "B", tradeoff: "y" }],
      recommendation: { choice: "B — because", why: "w" },
      decision: { text: "B", by: "user", at: AT },
    },
    { id: "q4", topic: "Dropped one", ask: "Why?", recommendation: { choice: "No", why: "w" }, dropped: { why: "moot", at: AT } },
    { id: "q5", topic: "No match", ask: "?", options: [{ label: "X", tradeoff: "" }, { label: "Y", tradeoff: "" }], recommendation: { choice: "Z", why: "w" } },
  ],
  phase: "open",
  next: { f: 1, a: 2, x: 1, q: 6 },
  rev: 2,
  createdAt: AT,
  updatedAt: AT,
} as AlignDocInfo;

const answer = (blocked: string | null) => ({
  on: () => true,
  current: () => doc,
  picked: (_d: string, q: string) => q === "q2",
  toggle() {},
  pickedOption: (_d: string, q: string) => (q === "q1" ? 2 : q === "q5" ? 0 : undefined),
  pick() {},
  tickBlocked: () => blocked,
  goBlocked: () => null,
  goWithRecommendations() {},
});

const draw = (ctx: unknown): string =>
  renderToString(() =>
    solid.createComponent(AlignAnswerContext.Provider, {
      value: ctx,
      get children() {
        return solid.createComponent(AlignDocCard as never, { doc } as never);
      },
    }),
  )
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "")
    .replace(/align-(doc|q)-\d+/g, "align-$1-N");

const drawn: Record<string, string> = {
  "read-only": draw(null),
  "answerable, with picks and a tick": draw(answer(null)),
  "answerable, ticking blocked": draw(answer("This chat is archived.")),
};

if (process.env.WRITE_ALIGN_Q_SNAPSHOT === "1") writeFileSync(SNAPSHOT, `${JSON.stringify(drawn, null, 2)}\n`);

test("the alignment card's questions draw the markup they drew before the shared question layout", () => {
  assert.ok(existsSync(SNAPSHOT), "the snapshot is missing");
  const before = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(drawn).sort(), Object.keys(before).sort());
  for (const [name, html] of Object.entries(drawn)) assert.equal(html, before[name], name);
});

test("the cases draw what they say, so the comparison can't pass on cards that drew nothing", () => {
  assert.doesNotMatch(drawn["read-only"]!, /type="radio"/);
  assert.match(drawn["answerable, with picks and a tick"]!, /type="radio"/);
  assert.match(drawn["answerable, ticking blocked"]!, /title="This chat is archived\."/);
});
