// record_tour's supplied credentials stay in the chat's own file only: every projection of its
// arguments Sova makes (the live stream, the transcript's tool content, the memory log, the attention
// signals' facts, an older server's rows) shows "[hidden]" (§app.tours/sites). A canary password must
// appear in none of them; a control tool's arguments pass through unchanged.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { V1EventFrame } from "../shared/protocol";
import { upgradeLegacyRows } from "../src/lib/legacy-rows";
const agentDir = mkdtempSync(join(tmpdir(), "sova-tour-hidden-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before modules that compute state paths at import
after(() => rmSync(agentDir, { recursive: true, force: true }));
const { toV1Event, v1Frame, v2Frames } = await import("./harness/pi/wire");
const { historyOf } = await import("./harness/pi/reader");
const { normalizeEntries, toolContents } = await import("./transcript");
const { entryMessages } = await import("./memory/log");
const sig = await import("./attention-signals");

const PASSWORD = "fake-pw-03";
const USER = "canary-user-2a7f9";
const ACCOUNT = "canary-acct-8c4d2"; // an account box's value (a site's pre-filled code box): as hidden as the rest
const args = { op: "dry-run", script: { title: "Orders" }, credentials: { "https://app.example": { account: ACCOUNT, username: USER, password: PASSWORD } } };
const bashArgs = { command: `echo ${PASSWORD}` }; // the control: another tool's arguments are not touched
const leaks = (v: unknown) => { const s = JSON.stringify(v) ?? ""; return s.includes(PASSWORD) || s.includes(USER) || s.includes(ACCOUNT); };
const AT = "2026-10-15T12:00:00.000Z";
const assistantMessage = { role: "assistant", content: [{ type: "toolCall", id: "call-tour", name: "record_tour", arguments: args }, { type: "toolCall", id: "call-bash", name: "bash", arguments: bashArgs }], stopReason: "toolUse", timestamp: 1 };
const entries = [
  { type: "message", id: "u1", parentId: null, timestamp: AT, message: { role: "user", content: [{ type: "text", text: "record it" }], timestamp: 0 } },
  { type: "message", id: "a1", parentId: "u1", timestamp: AT, message: assistantMessage },
  { type: "message", id: "r1", parentId: "a1", timestamp: AT, message: { role: "toolResult", toolCallId: "call-tour", toolName: "record_tour", content: [{ type: "text", text: "{}" }], isError: false, timestamp: 2 } },
];

test("the live stream never carries record_tour's credentials: deltas are empty, ends and whole messages hidden", () => {
  const partial = { content: [{ type: "toolCall", id: "call-tour", name: "record_tour", arguments: {} }] };
  const delta = toV1Event({ type: "message_update", message: { usage: {} }, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: `{"credentials":{"x":{"password":"${PASSWORD}"`, partial } });
  assert.ok(!leaks(delta), "a record_tour delta carries nothing");
  const bashDelta = toV1Event({ type: "message_update", message: { usage: {} }, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: PASSWORD, partial: { content: [{ type: "toolCall", id: "b", name: "bash" }] } } });
  assert.ok(leaks(bashDelta), "control: another tool's delta streams as it is");
  const end = toV1Event({ type: "message_update", message: { usage: {} }, assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call-tour", name: "record_tour", arguments: args } } });
  assert.ok(!leaks(end));
  assert.equal((end as any).assistantMessageEvent.toolCall.arguments.credentials, "[hidden]");
  for (const type of ["message_start", "message_end", "turn_end"]) {
    const ev = toV1Event({ type, message: assistantMessage });
    assert.ok(!leaks((ev as any).message.content[0]), `${type}: the record_tour block is hidden`);
    assert.deepEqual((ev as any).message.content[1].arguments, bashArgs, `${type}: the bash block is untouched`);
  }
  for (const type of ["tool_execution_start", "tool_execution_end"]) {
    const ev = toV1Event({ type, toolCallId: "call-tour", toolName: "record_tour", args });
    assert.ok(!leaks(ev), type);
  }
  // The wire-2 frames the browser gets are made from the hidden wire-1 frame.
  const frames = v2Frames({ type: "event", event: toV1Event({ type: "message_end", message: assistantMessage }) } as V1EventFrame);
  assert.ok(!leaks((frames[0]!.event as any).parts[0]));
  // The composition the session sends (session.ts: v1Frame, then v2Frames), on one-tool messages so the
  // whole frame list is checked: record_tour's hidden, a bash control's carried as it is.
  const tourOnly = { ...assistantMessage, content: [assistantMessage.content[0]] };
  const bashOnly = { ...assistantMessage, content: [assistantMessage.content[1]] };
  // turn_end has no wire-2 frame of its own (fromV1 maps it to none); its wire-1 check is above.
  assert.equal(v2Frames(v1Frame({ type: "turn_end", message: bashOnly })).length, 0, "turn_end sends no wire-2 frame");
  for (const type of ["message_end"]) {
    const sent = v2Frames(v1Frame({ type, message: tourOnly }));
    assert.ok(sent.length > 0, `${type}: v2Frames(v1Frame(…)) sends frames`);
    assert.ok(!leaks(sent), `${type}: v2Frames(v1Frame(…)) carries no credentials`);
    assert.ok(leaks(v2Frames(v1Frame({ type, message: bashOnly }))), `${type}: control, the bash frames carry the canary`);
  }
  const endFrames = v2Frames(v1Frame({ type: "message_update", message: { usage: {} }, assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call-tour", name: "record_tour", arguments: args } } }));
  assert.ok(!leaks(endFrames), "toolcall_end through v2Frames(v1Frame(…))");
  assert.ok(leaks(assistantMessage), "the original message still holds them (the chat's own file)");
});

test("the transcript's opened tool card shows record_tour's credentials hidden", () => {
  const rows = normalizeEntries(entries as never);
  const call = rows.find(r => r.kind === "tool-call" && r.text === "record_tour")!;
  const bash = rows.find(r => r.kind === "tool-call" && r.text === "bash")!;
  assert.ok(!leaks(rows.find(r => r === call)), "the eager row carries no credentials");
  const content = toolContents(rows, [call.id, bash.id]);
  assert.deepEqual((content[call.id]!.args as any).credentials, "[hidden]");
  assert.ok(!leaks(content[call.id]));
  assert.deepEqual(content[bash.id]!.args, bashArgs, "control: the bash card is unchanged");
});

test("the folded tool line's summary (slimTool) is made from tourCardArgs, never the raw arguments", () => {
  // A malformed call whose credentials are a string, first among its values: the raw arguments' summary
  // would be that string; tourCardArgs leaves only the op. The bash control shows the raw path does leak.
  const stray = { credentials: `${USER}:${PASSWORD}`, op: "dry-run" };
  const message = { role: "assistant", content: [{ type: "toolCall", id: "call-stray", name: "record_tour", arguments: stray }, { type: "toolCall", id: "call-bash", name: "bash", arguments: bashArgs }], stopReason: "toolUse", timestamp: 1 };
  const rows = normalizeEntries([entries[0], { type: "message", id: "a2", parentId: "u1", timestamp: AT, message }] as never);
  const call = rows.find(r => r.kind === "tool-call" && r.text === "record_tour")!;
  const bash = rows.find(r => r.kind === "tool-call" && r.text === "bash")!;
  assert.equal(call.tool?.summary, "dry-run", "the summary is the op alone");
  assert.ok(!leaks(call), "nothing on the row carries the canary");
  assert.ok(leaks(bash.tool?.summary), "control: a raw-arguments summary carries it");
});

test("the memory log and the attention signals' facts never copy record_tour's credentials", () => {
  const history = historyOf(entries as never);
  const logged = history.flatMap(h => entryMessages(h));
  assert.ok(logged.some(m => m.text.startsWith("record_tour ")), "the call is still logged");
  assert.ok(!logged.some(m => m.text.startsWith("record_tour ") && leaks(m.text)));
  assert.ok(logged.some(m => m.text.startsWith("bash ") && m.text.includes(PASSWORD)), "control: bash is logged as it is");
  // turnFacts reads a FINISHED turn (its last reply isn't a toolUse stop): the bash result and a closing reply end it.
  const finished = historyOf([
    ...entries,
    { type: "message", id: "r2", parentId: "r1", timestamp: AT, message: { role: "toolResult", toolCallId: "call-bash", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 } },
    { type: "message", id: "a2", parentId: "r2", timestamp: AT, message: { role: "assistant", content: [{ type: "text", text: "Recorded." }], stopReason: "stop", timestamp: 4 } },
  ] as never);
  const facts = sig.turnFacts(finished);
  assert.ok(facts, "the turn has facts");
  const tour = facts.tools.find(t => t.name === "record_tour");
  assert.ok(tour, "record_tour is among the facts' tools");
  assert.ok(!leaks(tour.args) && tour.args.includes("[hidden]"), "record_tour's facts carry its credentials hidden");
  assert.ok(facts.tools.some(t => t.name === "bash" && t.args.includes(PASSWORD)), "control: bash's facts carry the canary");
  assert.ok(!JSON.stringify(facts.tools.filter(t => t.name !== "bash")).includes(USER));
});

test("an older server's rows show record_tour's credentials hidden too", () => {
  const rows = upgradeLegacyRows([{ kind: "tool-call", id: "a1:0", text: "record_tour", toolCallId: "call-tour", raw: entries[1] }] as any[]);
  assert.ok(!leaks((rows[0] as any).tool));
});
