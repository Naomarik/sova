// Actual common team spawn -> scripted RPC child running the pinned SDK/spec-worker -> owner reopen -> explicit companion CLI.
// No model/network requests. The spawnImpl replaces only the CLI transport, not the worker's SDK lifecycle.
// The spec core's sova-spec-assess.mjs is a trap that records each call, then runs the real companion: neither the
// worker, the owner nor a spec-on mode session calls it by itself; only the operator's explicit CLI calls reach it.
import "../../pi-config/extensions/claude-code/tests/hermetic-env.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.PI_PACKAGE_DIR = realpathSync(path.resolve(here, "../../node_modules/@earendil-works/pi-coding-agent"));
if (process.env.SOVA_ASSESS_TEST_AGENT) process.env.PI_CODING_AGENT_DIR = process.env.SOVA_ASSESS_TEST_AGENT;
const { jiti } = await import("../../pi-config/extensions/subagents/tests/runtime.mjs");
const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, initTheme } = await jiti.import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
initTheme(); // Match an actual host's theme initialization; never manually enable an extension tool.
const { registerSubagents } = await jiti.import(path.resolve(here, "../../pi-config/extensions/subagents/index.ts"));
const { SubagentRunner } = await jiti.import(path.resolve(here, "../../pi-config/extensions/subagents/runner.ts"));
const { computeReadiness, configureReadiness, resetReadiness, readinessChecksOf } = await jiti.import(path.resolve(here, "../merge-readiness.ts"));
const { callAssessment } = await jiti.import(path.resolve(here, "../../pi-config/extensions/mode/spec-assessment.ts"));
const realCore = path.resolve(here, "../../pi-config/extensions/spec/core");

function provider(script, probe) {
 return pi => pi.registerProvider("scripted", { baseUrl: "http://localhost", apiKey: "unused", api: "openai-completions", models: [{ id: "assessment", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  streamSimple(model) {
   const stream = createAssistantMessageEventStream(), step = script.shift() ?? { text: "Done.\nAlso changes: none" }; probe?.(step);
   const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: step.tool ? "toolUse" : "stop", timestamp: Date.now() };
   queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    if (step.tool) { const call = { type: "toolCall", id: `call-${crypto.randomUUID()}`, name: step.tool, arguments: step.args }; message.content.push(call); stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message }); }
    else { message.content.push({ type: "text", text: step.text }); stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: message }); }
    stream.push({ type: "done", reason: message.stopReason, message });
   });
   return stream;
  },
 });
}

if (process.argv.includes("--worker")) {
 const cwd = process.env.SOVA_ASSESS_TEST_CWD, agentDir = process.env.SOVA_ASSESS_TEST_AGENT;
 const script = [{ tool: "read", args: { path: "src/value.ts" } }, { tool: "bash", args: { command: "git status --short" } }, { tool: "write", args: { path: "src/value.ts", content: "export const value = 90;\n" } }, { text: "Done.\nAlso changes: §demo/rule — value is now 90" }];
 const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, additionalExtensionPaths: [path.resolve(here, "../../pi-config/extensions/mode/spec-worker.ts")], extensionFactories: [provider(script)] });
 await loader.reload();
 const manager = SessionManager.create(cwd, path.join(agentDir, "sessions/worker"));
 const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: SettingsManager.inMemory(), sessionManager: manager });
 await session.setModel(session.modelRuntime.getModel("scripted", "assessment"));
 writeFileSync(process.env.SOVA_ASSESS_TEST_PROBE, JSON.stringify({ tools: session.getAllTools().map(t => t.name), spawnEnvironment: { owner: process.env.SOVA_SPEC_OWNER_SESSION, worker: process.env.SOVA_SPEC_WORKER_ID, team: process.env.SOVA_SPEC_TEAM_ID } }));
 const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
 session.subscribe(send);
 createInterface({ input: process.stdin }).on("line", async line => {
  try {
   const cmd = JSON.parse(line);
   if (cmd.type === "get_state") send({ type: "response", id: cmd.id, command: cmd.type, success: true, data: { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), model: session.model, thinkingLevel: "high" } });
   else if (cmd.type === "prompt") { send({ type: "response", id: cmd.id, command: cmd.type, success: true }); await session.prompt(cmd.message); }
   else if (cmd.type === "abort") { await session.abort(); send({ type: "response", id: cmd.id, command: cmd.type, success: true }); }
   else send({ type: "response", id: cmd.id, command: cmd.type, success: false, error: "unsupported fixture command" });
  } catch (error) { process.stderr.write(String(error.stack ?? error)); process.exitCode = 1; }
 });
} else {
 const scratch = mkdtempSync(path.join(tmpdir(), "assessment-spawn-sdk-")), cwd = path.join(scratch, "project"), agentDir = path.join(scratch, "agent"), probe = path.join(scratch, "worker-probe.json"), marker = path.join(scratch, "assess-calls.jsonl");
 const calls = () => existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
 const store = path.join(cwd, ".sova/spec/assessments");
 const receipts = () => existsSync(store) ? readdirSync(store).filter(n => !n.startsWith(".")) : [];
 const taskEntries = manager => manager.getEntries().filter(e => e.type === "custom" && /^spec-assessment/.test(e.customType));
 let session, runners = [];
 try {
  mkdirSync(path.join(cwd, ".sova/spec/claims/demo"), { recursive: true }); mkdirSync(path.join(cwd, "src"));
  const core = path.join(agentDir, "extensions/spec/core"); mkdirSync(core, { recursive: true });
  for (const name of readdirSync(realCore)) if (name !== "sova-spec-assess.mjs") symlinkSync(path.join(realCore, name), path.join(core, name));
  writeFileSync(path.join(core, "sova-spec-assess.mjs"), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nawait import(${JSON.stringify(path.join(realCore, "sova-spec-assess.mjs"))});\n`);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(path.join(cwd, ".sova/spec/manifest.json"), JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims: { "§demo/rule": { kind: "behavior", code: ["src/value.ts"], requires: [], authority: "accepted", evidence: "verified" } } }));
  writeFileSync(path.join(cwd, ".sova/spec/claims/demo/rule.md"), "# §demo/rule\n\nValue is 80.\n"); writeFileSync(path.join(cwd, ".sova/spec/.gitignore"), "/assessments/\n/drafts/\n"); writeFileSync(path.join(cwd, "src/value.ts"), "export const value = 80;\n"); writeFileSync(path.join(cwd, "src/other.ts"), "export const other = 1;\n");
  const git = (...args) => { const r = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q", "-b", "master"); git("add", "."); git("commit", "-qm", "initial"); const base = git("rev-parse", "HEAD");
  // Prove the trap sees the actual transport, then start clean.
  await callAssessment(core, cwd, ["status", "--owner-session", "nobody"]); assert.equal(calls().length, 1, "the trap records a real transport call"); rmSync(marker);
  // Dirty before the task starts: a late baseline would have subtracted it, a known base keeps it visible.
  writeFileSync(path.join(cwd, "src/other.ts"), "export const other = 2;\n");
  const parentScript = [{ tool: "team_create", args: { name: "assessment fixture", objective: "Change the value", members: [{ role: "author", prompt: "Change value to 90.", tools: ["read", "write", "bash"], wake: false }] } }, { text: "Team started." }];
  const manager = SessionManager.create(cwd, path.join(agentDir, "sessions/owner"));
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, extensionFactories: [provider(parentScript), pi => {
   pi.events.on("mode:discover", () => pi.events.emit("mode:state", { version: 1, minorModes: ["spec"] }));
   registerSubagents(pi, (options, handlers) => {
    const runner = new SubagentRunner({ ...options, spawnImpl: (_command, args, spawnOptions) => {
     assert.ok(args.includes(path.resolve(here, "../../pi-config/extensions/mode/spec-worker.ts")), "actual common code-writing worker path injected the worker's spec checks");
     return spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker"], { ...spawnOptions, env: { ...spawnOptions.env, SOVA_ASSESS_TEST_CWD: cwd, SOVA_ASSESS_TEST_AGENT: agentDir, SOVA_ASSESS_TEST_PROBE: probe } });
    } }, handlers); runners.push(runner); return runner;
   }, { agentDir, policyFile: path.join(agentDir, "absent-policy.json"), hosting: { enabled: false } });
  }] });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: SettingsManager.inMemory(), sessionManager: manager }));
  await session.setModel(session.modelRuntime.getModel("scripted", "assessment"));
  await session.prompt("Start the team");
  assert.equal(runners.length, 1, "actual team_create launched a real runner");
  const worker = runners[0], until = Date.now() + 30_000;
  while (!worker.isSettled() && Date.now() < until) await new Promise(r => setTimeout(r, 25));
  assert.equal(worker.taskOutcome, "success", worker.error ?? worker.finalOutput());
  const workerEntries = readFileSync(worker.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(workerEntries.some(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "write" && !e.message.isError), "the worker wrote");
  assert.deepEqual(workerEntries.filter(e => e.type === "custom" && /^spec-assessment/.test(e.customType)), [], "the worker wrote no assessment task or error entry");
  const captured = JSON.parse(readFileSync(probe, "utf8"));
  assert.ok(!captured.tools.includes("spec_assess"), "a spec-on worker has no assessment tool");
  assert.equal(captured.spawnEnvironment.owner, manager.getSessionId()); assert.equal(captured.spawnEnvironment.worker, worker.id); assert.ok(captured.spawnEnvironment.team, "spawn attribution env is still set");
  assert.deepEqual(calls(), [], "neither the owner nor the worker ran an assessment by itself"); assert.deepEqual(receipts(), []);
  const ownerFile = manager.getSessionFile();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose(); session = undefined;
  const reopened = SessionManager.open(ownerFile);
  assert.ok(reopened.getEntries().some(e => e.type === "custom" && e.customType === "subagents-worker-manifest" && e.data.ref?.sessionId === worker.sessionId), "production recorder persisted worker identity");
  assert.deepEqual(taskEntries(reopened), []);
  // The work lands as a commit after the task began: a later HEAD as base would hide it.
  git("add", "src/value.ts"); git("commit", "-qm", "value 90");
  resetReadiness(); configureReadiness({ insights: { treeStatus: async () => ({ exists: true, readable: true, branch: "fixture", base: "master", ahead: 1, dirty: false, merged: false, subjects: [], headAt: 2 }) }, git: async () => "" });
  const row = { id: reopened.getSessionId(), path: ownerFile, cwd, busy: false, archived: false, lastActiveAt: new Date().toISOString() };
  const facts = { trees: [{ path: cwd, branch: "fixture", base, status: "active", session: row.id, action: "created" }], merges: [], lastCheck: { at: 1, ok: false } };
  const result = await computeReadiness(row, facts);
  assert.equal(result.trees[0].state, "in-progress"); assert.equal(result.trees[0].why, "the last check failed"); assert.deepEqual(readinessChecksOf(ownerFile).lastCheck, facts.lastCheck);
  assert.ok(!Object.hasOwn(result, "specObservations"), "routine readiness does not query or carry assessments");
  assert.deepEqual(calls(), [], "readiness ran no assessment");

  // The operator's explicit companion CLI against the known start revision: the only calls that reach the trap.
  const attribution = { ownerSessionId: row.id, sessionId: worker.sessionId, workerId: worker.id, teamId: captured.spawnEnvironment.team, taskId: null, attemptId: null };
  const prepared = await callAssessment(core, cwd, ["prepare", "operator-review", "--base", base, "--attribution-json", JSON.stringify(attribution), "--write"]);
  assert.equal(prepared.written, true, JSON.stringify(prepared)); assert.equal(prepared.query.base, base, "the receipt names the declared base");
  assert.ok(prepared.changedFiles.includes("src/value.ts"), "the task's committed change is included");
  assert.ok(prepared.changedFiles.includes("src/other.ts"), "a change already there at the start is over-included and visible, never subtracted");
  const recorded = await callAssessment(core, cwd, ["record", "operator-review", "--by", "operator", "--decisions-json", JSON.stringify({ decisions: [{ ids: ["§demo/rule"], disposition: "unresolved", reason: "Implementation changed while the requirement says 80; the comparison remains outstanding.", basis: [{ kind: "test", revision: base, result: "failed", summary: "A declared fixture verification result, not semantic proof." }] }], files: [] }), "--attribution-json", JSON.stringify(attribution), "--write"]);
  assert.equal(recorded.written, true, JSON.stringify(recorded));
  const status = await callAssessment(core, cwd, ["status", "operator-review"]);
  assert.equal(status.assessmentState, "outstanding"); assert.equal(status.decisions.decisions[0].disposition, "unresolved");
  const queried = await callAssessment(core, cwd, ["status", "--owner-session", row.id]);
  assert.equal(queried.observations.length, 1); const observation = queried.observations[0];
  assert.equal(observation.attribution.workerId, worker.id); assert.equal(observation.attribution.taskId, null, "an attribution the caller did not pass stays null");
  assert.equal(observation.verification.failed[0].result, "failed"); assert.equal(observation.verification.failed[0].revisionBinding.inputApplicability, "mismatched");
  assert.deepEqual(calls().map(a => a[0]), ["prepare", "record", "status", "status"], "exactly the explicit calls");
  assert.deepEqual(receipts(), ["operator-review"]);

  // A full mode session with spec on: no assessment tool, no capture, across a write, the settle and a reopen.
  rmSync(marker);
  const modeScript = [{ tool: "read", args: { path: "src/value.ts" } }, { tool: "write", args: { path: "src/value.ts", content: "const base = 80; export const value = base;\n" } }, { text: "Done.\nAlso changes: §demo/rule — value back to 80" }];
  const makeModeSession = async manager => {
   const resources = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, additionalExtensionPaths: [path.resolve(here, "../../pi-config/extensions/mode/index.ts")], extensionFactories: [provider(modeScript)] });
   await resources.reload();
   const created = await createAgentSession({ cwd, agentDir, resourceLoader: resources, settingsManager: SettingsManager.inMemory(), sessionManager: manager });
   await created.session.bindExtensions({});
   await created.session.setModel(created.session.modelRuntime.getModel("scripted", "assessment")); return created.session;
  };
  const modeManager = SessionManager.create(cwd, path.join(agentDir, "sessions/full-mode")); session = await makeModeSession(modeManager);
  await session.prompt("/mode spec on");
  assert.ok(!session.getAllTools().some(t => t.name === "spec_assess"), "spec on registers no assessment tool");
  await session.prompt("Refactor without changing the value");
  assert.ok(modeManager.getBranch().some(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "write" && !e.message.isError));
  assert.deepEqual(taskEntries(modeManager), []);
  const modeFile = modeManager.getSessionFile();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); session = undefined;
  const restored = SessionManager.open(modeFile); session = await makeModeSession(restored);
  assert.ok(!session.getActiveToolNames().includes("spec_assess"), "reopen restores no assessment tool");
  assert.deepEqual(taskEntries(restored), [], "opening creates no assessment task");
  assert.deepEqual(calls(), [], "the mode session ran no assessment"); assert.deepEqual(receipts(), ["operator-review"], "the explicit receipt is untouched");
  console.log(JSON.stringify({ result: "pass", commonTeamSpawn: true, actualWorkerSdk: true, parentReopened: true, automaticCalls: 0, explicitCli: { base: prepared.query.base, changedFiles: prepared.changedFiles, assessmentState: status.assessmentState }, unchangedGate: result.trees[0].why }));
 } finally { if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await Promise.all(runners.map(r => r.dispose())); session?.dispose(); rmSync(scratch, { recursive: true, force: true }); }
}
