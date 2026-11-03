// A worker's report check (§app.decisions/worker-report): one decision per done report, cached,
// over the report text only, only with attention signals on and never for an excluded session.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { HEntry } from "../shared/harness";
import type { SessionSummary } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-worker-checks-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { workerChecks, workerReports, reportState, REPORT_CHARS } = await import("./worker-checks");
const { createFakeProvider } = await import("./decide-fake");
const { decisionDefaults } = await import("./decide-settings");

const note = (id: string, noteType: string, content: string): HEntry =>
  ({ kind: "note", id, parentId: null, at: "2026-10-01T00:00:00.000Z", noteType, content, display: true, inMessage: false }) as unknown as HEntry;
const done = (id: string, agent: string, body: string, outcome = "success") =>
  note(id, "subagent-complete", `### ${agent} (builder) — waiting · task ${outcome}\nModel: zai/glm-5.3 · thinking: low\n\n${body}`);
const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: "s1", path: "/s/s1.jsonl", cwd: "/w", title: "t", createdAt: "", lastActiveAt: "", model: null, live: null, busy: false, origin: "web", archived: false, ...over }) as SessionSummary;
const on = () => ({ ...decisionDefaults(), features: { ...decisionDefaults().features, attention: true } });
const UNTESTED = { report_outcome: { probabilities: { finished: 0.9, partial: 0.1 } }, claims_unverified: { p: 0.92 } };

test("each worker's newest done report; an error ending is no claim of done", () => {
  const branch = [
    done("e1", "ag_01", "First pass."),
    done("e2", "ag_01", "All done."),
    done("e3", "ag_02", "Crashed.", "error"),
    note("e4", "team-report", "[Team report from coordinator coordinator (ag_03), team_01 — build · milestone]\nShipped the page.\n(Informational: no action is requested.)"),
  ];
  const rs = workerReports(branch);
  assert.deepEqual(rs.map((r) => [r.workerId, r.entry]), [["ag_01", "e2"], ["ag_03", "e4"]]);
  assert.equal(rs[1]!.body.trim(), "Shipped the page.");
});

test("the state is the report only, its body capped", () => {
  const [r] = workerReports([done("e1", "ag_01", `x${"y".repeat(REPORT_CHARS + 50)}`)]);
  const st = reportState(r!);
  assert.deepEqual(Object.keys(st).sort(), ["body", "status", "task_outcome", "worker"]);
  assert.equal((st.body as string).length, REPORT_CHARS + 1);
});

test("asked once per report, cached; a finished report without tests is Untested; a newer report asks again", async () => {
  const fake = createFakeProvider({ reply: UNTESTED });
  const file = join(agentDir, "checks-1.json");
  const deps = { settings: on, provider: () => fake, held: () => true, file };
  const c1 = await workerChecks(session(), [done("e1", "ag_01", "Done, didn't run tests.")], deps);
  assert.deepEqual(c1.workers.ag_01 && { o: c1.workers.ag_01.outcome, u: c1.workers.ag_01.unverified, r: c1.workers.ag_01.report }, { o: "finished", u: true, r: "e1" });
  assert.equal(fake.calls[0]!.purpose, "worker-report");
  await workerChecks(session(), [done("e1", "ag_01", "Done, didn't run tests.")], deps);
  assert.equal(fake.calls.length, 1, "the same report is never asked twice");
  await workerChecks(session(), [done("e1", "ag_01", "x"), done("e2", "ag_01", "Done again.")], deps);
  assert.equal(fake.calls.length, 2);
});

test("a partial report is never Untested, however high claims_unverified is", async () => {
  const fake = createFakeProvider({ reply: { report_outcome: { probabilities: { partial: 1 } }, claims_unverified: { p: 0.99 } } });
  const c = await workerChecks(session(), [done("e1", "ag_01", "Half.")], { settings: on, provider: () => fake, held: () => true, file: join(agentDir, "checks-2.json") });
  assert.equal(c.workers.ag_01?.unverified, false);
});

test("nothing is asked while attention signals are off, for an excluded session, with no provider, or on a failure", async () => {
  const fake = createFakeProvider({ reply: UNTESTED });
  const file = join(agentDir, "checks-3.json");
  const b = [done("e1", "ag_01", "Done.")];
  assert.deepEqual((await workerChecks(session(), b, { settings: () => decisionDefaults(), provider: () => fake, held: () => true, file })).workers, {});
  assert.deepEqual((await workerChecks(session({ baton: { role: "operator" } as never }), b, { settings: on, provider: () => fake, held: () => true, file })).workers, {});
  assert.deepEqual((await workerChecks(session(), b, { settings: on, provider: () => null, held: () => true, file })).workers, {});
  assert.equal(fake.calls.length, 0);
  const failing = createFakeProvider({ reply: { fail: "network" } });
  assert.deepEqual((await workerChecks(session(), b, { settings: on, provider: () => failing, held: () => true, file })).workers, {});
});
