import assert from "node:assert/strict";
import { test } from "node:test";
import type { IdeaRecord } from "../../shared/protocol";
import { IDEA_ID_RE } from "../../shared/protocol";
import { actionLine, allowanceLine, gapArea, itemSendInput, lastRunTail, limitsProblem, openIdeas, operatorIdeaId, pendingLine, tokens, toolWords, waitingLines, watchHint } from "./project-overseer-view";
import { DEFAULT_PO_CAPS } from "../../shared/project-overseer";

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
  assert.equal(actionLine({ tool: "sova_promote", outcome: "partial", error: "2 refused: d1 (outside Bo's decision area); d2 (in a conflict)." }), "promote: partly (2 refused: d1 (outside Bo's decision area); d2 (in a conflict))");
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

test("lastRunTail: the status line ends with one period, whatever the reason ends with", () => {
  const line = (run: Parameters<typeof lastRunTail>[0]) => `Last looked on its own 2m ago${lastRunTail(run)}.`;
  assert.equal(line({ reasons: [], outcome: "skipped", detail: "the session was closed." }), "Last looked on its own 2m ago, skipped: the session was closed.");
  assert.equal(line({ reasons: [], outcome: "skipped", detail: "budget spent" }), "Last looked on its own 2m ago, skipped: budget spent.");
  assert.equal(line({ reasons: [], outcome: "skipped" }), "Last looked on its own 2m ago, skipped.");
  assert.equal(line({ reasons: ["a new decision.", "a conflict"], outcome: "finished" }), "Last looked on its own 2m ago, after a new decision, a conflict.");
  assert.equal(line({ reasons: [], outcome: "finished" }), "Last looked on its own 2m ago.");
  for (const detail of ["x.", "x..", "x. ", "x"]) assert.doesNotMatch(line({ reasons: [], outcome: "skipped", detail }), /\.\.$/);
  // The server's own reasons are whole sentences: mid-line they continue it, one stop at the end.
  assert.equal(
    line({ reasons: ['A decision was recorded in "Payment approval rules".', 'The gathering session "Payment approval rules" reached its goal.'], outcome: "finished" }),
    'Last looked on its own 2m ago, after a decision was recorded in "Payment approval rules", the gathering session "Payment approval rules" reached its goal.',
  );
  assert.equal(line({ reasons: ["IT asked for a look."], outcome: "finished" }), "Last looked on its own 2m ago, after IT asked for a look.");
});

test("lastRunTail: running, finished, stopped and cut off each say so, with one period", () => {
  const line = (run: Parameters<typeof lastRunTail>[0]) => `Last looked on its own 2m ago${lastRunTail(run)}.`;
  assert.equal(line({ reasons: ["A conflict was found."], outcome: "started" }), "Last looked on its own 2m ago, running now, after a conflict was found.");
  assert.equal(line({ reasons: [], outcome: "started" }), "Last looked on its own 2m ago, running now.");
  assert.equal(line({ reasons: ["A conflict was found."], outcome: "finished" }), "Last looked on its own 2m ago, after a conflict was found.");
  assert.equal(
    line({ reasons: ["A conflict was found."], outcome: "stopped", detail: "a tool call's arguments passed 65,536 characters" }),
    "Last looked on its own 2m ago, stopped: a tool call's arguments passed 65,536 characters.",
  );
  assert.equal(line({ reasons: [], outcome: "stopped", detail: "Stopped." }), "Last looked on its own 2m ago, stopped.");
  assert.equal(line({ reasons: [], outcome: "stopped" }), "Last looked on its own 2m ago, stopped.");
  assert.equal(line({ reasons: ["x"], outcome: "cut-off", detail: "The server restarted during the run." }), "Last looked on its own 2m ago, cut off by a restart.");
  for (const outcome of ["started", "finished", "stopped", "cut-off", "skipped"] as const)
    for (const detail of [undefined, "x.", "x"]) assert.match(line({ reasons: ["It ended."], outcome, ...(detail ? { detail } : {}) }), /[^.]\.$/, `${outcome} ${detail}`);
});

test("pendingLine: the waiting reasons as sentences, each with exactly one stop", () => {
  // The two reasons the server writes (server/project-overseer.ts), as the lanes saw them doubled.
  const real = ['A decision was recorded in "Payment approval rules".', 'The gathering session "Payment approval rules" reached its goal.'];
  const line = `Waiting to look at: ${pendingLine(real)}`;
  assert.equal(line, 'Waiting to look at: A decision was recorded in "Payment approval rules". The gathering session "Payment approval rules" reached its goal.');
  assert.doesNotMatch(line, /\.\.|"\.,|\.,/);
  assert.equal(pendingLine(["no stop", "two stops..", "  spaced.  "]), "no stop. two stops. spaced.");
  assert.equal(pendingLine(['A decision was recorded in "Who approves?".', 'Closed "Done.".']), 'A decision was recorded in "Who approves?" Closed "Done."');
  assert.equal(pendingLine(["Is it?"]), "Is it?");
  for (const r of real) assert.equal(pendingLine([r]), r, "a well-formed sentence is left alone");
});

test("operatorIdeaId: a valid idea id from any title, never one already taken", () => {
  assert.equal(operatorIdeaId("Detect duplicate invoices", new Set()), "§idea/detect-duplicate-invoices");
  assert.equal(operatorIdeaId("Détecter les doublons", new Set()), "§idea/detecter-les-doublons");
  assert.equal(operatorIdeaId("Detect duplicate invoices", new Set(["§idea/detect-duplicate-invoices"])), "§idea/detect-duplicate-invoices-2");
  const taken = new Set<string>();
  for (const title of ["Détecter les doublons", "!!!", "   ", "日本語だけ", "x".repeat(200), "a -- b --", "Same", "Same", "Same"]) {
    const id = operatorIdeaId(title, taken);
    assert.match(id, IDEA_ID_RE, title);
    assert.ok(!taken.has(id), `${title} → ${id} collides`);
    taken.add(id);
  }
});

// ---- limits (§app.project-overseer/limits, §design.copy-deck/project-limits) ----

const DEFAULTS = { ...DEFAULT_PO_CAPS };
const draft = (caps: Partial<Record<keyof typeof DEFAULTS, number | null>> = {}, tokenBudget: number | null = 2_000_000) => ({ caps: { ...DEFAULTS, ...caps }, tokenBudget });

test("a draft's first problem, as the server says it; Unlimited is null, never a blank field", () => {
  assert.equal(limitsProblem(draft()), null);
  assert.equal(limitsProblem(draft({ gatherPerDay: null, unattendedPerDay: null }, null)), null);
  assert.equal(limitsProblem(draft({ promptsPerDay: Number.NaN })), "Prompts to coding sessions (on its own, each day) must be a whole number from 0 to 1000, or Unlimited.");
  assert.equal(limitsProblem(draft({ gatherPerTurn: 1001 })), "Gathering sessions started (each message you send) must be a whole number from 0 to 1000, or Unlimited.");
  assert.equal(limitsProblem(draft({ codingRunning: 11 })), "Coding sessions running must be a whole number from 0 to 10.");
  assert.equal(limitsProblem(draft({ gatheringsOpen: -1 })), "Gathering sessions open must be a whole number from 0 to 20.");
  assert.equal(limitsProblem(draft({}, 1.5)), "Coding token budget must be a whole number from 0 to 1,000,000,000, or Unlimited.");
});

test("the watch hint is built from the pace", () => {
  assert.equal(watchHint(10, 60), "When a session finishes, a conflict appears, or you promote, it looks on its own: within 1 min for the important ones, otherwise at most every 10 min.");
  assert.equal(watchHint(60, 30), "When a session finishes, a conflict appears, or you promote, it looks on its own: within 30 s for the important ones, otherwise at most every 1 hour.");
  assert.equal(watchHint(5, null), "When a session finishes, a conflict appears, or you promote, it looks on its own at most every 5 min.");
});

test("the readout names only what was used, Unlimited as no limit", () => {
  const n = (used: number, max: number | null) => ({ used, max });
  const today = { gather: n(3, 6), promote: n(0, 60), create: n(2, null), prompt: n(0, 12) };
  assert.equal(allowanceLine("Today on its own", today), "Today on its own: 3 of 6 gathering sessions, 2 coding sessions (no limit).");
  assert.equal(allowanceLine("Your last message", { gather: n(0, 3), promote: n(0, 20), create: n(0, 2), prompt: n(5, 5) }), "Your last message: 5 of 5 prompts to coding sessions.");
  assert.equal(allowanceLine("Today on its own", { gather: n(0, 6), promote: n(0, 60), create: n(0, 4), prompt: n(0, 12) }), null);
});

test("what it waits for, one line per held item; the message allowance's isn't shown", () => {
  const since = "2026-09-27T14:11:00.000Z";
  const s = { caps: { ...DEFAULTS }, tokenBudget: 2_000_000 };
  const lines = waitingLines(
    [
      { key: "day:gather", what: "gathering sessions started", why: "", since, retryAt: "2026-09-28T00:00:00.000Z" },
      { key: "looks", what: "looks", why: "", since, retryAt: "2026-09-28T00:00:00.000Z" },
      { key: "budget", what: "coding tokens", why: "", since, retryAt: null },
      { key: "message:prompt", what: "prompts to coding sessions", why: "", since, retryAt: since },
    ],
    s,
    2_000_000,
  );
  assert.deepEqual(lines, ["Waiting until midnight: today's 6 gathering sessions are used.", "Waiting until midnight: today's 12 looks are used.", "Waiting for you: the coding token budget is spent (2.0M of 2.0M)."]);
});
