// Run: pnpm test -- src/lib/design-setup-view.browser.test.ts (Solid's reactive build).
// A Setup card's open rows and its request editor live outside the card: drawn again (it moves down the chat under a
// chat's change), it opens as it was left, with the words being typed and nothing saved until Save.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createRequestEditor, setupOpenState } = await import("./design-setup-view");

/** One drawing of a card: its open state and editor, made the way the card makes them, then thrown away. */
const draw = (key: string, card: { brief: string }, saved: string[], modelsOpen = false) =>
  solid.createRoot((dispose) => {
    const open = setupOpenState(key, modelsOpen);
    const editor = createRequestEditor(() => card.brief, (t) => saved.push(t), open.request);
    return { open, editor, dispose };
  });

test("a card drawn again opens its rows as they were left; where Models starts counts only the first time", () => {
  const first = draw("r1:setup", { brief: "" }, []);
  assert.equal(first.open.models(), false);
  first.open.setModels(true);
  first.open.toggle("claude");
  first.open.toggle("style");
  first.dispose();
  const again = draw("r1:setup", { brief: "" }, []);
  assert.equal(again.open.models(), true);
  assert.deepEqual([...again.open.opened()].sort(), ["claude", "style"]);
  again.open.toggle("claude");
  assert.deepEqual([...again.open.opened()], ["style"]);
  again.dispose();
  // Behind the brief's Change, Models starts open: a key of its own.
  assert.equal(draw("r1:brief", { brief: "" }, [], true).open.models(), true);
  assert.equal(draw("r2:setup", { brief: "" }, []).open.models(), false, "another run starts closed");
});

test("the editor changes nothing until Save; Cancel drops the words", () => {
  const card = { brief: "A landing page" };
  const saved: string[] = [];
  const { editor, dispose } = draw("r3:setup", card, saved);
  assert.equal(editor.text(), null);
  editor.open();
  assert.equal(editor.text(), "A landing page", "opens on the card's request");
  editor.setText("A calmer landing page");
  assert.deepEqual(saved, [], "typing saves nothing");
  editor.cancel();
  assert.equal(editor.text(), null);
  assert.deepEqual(saved, []);
  editor.open();
  assert.equal(editor.text(), "A landing page", "Cancel left the card's words");
  editor.setText("A calmer landing page");
  editor.save();
  assert.deepEqual(saved, ["A calmer landing page"]);
  assert.equal(editor.text(), null);
  editor.open();
  editor.save();
  assert.deepEqual(saved, ["A calmer landing page"], "Save with nothing changed sends nothing");
  editor.setText("closed");
  assert.equal(editor.text(), null, "a closed editor takes no words");
  dispose();
});

test("the words being typed outlast the card being drawn again, and the card's newer request doesn't replace them", () => {
  const card = { brief: "A landing page" };
  const saved: string[] = [];
  const first = draw("r4:setup", card, saved);
  first.editor.open();
  first.editor.setText("A calmer landing");
  first.dispose();
  card.brief = "A landing page, changed by the chat";
  const again = draw("r4:setup", card, saved);
  assert.equal(again.editor.text(), "A calmer landing");
  again.editor.save();
  assert.deepEqual(saved, ["A calmer landing"]);
  again.dispose();
});

// ---- the card's choices: saved whole, the latest change winning, the card showing what the server holds ----

const { createSetupDraft } = await import("./design-setup-view");
type Run = Parameters<typeof createSetupDraft>[0] extends () => infer R ? R : never;
const model = (ref: string, design: boolean) => ({ ref, name: ref, design, coordinator: ref === "a/x", vision: true, route: "tool" as const });
const runAt = (updatedAt: string, designing: string[], brief = "A page"): Run =>
  ({ id: "r9", phase: "setup", labels: [], createdAt: "t0", updatedAt, setup: { brief, models: ["a/x", "a/y", "b/z"].map((r) => model(r, designing.includes(r))), directions: [{ name: "Calm", on: true }] } }) as Run;
const designing = (s: { models: { ref: string; design: boolean }[] }) => s.models.filter((m) => m.design).map((m) => m.ref);
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A store whose saves answer only when the test says, each with the run as the server then holds it. */
function fakeStore() {
  const saves: { sent: Run["setup"]; answer(run: Run): void }[] = [];
  const api = {
    setup: (_id: string, sent: Run["setup"]) => new Promise<unknown>((resolve) => saves.push({ sent, answer: (r) => resolve({ runs: [r] }) })),
  };
  return { saves, store: { api } as unknown as Parameters<typeof createSetupDraft>[1] };
}

test("a chat's change that lands while your click is being saved shows once the save is answered", async () => {
  const [run, setRun] = solid.createSignal(runAt("t1", ["a/x"]));
  const { saves, store } = fakeStore();
  const { setup, dispose } = solid.createRoot((dispose) => ({ setup: createSetupDraft(run, store), dispose }));
  setup.change({ ...setup.draft(), models: setup.draft().models.map((m) => (m.ref === "a/y" ? { ...m, design: true } : m)) });
  await later(350);
  assert.equal(saves.length, 1, "the click is saved");
  // The chat's change is made after the click on the server, and its update arrives before the click's answer.
  setRun(runAt("t3", ["a/x", "a/y", "b/z"]));
  assert.deepEqual(designing(setup.draft()), ["a/x", "a/y"], "an unsaved card isn't replaced");
  saves[0]!.answer(runAt("t2", ["a/x", "a/y"]));
  await later(0);
  assert.deepEqual(designing(setup.draft()), ["a/x", "a/y", "b/z"], "the card shows the chat's later change");
  dispose();
});

test("the save's answer shows before the update that carries it, so the click doesn't flicker back", async () => {
  const [run, setRun] = solid.createSignal(runAt("t1", ["a/x"]));
  const { saves, store } = fakeStore();
  const { setup, dispose } = solid.createRoot((dispose) => ({ setup: createSetupDraft(run, store), dispose }));
  setup.change({ ...setup.draft(), models: setup.draft().models.map((m) => (m.ref === "b/z" ? { ...m, design: true } : m)) });
  const flushed = setup.flush();
  await later(0);
  saves[0]!.answer(runAt("t2", ["a/x", "b/z"]));
  await later(0);
  await flushed;
  assert.deepEqual(designing(setup.draft()), ["a/x", "b/z"]);
  // The update sent before the save (it doesn't hold the click yet) arrives late: the card stays.
  setRun(runAt("t1b", ["a/x"]));
  assert.deepEqual(designing(setup.draft()), ["a/x", "b/z"], "an older update doesn't take the click back");
  setRun(runAt("t2", ["a/x", "b/z"]));
  setRun(runAt("t4", ["a/y"]));
  assert.deepEqual(designing(setup.draft()), ["a/y"], "a newer one does");
  dispose();
});

test("a newer click waiting to be saved is never replaced by an older save's answer", async () => {
  const [run] = solid.createSignal(runAt("t1", ["a/x"]));
  const { saves, store } = fakeStore();
  const { setup, dispose } = solid.createRoot((dispose) => ({ setup: createSetupDraft(run, store), dispose }));
  const tick = (ref: string) => setup.change({ ...setup.draft(), models: setup.draft().models.map((m) => (m.ref === ref ? { ...m, design: true } : m)) });
  tick("a/y");
  await later(350);
  tick("b/z");
  saves[0]!.answer(runAt("t2", ["a/x", "a/y"]));
  await later(0);
  assert.deepEqual(designing(setup.draft()), ["a/x", "a/y", "b/z"], "the newer click stays");
  await later(350);
  assert.deepEqual(designing(saves[1]!.sent), ["a/x", "a/y", "b/z"], "and is saved whole");
  dispose();
});

test("Hide's answer is taken back into the card, so the next save sends the provider's rows unticked", async () => {
  const [run] = solid.createSignal(runAt("t1", ["a/x", "b/z"]));
  const { store } = fakeStore();
  const { setup, dispose } = solid.createRoot((dispose) => ({ setup: createSetupDraft(run, store), dispose }));
  setup.adopt({ runs: [runAt("t2", ["a/x"])] });
  assert.deepEqual(designing(setup.draft()), ["a/x"]);
  setup.adopt({ runs: [runAt("t0", ["a/x", "a/y"])] });
  assert.deepEqual(designing(setup.draft()), ["a/x"], "an answer older than what the card shows doesn't replace it");
  dispose();
});
