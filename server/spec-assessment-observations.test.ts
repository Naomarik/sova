import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSpecAssessmentObservations } from "./spec-assessment-observations";
import { ASSESSMENT_TASK_ENTRY, type AssessmentCall } from "../pi-config/extensions/mode/spec-assessment.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
 const root = await mkdtemp(join(tmpdir(), "spec-observation-")); t.after(() => rm(root, { recursive: true, force: true }));
 await mkdir(join(root, ".sova/spec"), { recursive: true }); await writeFile(join(root, ".sova/spec/manifest.json"), "{}\n");
 const owner = join(root, "owner.jsonl"), worker = join(root, "worker.jsonl");
 const a = { ownerSessionId: "owner", sessionId: "worker", workerId: "ag_01", teamId: "team", taskId: "u1", attemptId: "attempt1" };
 const workerEntries = [{ type: "session", version: 3, id: "worker", cwd: root }, { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "task" }] } }, { type: "custom", id: "snapshot", parentId: "u1", customType: ASSESSMENT_TASK_ENTRY, data: { root, attemptId: "attempt1", task: { sessionId: "worker", taskId: "u1" } } }];
 const ownerEntries = [{ type: "session", version: 3, id: "owner", cwd: root }, { type: "message", id: "parent-u", parentId: null, message: { role: "user", content: [] } }, { type: "custom", id: "manifest", parentId: "parent-u", customType: "subagents-worker-manifest", data: { v: 1, kind: "worker-manifest", workerId: "ag_01", backend: "pi", at: 1, spec: { cwd: root, taskPreview: "task", wake: true }, team: { teamId: "team", role: "author" }, ref: { v: 1, backend: "pi", kind: "pi-session-file", locator: worker, sessionId: "worker", cwd: root } } }];
 const put = (file: string, entries: unknown[]) => writeFile(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
 await put(worker, workerEntries); await put(owner, ownerEntries);
 const raw: Record<string, unknown> = { name: "receipt", fingerprint: "a".repeat(64), capturedGitHead: "b".repeat(40), attribution: a, recordAttribution: null, applicability: "current", assessmentState: "outstanding", coverage: { unresolvedIds: ["§demo/rule"], unresolvedFiles: [] }, verification: { passed: [], failed: [], unknown: [] }, decisions: null, unknowns: [], reasons: [] };
 const call: AssessmentCall = async () => ({ exit: 0, state: "observed", observations: [raw], excluded: 0, reasons: [] });
 return { root, owner, worker, raw, a, workerEntries, ownerEntries, put, read: () => readSpecAssessmentObservations({ id: "owner", path: owner }, [root], { core: root, call }) };
}

test("worker attribution uses durable owner manifest, actual user boundary and actual attempt; verification input mismatch stays separate", async t => {
 const f = await fixture(t);
 f.raw.decisions = {}; f.raw.recordAttribution = f.a;
 f.raw.verification = { passed: [{ kind: "test", revision: "HEAD", result: "passed", summary: "declared test", revisionBinding: { source: "recorder-declaration", revisionCommit: "b".repeat(40), inputApplicability: "mismatched" } }], failed: [], unknown: [] };
 const out = await f.read();
 assert.equal(out?.state, "observed"); assert.equal(out?.items[0]?.attributionState, "matched");
 assert.equal(out?.items[0]?.applicability, "current"); assert.equal(out?.items[0]?.verification[0]?.result, "passed");
 assert.equal(out?.items[0]?.verification[0]?.revisionBinding?.inputApplicability, "mismatched");
});

test("wrong task does not become byte staleness, and a forged manifest session does not match the actual header", async t => {
 const f = await fixture(t); f.raw.attribution = { ...f.a, taskId: "not-current" };
 let out = await f.read(); assert.equal(out?.items[0]?.attributionState, "conflicting"); assert.equal(out?.items[0]?.applicability, "current");
 f.raw.attribution = f.a;
 const manifest = f.ownerEntries[2] as unknown as { data: { ref: { sessionId: string } } }; manifest.data.ref.sessionId = "different-session";
 await f.put(f.owner, f.ownerEntries);
 out = await f.read(); assert.equal(out?.items[0]?.attributionState, "conflicting");
});

test("record missing attribution and unrecorded attempt remain unknown rather than the preparation's known identity", async t => {
 const f = await fixture(t); f.raw.decisions = {}; f.raw.recordAttribution = null;
 assert.equal((await f.read())?.items[0]?.attributionState, "unknown");
 f.raw.recordAttribution = { ...f.a, attemptId: "unrecorded-attempt" };
 assert.equal((await f.read())?.items[0]?.attributionState, "unknown");
});

test("partial worker input, malformed verification and absent unknown inventory never silently report complete observations", async t => {
 const f = await fixture(t); await appendFile(f.worker, '{"torn":');
 assert.equal((await f.read())?.items[0]?.attributionState, "unknown");
 await f.put(f.worker, f.workerEntries);
 f.raw.verification = { passed: [{ kind: "test", revision: null, result: "passed", summary: "no binding" }, { unsupported: true }], failed: [], unknown: [] };
 delete f.raw.unknowns;
 const out = await f.read(); assert.equal(out?.state, "incomplete"); assert.equal(out?.items[0]?.verification[0]?.revisionBinding?.inputApplicability, "unknown");
 assert.match(out?.items[0]?.reasons.join(" ") ?? "", /inventory incomplete/);
});

test("newer unresolved observations are retained beside older recorded ones; absence explicitly says absence", async t => {
 const f = await fixture(t);
 const out = await readSpecAssessmentObservations({ id: "owner", path: f.owner }, [f.root], { call: async () => ({ state: "observed", observations: [{ ...f.raw, name: "older", assessmentState: "recorded", coverage: { unresolvedIds: [], unresolvedFiles: [] } }, { ...f.raw, name: "newer" }], reasons: [] }) });
 assert.deepEqual(out?.items.map(i => [i.name, i.assessmentState, i.unresolved]), [["older", "recorded", 0], ["newer", "outstanding", 1]]);
 const absent = await readSpecAssessmentObservations({ id: "owner", path: f.owner }, [f.root], { call: async () => ({ state: "absent", observations: [], reasons: ["no-assessment-store"] }) });
 assert.equal(absent?.state, "absent"); assert.equal(absent?.items.length, 0);
});
