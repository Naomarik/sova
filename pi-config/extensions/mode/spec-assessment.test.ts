import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as assessment from "./spec-assessment.ts";
const { callAssessment } = assessment;

test("only the transport and the spawn attribution names remain: nothing to capture or observe with", () => {
 assert.deepEqual(Object.keys(assessment).sort(), ["ASSESSMENT_OWNER_ENV", "ASSESSMENT_TEAM_ENV", "ASSESSMENT_WORKER_ENV", "callAssessment"]);
 assert.deepEqual([assessment.ASSESSMENT_OWNER_ENV, assessment.ASSESSMENT_WORKER_ENV, assessment.ASSESSMENT_TEAM_ENV], ["SOVA_SPEC_OWNER_SESSION", "SOVA_SPEC_WORKER_ID", "SOVA_SPEC_TEAM_ID"]);
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
