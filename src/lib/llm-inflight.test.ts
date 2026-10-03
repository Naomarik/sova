// Run: pnpm exec tsx --test src/lib/llm-inflight.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmInflight } from "../../shared/protocol";
import { agentsRow, inflightWhy, llmInflightView, sameInflight } from "./llm-inflight";
import { activeAgentCounts, activeTeamCount } from "./workers";

const complete = (count: number): LlmInflight => ({ count, approximate: 0, partial: false, gaps: [] });
const labels: Record<string, string> = { "peer-a": "studio", "peer-b": "laptop" };
const label = (id: string) => labels[id] ?? id;

test("complete: a bare figure, singular at 1, and the only state that may read 0", () => {
  const zero = llmInflightView(complete(0));
  assert.equal(zero.state, "complete");
  assert.equal(zero.figure, "0");
  assert.equal(zero.rowWord, "agents");
  assert.equal(zero.sentence, "No LLM calls running now");
  assert.equal(zero.agentsLabel, "Agents: No LLM calls running now");
  assert.equal(zero.showTally, false, "the spine tally hides only a complete 0");

  const one = llmInflightView(complete(1));
  assert.deepEqual([one.figure, one.rowWord, one.sentence, one.agentsLabel, one.showTally], ["1", "agent", "1 LLM call running now", "Agents: 1 LLM call running now", true]);

  const many = llmInflightView(complete(3));
  assert.deepEqual([many.figure, many.rowWord, many.sentence, many.agentsLabel], ["3", "agents", "3 LLM calls running now", "Agents: 3 LLM calls running now"]);
});

test("unknown (no snapshot on this connection): no figure, the word Agents, never a 0", () => {
  const v = llmInflightView(null);
  assert.equal(v.state, "unknown");
  assert.equal(v.figure, "–");
  assert.equal(v.rowWord, null, "the row reads the plain word Agents");
  assert.equal(v.sentence, "LLM calls running now: not known yet");
  assert.equal(v.agentsLabel, "Agents: LLM calls running now: not known yet");
  assert.equal(v.showTally, true);
  assert.doesNotMatch(v.figure, /0/);
});

test("partial: a floor shown as the bare number, the reasons in the sentence, even at 0", () => {
  const v = llmInflightView({ count: 3, approximate: 0, partial: true, gaps: [{ reason: "claude-internal" }] });
  assert.equal(v.state, "partial");
  assert.equal(v.figure, "3", "the number only: the floor is the sentence's to say");
  assert.equal(v.rowWord, "agents");
  assert.equal(v.sentence, "At least 3 LLM calls running now. Claude Code's own internal calls aren't visible.");
  assert.equal(v.agentsLabel, "Agents: At least 3 LLM calls running now. Claude Code's own internal calls aren't visible.");

  const zero = llmInflightView({ count: 0, approximate: 0, partial: true, gaps: [{ reason: "peer-unreachable", host: "peer-a" }] }, label);
  assert.equal(zero.figure, "0");
  assert.equal(zero.state, "partial", "a partial 0 is a floor, never a proven 0");
  assert.equal(zero.showTally, true);
  assert.equal(zero.sentence, "At least 0 LLM calls running now. studio can't be reached.");

  const one = llmInflightView({ count: 1, approximate: 0, partial: true, gaps: [{ reason: "claude-internal" }] });
  assert.equal(one.figure, "1");
  assert.match(one.sentence, /^At least 1 LLM call running now\./);
});

test("approximate one-shots: the same figure as an exact one, the sentence apart", () => {
  const exact = llmInflightView(complete(1));
  const approx = llmInflightView({ count: 1, approximate: 1, partial: false, gaps: [] });
  assert.equal(exact.figure, "1");
  assert.equal(approx.figure, "1");
  assert.equal(approx.approximate, true);
  assert.equal(exact.approximate, false);
  assert.equal(approx.state, "complete", "an estimate is not a gap");
  assert.equal(approx.rowWord, "agent");
  assert.equal(approx.sentence, "No exact LLM calls running now, and 1 one-shot that may be calling");
  assert.equal(approx.agentsLabel, "Agents: No exact LLM calls running now, and 1 one-shot that may be calling");
  assert.notEqual(approx.sentence, exact.sentence);
  assert.equal(approx.showTally, true);

  const three = llmInflightView({ count: 3, approximate: 1, partial: false, gaps: [] });
  assert.deepEqual([three.figure, three.rowWord, three.sentence], ["3", "agents", "2 LLM calls running now, and 1 one-shot that may be calling"]);

  const two = llmInflightView({ count: 2, approximate: 1, partial: false, gaps: [] });
  assert.equal(two.sentence, "1 LLM call running now, and 1 one-shot that may be calling");

  const plural = llmInflightView({ count: 5, approximate: 2, partial: false, gaps: [] });
  assert.deepEqual([plural.figure, plural.sentence], ["5", "3 LLM calls running now, and 2 one-shots that may be calling"]);

  const allOneShots = llmInflightView({ count: 2, approximate: 2, partial: false, gaps: [] });
  assert.equal(allOneShots.sentence, "No exact LLM calls running now, and 2 one-shots that may be calling");
});

test("partial and approximate together: the bare number, never \"at least\" over the estimates", () => {
  const v = llmInflightView({ count: 4, approximate: 1, partial: true, gaps: [{ reason: "claude-internal" }] });
  assert.equal(v.state, "partial");
  assert.equal(v.approximate, true);
  assert.equal(v.figure, "4");
  assert.equal(v.rowWord, "agents");
  assert.equal(v.sentence, "At least 3 LLM calls running now, and 1 one-shot that may be calling. Claude Code's own internal calls aren't visible.");
  const none = llmInflightView({ count: 2, approximate: 2, partial: true, gaps: [{ reason: "peer-connecting", host: "peer-b" }] }, label);
  assert.equal(none.figure, "2");
  assert.equal(none.sentence, "No exact LLM calls seen, and 2 one-shots that may be calling. laptop hasn't reported yet.");
  const exactPartial = llmInflightView({ count: 4, approximate: 0, partial: true, gaps: [{ reason: "claude-internal" }] });
  assert.equal(exactPartial.figure, "4");
  assert.equal(exactPartial.approximate, false, "no estimate in it");
  assert.notEqual(exactPartial.sentence, v.sentence, "the figures match; the sentences tell them apart");
});

test("a malformed frame can't claim more one-shots than calls", () => {
  assert.equal(llmInflightView({ count: 1, approximate: 3, partial: false, gaps: [] }).sentence, "No exact LLM calls running now, and 1 one-shot that may be calling");
  assert.equal(llmInflightView({ count: 2, approximate: -1, partial: false, gaps: [] }).figure, "2");
});

test("a gap makes the count a floor even if `partial` disagrees", () => {
  const v = llmInflightView({ count: 2, approximate: 0, partial: false, gaps: [{ reason: "peer-connecting", host: "peer-b" }] }, label);
  assert.equal(v.state, "partial");
  assert.equal(v.figure, "2");
  assert.match(v.sentence, /^At least 2 /);
});

test("each reason in words, once, in the gaps' order; this host and peers by label", () => {
  assert.equal(
    inflightWhy(
      [
        { reason: "claude-internal" },
        { reason: "claude-internal", host: "peer-a" },
        { reason: "unreported", processes: 2 },
        { reason: "unreported", host: "peer-a", processes: 1 },
        { reason: "peer-connecting", host: "peer-b" },
        { reason: "peer-unreachable", host: "peer-a" },
        { reason: "peer-unsupported", host: "peer-x" },
      ],
      label,
    ),
    "Claude Code's own internal calls aren't visible. 2 processes on this host don't report. 1 process on studio doesn't report. laptop hasn't reported yet. studio can't be reached. peer-x runs an older Sova.",
  );
});

test("sameInflight: an unchanged frame is equal; any change to the figure or its coverage is not", () => {
  const a: LlmInflight = { count: 2, approximate: 0, partial: true, gaps: [{ reason: "claude-internal" }] };
  assert.equal(sameInflight(a, { ...a, gaps: [{ reason: "claude-internal" }] }), true);
  assert.equal(sameInflight(null, null), true);
  assert.equal(sameInflight(a, null), false, "unknown is never the same as a count");
  assert.equal(sameInflight(complete(0), null), false, "a complete 0 is not unknown");
  assert.equal(sameInflight(a, { ...a, count: 3 }), false);
  assert.equal(sameInflight(a, { ...a, partial: false, gaps: [] }), false);
  assert.equal(sameInflight(a, { ...a, gaps: [{ reason: "claude-internal", host: "peer-a" }] }), false);
});

// ---- The Agents row: the call count first, then this host's sessions and teams ------------------

const rowText = (r: ReturnType<typeof agentsRow>, v: ReturnType<typeof llmInflightView>) =>
  [v.rowWord ? `${v.figure} ${v.rowWord}` : "Agents", ...r.secondary.map((p) => `${p.n} ${p.word}`)].join(" · ");

test("agents row: the call count and this host's sessions and teams are separate figures", () => {
  const v = llmInflightView(complete(3));
  const r = agentsRow(v, { sessions: 4, teams: 2 });
  assert.equal(rowText(r, v), "3 agents · 4 sessions · 2 teams");
  assert.equal(r.label, "Agents: 3 LLM calls running now. Each agent counted is one model call in flight, background work included. On this host, subagents are working in 4 sessions and 2 teams.");
  const bg = llmInflightView(complete(5));
  const one = agentsRow(bg, { sessions: 1, teams: 1 });
  assert.equal(rowText(one, bg), "5 agents · 1 session · 1 team", "background calls imply no session or team");
  assert.equal(one.label, "Agents: 5 LLM calls running now. Each agent counted is one model call in flight, background work included. On this host, subagents are working in 1 session and 1 team.");
});

test("agents row: a 0 is left out, and with both 0 the row and its label are the count's alone", () => {
  const v = llmInflightView(complete(2));
  const sOnly = agentsRow(v, { sessions: 2, teams: 0 });
  assert.equal(rowText(sOnly, v), "2 agents · 2 sessions");
  assert.equal(sOnly.label, "Agents: 2 LLM calls running now. Each agent counted is one model call in flight, background work included. On this host, subagents are working in 2 sessions.");
  const tOnly = agentsRow(v, { sessions: 0, teams: 1 });
  assert.equal(rowText(tOnly, v), "2 agents · 1 team");
  assert.equal(tOnly.label, "Agents: 2 LLM calls running now. Each agent counted is one model call in flight, background work included. On this host, subagents are working in 1 team.");
  const none = agentsRow(v, { sessions: 0, teams: 0 });
  assert.deepEqual(none.secondary, []);
  assert.equal(none.label, `Agents: 2 LLM calls running now. Each agent counted is one model call in flight, background work included.`);
  assert.equal(rowText(none, v), "2 agents");
});

test("agents row: an unknown count stays unknown beside nonzero local figures", () => {
  const v = llmInflightView(null);
  const r = agentsRow(v, { sessions: 2, teams: 1 });
  assert.equal(rowText(r, v), "Agents · 2 sessions · 1 team");
  assert.equal(r.label, "Agents: LLM calls running now: not known yet. On this host, subagents are working in 2 sessions and 1 team.");
  assert.doesNotMatch(rowText(r, v), /\b0\b/);
});

test("agents row: partial and approximate counts keep their marks; one full stop between sentences", () => {
  const p = llmInflightView({ count: 3, approximate: 0, partial: true, gaps: [{ reason: "claude-internal" }] });
  const rp = agentsRow(p, { sessions: 1, teams: 0 });
  assert.equal(rowText(rp, p), "3 agents · 1 session");
  assert.equal(rp.label, "Agents: At least 3 LLM calls running now. Claude Code's own internal calls aren't visible. Each agent counted is one model call in flight, background work included. On this host, subagents are working in 1 session.");
  assert.doesNotMatch(rp.label, /\.\./);
  const pa = llmInflightView({ count: 4, approximate: 1, partial: true, gaps: [{ reason: "claude-internal" }] });
  const rpa = agentsRow(pa, { sessions: 2, teams: 1 });
  assert.equal(rowText(rpa, pa), "4 agents · 2 sessions · 1 team");
  assert.doesNotMatch(rpa.label, /\.\./);
  const a = llmInflightView({ count: 1, approximate: 1, partial: false, gaps: [] });
  const ra = agentsRow(a, { sessions: 0, teams: 3 });
  assert.equal(rowText(ra, a), "1 agent · 3 teams");
  assert.equal(ra.label, "Agents: No exact LLM calls running now, and 1 one-shot that may be calling. Each agent counted is one model call in flight, background work included. On this host, subagents are working in 3 teams.");
  const zero = llmInflightView(complete(0));
  const rz = agentsRow(zero, { sessions: 1, teams: 0 });
  assert.equal(rowText(rz, zero), "0 agents · 1 session");
  assert.equal(rz.label, "Agents: No LLM calls running now. On this host, subagents are working in 1 session.");
});

test("agents row reads the old helpers unchanged: fresh host sessions only, teams with a member working", () => {
  const rec = (fresh: boolean, working: number, teams: { working: number }[] = [], mode = "tui") => ({
    mode,
    fresh,
    workerCounts: { total: 0, working, waiting: 2, done: 0, error: 0, killed: 0 },
    workers: [],
    teams,
  });
  const agents = { at: 0, totals: { sessions: 0, working: 0, total: 0, teams: 0, teamWorking: 0, soloWorking: 0 }, sessions: [
    rec(true, 2, [{ working: 1 }, { working: 0 }]),
    rec(false, 5, [{ working: 3 }]), // stale heartbeat: never counted
    rec(true, 0, [{ working: 0 }]), // only waiting workers
    rec(true, 3, [], "rpc"), // a headless worker pi is not a host session
  ] } as never;
  const local = { sessions: activeAgentCounts(agents).sessions, teams: activeTeamCount(agents) };
  assert.deepEqual(local, { sessions: 1, teams: 1 });
  const v = llmInflightView(complete(7));
  assert.equal(rowText(agentsRow(v, local), v), "7 agents · 1 session · 1 team");
  assert.deepEqual(agentsRow(v, { sessions: activeAgentCounts(undefined).sessions, teams: activeTeamCount(undefined) }).secondary, [], "no poll yet: nothing local");
});

test("agents row: the definition sentence comes only with a figure above 0", () => {
  const D = "Each agent counted is one model call in flight, background work included.";
  const label = (v: ReturnType<typeof llmInflightView>, sessions = 0) => agentsRow(v, { sessions, teams: 0 }).label;
  assert.equal(label(llmInflightView(null)), "Agents: LLM calls running now: not known yet", "unknown: no definition, as before");
  assert.equal(label(llmInflightView(null), 1), "Agents: LLM calls running now: not known yet. On this host, subagents are working in 1 session.");
  assert.equal(label(llmInflightView(complete(0))), "Agents: No LLM calls running now", "complete 0: no definition");
  assert.equal(label(llmInflightView(complete(1))), `Agents: 1 LLM call running now. ${D}`);
  assert.equal(label(llmInflightView({ count: 2, approximate: 2, partial: false, gaps: [] })), `Agents: No exact LLM calls running now, and 2 one-shots that may be calling. ${D}`);
  const partial0 = llmInflightView({ count: 0, approximate: 0, partial: true, gaps: [{ reason: "claude-internal" }] });
  assert.equal(label(partial0), "Agents: At least 0 LLM calls running now. Claude Code's own internal calls aren't visible.", "a 0+ floor: no definition");
  const partial = llmInflightView({ count: 3, approximate: 0, partial: true, gaps: [{ reason: "claude-internal" }] });
  assert.equal(label(partial), `Agents: At least 3 LLM calls running now. Claude Code's own internal calls aren't visible. ${D}`);
  for (const v of [complete(0), complete(1), complete(9), { count: 4, approximate: 1, partial: true, gaps: [{ reason: "claude-internal" as const }] }, null]) {
    assert.doesNotMatch(label(llmInflightView(v), 2), /\.\.|\. \./, "exactly one full stop between sentences");
  }
});

test("agents word on the row: 0/1/many, partial, approximate, unknown", () => {
  const word = (v: ReturnType<typeof llmInflightView>) => (v.rowWord ? `${v.figure} ${v.rowWord}` : "Agents");
  assert.equal(word(llmInflightView(complete(0))), "0 agents");
  assert.equal(word(llmInflightView(complete(1))), "1 agent");
  assert.equal(word(llmInflightView(complete(6))), "6 agents");
  assert.equal(word(llmInflightView({ count: 1, approximate: 0, partial: true, gaps: [{ reason: "claude-internal" }] })), "1 agents");
  assert.equal(word(llmInflightView({ count: 3, approximate: 1, partial: false, gaps: [] })), "3 agents");
  assert.equal(word(llmInflightView({ count: 3, approximate: 1, partial: true, gaps: [{ reason: "claude-internal" }] })), "3 agents");
  assert.equal(word(llmInflightView(null)), "Agents");
});
