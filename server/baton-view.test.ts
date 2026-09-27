// Run: pnpm exec tsx --test server/baton-view.test.ts. Pure: no files, no agent dir.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BATON_DECISION_ENTRY, BATON_DONE_ENTRY, BATON_ENTRY, BATON_HANDOFF_ENTRY, BATON_OFFER_ENTRY, BATON_SENT_ENTRY, BATON_WRAPUP_ENTRY } from "../shared/baton";
import { OVERSEER_SENT_ENTRY } from "../shared/protocol";
import { authorNotes, batonView, labelAuthors, redactPhrases } from "./baton-view";

const names = { operator: "Omar", p_t: "Tony", p_m: "Maria" };
const custom = (id: string, customType: string, data: unknown) => ({ type: "custom", id, customType, data });
const msg = (id: string, role: string, content: unknown) => ({ type: "message", id, timestamp: "2026-09-26T10:00:00.000Z", message: { role, content } });

/** Every entry shape a baton file can hold, and several it never should. */
const BRANCH = [
  { type: "session", id: "h", cwd: "/secret/cwd" },
  custom("c0", BATON_ENTRY, { v: 1, orgId: "org_x", projectId: "prj_x" }),
  custom("c1", BATON_HANDOFF_ENTRY, { v: 1, n: 1, from: "operator", to: "p_t", question: "Where to host?", briefing: "" }),
  msg("s0", "system", "SYSTEM PROMPT with the goal SECRET-GOAL"),
  { type: "model_change", id: "mc", provider: "zai", modelId: "glm-5.3" },
  { type: "thinking_level_change", id: "tl", thinkingLevel: "low" },
  msg("u1", "user", [{ type: "text", text: "On srv-01." }, { type: "image", data: "AAA", mimeType: "image/png" }]),
  custom("m1", BATON_SENT_ENTRY, { v: 1, targetId: "u1", by: "p_t" }),
  msg("a1", "assistant", [
    { type: "thinking", thinking: "THINKING: the voice says be terse" },
    { type: "text", text: "Thanks Tony." },
    { type: "toolCall", id: "tc1", name: "hand_to", arguments: { person: "Maria" } },
  ]),
  custom("d1", BATON_DECISION_ENTRY, { v: 1, area: "hosting", statement: "srv-01", quote: "On srv-01.", by: "p_t" }),
  custom("c2", BATON_HANDOFF_ENTRY, { v: 1, n: 2, from: "p_t", to: "p_m", question: "Export format?", briefing: "BRIEF-FOR-MARIA" }),
  msg("r1", "toolResult", [{ type: "text", text: "TOOL RESULT" }]),
  { type: "custom_message", id: "cm", customType: "subagent-complete", content: "REPORT", display: true },
  { type: "compaction", id: "cp", summary: "COMPACTION SUMMARY" },
  { type: "usage", id: "us" },
  custom("x1", OVERSEER_SENT_ENTRY, { v: 1, targetId: "u1" }),
  custom("x2", "mode", { mode: "delegate" }),
  msg("u2", "user", "Excel please. Omar decides bonuses."),
  custom("m2", BATON_SENT_ENTRY, { v: 1, targetId: "u2", by: "p_m" }),
  msg("u3", "user", "Yes, include bonuses."),
  custom("m3", BATON_SENT_ENTRY, { v: 1, targetId: "u3", by: "operator" }),
  custom("f1", BATON_DONE_ENTRY, { v: 1, summary: "srv-01, Excel with bonuses" }),
];

const view = (viewer?: string, redact = (t: string) => t) =>
  batonView({ row: { publicTitle: "Portal", state: "done", holder: null }, branch: BRANCH, names, ...(viewer ? { viewer } : {}), redact });

test("only messages, reply text and the three cards survive, in order", () => {
  const v = view("p_t");
  assert.deepEqual(
    v.items.map((i) => `${i.kind}:${i.id}`),
    ["handoff:c1", "message:u1", "reply:a1", "decision:d1", "handoff:c2", "message:u2", "message:u3", "done:f1"],
  );
  const text = JSON.stringify(v);
  for (const leak of ["SECRET-GOAL", "THINKING", "TOOL RESULT", "REPORT", "COMPACTION", "glm-5.3", "/secret/cwd", "org_x", "prj_x", "hand_to", "AAA"])
    assert.ok(!text.includes(leak), `never shown: ${leak}`);
});

test("every message carries its sender's name; the operator's messages are kept", () => {
  const v = view("p_t");
  assert.deepEqual(
    v.items.filter((i) => i.kind === "message").map((i) => (i.kind === "message" ? `${i.name}: ${i.text}` : "")),
    ["Tony: On srv-01.", "Maria: Excel please. Omar decides bonuses.", "Omar: Yes, include bonuses."],
  );
});

test("a briefing is shown only to its addressee (and in the view with no viewer)", () => {
  const brief = (viewer?: string) => view(viewer).items.find((i) => i.kind === "handoff" && i.n === 2);
  assert.equal((brief("p_t") as { briefing?: string }).briefing, undefined);
  assert.equal((brief("p_m") as { briefing?: string }).briefing, "BRIEF-FOR-MARIA");
  assert.equal((brief(undefined) as { briefing?: string }).briefing, "BRIEF-FOR-MARIA");
});

test("every string goes through the redactor", () => {
  const v = view("p_t", (t) => redactPhrases(t, ["srv-01"]));
  assert.ok(!JSON.stringify(v).includes("srv-01"));
  assert.equal(redactPhrases("Be Direct And Technical here", ["direct and technical"]), "Be [redacted] here");
  assert.equal(redactPhrases("a.b(c)", ["b(c"]), "a.[redacted])");
});

test("a message whose sender marker hasn't landed yet is the holder's only when it is the last one", () => {
  const branch = [msg("u1", "user", "first"), msg("u2", "user", "second")];
  const v = batonView({ row: { publicTitle: "T", state: "open", holder: "p_m" }, branch, names, viewer: "p_m", redact: (t) => t });
  assert.deepEqual(
    v.items.map((i) => (i.kind === "message" ? i.name : "")),
    ["Someone", "Maria"],
  );
});

/** A model context as pi builds it from `branch`: the user and assistant messages, timestamps kept. */
const contextOf = (branch: any[]) => branch.filter((e) => e.type === "message" && e.message.role !== "system").map((e) => structuredClone(e.message));
const at = (e: any, timestamp: number) => ((e.message.timestamp = timestamp), e);
const texts = (messages: any[]) => messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((b: any) => b.text ?? "").join("")));

test("the model's context: each person's message opens with its own author, and the moves since the one before", () => {
  const branch = BRANCH.map((e: any) => (e.type === "message" ? at(structuredClone(e), Number(e.id.replace(/\D/g, "") || 0) + 1) : e));
  const labelled = labelAuthors(contextOf(branch), authorNotes(branch, names, null));
  assert.deepEqual(texts(labelled), [
    "[The conversation passed from Omar (the operator) to Tony]\n[From Tony]\nOn srv-01.",
    "[The conversation passed from Tony to Maria]\n[From Maria]\nExcel please. Omar decides bonuses.",
    "[From Omar (the operator)]\nYes, include bonuses.",
  ]);
  // Tony's words are never Maria's and hers never his (a label that only named the holder would fail here).
  assert.doesNotMatch(texts(labelled)[0]!, /Maria/);
  assert.doesNotMatch(texts(labelled)[1]!, /From Tony/);
  const image = labelled.find((m: any) => m.role === "user")!.content as any[];
  assert.equal(image.at(-1).type, "image", "the person's own blocks are kept, after the label");
  assert.ok(labelled.filter((m: any) => m.role === "assistant").every((m: any, i: number) => m === labelled.filter((x: any) => x.role === "assistant")[i]));
});

test("labels are the markers' (one rule with the views): the unmarked last message is the holder's; an earlier one is someone's", () => {
  const branch = [at(msg("u1", "user", "first"), 1), at(msg("u2", "user", "second"), 2)];
  assert.deepEqual(texts(labelAuthors(contextOf(branch), authorNotes(branch, names, "p_m"))), ["[From someone]\nfirst", "[From Maria]\nsecond"]);
});

test("an offer is a line; the wrap-up's prompt and anything after its marker carry no author", () => {
  const branch = [
    custom("o1", BATON_OFFER_ENTRY, { v: 1, n: 1, offerId: "of", from: "operator", to: ["p_t", "p_m"], question: "Q?", briefing: "B" }),
    at(msg("u1", "user", "mine"), 1),
    custom("m1", BATON_SENT_ENTRY, { v: 1, targetId: "u1", by: "p_m" }),
    custom("w1", BATON_WRAPUP_ENTRY, { v: 1, phase: "start" }),
    at(msg("u2", "user", "[Wrap-up] record profiles"), 2),
  ];
  assert.deepEqual(texts(labelAuthors(contextOf(branch), authorNotes(branch, names, "p_m"))), [
    "[Omar (the operator) offered the conversation to Tony, Maria]\n[From Maria]\nmine",
    "[Wrap-up] record profiles",
  ]);
});

test("a message is found by its timestamp and text, in branch order, and matched on the context before redaction", () => {
  // The same words twice, by two people; a context that starts later (a compaction dropped the first).
  const branch = [
    at(msg("u1", "user", "ok"), 1),
    custom("m1", BATON_SENT_ENTRY, { v: 1, targetId: "u1", by: "p_t" }),
    at(msg("u2", "user", "ok sk-SECRET"), 2),
    custom("m2", BATON_SENT_ENTRY, { v: 1, targetId: "u2", by: "p_m" }),
  ];
  const original = contextOf(branch).slice(1);
  const redacted = original.map((m: any) => ({ ...m, content: "ok [redacted]" }));
  const out = labelAuthors(redacted, authorNotes(branch, names, null), original);
  assert.deepEqual(texts(out), ["[From Maria]\nok [redacted]"]);
  const none = [{ role: "user", content: "not on the branch", timestamp: 9 }];
  assert.equal(labelAuthors(none, authorNotes(branch, names, null)), none, "nothing labelled: the same array");
});
