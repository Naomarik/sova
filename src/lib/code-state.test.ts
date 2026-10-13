// Run: pnpm test -- src/lib/code-state.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { codeChip, codeFailure, codeView, reloadButton } from "./code-state";

const idle = { running: false, workersWorking: 0 };

test("current says nothing: no chip, no button, no banner", () => {
  const v = codeView({ type: "code", state: "current" });
  assert.equal(v, null);
  assert.equal(codeChip(v), null);
  assert.equal(reloadButton(v, idle), null);
  assert.equal(codeFailure(v), null);
});

test("older: the muted chip and Reload Now", () => {
  const v = codeView({ type: "code", state: "older" });
  assert.deepEqual(v, { state: "older", pending: false });
  assert.equal(codeChip(v)?.label, "On older code");
  assert.equal(codeChip(v)?.title, "This chat keeps the code it started with until its next quiet moment.");
  assert.deepEqual(reloadButton(v, idle), { label: "Reload Now", waiting: false });
  assert.equal(codeFailure(v), null);
});

test("Reload Now pressed during a reply waits, and says for what", () => {
  const v = codeView({ type: "code", state: "older", pending: true });
  assert.deepEqual(reloadButton(v, { running: true, workersWorking: 2 }), { label: "Reloads after this reply", waiting: true });
  assert.deepEqual(reloadButton(v, { running: false, workersWorking: 1 }), { label: "Reloads when its worker finishes", waiting: true });
  assert.deepEqual(reloadButton(v, { running: false, workersWorking: 3 }), { label: "Reloads when its workers finish", waiting: true });
  assert.deepEqual(reloadButton(v, idle), { label: "Reloads after this reply", waiting: true }, "the server's word wins over a stale local idle");
});

test("reloading: the chip says so and nothing can be pressed", () => {
  const v = codeView({ type: "code", state: "reloading" });
  assert.equal(codeChip(v)?.label, "Reloading");
  assert.equal(reloadButton(v, idle), null);
});

test("failed: still on older code, the banner carries the reason, Try Again is the banner's", () => {
  const v = codeView({ type: "code", state: "failed", detail: "The new process exited with code 3 before it was ready." });
  assert.equal(codeChip(v)?.label, "On older code");
  assert.equal(reloadButton(v, idle), null);
  assert.deepEqual(codeFailure(v), {
    title: "Couldn't start this chat on new code.",
    body: "It keeps running on older code. The new process exited with code 3 before it was ready.",
  });
  assert.equal(codeFailure(codeView({ type: "code", state: "failed" }))?.body, "It keeps running on older code.");
});
