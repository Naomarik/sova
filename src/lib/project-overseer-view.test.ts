import assert from "node:assert/strict";
import { test } from "node:test";
import type { IdeaRecord } from "../../shared/protocol";
import { actionLine, gapArea, itemSendInput, openIdeas, tokens, toolWords } from "./project-overseer-view";

const idea = (id: string, status: IdeaRecord["status"], tags: string[] = []): IdeaRecord => ({
  id,
  ns: "gap",
  title: id,
  status,
  tags,
  links: [],
  createdAt: "",
  updatedAt: "",
}) as unknown as IdeaRecord;

test("open ideas: gaps first, settled ones gone, order otherwise kept", () => {
  const out = openIdeas([idea("a", "open"), idea("b", "done", ["gap"]), idea("c", "exploring", ["gap"]), idea("d", "dropped"), idea("e", "started")]);
  assert.deepEqual(out.map((i) => i.id), ["c", "a", "e"]);
});

test("a gap's area comes from its area- tag", () => {
  assert.equal(gapArea({ tags: ["gap", "area-invoicing"] }), "invoicing");
  assert.equal(gapArea({ tags: ["gap"] }), null);
  assert.equal(gapArea({ tags: ["area-"] }), null);
});

test("an act reads as words; a refusal carries its reason", () => {
  assert.equal(toolWords("sova_start_gathering"), "start gathering");
  assert.equal(actionLine({ tool: "sova_promote", outcome: "ok" }), "promote");
  assert.equal(actionLine({ tool: "sova_promote", outcome: "refused", error: "Autonomy L1 doesn't promote." }), "promote: refused (Autonomy L1 doesn't promote)");
  assert.equal(actionLine({ tool: "sova_offer", outcome: "error" }), "offer: failed");
});

test("token figures", () => {
  assert.deepEqual([0, 950, 1234, 12_345, 999_999, 1_250_000].map(tokens), ["0", "950", "1.2k", "12k", "1.0M", "1.3M"]);
});

test("Send to Person… never takes the public title or question from the item; nothing typed, no request", () => {
  const ref = { ideaId: "§gap/automation-policy" };
  assert.equal(itemSendInput(ref, { to: ["p_1"], publicTitle: "   ", question: "Who approves?" }), null, "no title: the server would fall back to the item");
  assert.equal(itemSendInput(ref, { to: ["p_1"], publicTitle: "Bank payments", question: "  " }), null, "no question: same");
  assert.equal(itemSendInput(ref, { to: [], publicTitle: "Bank payments", question: "Who approves?" }), null, "nobody picked");
  const one = itemSendInput(ref, { to: ["p_1"], publicTitle: " Bank payments ", question: " Who approves? " })!;
  assert.deepEqual(one, { ideaId: "§gap/automation-policy", to: "p_1", publicTitle: "Bank payments", question: "Who approves?" });
  const offer = itemSendInput({ todoId: "td_1" }, { to: ["p_1", "p_2"], publicTitle: "A question", question: "Who approves?" })!;
  assert.deepEqual(offer, { todoId: "td_1", to: ["p_1", "p_2"], publicTitle: "A question", question: "Who approves?" });
});
