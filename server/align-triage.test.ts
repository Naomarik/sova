// Triage on an alignment card (§app.decisions/align-triage): one decision per card version, cached,
// only with attention signals on and never for an excluded session; accepting is untouched.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { HEntry } from "../shared/harness";
import type { SessionSummary } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-align-triage-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { alignTriage, triageQuestions, triageState } = await import("./align-triage");
const { createFakeProvider } = await import("./decide-fake");
const { decisionDefaults } = await import("./decide-settings");

const { applyAlignCall } = await import("../pi-config/extensions/mode/align.ts");
type AlignDocument = import("../pi-config/extensions/mode/align.ts").AlignDocument;
const env = { now: "2026-10-01T00:00:00.000Z", readFile: () => "" };
const Q = (topic: string) => ({
  topic,
  ask: `What about ${topic}?`,
  options: [
    { label: "Drop the table", tradeoff: "Old rows are deleted for good" },
    { label: "Keep it", tradeoff: "Nothing changes" },
  ],
  recommendation: { choice: "Keep it", why: "safer" },
});
/** al_1 at rev 1 (q1, q2 open, q3 decided), and each later rev one edit on. */
function docAt(rev: number): AlignDocument {
  let d = applyAlignCall([], { ops: [{ op: "create", title: "Cleanup", summary: "Drop old tables.", findings: ["SECRET-FINDING"], questions: [Q("a"), Q("b"), Q("c")] }, { op: "decide", q: "q3", decision: "Keep it" }] }, env).details.doc!;
  while (d.rev < rev) d = applyAlignCall([d], { doc: "al_1", ops: [{ op: "edit_question", q: "q1", ask: `Rev ${d.rev}?` }] }, env).details.doc!;
  return d;
}
const doc = (rev: number) => docAt(rev);
const branch = (rev: number): HEntry[] => [{ kind: "tool-result", id: `r${rev}`, parentId: null, at: env.now, tool: "align", callId: "c", isError: false, blocks: [], details: JSON.parse(JSON.stringify({ v: 1, doc: docAt(rev), changes: [], line: "" })) } as unknown as HEntry];
const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: "s1", path: "/s/s1.jsonl", cwd: "/w", title: "t", createdAt: "", lastActiveAt: "", model: null, live: null, busy: false, origin: "web", archived: false, ...over }) as SessionSummary;
const REPLY = { stakes_q1: { probabilities: { "deletes-data": 0.9, "low-risk": 0.1 } }, stakes_q2: { probabilities: { "low-risk": 1 } } };
const on = () => ({ ...decisionDefaults(), features: { ...decisionDefaults().features, attention: true } });

test("one question per open question, over the title, summary and open questions only", () => {
  assert.deepEqual(Object.keys(triageQuestions(doc(1) as never)), ["stakes_q1", "stakes_q2"]);
  const st = JSON.stringify(triageState(doc(1) as never));
  assert.equal(st.includes("SECRET-FINDING"), false, "never the findings");
  assert.ok(st.includes("Old rows are deleted for good"), "each option's consequence line");
});

test("each stakes question names its own question by id and topic, and no other", () => {
  const qs = triageQuestions(doc(1) as never) as Record<string, { instructions: string }>;
  const i1 = qs.stakes_q1!.instructions, i2 = qs.stakes_q2!.instructions;
  assert.ok(i1.includes("q1") && i1.includes('"a"'), i1);
  assert.ok(i2.includes("q2") && i2.includes('"b"'), i2);
  assert.equal(/\bq2\b/.test(i1), false, "q1's instructions never name q2");
  assert.equal(/\bq1\b/.test(i2), false, "q2's instructions never name q1");
  assert.notEqual(i1, i2);
});

test("asked once per card version, cached; a new version asks again", async () => {
  const fake = createFakeProvider({ reply: REPLY });
  const file = join(agentDir, "triage-1.json");
  const deps = { settings: on, provider: () => fake, held: () => true, file };
  const t1 = await alignTriage(session(), branch(1), deps);
  assert.deepEqual(t1.docs.al_1?.stakes, { q1: "deletes-data", q2: "low-risk" });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.purpose, "align-triage");
  await alignTriage(session(), branch(1), deps);
  assert.equal(fake.calls.length, 1, "the same version is never asked twice");
  const t2 = await alignTriage(session(), branch(2), deps);
  assert.equal(fake.calls.length, 2);
  assert.equal(t2.docs.al_1?.rev, 2);
});

test("nothing is asked while attention signals are off, for an excluded session, or with no provider", async () => {
  const fake = createFakeProvider({ reply: REPLY });
  const file = join(agentDir, "triage-2.json");
  const off = await alignTriage(session(), branch(1), { settings: () => decisionDefaults(), provider: () => fake, held: () => true, file });
  assert.deepEqual(off.docs, {});
  const baton = await alignTriage(session({ baton: { role: "operator" } as never }), branch(1), { settings: on, provider: () => fake, held: () => true, file });
  assert.deepEqual(baton.docs, {});
  const none = await alignTriage(session(), branch(1), { settings: on, provider: () => null, held: () => true, file });
  assert.deepEqual(none.docs, {});
  assert.equal(fake.calls.length, 0);
});
