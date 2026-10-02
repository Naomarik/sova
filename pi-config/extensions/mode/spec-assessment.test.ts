import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assessmentAttribution, callAssessment, decodeAssessmentTask, observeAssessment, startAssessmentTask, type AssessmentTask } from "./spec-assessment.ts";
const task = (): AssessmentTask => ({ v: 1, sessionId: "s", taskId: "u", base: "a".repeat(40), baseline: { inputs: [] }, paths: [], unknowns: [] });
const a = assessmentAttribution("s", "u", "attempt", true, { SOVA_SPEC_OWNER_SESSION: "parent", SOVA_SPEC_WORKER_ID: "ag_01", SOVA_SPEC_TEAM_ID: "team" });

test("only supplied worker identity is carried; standalone missing fields remain null", () => {
 assert.deepEqual(a, { ownerSessionId: "parent", sessionId: "s", workerId: "ag_01", teamId: "team", taskId: "u", attemptId: "attempt" });
 assert.deepEqual(assessmentAttribution("s", "u", "attempt", true, {}), { ownerSessionId: null, sessionId: "s", workerId: null, teamId: null, taskId: "u", attemptId: "attempt" });
});

test("exact fingerprints, not repeated filename or mtime, create new immutable observations", async () => {
 const t = task(); let fingerprint = "b".repeat(64), writes = 0;
 const call = async (_core: string, _cwd: string, args: string[]) => { if (args.includes("--write")) writes++; return { exit: 0, written: args.includes("--write"), name: args[1], fingerprint, changedFiles: ["src/value.ts"], query: { base: t.base }, unknowns: [] }; };
 await observeAssessment("core", ".", t, a, call); await observeAssessment("core", ".", t, a, call); assert.equal(writes, 1);
 const first = t.receipt; fingerprint = "c".repeat(64); await observeAssessment("core", ".", t, a, call); assert.equal(writes, 2); assert.notEqual(t.receipt, first);
});

test("missing initial input capture or later Git initialization cannot replace the fixed task base", async () => {
 const initial = await startAssessmentTask("core", ".", "s", "u", async () => ({ exit: 2, unavailable: "missing" }));
 assert.match((await observeAssessment("core", ".", initial, a, async () => { throw new Error("must not recapture"); })).failure ?? "", /initial inputs unavailable/);
 const nogit = { ...task(), base: null };
 const result = await observeAssessment("core", ".", nogit, a, async () => ({ exit: 0, written: false, fingerprint: "b".repeat(64), changedFiles: ["src/value.ts"], query: { base: "a".repeat(40) } }));
 assert.match(result.failure ?? "", /later HEAD cannot replace/);
 let capture = 0;
 const unstable = await startAssessmentTask("core", ".", "s", "u", async () => ({ exit: 0, query: { base: "a".repeat(40) }, inputs: [], changedFiles: [], fingerprint: (++capture === 1 ? "b" : "c").repeat(64) }));
 assert.ok(unstable.unknowns.includes("initial input capture unavailable"), "disagreeing initial captures cannot become a durable baseline");
});

test("task snapshot schema corruption cannot be treated as a restart baseline", () => {
 assert.ok(decodeAssessmentTask(task()));
 assert.equal(decodeAssessmentTask({ ...task(), receipt: 1 }), undefined);
 assert.equal(decodeAssessmentTask({ ...task(), fingerprint: "incorrect" }), undefined);
 assert.equal(decodeAssessmentTask({ ...task(), paths: ["../foreign"] }), undefined);
});

test("valid JSON with disagreeing process exit, malformed and capped stdout are unavailable transport", async t => {
 const dir = mkdtempSync(join(tmpdir(), "assess-transport-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const file = join(dir, "sova-spec-assess.mjs");
 writeFileSync(file, 'const b=Buffer.from(JSON.stringify({exit:0,summary:"結果§"}));const i=b.indexOf(0xe7)+1;process.stdout.write(b.subarray(0,i));setTimeout(()=>process.stdout.write(b.subarray(i)),20);');
 assert.equal((await callAssessment(dir, dir, ["status", "test"])).summary, "結果§", "split UTF-8 transport preserves exact text");
 writeFileSync(file, 'console.log(JSON.stringify({exit:0,written:true}));process.exitCode=1;');
 assert.equal((await callAssessment(dir, dir, ["prepare", "test"])).exit, 2);
 writeFileSync(file, 'console.log("partial{");'); assert.equal((await callAssessment(dir, dir, ["status", "test"])).exit, 2);
 writeFileSync(file, 'console.log("x".repeat(3*1024*1024));'); assert.match(String((await callAssessment(dir, dir, ["status", "test"])).unavailable), /limit/);
});
