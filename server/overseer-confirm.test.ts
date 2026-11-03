// The card's items as the host resolves them (§app.overseer/confirm, §app.overseer/card-sections).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../shared/protocol";
import { applyCardCall, CardError } from "../shared/overseer-card";
import { resolveConfirmItems, type ConfirmLookup } from "./overseer-confirm";

const lookup: ConfirmLookup = {
  session: async (ref) => (ref.startsWith("s") ? ({ id: ref, path: `/s/${ref}.jsonl`, title: `Session ${ref}` } as SessionSummary) : null),
  isSelf: () => false,
  idea: () => null,
  todo: (ref) => (ref.startsWith("td_") ? { id: ref, text: `Do ${ref}` } : null),
};
const refusal = (m: string) => new Error(m);

test("an entry's section and sends reach the card as written, and the card checks them", async () => {
  const items = await resolveConfirmItems(
    { sessions: [{ id: "s1", note: "Ready.", section: "Ready to land", sends: "Rebase on master and run the checks.", default: "a" }, "s2"], todos: [{ id: "td_1", section: "Done" }] },
    lookup,
    refusal,
  );
  assert.deepEqual(
    items.map((it) => [it.id, it.section ?? null, it.sends ?? null]),
    [
      ["s1", "Ready to land", "Rebase on master and run the checks."],
      ["s2", null, null],
      ["td_1", "Done", null],
    ],
  );
  const card = applyCardCall([], { ops: [{ op: "create", title: "t", choices: ["Go", "Not Yet"] }] }, { now: "2026-10-27T10:00:00.000Z", prepared: { items, hrefs: [] } }).details.card!;
  assert.deepEqual(card.items.map((it) => `${it.n}:${it.id}`), ["1:s2", "2:s1", "3:td_1"], "unsectioned first, then the sections as they first appear");
  // A section given as something other than text reaches the card model, which refuses it.
  const bad = await resolveConfirmItems({ sessions: [{ id: "s1", section: 4 }] }, lookup, refusal);
  assert.throws(() => applyCardCall([], { ops: [{ op: "create", title: "t", choices: ["Go", "Not Yet"] }] }, { now: "2026-10-27T10:00:00.000Z", prepared: { items: bad, hrefs: [] } }), CardError);
});
