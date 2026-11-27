// The Transport dialog's error banner (§app.transport/dialog): only a failed start says "Nothing was sent."; a refused
// Retry, Cancel or Interrupt shows the server's reason alone, so a Cancel refused while the chat opens there never
// reads as nothing having been sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type TransportErrorFrom, transportErrorBanner } from "./transport-dialog-error";

const opening = "It is opening on Laptop right now, so it can't be cancelled; it arrives in a moment.";

test("a failed start says nothing was sent, above its reason", () => {
  assert.deepEqual(transportErrorBanner("start", "Laptop is offline."), { title: "Nothing was sent.", body: "Laptop is offline." });
});

test("a refused action shows its reason as the one line, never 'Nothing was sent.'", () => {
  for (const from of ["retry", "cancel", "interrupt"] as TransportErrorFrom[]) {
    const b = transportErrorBanner(from, opening);
    assert.equal(b.title, opening, from);
    assert.equal(b.body, undefined, from);
    assert.ok(!JSON.stringify(b).includes("Nothing was sent"), from);
  }
});
