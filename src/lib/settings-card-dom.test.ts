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
  assert.match(held, /Waiting to save/);
  assert.doesNotMatch(held, />\s*Apply\s*</);
  const ready = draw(card({ id: "sc_4", kind: "queue" }), "p1");
  assert.match(ready, /Apply/);
  assert.doesNotMatch(ready, /Cancel Save/);
});

test("a held card says what holds it, in the server's words", () => {
  const words = "Saves once release v1.2.0 is published or abandoned.";
  const held = draw(card({ id: "sc_5", saveWaits: true, saveWords: words }), "p1");
  assert.ok(held.includes(words));
  assert.ok(!held.includes(QUEUE_CARD_WAITS), "never says a branch holds it during a release");
  assert.doesNotMatch(held, /a branch/);
  assert.ok(draw(card({ id: "sc_5", saveWaits: true, saveWords: words }), "p1", false).includes(words), "where nobody may act too");
});

test("a failed held card's button says what it does", () => {
  const why = "It changed: dismiss it and ask for a new card. Nothing was saved.";
  const failed = (over: Record<string, unknown>) => draw(card({ saveWaits: true, saveFailed: why, ...over }), "p1");
  assert.match(failed({ id: "sc_5" }), />\s*(<!--[^>]*-->)?\s*Dismiss/);
  assert.doesNotMatch(failed({ id: "sc_5" }), /Cancel Save/);
  assert.match(failed({ id: "sc_5", kind: "queue" }), /Cancel Save/, "a queue card cancels the queue's kept save");
  assert.match(failed({ id: "local" }), /Cancel Save/, "the folder's edits stay, so it isn't a dismissal");
});

test("a project card, and the folder's edits, hold the same way", () => {
  for (const c of [card({ id: "sc_5", saveWaits: true }), card({ id: "local", saveWaits: true })]) {
    const held = draw(c, "p1");
    assert.ok(held.includes(QUEUE_CARD_WAITS));
    assert.match(held, /Cancel Save/);
    assert.doesNotMatch(held, /Discard Edits|Land Edits|>\s*Apply\s*</, "no other button while it holds");
  }
});

test("a grant that wasn't recorded reads as still needed, each with where to approve it", () => {
  const applied = draw(card({ id: "sc_6", state: "applied", stillNeeds: ["Schedule weekly still needs approving, in the Playbooks dialog."] }), "p1");
  assert.match(applied, /banner-warn/);
  assert.match(applied, /Schedule weekly still needs approving, in the Playbooks dialog\./);
  assert.doesNotMatch(draw(card({ id: "sc_6", state: "applied" }), "p1"), /banner-warn/, "nothing when all were recorded");
});

test("every computer's access is listed, the changed row marked and a shell-level one said plainly", () => {
  const html = draw(
    card({
      kind: "sova",
      access: [
        { peer: "a", label: "Laptop", before: "sessions: presence", after: "sessions: presence, shell", changed: true, shell: true },
        { peer: "b", label: "Desktop", before: "sessions: presence", after: "sessions: presence", changed: false, shell: false },
      ],
    }),
    null,
  );
  assert.match(html, /Every computer(&#39;|')s access after this/);
  assert.match(html, /Laptop/);
  assert.match(html, /Desktop/);
  assert.equal(html.match(/data-access-changed/g)?.length, 1, "only the row that changes");
  assert.equal(html.match(/Shell-level: it can run anything here\./g)?.length, 1, "only the row that is shell-level");
});

test("a card's field: Apply waits for it, nothing fills it in, and it shows only where Apply does", () => {
  const pairing = card({ kind: "sova", input: { field: "pin", label: "The other computer's fingerprint" } });
  const html = draw(pairing, null);
  assert.match(html, /The other computer(&#39;|')s fingerprint/);
  assert.match(html, /autocomplete="off"/);
  assert.match(html, /<button[^>]*button-primary[^>]*disabled[^>]*>/, "Apply is held back while it's empty");
  assert.match(html, /Open Mesh Page/);
  assert.match(html, /href="#\/mesh"/);
  assert.doesNotMatch(draw(pairing, null, false), /<input/, "no field where nobody may apply");
  assert.doesNotMatch(draw({ ...pairing, state: "applied" }, null), /<input/, "no field once it has ended");
  assert.doesNotMatch(draw(card({ kind: "sova" }), null), /<input|<button[^>]*button-primary[^>]*disabled/, "a card without one: Apply stands ready");
});

test("a card's notes stand before Apply, as given, and go when it ends", () => {
  const notes = ["Resync copies this computer's settings to Laptop."];
  const html = draw(card({ kind: "sova", notes }), null);
  assert.ok(html.indexOf(notes[0]!.replace("'", "&#39;")) >= 0 || html.includes(notes[0]!));
  assert.doesNotMatch(draw(card({ kind: "sova", state: "applied", notes }), null), /Resync copies/);
});

test("a save that failed when its turn came says why on the card", () => {
  const failed = draw(card({ id: "sc_4", kind: "queue", saveWaits: true, saveFailed: "A newer save took its place." }), "p1");
  assert.match(failed, /A newer save took its place/);
  assert.match(failed, /Save failed/);
  assert.match(failed, /Cancel Save/);
  assert.ok(!failed.includes(QUEUE_CARD_WAITS), "it no longer waits for a branch");
});
