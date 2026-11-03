// A view's code file that can't be loaded, told apart where it is loaded (lib/module-load.ts): whatever
// the browser's words for it, never by reading them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isModuleLoadError, loadsModule, ModuleLoadError } from "./module-load";

/** The words each browser rejects a dynamic import of a missing file with. */
const WORDINGS = [
  "Failed to fetch dynamically imported module: http://sova.test/assets/TranscriptCard-abc.js", // Chrome
  "error loading dynamically imported module: http://sova.test/assets/TranscriptCard-abc.js", // Firefox
  "Importing a module script failed.", // Safari
];

test("a code file that can't be loaded is told apart, in every browser's words", async () => {
  for (const words of WORDINGS) {
    const cause = new TypeError(words);
    const err = await loadsModule(() => Promise.reject(cause))().then(
      () => assert.fail("loaded"),
      (e: unknown) => e,
    );
    assert.equal(isModuleLoadError(err), true, words);
    assert.ok(err instanceof ModuleLoadError);
    assert.equal((err as ModuleLoadError).cause, cause, "it keeps the browser's own error");
    assert.equal((err as Error).message, words, "the box still says why");
  }
});

test("any other failure is not a code file that couldn't be loaded, whatever its words", () => {
  for (const words of [...WORDINGS, "it failed while drawing"]) assert.equal(isModuleLoadError(new TypeError(words)), false, words);
  assert.equal(isModuleLoadError("Failed to fetch dynamically imported module"), false);
  assert.equal(isModuleLoadError(undefined), false);
});

test("a module that loads is handed over as is", async () => {
  const mod = { default: () => null };
  assert.equal(await loadsModule(() => Promise.resolve(mod))(), mod);
});
