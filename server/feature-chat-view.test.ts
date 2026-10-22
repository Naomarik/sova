// Run: pnpm test -- server/feature-chat-view.test.ts. Pure: no files, no agent dir. A feature request chat's plan card
// on the owner page (§app.baton/outsider-view, §app.project-assistant/feature-chats): the one tool result that crosses,
// built field by field; never its technical notes, never the call, never another tool's result; its drawings through
// the markup backstop; only in a feature request chat.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BATON_HANDOFF_ENTRY } from "../shared/baton";
import { batonView, markupBackstop, redactPhrases } from "./baton-view";
import { historyOf } from "./harness/pi/reader";

const names = { operator: "Omar", p_o: "Alperen" };
const custom = (id: string, customType: string, data: unknown) => ({ type: "custom", id, customType, data });
const at = "2026-10-22T10:00:00.000Z";
const msg = (id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) => ({ type: "message", id, timestamp: at, message: { role, content, ...extra } });

const MARK = { tech: "TECH-MARK-4471", tool: "TOOL-ARG-MARK-1290", other: "OTHER-RESULT-MARK-3388", phrase: "Falcon Ridge Holdings" };

const doc = (rev: number, extra: Record<string, unknown> = {}) => ({
  id: "al_1",
  title: "Online booking",
  summary: "Book a class from the website.",
  findings: [{ id: "f1", text: "Classes are listed on the schedule page today." }],
  approach: [{ id: "a1", text: "Add a Book button to each class." }],
  rejected: [{ id: "x1", option: "Phone bookings only", why: "Too slow." }],
  technical: [{ id: "t1", text: `server/routes/booking.ts ${MARK.tech}` }],
  questions: [
    {
      id: "q1",
      topic: "Who can book",
      ask: "Who can book a class?",
      options: [
        { label: "Anyone", tradeoff: "More bookings." },
        { label: "Members only", tradeoff: "Fewer no-shows." },
      ],
      recommendation: { choice: "Anyone", why: "Simplest to start." },
      // Entity-encoded: the plain pass misses it, the markup backstop doesn't.
      visual: { kind: "html", source: `<button>Book</button><p>F&#97;lcon Ridge Holdings</p>` },
    },
  ],
  phase: "open",
  next: { f: 1, a: 1, x: 1, q: 1, t: 1 },
  rev,
  style: "pm",
  visual: { kind: "wireframe", source: 'screen "Book"\nbutton "Book"' },
  createdAt: at,
  updatedAt: at,
  ...extra,
});
const alignResult = (id: string, d: unknown) => msg(id, "toolResult", [{ type: "text", text: `echo ${MARK.tech}` }], { toolCallId: `tc_${id}`, toolName: "align", isError: false, details: { v: 1, doc: d, changes: [{ kind: "created" }], line: "" } });

const BRANCH = [
  { type: "session", id: "h", cwd: "/ws" },
  custom("c1", BATON_HANDOFF_ENTRY, { v: 1, n: 1, from: "operator", to: "p_o", question: "Let's plan it together: Online booking", briefing: "" }),
  msg("u1", "user", "I want online booking."),
  msg("a1", "assistant", [
    { type: "text", text: "Here is a first plan." },
    { type: "toolCall", id: "tc_r1", name: "align", arguments: { ops: [{ op: "create", title: "Online booking", summary: MARK.tool }] } },
  ]),
  alignResult("r1", doc(1)),
  msg("r2", "toolResult", [{ type: "text", text: MARK.other }], { toolCallId: "tc_x", toolName: "spec_lookup", isError: false, details: { secret: MARK.other } }),
  msg("a2", "assistant", [{ type: "text", text: "Updated." }]),
  alignResult("r3", doc(2, { questions: [{ ...doc(1).questions[0], decision: { text: "Members only", by: "user", at } }] })),
];

const view = (plans: boolean, phrases: string[] = [MARK.phrase]) =>
  batonView({
    row: { publicTitle: "Online booking", state: "open", holder: "p_o", abilities: { draw: true, drawHtml: true, readLinks: false } },
    branch: historyOf(BRANCH),
    names,
    viewer: "p_o",
    redact: (t) => t,
    said: (t) => markupBackstop(redactPhrases(t, phrases), phrases),
    ...(plans ? { plans: true } : {}),
  });

test("a feature request chat's plan crosses once, at its latest change, field by field", () => {
  const v = view(true);
  const plans = v.items.filter((i) => i.kind === "plan");
  assert.equal(plans.length, 1, "each plan once");
  const p = plans[0]!.kind === "plan" ? plans[0]!.plan : null;
  assert.ok(p);
  assert.equal(v.items.at(-1)!.kind, "plan", "at its latest change");
  assert.deepEqual([p.doc, p.title, p.state], ["al_1", "Online booking", "agreed"]);
  assert.deepEqual(p.findings, ["Classes are listed on the schedule page today."]);
  assert.deepEqual(p.approach, ["Add a Book button to each class."]);
  assert.deepEqual(p.questions.map((q) => [q.id, q.decision]), [["q1", "Members only"]]);
  assert.deepEqual(Object.keys(p).sort(), ["approach", "doc", "findings", "questions", "rejected", "state", "summary", "title", "visual"], "no technical, review, style, ids or times");
});

test("never its technical notes, the call, the result's text, or another tool's result", () => {
  const text = JSON.stringify(view(true));
  for (const m of [MARK.tech, MARK.tool, MARK.other, "technical", "toolCall", "spec_lookup", "toolName"]) assert.ok(!text.includes(m), `no ${m}`);
  // Control: the technical note is in the branch the operator reads.
  assert.ok(JSON.stringify(BRANCH).includes(MARK.tech));
});

test("a drawing goes through the markup backstop: one carrying a secret phrase is withheld", () => {
  const p = view(true).items.find((i) => i.kind === "plan");
  const q = p?.kind === "plan" ? p.plan.questions[0]! : null;
  assert.deepEqual(q?.visual, { withheld: true });
  const clean = view(true, ["Somebody Else Entirely"]).items.find((i) => i.kind === "plan");
  assert.deepEqual(clean?.kind === "plan" ? clean.plan.questions[0]!.visual : null, { kind: "html", source: `<button>Book</button><p>F&#97;lcon Ridge Holdings</p>` });
  assert.deepEqual(p?.kind === "plan" ? p.plan.visual : null, { kind: "wireframe", source: 'screen "Book"\nbutton "Book"' });
});

test("in any other conversation no tool result crosses, align's included", () => {
  const v = view(false);
  assert.equal(v.items.filter((i) => i.kind === "plan").length, 0);
  assert.ok(!JSON.stringify(v).includes("Add a Book button"));
});
