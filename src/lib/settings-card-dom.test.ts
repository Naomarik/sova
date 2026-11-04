// Run: pnpm test -- src/lib/settings-card-dom.test.ts
// What a Create chat's Settings change card draws (§chat.create-mode/settings-cards): a Sova-wide
// card says where it lands, the sync note included, and has the card's buttons only where this view
// may act; a queue card whose Save waits says so and offers Cancel Save in place of Apply.
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const { renderToString } = await import("solid-js/web");
const { SettingsCard, QUEUE_CARD_WAITS } = await importSsr(new URL("../components/SettingsChangeCard.tsx", import.meta.url), (s: string) => import.meta.resolve(s));

const card = (over: Record<string, unknown>) => ({
  id: "sw_1",
  state: "waiting",
  title: "Let worker priority follow the machine",
  why: "",
  by: { kind: "create", chat: "s1", via: "tool" },
  createdAt: "2026-02-01T10:00:00.000Z",
  kept: [{ field: "workerPriority", label: "Worker priority", from: "normal", to: "low", fromText: "Normal", toText: "Low" }],
  files: [],
  grants: [],
  lands: null,
  diff: "",
  fingerprint: "fp",
  ...over,
});
const draw = (c: unknown, projectId: string | null, canAct = true) => renderToString(() => SettingsCard({ projectId, card: c, canAct }));

test("a Sova-wide card names its place, and the sync note when it spreads, as given", () => {
  assert.match(draw(card({ kind: "sova", place: "Sova-wide" }), null), /Where it lands[\s\S]*Sova-wide/);
  assert.match(draw(card({ kind: "sova", place: "Sova-wide, and your other computers by sync" }), null), /your other computers by sync/);
  assert.doesNotMatch(draw(card({}), "p1"), /Where it lands/, "a project's card has no place line");
});

test("a queue card heads its rows as the merge queue and says where it lands", () => {
  const queue = draw(card({ id: "sc_4", kind: "queue", place: ".sova/project.json on main" }), "p1");
  assert.match(queue, /Merge queue/);
  assert.doesNotMatch(queue, /Sova(&#39;|')s settings/);
  assert.match(queue, /Where it lands[\s\S]*\.sova\/project\.json on main/);
  assert.match(draw(card({}), "p1"), /Sova(&#39;|')s settings/, "a project's own card keeps its heading");
});

test("a card nobody here may act on points at where it can be applied, and never offers Apply", () => {
  const sova = draw(card({ kind: "sova", place: "Sova-wide" }), null, false);
  assert.doesNotMatch(sova, /<button[^>]*>\s*(<!--[^>]*-->)?\s*Apply/);
  assert.match(sova, /chat that prepared it/);
  assert.doesNotMatch(sova, /project(&#39;|')s Settings tab/, "a Sova-wide card has no project page");
});

test("a queue card whose Save waits has Cancel Save in place of Apply", () => {
  const held = draw(card({ id: "sc_4", kind: "queue", saveWaits: true }), "p1");
  assert.ok(held.includes(QUEUE_CARD_WAITS));
  assert.match(held, /Cancel Save/);
  assert.match(held, /Waiting for a branch/);
  assert.doesNotMatch(held, />\s*Apply\s*</);
  const ready = draw(card({ id: "sc_4", kind: "queue" }), "p1");
  assert.match(ready, /Apply/);
  assert.doesNotMatch(ready, /Cancel Save/);
});

test("a project card, and the folder's edits, hold the same way", () => {
  for (const c of [card({ id: "sc_5", saveWaits: true }), card({ id: "local", saveWaits: true })]) {
    const held = draw(c, "p1");
    assert.ok(held.includes(QUEUE_CARD_WAITS));
    assert.match(held, /Cancel Save/);
    assert.doesNotMatch(held, /Discard Edits|Land Edits|>\s*Apply\s*</, "no other button while it holds");
  }
});

test("a save that failed when its turn came says why on the card", () => {
  const failed = draw(card({ id: "sc_4", kind: "queue", saveWaits: true, saveFailed: "A newer save took its place." }), "p1");
  assert.match(failed, /A newer save took its place/);
  assert.match(failed, /Save failed/);
  assert.match(failed, /Cancel Save/);
  assert.ok(!failed.includes(QUEUE_CARD_WAITS), "it no longer waits for a branch");
});
