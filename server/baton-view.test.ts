// Run: pnpm exec tsx --test server/baton-view.test.ts. Pure: no files, no agent dir.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BATON_DECISION_ENTRY, BATON_DONE_ENTRY, BATON_ENTRY, BATON_HANDOFF_ENTRY, BATON_SENT_ENTRY } from "../shared/baton";
import { OVERSEER_SENT_ENTRY } from "../shared/protocol";
import { batonView, redactPhrases } from "./baton-view";

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

test("a briefing is shown only to its addressee (and in the operator's replay)", () => {
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
