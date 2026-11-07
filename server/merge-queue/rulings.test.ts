import { test } from "node:test";
import assert from "node:assert/strict";
import type { MergeRun, RunStep } from "../../shared/merge-queue";
import { cleanChoices, decisionPush, fingerprintOf, resolveVerdict, sendBackText } from "./rulings";

const step = (o: Partial<RunStep> & { id: string }): RunStep => ({ kind: "check", label: o.id, result: "failed", ms: 1, log: `${o.id}.log`, ...o });
const run = (steps: RunStep[], id = "mr_1"): MergeRun => ({ id, entry: "mq_1", project: "p", branch: "feat/x", base: "a".repeat(40), commit: "b".repeat(40), steps, checks: [], verdict: "failed", startedAt: "t" });
const e = { branch: "feat/x", target: "master", commit: "b".repeat(40) };

test("verdicts: the old word reads as needs-user; anything else is refused", () => {
  assert.equal(resolveVerdict("behaviour-differs"), "needs-user");
  assert.equal(resolveVerdict("chat-fixes"), "chat-fixes");
  assert.equal(resolveVerdict("no-behaviour-change"), "no-behaviour-change");
  assert.equal(resolveVerdict("send-back"), null);
});

test("choices: trimmed, empties dropped, at most four", () => {
  assert.deepEqual(cleanChoices([" a ", "", "b", 3, "c", "d", "e"]), ["a", "b", "c", "d"]);
  assert.deepEqual(cleanChoices("a"), []);
});

test("the same failure: same failing tests, files or findings compare equal in any order; a different one doesn't", () => {
  const r1 = run([step({ id: "check:unit", failures: [{ file: "a.test.ts", name: "x" }, { file: "b.test.ts", name: "y" }] })]);
  const r2 = run([step({ id: "check:unit", failures: [{ file: "b.test.ts", name: "y" }, { file: "a.test.ts", name: "x" }] })], "mr_2");
  const r3 = run([step({ id: "check:unit", failures: [{ file: "c.test.ts", name: "z" }] })], "mr_3");
  assert.equal(fingerprintOf({ cause: "checks", run: r1 }), fingerprintOf({ cause: "checks", run: r2 }));
  assert.notEqual(fingerprintOf({ cause: "checks", run: r1 }), fingerprintOf({ cause: "checks", run: r3 }));
  assert.equal(fingerprintOf({ cause: "conflict", files: ["b", "a"] }), fingerprintOf({ cause: "conflict", files: ["a", "b"] }));
  assert.notEqual(fingerprintOf({ cause: "conflict", files: ["a"] }), fingerprintOf({ cause: "conflict", files: ["a", "b"] }));
  assert.equal(fingerprintOf({ cause: "review", review: "Dead code in a.ts (abc1234)" }), fingerprintOf({ cause: "review", review: "dead code in a.ts (def5678)" }));
  assert.notEqual(fingerprintOf({ cause: "review", review: "dead code" }), fingerprintOf({ cause: "conflict", files: [] }));
});

test("a step with no parsed tests is told apart by what it says: other errors differ, the same error is the same", () => {
  const tc = (detail: string, id: string) => run([step({ id: "check:typecheck", detail })], id);
  const a = fingerprintOf({ cause: "checks", run: tc("src/a.ts(480,31): error TS2345", "mr_1") });
  const a2 = fingerprintOf({ cause: "checks", run: tc("src/a.ts(481,2): error TS2345", "mr_2") });
  const b = fingerprintOf({ cause: "checks", run: tc("src/b.ts(12,1): error TS2304", "mr_3") });
  assert.equal(a, a2, "the same error, its line moved");
  assert.notEqual(a, b);
  const t1 = fingerprintOf({ cause: "checks", run: tc("exit 2", "mr_4"), tails: { "check:typecheck": "server/x.ts: Cannot find name 'foo'" } });
  const t2 = fingerprintOf({ cause: "checks", run: tc("exit 2", "mr_5"), tails: { "check:typecheck": "server/y.ts: Type 'string' is not assignable" } });
  assert.notEqual(t1, t2, "the log's tail tells them apart");
});

test("a send-back's request: what failed, its log, the diagnosis, the try; a conflict's names only this conflict", () => {
  const r = run([step({ id: "check:unit", label: "Unit tests", detail: "1 failed", failures: [{ file: "a.test.ts", name: "adds", message: "expected 2\nstack" }] }), step({ id: "rerun-master:unit", kind: "rerun-master" })]);
  const t = sendBackText(e, { cause: "checks", why: "unit failed: a.test.ts", run: r, logDir: "/runs/mr_1", diagnosis: "a.ts returns 3 now", attempt: { try: 2, of: 3 } });
  assert.match(t, /^feat\/x didn't land \(try 2 of 3\): unit failed: a\.test\.ts\./);
  assert.match(t, /- Unit tests: 1 failed \(a\.test\.ts › adds\) · log \/runs\/mr_1\/check:unit\.log/);
  assert.match(t, /\n {2}expected 2\n/);
  assert.doesNotMatch(t, /rerun-master/);
  assert.match(t, /The merge thread's diagnosis: a\.ts returns 3 now/);
  assert.match(t, /answer this request by its id/);
  const c = sendBackText(e, { cause: "conflict", why: "conflicts", files: ["b.ts"] });
  assert.match(c, /^feat\/x conflicts with master in b\.ts, as master is now\./);
  assert.doesNotMatch(c, /Unit tests|diagnosis/);
  const rv = sendBackText(e, { cause: "review", why: "flagged", review: "dead code in a.ts" });
  assert.match(rv, /review found problems in feat\/x at bbbbbbb:\ndead code in a\.ts/);
  assert.doesNotMatch(rv, /conflicts/);
});

test("a decision's notification: the chat that shows it, else the Merge Queue tab where it waits; one tag per entry", () => {
  const d = { id: "dc_1", kind: "needs-you" as const, question: "Which wording?\nmore", choices: [], raisedBy: "chat" as const, actions: [], at: "t" };
  const inChat = decisionPush({ id: "mq_1", branch: "feat/x", session: "s1", decision: d }, "p1");
  assert.deepEqual(inChat, { title: "The merge queue needs you · feat/x", body: "Which wording?", hash: "#/sid/s1", tag: "sova:merge-decision:mq_1" });
  // Its chat can't show it (archived, open in a terminal, an Overseer, a baton chat): the tab, though it has a session.
  assert.equal(decisionPush({ id: "mq_1", branch: "feat/x", session: "s1", decision: d }, "p1", { onTab: true }).hash, "#/projects/p1/merge-queue");
  assert.equal(decisionPush({ id: "mq_1", branch: "feat/x", decision: d }, null, { onTab: true }).hash, "#/projects");
});
