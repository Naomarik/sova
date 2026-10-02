import "./tests/hermetic-env.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const core = resolve(import.meta.dirname, "../spec/core");
const script = resolve(import.meta.dirname, "spec-hooks.ts");
function fixture(t: { after(fn: () => void): void }) {
 const root = mkdtempSync(join(tmpdir(), "native-assessment-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const cwd = join(root, "project"), state = join(root, "state"); mkdirSync(join(cwd, ".sova/spec/claims/demo"), { recursive: true }); mkdirSync(join(cwd, "src"));
 writeFileSync(join(cwd, ".sova/spec/manifest.json"), JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims: { "§demo/rule": { kind: "behavior", code: ["src/value.ts"], requires: [], authority: "accepted", evidence: "verified" } } }));
 writeFileSync(join(cwd, ".sova/spec/claims/demo/rule.md"), "# §demo/rule\n\nValue is 80.\n"); writeFileSync(join(cwd, ".sova/spec/.gitignore"), "/assessments/\n/drafts/\n"); writeFileSync(join(cwd, "src/value.ts"), "export const value = 80;\n");
 const git = (...args: string[]) => { const r = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args]); assert.equal(r.status, 0, r.stderr.toString()); return r.stdout.toString().trim(); };
 git("init", "-q", "-b", "master"); git("add", "."); git("commit", "-qm", "initial"); const base = git("rev-parse", "HEAD");
 const hook = (event: string, extra: Record<string, unknown> = {}, prompt: string | null = "actual-prompt") => {
  const r = spawnSync(process.execPath, [script, event, "--core", core, "--state", state], { cwd, encoding: "utf8", input: JSON.stringify({ session_id: "native-session", ...(prompt ? { prompt_id: prompt } : {}), cwd, ...extra }), env: { ...process.env, SOVA_SPEC_OWNER_SESSION: "owner", SOVA_SPEC_WORKER_ID: "ag_01", SOVA_SPEC_TEAM_ID: "team" }, timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
 };
 const saved = () => JSON.parse(readFileSync(join(state, "native-session.json"), "utf8"));
 const receipts = () => { try { return readdirSync(join(cwd, ".sova/spec/assessments")).filter(n => !n.startsWith(".")).map(n => JSON.parse(readFileSync(join(cwd, ".sova/spec/assessments", n, "packet.json"), "utf8"))); } catch { return []; } };
 return { cwd, state, base, hook, saved, receipts, edit: (n: number) => writeFileSync(join(cwd, "src/value.ts"), `export const value = ${n};\n`) };
}

test("native fresh hook processes preserve actual prompt/base and produce unresolved receipts without changing the Stop gate", t => {
 const f = fixture(t); f.hook("turn"); f.edit(90); f.hook("post", { tool_name: "Write", tool_input: { file_path: join(f.cwd, "src/value.ts") } });
 const first = f.saved(); assert.equal(first.assessment.task.base, f.base); assert.equal(first.assessment.task.taskId, "actual-prompt"); assert.equal(f.receipts().length, 1);
 const packet = f.receipts()[0]; assert.equal(packet.attribution.workerId, "ag_01"); assert.equal(packet.capture.candidates[0].disposition, "unresolved");
 f.hook("turn"); assert.equal(f.saved().assessment.task.base, f.base); assert.notEqual(f.saved().assessment.attemptId, first.assessment.attemptId);
 const stopped = f.hook("stop", { last_assistant_message: "Done." }); assert.notEqual(stopped?.decision, "block");
});

test("first native post with missing pre/turn never calls changed bytes a baseline", t => {
 const f = fixture(t); f.edit(90);
 const out = f.hook("post", { tool_name: "Write", tool_input: { file_path: join(f.cwd, "src/value.ts") } });
 assert.equal(f.saved().assessment, undefined); assert.equal(f.saved().assessmentUnavailable, true); assert.match(f.saved().assessmentError, /baseline missing/);
 assert.match(JSON.stringify(out), /Native assessment observation unavailable/); assert.equal(f.receipts().length, 0);
});

test("native prompt identity unavailable is explicitly null; corrupt hook state stays unknown", t => {
 const f = fixture(t); f.hook("turn", {}, null); f.edit(90); f.hook("post", { tool_name: "Write" }, null);
 assert.equal(f.receipts()[0].attribution.taskId, null);
 writeFileSync(join(f.state, "native-session.json"), "{torn");
 const out = f.hook("post", { tool_name: "Write" }, null);
 assert.equal(f.saved().assessmentUnavailable, true); assert.match(JSON.stringify(out), /Native assessment observation unavailable/);
 assert.equal(f.receipts().length, 1, "corruption neither deletes history nor invents a new baseline");
});
