// Run: node scripts/run-tests.mjs server/org-history-capture.test.ts. The capture adapters: one engine
// call's steps as history inputs, pure.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CAPTURE_MATRIX, type HistoryInput } from "../shared/org-history";
import { ADAPTER, ADAPTER_VERSION, CAPTURED_KINDS, actorsOf, composeHistory, type CaptureContext } from "./org-history-capture";
import type { Step } from "./statecharts";

const step = (s: Partial<Step> & Pick<Step, "sessionId" | "event">): Step => ({
  at: 1_000,
  before: [],
  after: [],
  outbox: [],
  running: true,
  microsteps: 1,
  saved: true,
  ...s,
});
const ctx = (over: Partial<CaptureContext> = {}): CaptureContext => ({ orgId: "o1", journalId: "j1", ...over });
const operatorEnv = { by: "operator", attended: true, autonomy: "L2", paused: false, ceiling: null, projectId: "p1" };
const overseerEnv = (attended: boolean, extra: Record<string, unknown> = {}) => ({ by: "overseer", overseerId: "c1", attended, autonomy: "L3", paused: false, ceiling: null, projectId: "p1", ...extra });
const one = (xs: HistoryInput[], kind: string) => {
  const hit = xs.filter((x) => x.kind === kind);
  assert.equal(hit.length, 1, `one ${kind} in ${xs.map((x) => x.kind).join(",")}`);
  return hit[0]!;
};

describe("composeHistory", () => {
  test("Run Now: the operator's request, then an unattended look it triggered; the overseer's act in the look is the overseer's", () => {
    const run = step({ sessionId: "watch/p1", statechart: "watch", event: "operator/run-now", data: operatorEnv, projectId: "p1", before: ["loop", "quiet"], after: ["loop", "running"] });
    const out = composeHistory([run], ctx({ act: { sessionId: "watch/p1", event: "operator/run-now" }, invocations: [{ op: "start", sessionId: "watch/p1", invokeId: "look", runId: "r7", type: "sova/look" }] }));
    const req = one(out, "request.made");
    assert.deepEqual(req.actors.initiatedBy, { kind: "operator" });
    assert.deepEqual(req.actors.authorization, { kind: "operator-act", attended: true });
    const look = one(out, "look.started");
    assert.deepEqual(look.aliases, ["invoke:r7"]);
    assert.deepEqual(look.parentKeys, [{ key: req.source.key, via: "request" }]);
    assert.deepEqual(look.actors.initiatedBy, { kind: "operator" });
    assert.equal(look.policy?.attended, false);
    assert.deepEqual(look.actors.authorization, { kind: "autonomy-level", attended: false });

    // later, in that look: the overseer files a gap
    const gap = step({ sessionId: "placement/o1/p1", statechart: "placement", event: "gap/file", data: { ...overseerEnv(false, { lookRun: "r7" }), gapId: "g_1", ideaId: "i1" }, projectId: "p1" });
    const g = one(composeHistory([gap], ctx({ journalId: "j2", act: { sessionId: "placement/o1/p1", event: "gap/file" } })), "gap.filed");
    assert.deepEqual(g.actors.decidedBy, { kind: "project-overseer", id: "p1", session: "c1" });
    assert.equal((g.actors.initiatedBy as { unknown?: boolean }).unknown, true, "never the operator by inheritance");
    assert.deepEqual(g.actors.authorization, { kind: "autonomy-level", attended: false, level: "L3" });
    assert.deepEqual(g.parentKeys, [{ key: "invoke:r7", via: "invocation", optional: true }]);
    assert.deepEqual(g.aliases, ["gap:g_1"]);
    assert.equal(g.policy?.attended, false);
  });

  test("an attended overseer act was initiated by the operator's message and decided by the overseer", () => {
    const a = actorsOf(step({ sessionId: "item/o1/p1/g_1", event: "gather/plan", data: overseerEnv(true) }), "p1");
    assert.deepEqual(a.initiatedBy, { kind: "operator" });
    assert.deepEqual(a.decidedBy, { kind: "project-overseer", id: "p1", session: "c1" });
    assert.deepEqual(a.authorization, { kind: "attended-turn", attended: true, level: "L3" });
  });

  test("paused or capped: the level in force is recorded, not the setting", () => {
    const capped = actorsOf(step({ sessionId: "x", event: "gap/file", data: overseerEnv(false, { ceiling: { autonomy: "L0", reason: "r" } }) }), "p1");
    assert.equal((capped.authorization as { level?: string }).level, "L0");
    const paused = actorsOf(step({ sessionId: "x", event: "gap/file", data: overseerEnv(false, { paused: true }) }), "p1");
    assert.equal((paused.authorization as { level?: string }).level, "L0");
  });

  test("a refused act is recorded as refused, its sentence only in the rationale", () => {
    const s = step({ sessionId: "build/p1/s1", statechart: "build", event: "build/merge", data: operatorEnv, saved: false, refused: { sentence: "Merge refused: dirty tree." } });
    const r = one(composeHistory([s], ctx()), "act.refused");
    assert.equal(r.outcome, "refused");
    assert.deepEqual(r.rationale, { what: "Merge refused: dirty tree." });
    assert.ok(!JSON.stringify({ ...r, rationale: undefined }).includes("dirty tree"));
  });

  test("a hold, its release by timer and the released act are linked by the engine's own hold id", () => {
    const held = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/close", data: overseerEnv(false), held: { id: "h1", sessionId: "baton/o1/b1", kind: "close", since: 1, until: 2, what: 'Closing "Q1 numbers"' } });
    const h = one(composeHistory([held], ctx()), "hold.created");
    assert.equal(h.source.key, "hold:baton/o1/b1:h1");
    assert.equal(h.rationale?.what, 'Closing "Q1 numbers"');
    assert.ok(!JSON.stringify(h.entities).includes("Q1"));

    const act = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/close", data: { ...overseerEnv(false), by: "overseer", "sova/released": "h1" } });
    const rel = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "hold/released", data: { id: "h1", by: "system" } });
    // the host's own timer call: released because its time came
    const out = composeHistory([act, rel], ctx({ journalId: "j3", call: "timers" }));
    const closed = one(out, "gathering.closed");
    assert.deepEqual(closed.parentKeys, [{ key: "hold:baton/o1/b1:h1", via: "timer" }]);
    assert.deepEqual(closed.actors.authorization, { kind: "hold-release", ref: "h1", attended: false, level: "L3" });
    assert.equal(closed.policy?.hold, "h1");
    const released = one(out, "hold.released");
    assert.deepEqual(released.parentKeys, [{ key: "hold:baton/o1/b1:h1", via: "timer" }]);
    assert.deepEqual(released.actors.decidedBy, { kind: "statechart" });
  });

  test("a hold released by an approval: triggered by the approval, decided by the approver, never 'timer'", () => {
    const approve = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "hold/approve", data: { ...operatorEnv, id: "h1", reason: "Fine now" } });
    const act = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/close", data: { ...overseerEnv(false), "sova/released": "h1" } });
    const rel = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "hold/released", data: { id: "h1", by: "system" } });
    const out = composeHistory([approve, act, rel], ctx({ journalId: "j6", call: "act", act: { sessionId: "baton/o1/b1", event: "hold/approve" } }));
    const ap = out.find((x) => x.kind === "hold.released" && x.source.key === "step:j6:0")!;
    assert.equal(ap.rationale?.reason?.text, "Fine now");
    const closed = one(out, "gathering.closed");
    assert.deepEqual(closed.parentKeys, [{ key: "step:j6:0", via: "operator-act" }]);
    // the overseer decided the close; the operator's approval is its authorization, not its decision
    assert.deepEqual(closed.actors.decidedBy, { kind: "project-overseer", id: "p1", session: "c1" });
    assert.deepEqual(closed.actors.authorization, { kind: "hold-release", ref: "h1", by: { kind: "operator" }, attended: false, level: "L3" });
    const rel2 = out.find((x) => x.source.key === "release:baton/o1/b1:h1")!;
    assert.deepEqual(rel2.parentKeys, [{ key: "step:j6:0", via: "operator-act" }]);
    assert.deepEqual(rel2.actors.decidedBy, { kind: "operator" });
    assert.ok(!JSON.stringify(out).includes('"timer"'));
  });

  test("a release in an act call that isn't its approval has no recorded trigger, only a relation to its hold", () => {
    const rel = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "hold/released", data: { id: "h1", by: "system" } });
    const act = step({ sessionId: "baton/o1/b2", statechart: "baton", event: "baton/close", data: operatorEnv });
    const out = composeHistory([rel, act], ctx({ journalId: "j7", call: "act", act: { sessionId: "baton/o1/b2", event: "baton/close" } }));
    const r = one(out, "hold.released");
    assert.equal(r.parentKeys, undefined);
    assert.deepEqual(r.relationKeys, [
      { key: "sc:baton/o1/b1", type: "named-target", optional: true, entity: { type: "gathering", id: "b1" } },
      { key: "hold:baton/o1/b1:h1", type: "related", optional: true },
    ]);
    assert.equal((r.actors.decidedBy as { unknown?: boolean }).unknown, true);
  });

  test("the global Overseer in the operator's turn: decided by it; a confirm card is its authorization, never the operator's decision", () => {
    const via = { by: "operator", via: "overseer", overseerId: "ov1", attended: true, projectId: "p1" };
    const noCard = actorsOf(step({ sessionId: "x", event: "baton/close", data: via }), "p1");
    assert.deepEqual(noCard.initiatedBy, { kind: "operator" });
    assert.deepEqual(noCard.decidedBy, { kind: "global-overseer", id: "ov1" });
    assert.deepEqual(noCard.authorization, { kind: "attended-turn", attended: true });
    const card = actorsOf(step({ sessionId: "x", event: "baton/close", data: { ...via, card: { people: ["p_ana"], projects: [], sessions: ["b1"] } } }), "p1");
    assert.deepEqual(card.initiatedBy, { kind: "operator" });
    assert.deepEqual(card.decidedBy, { kind: "global-overseer", id: "ov1" });
    assert.deepEqual(card.recordedBy, { kind: "global-overseer", id: "ov1" });
    assert.deepEqual(card.executedBy, { kind: "sova" });
    assert.deepEqual(card.authorization, { kind: "confirm-card", attended: true, ref: "card:people=p_ana;projects=;sessions=b1" });
  });

  test("the operator clicked Close on a card for a session, then the Overseer took the session back: the take-back is the Overseer's decision", () => {
    // the card names only its targets (session b1); the engine checks the act's targets against it, not its verb
    const card = { people: [], projects: [], sessions: ["b1"] };
    const takeBack = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/take-back", data: { by: "operator", via: "overseer", overseerId: "ov1", attended: true, projectId: "p1", card } });
    const a = actorsOf(takeBack, "p1");
    assert.deepEqual(a.initiatedBy, { kind: "operator" });
    assert.deepEqual(a.decidedBy, { kind: "global-overseer", id: "ov1" }, "not the operator: they confirmed Close, not this act");
    assert.deepEqual(a.authorization, { kind: "confirm-card", attended: true, ref: "card:people=;projects=;sessions=b1" });
    // a direct operator act is unchanged
    assert.deepEqual(actorsOf(step({ sessionId: "baton/o1/b1", event: "baton/close", data: { by: "operator", attended: true } }), "p1").decidedBy, { kind: "operator" });
  });

  test("a re-delivered held act and a new act with the same event: provenance goes to the new act only", () => {
    const redelivered = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/record-decision", data: { by: "model", decisionId: "s1:m0", "sova/released": "h0" } });
    const fresh = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/record-decision", data: { by: "model", decisionId: "s1:m1" } });
    const out = composeHistory([redelivered, fresh], ctx({ act: { sessionId: "baton/o1/b1", event: "baton/record-decision" }, provenance: { actors: { decidedBy: { kind: "person", id: "p_ana" } } } }));
    assert.equal(out.length, 2);
    assert.deepEqual(out.find((x) => x.source.key === "decision:s1:m0")!.actors.decidedBy, { kind: "model" });
    assert.deepEqual(out.find((x) => x.source.key === "decision:s1:m1")!.actors.decidedBy, { kind: "person", id: "p_ana" });
  });

  test("two candidate steps for the act: provenance attaches to neither, and it is reported", () => {
    const problems: string[] = [];
    const a = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/close", data: operatorEnv });
    const b = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/close", data: operatorEnv });
    const out = composeHistory([a, b], ctx({ act: { sessionId: "baton/o1/b1", event: "baton/close" }, provenance: { rationale: { what: "MINE" } }, onProblem: (w) => problems.push(w) }));
    assert.equal(out.length, 2);
    // only each step's own headline: the caller's rationale went to neither
    assert.ok(out.every((x) => JSON.stringify(x.rationale) === JSON.stringify({ what: "Gathering closed" })));
    assert.equal(problems.length, 1);
  });

  test("Run Now in a call whose due timer already moved the watch: the look is not claimed by co-occurrence", () => {
    const due = step({ sessionId: "watch/p1", statechart: "watch", event: "watch/due", data: { by: "system" }, before: ["loop", "waiting"], after: ["loop", "running"] });
    const run = step({ sessionId: "watch/p1", statechart: "watch", event: "operator/run-now", data: operatorEnv, before: ["loop", "running"], after: ["loop", "running"] });
    const out = composeHistory([due, run], ctx({ act: { sessionId: "watch/p1", event: "operator/run-now" }, invocations: [{ op: "start", sessionId: "watch/p1", invokeId: "look", runId: "r8", type: "sova/look" }] }));
    one(out, "request.made");
    const look = one(out, "look.started");
    assert.equal(look.parentKeys, undefined, "Trigger not recorded");
    assert.equal((look.actors.initiatedBy as { unknown?: boolean }).unknown, true);
  });

  test("a look the watch started on its own reads Trigger not recorded: no step is guessed as its start", () => {
    const quiet = step({ sessionId: "watch/p1", statechart: "watch", event: "reason/noted", data: { by: "statechart" } });
    const out = composeHistory([quiet], ctx({ invocations: [{ op: "start", sessionId: "watch/p1", invokeId: "look", runId: "r9", type: "sova/look" }] }));
    const look = one(out, "look.started");
    assert.equal(look.parentKeys, undefined);
    assert.deepEqual(look.aliases, ["invoke:r9"]);
    assert.equal((look.actors.initiatedBy as { unknown?: boolean }).unknown, true);
  });

  test("an outreach send whose result never came back reads Unknown, never Failed", () => {
    const answer = (result: Record<string, string>, event = "effect/done") =>
      one(composeHistory([step({ sessionId: "placement/o1/p1", statechart: "placement", event, data: { by: "system", key: "k1", result }, changed: { "sova/pending.k1": ["outreach-send", null] } })], ctx()), "outreach.sent").outcome;
    assert.equal(answer({ outcome: "failed", code: "unknown-after-restart", why: "Sova restarted during the send, so it may or may not have gone." }), "unknown");
    assert.equal(answer({ outcome: "failed", code: "unknown", why: "It may have been sent." }), "unknown");
    assert.equal(answer({ outcome: "sent" }), "done");
    assert.equal(answer({ outcome: "refused", code: "no-number" }), "refused");
    assert.equal(answer({ outcome: "failed", code: "rate-limited" }), "failed");
    assert.equal(answer({}), "unknown", "a result that says nothing is not a failure");
    assert.equal(answer({ outcome: "failed" }), "unknown");
    assert.equal(answer({ outcome: "queued" }), "unknown");
  });

  test("an operator's hold cancel is a cancellation with its reason, never a decision", () => {
    const s = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "hold/cancel", data: { ...operatorEnv, id: "h1", reason: "Not this week" } });
    const c = one(composeHistory([s], ctx()), "hold.cancelled");
    assert.equal(c.outcome, "cancelled");
    assert.equal(c.decision, undefined);
    assert.equal(c.rationale?.reason?.text, "Not this week");
    assert.deepEqual(c.parentKeys, [{ key: "hold:baton/o1/b1:h1", via: "operator-act", optional: true }]);
  });

  test("a merge: the request aliases its effect, the answer is the exact observation with the commit", () => {
    const req = step({ sessionId: "build/p1/s1", statechart: "build", event: "build/merge", data: operatorEnv, effects: ["k9"] });
    const r = one(composeHistory([req], ctx({ outbox: [{ kind: "merge", key: "k9", sessionId: "build/p1/s1" }] })), "merge.requested");
    assert.deepEqual(r.aliases, ["effect:k9"]);
    const done = step({ sessionId: "build/p1/s1", statechart: "build", event: "effect/done", data: { by: "system", key: "k9", result: { commit: "abc123" } }, changed: { "sova/pending.k9": ["merge", null] } });
    const m = one(composeHistory([done], ctx({ journalId: "j4" })), "merge.observed");
    assert.equal(m.outcome, "observed");
    assert.deepEqual(m.parentKeys, [{ key: "effect:k9", via: "effect" }]);
    assert.deepEqual(m.evidence, [{ n: 1, kind: "git", repo: "project", commit: "abc123" }]);
    const failed = step({ sessionId: "build/p1/s1", statechart: "build", event: "effect/failed", data: { by: "system", key: "k9", detail: "conflict in a.ts" }, changed: { "sova/pending.k9": ["merge", null] } });
    assert.equal(one(composeHistory([failed], ctx({ journalId: "j5" })), "merge.observed").outcome, "failed");
  });

  test("an outreach send names the person by id and never the number, note or link", () => {
    const s = step({
      sessionId: "placement/o1/p1",
      statechart: "placement",
      event: "outreach/send",
      data: { ...operatorEnv, note: "MARKER-NOTE", link: "https://x/h/MARKER-TOKEN", target: { id: "p_ana", name: "Ana", contact: { whatsapp: "+90 555 MARKER" } } },
    });
    const o = one(composeHistory([s], ctx()), "outreach.sent");
    assert.deepEqual(o.entities, [{ type: "person", id: "p_ana" }, { type: "session", id: "placement/o1/p1" }]);
    assert.ok(!JSON.stringify(o).includes("MARKER"));
  });

  test("provenance attaches to the call's own act only, never to a due timer's step fired first", () => {
    const timer = step({ sessionId: "baton/o1/b2", statechart: "baton", event: "baton/close", data: { by: "statechart" } });
    const act = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/record-decision", data: { by: "model", decisionId: "s1:m1", quote: "MARKER-QUOTE", statement: "MARKER-STATEMENT" } });
    const out = composeHistory([timer, act], ctx({ act: { sessionId: "baton/o1/b1", event: "baton/record-decision" }, provenance: { actors: { decidedBy: { kind: "person", id: "p_ana" } }, rationale: { what: "w" } } }));
    const closed = one(out, "gathering.closed");
    assert.deepEqual(closed.actors.decidedBy, { kind: "statechart" });
    assert.deepEqual(closed.rationale, { what: "Gathering closed" }, "its own headline, not the act's rationale");
    const d = one(out, "decision.recorded");
    assert.equal(d.source.key, "decision:s1:m1");
    assert.deepEqual(d.actors.decidedBy, { kind: "person", id: "p_ana" });
    assert.ok(!JSON.stringify({ ...d, rationale: undefined }).includes("MARKER"));
  });

  test("two decisions in one message are two events under their own marker keys", () => {
    const a = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/record-decision", data: { by: "model", decisionId: "s1:m1", entryId: "u1" } });
    const b = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/record-decision", data: { by: "model", decisionId: "s1:m2", entryId: "u1" } });
    const out = [...composeHistory([a], ctx({ journalId: "ja" })), ...composeHistory([b], ctx({ journalId: "jb" }))];
    assert.deepEqual(out.map((x) => x.source.key), ["decision:s1:m1", "decision:s1:m2"]);
  });

  test("quiet steps, engine events and host events give nothing", () => {
    const out = composeHistory(
      [
        step({ sessionId: "watch/p1", statechart: "watch", event: "turn/ended", data: { by: "system" } }),
        step({ sessionId: "baton/o1/b1", statechart: "baton", event: "link/moved", data: {} }),
        step({ sessionId: "baton/o1/b1", statechart: "baton", event: "budget/recount", data: { by: "system", n: 2 } }),
        step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/close", data: operatorEnv, ignored: true }),
      ],
      ctx(),
    );
    assert.deepEqual(out, []);
  });

  test("every kind the adapter writes is promised in the matrix by this adapter's version, and nothing else is", () => {
    const listed = new Map(CAPTURE_MATRIX.map((r) => [r.kind, r.by]));
    for (const k of CAPTURED_KINDS) assert.deepEqual(listed.get(k), { adapter: ADAPTER, version: ADAPTER_VERSION }, k);
    for (const r of CAPTURE_MATRIX) if (r.by?.adapter === ADAPTER) assert.ok(CAPTURED_KINDS.includes(r.kind), `${r.kind} is promised but not written`);
    // when capture started is the org's own first event (coverage, at runtime), never a date in the matrix
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(JSON.stringify(CAPTURE_MATRIX)));
  });
});

describe("headlines", () => {
  const whatOf = (s: Step, kind: string, c: Partial<CaptureContext> = {}) => one(composeHistory([s], ctx(c)), kind).rationale?.what;
  // contact, prompt, question, briefing, goal and message words: never in a headline
  const SECRET = { question: "MARKER-Q", briefing: "MARKER-B", goal: "MARKER-G", text: "MARKER-T", note: "MARKER-N", prompt: "MARKER-P", link: "https://x/MARKER" };
  const ana = { id: "p_ana", name: "Priya Shah", status: "active", contact: { whatsapp: "+90 MARKER" } };

  test("each captured act says its verb and object from the names and titles it holds, and nothing else", () => {
    const cases: [Step, string, string][] = [
      [step({ sessionId: "placement/o1/p1", statechart: "placement", event: "baton/start", data: { ...operatorEnv, ...SECRET, sessionId: "s1", publicTitle: "Q1 investor reporting", target: ana } }), "gathering.started", "Gathering started: Q1 investor reporting, with Priya Shah"],
      [step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/hand-to", data: { by: "model", ...SECRET, target: { id: "p_o", name: "Omar Ali" } } }), "gathering.handed-off", "Gathering handed to Omar Ali"],
      [step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/offer", data: { ...operatorEnv, ...SECRET, targets: ["p_ana", "p_o"], targetPeople: [ana, { id: "p_o", name: "Omar Ali" }] } }), "gathering.offered", "Gathering offered to Priya Shah, Omar Ali"],
      [step({ sessionId: "project/o1/p1", statechart: "project", event: "project/archive", data: { ...operatorEnv, projectName: "Investor portal" } }), "project.archived", "Project archived: Investor portal"],
      [step({ sessionId: "project/o1/p1", statechart: "project", event: "build/start", data: { ...operatorEnv, ...SECRET, sessionId: "c1", title: "Fix the export" } }), "build.started", "Coding session started: Fix the export"],
      [step({ sessionId: "placement/o1/p1", statechart: "placement", event: "outreach/send", data: { ...operatorEnv, ...SECRET, target: ana } }), "outreach.sent", "Message send started: to Priya Shah"],
      [step({ sessionId: "placement/o1/p1", statechart: "placement", event: "owner-update/post", data: { ...operatorEnv, ...SECRET } }), "owner-update.posted", "Owner update posted"],
      [step({ sessionId: "placement/o1/p1", statechart: "placement", event: "spec/freeze", data: { ...operatorEnv, frozen: true } }), "setting.changed", "Spec frozen"],
      [step({ sessionId: "placement/o1/p1", statechart: "placement", event: "stakeholder/set", data: { ...operatorEnv, personId: "p_ana", target: ana } }), "setting.changed", "Main stakeholder set: Priya Shah"],
    ];
    for (const [s, kind, what] of cases) {
      const input = one(composeHistory([s], ctx()), kind);
      assert.equal(input.rationale?.what, what, s.event);
      assert.ok(!JSON.stringify(input).includes("MARKER"), `${s.event}: no contact, prompt or message words`);
    }
  });

  test("an observed result says what was observed: the merge's commit, a failure as a failure", () => {
    const answer = (event: string, result: Record<string, string>) =>
      step({ sessionId: "build/p1/s1", statechart: "build", event, data: { by: "system", key: "k9", result }, changed: { "sova/pending.k9": ["merge", null] } });
    assert.equal(whatOf(answer("effect/done", { commit: "abc123" }), "merge.observed"), "Branch merged: abc123");
    assert.equal(whatOf(answer("effect/done", { commit: "44c67822754e1bf7db28fce3d79020ebbe711898" }), "merge.observed"), "Branch merged: 44c6782");
    const failed = one(composeHistory([answer("effect/failed", {})], ctx()), "merge.observed");
    assert.equal(failed.outcome, "failed");
    assert.notEqual(failed.rationale?.what, "Branch merged");
  });

  test("an observed promotion names the commit it made, as the promote effect answers it ({sha}), with its Git evidence", () => {
    const answer = (result: { promoted: string[]; refused: string[]; commit?: { sha: string } }) =>
      step({ sessionId: "reconciler/o1/p1", statechart: "reconciler", event: "effect/done", data: { by: "system", key: "k7", result }, changed: { "sova/pending.k7": ["promote", null] } });
    const sha = "12c59bf0e4a1d2c3b4a5968778695a4b3c2d1e0f";
    const input = one(composeHistory([answer({ promoted: ["d1"], refused: [], commit: { sha } })], ctx({ projectId: "p1" } as Partial<CaptureContext>)), "promotion.made");
    assert.equal(input.rationale?.what, "Decisions promoted: 12c59bf");
    assert.ok(input.evidence?.some((e) => e.kind === "git" && e.commit === sha), JSON.stringify(input.evidence));
    assert.equal(whatOf(answer({ promoted: ["d1"], refused: [] }), "promotion.made"), "Decisions promoted", "no commit: none named");
  });

  test("an object-less headline names its object from a title the step carries, else keeps the kind's wording", () => {
    const filed = (data: Record<string, unknown>) => step({ sessionId: "placement/o1/p1", statechart: "placement", event: "gap/file", data: { ...operatorEnv, gapId: "g_1", ideaId: "i1", ...data } });
    assert.equal(whatOf(filed({ title: "Receipts export", ...SECRET }), "gap.filed"), "Gap filed: Receipts export");
    assert.equal(whatOf(filed({}), "gap.filed"), "Gap filed");
    const input = one(composeHistory([filed({ ...SECRET })], ctx()), "gap.filed");
    assert.ok(!JSON.stringify(input).includes("MARKER"));
  });

  test("a more particular sentence wins: a decision's statement, a refusal's and a held act's own words", () => {
    const dec = step({ sessionId: "baton/o1/b1", statechart: "baton", event: "baton/record-decision", data: { by: "model", decisionId: "s1:m1" } });
    assert.equal(whatOf(dec, "decision.recorded", { act: { sessionId: "baton/o1/b1", event: "baton/record-decision" }, provenance: { rationale: { what: "Reports go weekly." } } }), "Reports go weekly.");
    assert.equal(whatOf(dec, "decision.recorded"), "Decision recorded");
    const refused = step({ sessionId: "project/o1/p1", statechart: "project", event: "project/archive", data: operatorEnv, saved: false, refused: { sentence: "It is archived already." } });
    assert.equal(whatOf(refused, "act.refused"), "It is archived already.");
  });
});

describe("lineage: relations from the ids a step carries", () => {
  const rel = (x: HistoryInput) => (x.relationKeys ?? []).map((r) => [r.type, r.key]);
  const started = (sessionId: string, data: Step["data"] = {}) => step({ sessionId, statechart: sessionId.split("/")[0], event: "sova/started", data });

  test("a gathering started on a gap names the gap; its start alias exists only when its session was started in the call", () => {
    const act = step({ sessionId: "item/o1/p1/g_1", statechart: "item", event: "gather/start", data: { ...overseerEnv(true), sessionId: "s9", publicTitle: "Hosting" }, projectId: "p1" });
    const g = one(composeHistory([act, started("baton/o1/s9", { sessionId: "s9" })], ctx()), "gathering.started");
    assert.deepEqual(g.aliases, ["sc:baton/o1/s9"]);
    assert.deepEqual(g.relationKeys, [{ key: "gap:g_1", type: "named-target", optional: true, entity: { type: "gap", id: "g_1" } }]);
    // the same act without its spawn (not started here): no claim on the session
    assert.equal(one(composeHistory([act], ctx()), "gathering.started").aliases, undefined);
  });

  test("a decision is recorded-in its gathering (holder: the decision); acts on a gathering name it as their target", () => {
    const rec = step({ sessionId: "baton/o1/s9", statechart: "baton", event: "baton/record-decision", data: { by: "model", decisionId: "s9:d1", statement: "MARK-S", quote: "MARK-Q" } });
    const d = one(composeHistory([rec], ctx()), "decision.recorded");
    assert.deepEqual(rel(d), [["recorded-in", "sc:baton/o1/s9"]]);
    assert.ok(!JSON.stringify({ ...d, rationale: undefined }).includes("MARK"));
    const close = one(composeHistory([step({ sessionId: "baton/o1/s9", statechart: "baton", event: "baton/close", data: operatorEnv })], ctx()), "gathering.closed");
    assert.deepEqual(rel(close), [["named-target", "sc:baton/o1/s9"]]);
  });

  test("a promotion request names the decisions it asked for; its answer adopts only those it promoted", () => {
    const req = step({ sessionId: "reconciler/o1/p1", statechart: "reconciler", event: "decision/promote", data: { ...operatorEnv, ids: ["s9:d1", "s9:d2"] }, effects: ["k1"] });
    const r = one(composeHistory([req], ctx({ outbox: [{ kind: "promote", key: "k1", sessionId: "reconciler/o1/p1" }] })), "promotion.made");
    assert.deepEqual(rel(r), [["named-target", "decision:s9:d1"], ["named-target", "decision:s9:d2"]]);
    const answer = step({ sessionId: "reconciler/o1/p1", statechart: "reconciler", event: "effect/done", data: { key: "k1", kind: "promote", result: { promoted: ["s9:d1"], refused: [{ id: "s9:d2", reason: "no" }] }, effect: { kind: "promote" } } });
    const a = one(composeHistory([answer], ctx()), "promotion.made");
    assert.deepEqual(rel(a), [["adopts", "decision:s9:d1"]]);
    assert.deepEqual(a.parentKeys, [{ key: "effect:k1", via: "effect" }], "the only cause is its effect");
    const failed = step({ sessionId: "reconciler/o1/p1", statechart: "reconciler", event: "effect/failed", data: { key: "k1", kind: "promote", detail: "x", effect: { kind: "promote" } } });
    assert.equal(one(composeHistory([failed], ctx()), "promotion.made").relationKeys, undefined, "a failed promotion adopts nothing");
  });

  test("a build names its gap and the decisions its build statechart was started with, from that start's data", () => {
    const act = step({ sessionId: "item/o1/p1/g_1", statechart: "item", event: "build/start", data: { ...operatorEnv, sessionId: "g_1-b1", title: "Build", prompt: "MARK-P" }, projectId: "p1" });
    const spawn = started("build/p1/g_1-b1", { sessionId: "g_1-b1", item: "g_1", gap: "§gap/hosting", decisions: ["s9:d1"], prompt: "MARK-P", projectId: "p1" });
    const b = one(composeHistory([act, spawn], ctx()), "build.started");
    assert.deepEqual(b.aliases, ["sc:build/p1/g_1-b1"]);
    assert.deepEqual(rel(b), [["named-target", "gap:g_1"], ["named-target", "decision:s9:d1"]]);
    assert.ok(!JSON.stringify(b).includes("MARK"));
    // later acts on the coding session name its start
    const merge = one(composeHistory([step({ sessionId: "build/p1/g_1-b1", statechart: "build", event: "build/merge", data: operatorEnv })], ctx()), "merge.requested");
    assert.deepEqual(rel(merge), [["named-target", "sc:build/p1/g_1-b1"]]);
  });

  test("a superseded decision's statechart names what supersedes it: that supersession, decided by no one recorded", () => {
    const sup = step({ sessionId: "decision/o1/p1/s9:d1", statechart: "decision", event: "reconcile/result", data: { state: "superseded", supersededBy: "operator:m2", at: 5 }, changed: { state: ["drafted", "superseded"], "superseded-by": [null, "operator:m2"] }, projectId: "p1" });
    const x = one(composeHistory([sup], ctx()), "decision.superseded");
    assert.deepEqual(rel(x), [["supersedes", "decision:s9:d1"], ["related", "decision:operator:m2"]]);
    assert.equal(x.source.key, "superseded:s9:d1:operator:m2");
    assert.equal((x.actors.decidedBy as { unknown?: boolean }).unknown, true);
    assert.equal(x.parentKeys, undefined, "no cause by co-occurrence");
    // no supersededBy, or another verdict: nothing
    const none = [
      step({ sessionId: "decision/o1/p1/s9:d1", statechart: "decision", event: "reconcile/result", data: { state: "superseded" }, changed: { state: ["drafted", "superseded"] } }),
      step({ sessionId: "decision/o1/p1/s9:d1", statechart: "decision", event: "reconcile/result", data: { state: "drafted", supersededBy: "x" }, changed: { state: ["pending", "drafted"] } }),
      step({ sessionId: "decision/o1/p1/s9:d1", statechart: "decision", event: "reconcile/result", data: { state: "superseded", supersededBy: "operator:m2" }, changed: { "record-id": [null, "r"] } }),
    ];
    assert.deepEqual(composeHistory(none, ctx()), []);
  });

  test("the operator's stated settle: its decision answers to the id the settle declared; a gathering's decision start is not recorded twice", () => {
    const settle = step({ sessionId: "conflict/o1/p1/c1", statechart: "conflict", event: "conflict/settle", data: { ...operatorEnv, statement: "MARK-S", decisionId: "operator:m2" } });
    const c = one(composeHistory([settle], ctx()), "conflict.settled");
    assert.deepEqual(c.aliases, ["settle-decision:operator:m2"]);
    assert.deepEqual(rel(c), [["named-target", "conflict:conflict/o1/p1/c1"]]);
    const born = started("decision/o1/p1/operator:m2", { id: "operator:m2", by: "operator", sessionId: "", statement: "Forty-five days.", quote: "Forty-five days.", name: "MARK-NAME", projectId: "p1" });
    const d = one(composeHistory([born], ctx()), "decision.recorded");
    assert.equal(d.source.key, "decision:operator:m2");
    assert.deepEqual(d.parentKeys, [{ key: "settle-decision:operator:m2", via: "effect", optional: true }]);
    assert.deepEqual(d.actors.decidedBy, { kind: "operator" });
    assert.deepEqual(d.actors.authorization, { kind: "operator-act" }, "attendance isn't on the step, so it isn't claimed");
    assert.equal(d.rationale?.what, "Forty-five days.");
    assert.ok(!JSON.stringify(d).includes("MARK"));
    assert.deepEqual(composeHistory([started("decision/o1/p1/s9:d1", { id: "s9:d1", by: "p_ana", sessionId: "s9" })], ctx()), []);
  });

  test("membership and authority: placed, added (by id, never the profile), status moved, level set, decision areas", () => {
    const place = step({ sessionId: "org/o1", statechart: "org", event: "project/place", data: { ...operatorEnv, projectId: "p1" } });
    assert.equal(one(composeHistory([place, started("placement/o1/p1", { projectId: "p1" })], ctx()), "project.placed").projects.primary, "p1");
    assert.deepEqual(composeHistory([place], ctx()), [], "placed again: nothing started, nothing recorded");
    const add = step({ sessionId: "org/o1", statechart: "org", event: "person/add", data: { ...operatorEnv, personId: "p_ana", person: { name: "MARK-NAME", contact: { whatsapp: "+90 MARK" }, voice: "MARK-V" } } });
    const a = one(composeHistory([add], ctx()), "person.added");
    assert.deepEqual(a.entities?.[0], { type: "person", id: "p_ana" });
    assert.ok(!JSON.stringify(a).includes("MARK"), "no name, contact or profile");
    const leave = step({ sessionId: "person/o1/p_ana", statechart: "person", event: "person/leave", data: operatorEnv, changed: { status: ["active", "left"] } });
    const l = one(composeHistory([leave], ctx()), "person.status-changed");
    assert.equal(l.rationale?.what, "Status: left");
    assert.deepEqual(composeHistory([step({ sessionId: "person/o1/p_ana", statechart: "person", event: "person/revert", data: operatorEnv, changed: { role: ["a", "b"] } })], ctx()), []);
    assert.deepEqual(composeHistory([step({ sessionId: "person/o1/p_ana", statechart: "person", event: "person/edit", data: operatorEnv, changed: { contact: [{}, { whatsapp: "+90 MARK" }] } })], ctx()), []);
    const areas = one(composeHistory([step({ sessionId: "person/o1/p_ana", statechart: "person", event: "person/edit", data: { ...operatorEnv, patch: { decides: ["MARK"] } }, changed: { decides: [[], ["MARK"]] } })], ctx()), "setting.changed");
    assert.equal(areas.rationale?.what, "Decision areas changed");
    assert.ok(!JSON.stringify(areas).includes("MARK"));
    const level = one(composeHistory([step({ sessionId: "watch/p1", statechart: "watch", event: "operator/level-set", data: { ...operatorEnv, resumeAt: "L2" }, changed: { "settings.autonomy": ["L1", "L2"] } })], ctx()), "setting.changed");
    assert.equal(level.rationale?.what, "Autonomy level set: L2");
  });
});
