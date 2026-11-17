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
