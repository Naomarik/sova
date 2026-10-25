// Run: pnpm test -- src/lib/built-once.browser.test.ts (Solid's reactive build).
// A project's Done tail builds its rows only once it is open (§app.session-list/content-rules): a
// project whose folder holds hundreds of finished sessions costs its Done head alone until opened.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { builtOnceOpen } = await import("./built-once");

test("rows are not built while the list has never been open", () => {
  solid.createRoot((dispose) => {
    const [open] = solid.createSignal(false);
    const built = builtOnceOpen(open);
    assert.equal(built(), false);
    dispose();
  });
});

test("the first open builds the rows, and closing again keeps them", () => {
  solid.createRoot((dispose) => {
    const [open, setOpen] = solid.createSignal(false);
    const built = builtOnceOpen(open);
    setOpen(true);
    assert.equal(built(), true);
    setOpen(false);
    assert.equal(built(), true, "a closed list keeps the rows it built");
    dispose();
  });
});

test("a list open from the start (a search, the open session inside) is built at once", () => {
  solid.createRoot((dispose) => {
    const built = builtOnceOpen(() => true);
    assert.equal(built(), true);
    dispose();
  });
});
