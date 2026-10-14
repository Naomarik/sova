// Run: pnpm test -- server/ws.test.ts. The chat socket's own decisions (server/ws.ts) that need no
// socket: which `?have=` it takes (§chat.transcript/instant-open), and what a pane that sent while
// its chat was opening is told when the chat doesn't open.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HAVE_MAX_CHARS } from "../shared/protocol";

const { haveOf, heldRefusals } = await import("./ws");

test("haveOf: only on a `?tail=rest` socket, never empty or longer than HAVE_MAX_CHARS", () => {
  const pull = { tail: true as const, pull: true as const, prefetch: false };
  assert.equal(haveOf(new URLSearchParams("have=a1%3A0"), pull), "a1:0");
  assert.equal(haveOf(new URLSearchParams("have="), pull), undefined);
  assert.equal(haveOf(new URLSearchParams(""), pull), undefined);
  assert.equal(haveOf(new URLSearchParams(`have=${"x".repeat(HAVE_MAX_CHARS + 1)}`), pull), undefined);
  assert.equal(haveOf(new URLSearchParams("have=a1"), { tail: true, pull: false }), undefined);
  assert.equal(haveOf(new URLSearchParams("have=a1"), { tail: false }), undefined);
});

test("heldRefusals: each prompt and steer the pane sent while its chat was opening is refused back to it, by its id", () => {
  const out = heldRefusals([
    { type: "prompt", text: "first", clientId: "c1" },
    { type: "abort" },
    { type: "steer", text: "second", clientId: "c2" },
    { type: "prompt", text: "no id" },
  ]);
  assert.deepEqual(
    out.map((m) => (m.type === "error" ? [m.code, (m as { clientId?: string }).clientId] : m.type)),
    [["refused", "c1"], ["refused", "c2"], ["refused", undefined]],
  );
});
