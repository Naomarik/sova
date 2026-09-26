// Run: npx tsx --test server/reports.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeTeamEventData, parseReport, parseTeamMessage, teamEventOf, teamEventText } from "./reports";

const report = (...lines: string[]) => parseReport("subagent-complete", lines.join("\n"));
const HEAD = "### ag_01 (ui-review) — done · task success";
const SESSION = "Session: ~/.pi/agent/sessions/abc.jsonl";

test("model line: model, thinking and backend, kept out of body and preview", () => {
  const r = report(HEAD, SESSION, "Model: claude-sonnet-4-6 · thinking: high · backend: claude-code",
    "", "Reviewed the composer.", "Second line.");
  assert.equal(r.model, "claude-sonnet-4-6");
  assert.equal(r.effort, "high");
  assert.equal(r.backend, "claude-code");
  assert.equal(r.body, "Reviewed the composer.\nSecond line.");
  assert.equal(r.preview, "Reviewed the composer.");
});

test("model line without a backend; a provider/model id keeps its slash", () => {
  const r = report(HEAD, SESSION, "Model: ollama-cloud/kimi-k3 · thinking: medium", "", "Done.");
  assert.equal(r.model, "ollama-cloud/kimi-k3");
  assert.equal(r.effort, "medium");
  assert.equal(r.backend, undefined);
  assert.equal(r.body, "Done.");
});

test("no session line: the model line is still peeled", () => {
  const r = report(HEAD, "Model: claude-sonnet-4-6 · thinking: low", "", "Done.");
  assert.equal(r.session, undefined);
  assert.equal(r.model, "claude-sonnet-4-6");
  assert.equal(r.effort, "low");
  assert.equal(r.body, "Done.");
});

test("old format without a model line is unchanged; preview is the first body line", () => {
  const r = report(HEAD, SESSION, "", "", "# Findings", "One issue.");
  assert.equal(r.model, undefined);
  assert.equal(r.effort, undefined);
  assert.equal(r.backend, undefined);
  assert.equal(r.body, "# Findings\nOne issue.");
  assert.equal(r.preview, "Findings");
});

test("sentinel values pass through verbatim", () => {
  const r = report(HEAD, SESSION, "Model: child default · thinking: default", "", "Done.");
  assert.equal(r.model, "child default");
  assert.equal(r.effort, "default");
});

test("model line present, body empty", () => {
  const r = report(HEAD, SESSION, "Model: claude-sonnet-4-6 · thinking: high · backend: claude-code");
  assert.equal(r.model, "claude-sonnet-4-6");
  assert.equal(r.effort, "high");
  assert.equal(r.body, "");
  assert.equal(r.preview, "");
});

test("malformed line: no model leaves every field unset, and unknown keys are ignored", () => {
  const empty = report(HEAD, SESSION, "Model: ", "", "Done.");
  assert.equal(empty.model, undefined);
  assert.equal(empty.body, "Done.");

  const bare = report(HEAD, SESSION, "Model: claude-sonnet-4-6", "", "Done.");
  assert.deepEqual([bare.model, bare.effort, bare.backend], ["claude-sonnet-4-6", undefined, undefined]);

  const odd = report(HEAD, SESSION, "Model: kimi · thinking: · nonsense · temperature: 0.7 · backend: claude-code",
    "", "Done.");
  assert.deepEqual([odd.model, odd.effort, odd.backend], ["kimi", undefined, "claude-code"]);
  assert.equal(odd.body, "Done.");
});

test("a body line that looks like the model line is left alone", () => {
  const r = report(HEAD, SESSION, "", "Model: gpt-5 · thinking: high");
  assert.equal(r.model, undefined);
  assert.equal(r.body, "Model: gpt-5 · thinking: high");
});

// Coordinated teams: the header regexes are pinned against the extension's literal formats.
const INFO = "(Informational: no action is requested. The coordinator asks questions as team-question messages.)";
const teamReport = (head: string, ...body: string[]) => parseTeamMessage("team-report", [head, ...body, "", INFO].join("\n"));

test("team report with a kind: header fields, label from the suffix, trailer peeled", () => {
  const t = teamReport("[Team report from coordinator coordinator (ag_01), team_01 — e2e-file-test · concern]", "The writer is stuck on c.txt.", "Second line.");
  assert.deepEqual(t?.team, { kind: "report", role: "coordinator", workerId: "ag_01", teamId: "team_01", teamName: "e2e-file-test", label: "concern" });
  assert.equal(t?.body, "The writer is stuck on c.txt.\nSecond line.");
  assert.equal(t?.truncated, false);
});

test("team report without a kind: a leading Milestone: line is the label and leaves the body", () => {
  const t = teamReport("[Team report from coordinator lead (ag_07), team_12 — docs · pass 2]", "Milestone: objective complete. All 3 files written.");
  assert.equal(t?.team.label, "milestone");
  assert.equal(t?.team.teamName, "docs · pass 2", "a middle dot in the name is not a kind");
  assert.equal(t?.body, "objective complete. All 3 files written.");
});

test("team report: neither suffix nor leading line → no label; a body label that disagrees with the header stays", () => {
  const plain = teamReport("[Team report from coordinator coordinator (ag_01), team_01 — e2e-file-test]", "Halfway there.");
  assert.equal(plain?.team.label, undefined);
  assert.equal("label" in (plain?.team ?? {}), false);
  const mixed = teamReport("[Team report from coordinator coordinator (ag_01), team_01 — x · concern]", "Milestone: done, but see below.");
  assert.equal(mixed?.team.label, "concern");
  assert.equal(mixed?.body, "Milestone: done, but see below.");
  const same = teamReport("[Team report from coordinator coordinator (ag_01), team_01 — x · milestone]", "milestone — shipped.");
  assert.equal(same?.body, "shipped.");
});

test("team report cut at 4000: [truncated] is peeled and flagged", () => {
  const t = teamReport("[Team report from coordinator coordinator (ag_01), team_01 — x]", "a".repeat(10), "[truncated]");
  assert.equal(t?.truncated, true);
  assert.equal(t?.body, "a".repeat(10));
});

test("team question: role, orchestrator flag, ids; the answer line for THIS asker is peeled", () => {
  const answer = 'Answer with agent_steer { id: "ag_01", message: "<answer>" }; the member continues (or resumes, if idle) from your message. If only the user can decide, ask them and relay their answer the same way.';
  const q = parseTeamMessage("team-question", ["[Team question from coordinator, orchestrator (ag_01), team_01 — e2e-file-test]", "Should c.txt be JSON?", "", answer].join("\n"));
  assert.deepEqual(q?.team, { kind: "question", role: "coordinator", workerId: "ag_01", teamId: "team_01", teamName: "e2e-file-test", orchestrator: true });
  assert.equal(q?.body, "Should c.txt be JSON?");
  const other = parseTeamMessage("team-question", ["[Team question from writer (ag_02), team_01 — e2e]", "Which?", "", answer].join("\n"));
  assert.equal(other?.team.orchestrator, undefined);
  assert.equal(other?.body, `Which?\n\n${answer}`, "an answer line naming another worker is body");
});

test("team messages: a header that doesn't parse, or another customType, is not a team message", () => {
  assert.equal(parseTeamMessage("team-report", "[Team report from writer (ag_02), team_01: done — routed to you as coordinator]\nx"), null);
  assert.equal(parseTeamMessage("team-report", "Milestone: no header at all"), null);
  assert.equal(parseTeamMessage("team-report", "[Team report from coordinator c (ag_x), team_01 — t]\nx"), null);
  assert.equal(parseTeamMessage("subagent-complete", "[Team report from coordinator c (ag_01), team_01 — t]\nx"), null);
  assert.equal(parseTeamMessage("team-question", "[Team question from w (ag_02) — e2e]\nx"), null, "no team id");
});

const ev = (kind: string, detail?: string, over: Record<string, unknown> = {}) =>
  ({ version: 1, teamId: "team_01", kind, workerId: "ag_02", role: "writer", at: 1790363063971, ...(detail !== undefined ? { detail } : {}), ...over });

test("team events: every kind decodes to one sentence", () => {
  const text = (d: unknown) => {
    const x = decodeTeamEventData(d);
    assert.ok(x, JSON.stringify(d));
    return teamEventText(x);
  };
  assert.equal(text(ev("handover", "successor writer-2 (ag_04) on pi/zai/glm-5.3-flash; retire on team_ready or after 2 min")), "writer handed over to writer-2 (ag_04).");
  assert.equal(text(ev("handover", "something else")), "writer is handing over to a successor.");
  assert.equal(text(ev("retire", "retired: successor writer-2 (ag_04) confirmed the takeover")), "writer retired. writer-2 confirmed the takeover.");
  assert.equal(text(ev("retire", "retired: handover to monitor-2 (ag_05) timed out")), "writer retired. The handover to monitor-2 timed out.");
  assert.equal(text(ev("retire")), "writer retired.");
  assert.equal(text(ev("pause", "pause → coordinator: zai 5h at 95%, resets 7:09 PM. Whole team wrap up.", { role: "monitor-2" })), "monitor-2 paused the team: zai 5h at 95%, resets 7:09 PM. Whole team wrap up.");
  assert.equal(text(ev("pause", undefined, { role: "monitor-2" })), "monitor-2 paused the team.");
  assert.equal(text(ev("resume", "resume → coordinator: window reset.", { role: "monitor-2" })), "monitor-2 resumed the team.");
  assert.equal(text(ev("wrap-up", "context 78% of 200k")), "writer was asked to wrap up: context 78% of 200k.");
  assert.equal(text(ev("wrap-up")), "writer was asked to wrap up.");
  // Long details are cut to one line of 120 characters; the whole detail stays on the event.
  const long = text(ev("pause", `pause → coordinator: ${"usage is high ".repeat(20)}`, { role: "monitor-2" }));
  assert.ok(long.startsWith("monitor-2 paused the team: usage is high usage"));
  assert.equal(long.length, "monitor-2 paused the team: ".length + 120);
  assert.ok(long.endsWith("…"));
  assert.ok(text(ev("wrap-up", "x".repeat(300))).endsWith("x…"));
});

test("team events: strict — any field off decodes to null", () => {
  for (const bad of [
    ev("report"), ev("handover", undefined, { version: 2 }), ev("pause", undefined, { teamId: "t1" }), ev("pause", undefined, { workerId: "writer" }),
    ev("pause", undefined, { role: "" }), ev("pause", undefined, { at: "1790363063971" }), ev("pause", undefined, { at: Number.NaN }),
    ev("pause", "x".repeat(501)), ev("pause", 42 as unknown as string), null, [], "handover",
  ]) assert.equal(decodeTeamEventData(bad), null, JSON.stringify(bad));
  assert.ok(decodeTeamEventData(ev("pause", "x".repeat(500))));
});

test("teamEventOf: the wire event, with the entry id and an ISO time", () => {
  const e = teamEventOf({ id: "a9cfcbaa", data: ev("wrap-up", "context 78% of 200k") });
  assert.deepEqual(e, { id: "a9cfcbaa", teamId: "team_01", kind: "wrap-up", workerId: "ag_02", role: "writer", at: "2026-09-25T19:04:23.971Z", detail: "context 78% of 200k", text: "writer was asked to wrap up: context 78% of 200k." });
  assert.equal(teamEventOf({ id: "x", data: { nope: 1 } }), null);
});
